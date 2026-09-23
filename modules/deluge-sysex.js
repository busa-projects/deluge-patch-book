/**
 * deluge-sysex.js
 * ----------------------------------------------------------------------
 * Eigenständiges Vanilla-JS-Modul für die Kommunikation mit einem
 * Synthstrom Deluge über Web MIDI + SysEx ("smSysex"-Protokoll).
 *
 * Voraussetzung auf dem Deluge: Community Firmware >= 1.3.0
 * Voraussetzung im Browser: Chrome / Edge / Opera (Web MIDI + SysEx)
 *
 * Protokoll-Grundlagen (aus dem Quellcode von silicakes/deluge-extensions,
 * MIT-lizenziert, abgeleitet und neu implementiert für dieses Projekt):
 *
 *   SysEx-Rahmen:      F0 <manufacturerId> <smCommand> <payload...> F7
 *   Manufacturer ID:   00 21 7B 01   (offizielle Synthstrom-ID)
 *                      7D            (Dev/Test-ID, falls Community FW das
 *                                     "developer sysex id" Flag nutzt)
 *   smCommands:        PING=0x00 POPUP=0x01 HID=0x02 DEBUG=0x03
 *                      JSON=0x04 JSON_REPLY=0x05 PONG=0x7F
 *
 *   Alle Datei-Operationen laufen über JSON-Kommandos (smCommand JSON),
 *   eingebettet als ASCII-Bytes direkt im SysEx-Body, z.B.:
 *
 *     { "dir":   { "path": "/SYNTHS", "offset": 0, "lines": 64 } }
 *     { "open":  { "path": "/SYNTHS/FOO.XML", "write": 0 } }
 *     { "read":  { "fid": 3, "addr": 0, "size": 1024 } }
 *     { "write": { "fid": 3, "addr": 0, "size": 128 } }   (+ binärer Anhang)
 *     { "close": { "fid": 3 } }
 *     { "mkdir": { "path": "/SYNTHS/BASS", "date": ..., "time": ... } }
 *     { "delete":{ "path": "/SYNTHS/FOO.XML" } }
 *     { "rename":{ "from": "...", "to": "..." } }
 *
 *   Antworten kommen mit "^" vorangestelltem Key zurück, z.B. "^dir",
 *   "^open", "^read" (inkl. binärem Anhang nach einem 0x00-Trenner).
 *
 *   Binärdaten (Dateiinhalt) werden 7-bit-safe gepackt: je 7 Datenbytes
 *   werden zu 8 SysEx-Bytes (1 Header-Byte mit den 7 MSBs + 7 Bytes mit
 *   je 7 LSBs).
 *
 *   Vor der ersten Datei-Operation muss eine Session eröffnet werden
 *   ({"session":{"tag":"MeinApp"}}) — die Antwort liefert sid/midMin/midMax,
 *   aus denen die Message-ID pro Nachricht rotierend gebildet wird.
 * ----------------------------------------------------------------------
 */

// Plain classic script (no import/export): loading this as an ES module
// would need <script type="module">, but Chrome/Edge refuse to fetch
// modules from file:// URLs at all (CORS), which is exactly how this app
// is meant to be opened (double-click index.html, no server). Wrapped in an
// IIFE instead so its internals stay private and don't leak into the global
// scope shared with app.js and the other modules/*.js files -- only the
// namespace object below (window.DelugeSysexModule) is exposed.
window.DelugeSysexModule = (function () {

// ---------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------

const SmCommand = Object.freeze({
  PING: 0x00,
  POPUP: 0x01,
  HID: 0x02,
  DEBUG: 0x03,
  JSON: 0x04,
  JSON_REPLY: 0x05,
  PONG: 0x7f,
});

const MANUFACTURER_ID_STD = [0x00, 0x21, 0x7b, 0x01];
const MANUFACTURER_ID_DEV = [0x7d];

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const SESSION_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_MESSAGES_PER_SESSION = 100;
// A large SysEx reply (e.g. a directory listing with many entries, or a
// read chunk near WRITE/READ_CHUNK_SIZE) spans more individual MIDI bytes,
// and with them a higher chance any ONE gets dropped/corrupted by the
// transport (USB-MIDI drivers/hardware are not perfectly reliable for
// large sustained transfers) -- reported directly: "Check failed: Bad
// control character in string literal in JSON at position 814 (line 46
// column 6)" on the first "Check now" attempt, unreproducible on five
// immediate retries of the exact same action. Every command this protocol
// sends (dir listing at a given offset, read at a given fid/addr/size,
// write of the same known bytes, ...) is safe to simply resend verbatim on
// a corrupted/unparseable reply -- so _sendJson() does that automatically,
// same as what the user already did by hand.
const MAX_JSON_PARSE_RETRIES = 2;
const WRITE_CHUNK_SIZE = 128; // Bytes pro SysEx-Write-Paket (vor 7->8 Packing)
const READ_CHUNK_SIZE = 1024; // Bytes pro SysEx-Read-Anfrage

// ---------------------------------------------------------------------
// 7-Bit Packing (SysEx darf nur Bytes 0x00-0x7F enthalten)
// ---------------------------------------------------------------------

/** Packt 8-Bit-Binärdaten in ein SysEx-sicheres 7-Bit-Format. */
function pack8to7(data) {
  const out = [];
  let n = 0;
  while (n < data.length) {
    const count = Math.min(7, data.length - n);
    let msbs = 0;
    const group = [];
    for (let i = 0; i < count; i++) {
      const b = data[n + i];
      msbs |= ((b & 0x80) >> 7) << i;
      group.push(b & 0x7f);
    }
    out.push(msbs, ...group);
    n += count;
  }
  return new Uint8Array(out);
}

/** Entpackt SysEx-sichere 7-Bit-Daten zurück in 8-Bit-Binärdaten. */
function unpack7to8(data, expectedSize) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const msbs = data[i++];
    for (let bit = 0; bit < 7; bit++) {
      if (expectedSize !== undefined && out.length >= expectedSize) break;
      if (i >= data.length) break;
      let b = data[i++];
      if ((msbs >> bit) & 1) b |= 0x80;
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------
// Hauptklasse
// ---------------------------------------------------------------------

class DelugeSysex {
  constructor() {
    /** @type {MIDIAccess|null} */
    this._midiAccess = null;
    /** @type {MIDIInput|null} */
    this._input = null;
    /** @type {MIDIOutput|null} */
    this._output = null;
    /** @type {{sid:number, midMin:number, midMax:number, counter:number}|null} */
    this._session = null;
    this._messagesSentInSession = 0;
    this._useDevId = false;
    this._listeners = new Set();
    this._connected = false;

    this._onMidiMessage = this._onMidiMessage.bind(this);
  }

  get connected() {
    return this._connected;
  }

  // -------------------------------------------------------------
  // Verbindung
  // -------------------------------------------------------------

  /**
   * Fordert Web-MIDI-Zugriff (inkl. SysEx) an und gibt die verfügbaren
   * Geräte zurück. Muss aus einem User-Gesture-Handler (Klick) heraus
   * aufgerufen werden.
   */
  async requestAccess() {
    if (!navigator.requestMIDIAccess) {
      throw new Error(
        "Web MIDI API wird von diesem Browser nicht unterstützt. Chrome/Edge/Opera verwenden.",
      );
    }
    this._midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    return this._midiAccess;
  }

  /** Listet alle verfügbaren MIDI-Eingänge. */
  listInputs() {
    if (!this._midiAccess) return [];
    return Array.from(this._midiAccess.inputs.values());
  }

  /** Listet alle verfügbaren MIDI-Ausgänge. */
  listOutputs() {
    if (!this._midiAccess) return [];
    return Array.from(this._midiAccess.outputs.values());
  }

  /**
   * Versucht automatisch ein Gerät zu finden, dessen Name "deluge" enthält.
   * Der Deluge meldet sich mit 3 MIDI-Ports, aber welcher davon dieses
   * SysEx-Protokoll tatsächlich beantwortet, ist je nach OS/Treiber
   * unterschiedlich (nicht zuverlässig an der Portnummer erkennbar) --
   * deshalb wird nicht einfach der erste Namens-Treffer genommen, sondern
   * jeder Kandidaten-Port kurz angepingt und der erste verbunden, der
   * tatsächlich antwortet.
   */
  async autoConnect(namePattern = "deluge") {
    const inputs = this.listInputs().filter((i) =>
      i.name?.toLowerCase().includes(namePattern),
    );
    const outputs = this.listOutputs().filter((o) =>
      o.name?.toLowerCase().includes(namePattern),
    );
    // Gleicher Name auf Input und Output = derselbe logische Port. Falls die
    // Namen nicht 1:1 übereinstimmen, positionsweise als Fallback paaren.
    const pairs = inputs.map((input, idx) => ({
      input,
      output: outputs.find((o) => o.name === input.name) || outputs[idx],
    })).filter((p) => p.output);

    if (pairs.length === 0) return false;

    // Prefer whichever candidate actually answers a quick ping. But some
    // firmware/driver combinations never answer PING at all (observed on
    // real hardware) and yet still work for real file commands via
    // _ensureSession's fallback below -- so don't treat "nobody answered
    // ping" as total failure, just connect to the first name match instead
    // of leaving the user stuck with no way to even try.
    for (const { input, output } of pairs) {
      this.connect(input, output);
      try {
        await this.ping(800);
        return true;
      } catch {
        // keep trying the remaining candidates
      }
    }
    this.connect(pairs[0].input, pairs[0].output);
    return true;
  }

  /** Verbindet explizit gewählte Ein-/Ausgänge. */
  connect(input, output) {
    if (this._input) {
      this._input.removeEventListener("midimessage", this._onMidiMessage);
    }
    this._input = input;
    this._output = output;
    if (this._input) {
      this._input.addEventListener("midimessage", this._onMidiMessage);
    }
    this._connected = !!(input && output);
    this._session = null; // neue Verbindung => neue Session nötig
  }

  disconnect() {
    if (this._input) {
      this._input.removeEventListener("midimessage", this._onMidiMessage);
    }
    this._input = null;
    this._output = null;
    this._connected = false;
    this._session = null;
  }

  /** Schneller Verbindungstest (PING -> PONG). */
  async ping(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Ping-Timeout: keine Antwort vom Deluge."));
      }, timeoutMs);

      const cleanup = this._subscribeRaw((data) => {
        const isDev = data[1] === 0x7d;
        const cmdPos = isDev ? 2 : 5;
        if (data[cmdPos] === SmCommand.PONG) {
          clearTimeout(timeout);
          cleanup();
          resolve(true);
        }
      });

      this._sendRaw([SmCommand.PING]);
    });
  }

  // -------------------------------------------------------------
  // Low-level SysEx senden/empfangen
  // -------------------------------------------------------------

  _manufacturerId() {
    return this._useDevId ? MANUFACTURER_ID_DEV : MANUFACTURER_ID_STD;
  }

  _sendRaw(bodyBytes) {
    if (!this._output) throw new Error("Kein MIDI-Ausgang verbunden.");
    const msg = new Uint8Array([
      SYSEX_START,
      ...this._manufacturerId(),
      ...bodyBytes,
      SYSEX_END,
    ]);
    this._output.send(msg);
  }

  _subscribeRaw(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _onMidiMessage(event) {
    const data = event.data;
    if (!data || data[0] !== SYSEX_START) return;
    this._listeners.forEach((fn) => fn(data));
  }

  // -------------------------------------------------------------
  // Session-Handling
  // -------------------------------------------------------------

  async _ensureSession() {
    if (
      this._session &&
      this._messagesSentInSession < MAX_MESSAGES_PER_SESSION
    ) {
      return this._session;
    }
    this._session = null;
    this._messagesSentInSession = 0;
    try {
      return await this._openSession();
    } catch (err) {
      // Some firmware/driver combinations never answer the explicit
      // {"session":{...}} handshake at all (observed: even a plain PING
      // goes unanswered, yet real file commands still work) -- rather than
      // give up, fall back to a fixed default message-ID range instead of
      // a negotiated one, same as the known-working silicakes/deluge-extensions
      // client does in this exact situation ("fallback mode").
      this._session = { sid: 0, midMin: 0x41, midMax: 0x4f, counter: 1 };
      return this._session;
    }
  }

  async _openSession(tag = "PatchbookApp") {
    const jsonBytes = this._jsonToBytes({ session: { tag } });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Session-Aufbau fehlgeschlagen (Timeout). Ist der Deluge verbunden, " +
              "eingeschaltet und läuft Community Firmware >= 1.3?",
          ),
        );
      }, SESSION_TIMEOUT_MS);

      const cleanup = this._subscribeRaw((data) => {
        try {
          const parsed = this._parseResponse(data);
          if (parsed?.json?.["^session"]) {
            clearTimeout(timeout);
            cleanup();
            const s = parsed.json["^session"];
            this._session = {
              sid: s.sid,
              midMin: s.midMin,
              midMax: s.midMax,
              counter: 1,
            };
            resolve(this._session);
          }
        } catch {
          // andere/unpassende SysEx-Nachricht, ignorieren
        }
      });

      this._sendRaw([SmCommand.JSON, 0, ...Array.from(jsonBytes)]);
    });
  }

  _buildMsgId(session) {
    const range = session.midMax - session.midMin + 1;
    return session.midMin + ((session.counter - 1) % range);
  }

  _incrementCounter(session) {
    const range = session.midMax - session.midMin + 1;
    session.counter = (session.counter % range) + 1;
  }

  _jsonToBytes(obj) {
    const str = JSON.stringify(obj);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
  }

  /**
   * Sendet ein JSON-Kommando (optional mit binärem Payload für "write")
   * und wartet auf die passende Antwort -- bei einer kaputten/unparsbaren
   * Antwort (siehe MAX_JSON_PARSE_RETRIES's eigener Kommentar) wird dasselbe
   * Kommando automatisch bis zu MAX_JSON_PARSE_RETRIES-mal unverändert erneut
   * gesendet, bevor der Fehler tatsächlich nach oben durchgereicht wird.
   */
  async _sendJson(cmd, binaryPayload) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_JSON_PARSE_RETRIES; attempt++) {
      try {
        return await this._sendJsonAttempt(cmd, binaryPayload);
      } catch (err) {
        // Only a malformed/unparseable reply is worth retrying -- a real
        // timeout means the device isn't responding at all, and resending
        // immediately would just wait out the same timeout again.
        if (!(err instanceof SyntaxError) || attempt === MAX_JSON_PARSE_RETRIES) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async _sendJsonAttempt(cmd, binaryPayload) {
    const session = await this._ensureSession();
    const msgId = this._buildMsgId(session);
    this._incrementCounter(session);
    this._messagesSentInSession++;

    const jsonBytes = this._jsonToBytes(cmd);
    let body;
    if (cmd.write && binaryPayload) {
      const packed = pack8to7(binaryPayload);
      body = [
        SmCommand.JSON,
        msgId,
        ...Array.from(jsonBytes),
        0x00, // Trenner JSON <-> Binärdaten
        ...Array.from(packed),
      ];
    } else {
      body = [SmCommand.JSON, msgId, ...Array.from(jsonBytes)];
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout bei Kommando: ${JSON.stringify(cmd)}`));
      }, COMMAND_TIMEOUT_MS);

      const cleanup = this._subscribeRaw((data) => {
        const isDev = data[1] === 0x7d;
        const cmdPos = isDev ? 2 : 5;
        const idPos = isDev ? 3 : 6;
        if (data[cmdPos] !== SmCommand.JSON_REPLY) return;
        if (data[idPos] !== msgId) return; // Antwort auf andere Anfrage

        clearTimeout(timeout);
        cleanup();
        try {
          resolve(this._parseResponse(data));
        } catch (err) {
          reject(err);
        }
      });

      this._sendRaw(body);
    });
  }

  /** Parst eine rohe SysEx-Antwort in { json, binaryData? }. */
  _parseResponse(data) {
    const isDev = data[1] === 0x7d;
    const headerLen = isDev ? 4 : 7; // F0 + manId(1|4) + cmd + msgId
    const bodyEnd = data.length - 1; // letztes Byte ist F7
    const body = data.slice(headerLen, bodyEnd);

    let sepIdx = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0x00) {
        sepIdx = i;
        break;
      }
    }

    const jsonBytes = sepIdx === -1 ? body : body.slice(0, sepIdx);
    const jsonText = String.fromCharCode(...jsonBytes);
    const json = JSON.parse(jsonText);

    if (sepIdx === -1) return { json };

    const packedBinary = body.slice(sepIdx + 1);
    const binaryData = unpack7to8(packedBinary);
    return { json, binaryData };
  }

  // -------------------------------------------------------------
  // Datei-Operationen (High-Level API)
  // -------------------------------------------------------------

  /** Listet ein Verzeichnis vollständig (paginiert automatisch). */
  async listDirectory(path) {
    const all = [];
    let offset = 0;
    const pageSize = 64;
    for (;;) {
      const { json } = await this._sendJson({
        dir: { path, offset, lines: pageSize },
      });
      const list = json?.["^dir"]?.list ?? [];
      all.push(...list);
      if (list.length === 0) break;
      offset += list.length;
      if (offset > 10000) break; // Sicherheitsnetz
    }
    return all; // [{ name, size, date, time, attr }, ...]
  }

  /** Liest eine Datei komplett vom Deluge (gibt ArrayBuffer zurück). */
  async readFile(path, onProgress) {
    const openResp = await this._sendJson({ open: { path, write: 0 } });
    const { fid, size, err } = openResp.json["^open"];
    if (err) throw new Error(`Öffnen fehlgeschlagen (err=${err}): ${path}`);

    try {
      const result = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunkSize = Math.min(READ_CHUNK_SIZE, size - offset);
        const resp = await this._sendJson({
          read: { fid, addr: offset, size: chunkSize },
        });
        const data = resp.binaryData;
        if (!data) throw new Error("Keine Binärdaten in Read-Antwort.");
        result.set(data.subarray(0, chunkSize), offset);
        offset += chunkSize;
        onProgress?.(offset, size);
      }
      return result.buffer;
    } finally {
      await this._sendJson({ close: { fid } }).catch(() => {});
    }
  }

  /**
   * Liest nur die ersten `maxBytes` einer Datei (oder die ganze Datei, falls
   * sie kleiner ist) -- additiv zu readFile(), ändert dessen Verhalten
   * nicht. Für Aufrufer gedacht, die nur ein paar Attribute nahe des
   * Dateianfangs brauchen (z.B. den Preset-Bibliothek-Filter, der Engine/
   * Oszillator-Quelle aus den ersten ein-zwei KB einer Deluge-Preset-XML
   * sniffen kann, siehe sniffCategories() in app.js) und dafür nicht jedes
   * einzelne Byte über SysEx transferieren wollen. Gibt zusätzlich zurück,
   * ob die Datei tatsächlich abgeschnitten wurde (`truncated`), da ein
   * Aufrufer das wissen muss, um z.B. Kandidaten für "arpeggiator/cables/
   * sidechain nicht bestimmbar" richtig zu behandeln.
   */
  async readFilePartial(path, maxBytes) {
    const openResp = await this._sendJson({ open: { path, write: 0 } });
    const { fid, size, err } = openResp.json["^open"];
    if (err) throw new Error(`Öffnen fehlgeschlagen (err=${err}): ${path}`);

    try {
      const readSize = Math.min(maxBytes, size);
      const result = new Uint8Array(readSize);
      let offset = 0;
      while (offset < readSize) {
        const chunkSize = Math.min(READ_CHUNK_SIZE, readSize - offset);
        const resp = await this._sendJson({
          read: { fid, addr: offset, size: chunkSize },
        });
        const data = resp.binaryData;
        if (!data) throw new Error("Keine Binärdaten in Read-Antwort.");
        result.set(data.subarray(0, chunkSize), offset);
        offset += chunkSize;
      }
      return { buffer: result.buffer, size, truncated: readSize < size };
    } finally {
      await this._sendJson({ close: { fid } }).catch(() => {});
    }
  }

  /** Schreibt Daten (ArrayBuffer/Uint8Array) als Datei auf den Deluge. */
  async writeFile(path, data, onProgress) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const openResp = await this._sendJson({ open: { path, write: 1 } });
    const { fid, err } = openResp.json["^open"];
    if (err) throw new Error(`Öffnen zum Schreiben fehlgeschlagen (err=${err}): ${path}`);

    try {
      let offset = 0;
      while (offset < bytes.length) {
        const size = Math.min(WRITE_CHUNK_SIZE, bytes.length - offset);
        const chunk = bytes.slice(offset, offset + size);
        await this._sendJson(
          { write: { fid, addr: offset, size: chunk.length } },
          chunk,
        );
        offset += size;
        onProgress?.(offset, bytes.length);
      }
    } finally {
      await this._sendJson({ close: { fid } }).catch(() => {});
    }
  }

  /** Legt ein Verzeichnis an. */
  async mkdir(path) {
    const now = new Date();
    const date =
      ((now.getFullYear() - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate();
    const time =
      (now.getHours() << 11) |
      (now.getMinutes() << 5) |
      Math.floor(now.getSeconds() / 2);
    return this._sendJson({ mkdir: { path, date, time } });
  }

  /** Löscht eine Datei (oder ein leeres Verzeichnis). */
  async deleteFile(path) {
    return this._sendJson({ delete: { path } });
  }

  /** Benennt um / verschiebt eine Datei oder ein Verzeichnis. */
  async rename(oldPath, newPath) {
    return this._sendJson({ rename: { from: oldPath, to: newPath } });
  }
}

return { DelugeSysex };
})();

// ---------------------------------------------------------------------
// Beispiel-Nutzung (auskommentiert, zur Orientierung)
// ---------------------------------------------------------------------
//
// const deluge = new DelugeSysex();
//
// connectButton.addEventListener("click", async () => {
//   await deluge.requestAccess();          // muss aus User-Klick kommen
//   const ok = deluge.autoConnect();        // sucht "deluge" im Portnamen
//   if (!ok) {
//     // Fallback: Eigene Auswahl-UI aus deluge.listInputs()/listOutputs()
//   }
//   await deluge.ping();                    // Verbindung testen
//   const files = await deluge.listDirectory("/SYNTHS");
//   const xmlBuffer = await deluge.readFile("/SYNTHS/" + files[0].name);
//   // ... XML parsen, Patchbook generieren ...
// });
