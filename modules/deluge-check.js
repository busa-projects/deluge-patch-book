/**
 * deluge-check.js
 * ----------------------------------------------------------------------
 * Step-basierte Check-Engine für das Patchbook.
 *
 * Statt einer rohen Diff-Liste liefert dieses Modul für eine Liste von
 * Patchbook-"Steps" (z.B. "Envelope 1" mit den Feldern Attack/Decay/
 * Sustain/Release) pro Feld einen Status, plus einen Gesamtstatus für
 * den Step (nur "erledigt"/angehakt, wenn ALLE Felder des Steps ok sind).
 *
 * Drei Vergleichs-Objekte:
 * - "target"  = der Patch, aus dem das Patchbook generiert wurde (das
 *               Rezept / Ziel)
 * - "actual"  = die Check-Datei, die der Nutzer auf dem Deluge beim
 *               Nachbauen immer wieder überschreibt (sein Fortschritt)
 * - "init"    = der Deluge-Init-Patch (INIT_PATCH_XML unten), um zu
 *               erkennen, ob ein Feld überhaupt schon angefasst wurde
 *
 * Pro Feld ergibt sich daraus ein `status` (siehe fieldStatus()):
 * - "ok"         Ziel und Ist stimmen überein (innerhalb der Toleranz)
 * - "changed"    Ist wurde vom Init-Wert weg verändert, trifft das Ziel
 *                aber noch nicht -- work in progress
 * - "unexpected" Ziel nutzt dieses Feld gar nicht (Ziel == Init), aber
 *                Ist wurde trotzdem verändert -- vermutlich ein Verdreher
 * - "untouched"  Ist ist noch beim Init-Wert, nichts zu berichten
 *
 * Absichtlich werden weder Ziel- noch Ist-Rohwert nach außen gereicht --
 * nur der Status. Das Patchbook soll beim Nachbauen nicht vorsagen, auf
 * welchen Wert genau zu drehen ist.
 *
 * Der Check-Datei-Pfad wird weiterhin NICHT persistiert (kein localStorage)
 * — Picker erscheint nur beim ersten "Check"-Klick pro Session, wenn noch
 * kein Pfad gewählt wurde. Siehe DelugeCheck.ensureCheckPath().
 *
 * Toleranzen ("OK-Range") kommen aus deluge-check-settings.js und werden
 * hier nur konsumiert (resolveTolerance), nicht verwaltet.
 * ----------------------------------------------------------------------
 */

// Plain classic script, not an ES module -- see the matching comment in
// deluge-sysex.js for why (file:// + <script type="module"> don't mix).
// IIFE-wrapped so this file's own parseDelugeXml() can't collide with
// app.js's separate, stricter parser of the same name.
window.DelugeCheckModule = (function () {

// ---------------------------------------------------------------------
// Verzeichnis rekursiv nach XML-Dateien durchsuchen (für den Picker)
// ---------------------------------------------------------------------

const FAT_ATTR_DIRECTORY = 0x10;

async function listXmlFilesRecursive(deluge, dir = "/SYNTHS", maxDepth = 3, depth = 0) {
  const entries = await deluge.listDirectory(dir);
  const results = [];

  for (const entry of entries) {
    const isDir = (entry.attr & FAT_ATTR_DIRECTORY) !== 0;
    const fullPath = dir.endsWith("/") ? `${dir}${entry.name}` : `${dir}/${entry.name}`;

    if (isDir) {
      if (depth < maxDepth) {
        const nested = await listXmlFilesRecursive(deluge, fullPath, maxDepth, depth + 1);
        results.push(...nested);
      }
    } else if (/\.xml$/i.test(entry.name) && !entry.name.startsWith("._")) {
      // Skip macOS AppleDouble sidecar files (e.g. "._Init.XML") -- the SD
      // card picks these up whenever a Mac has browsed it, same extension,
      // not a real preset.
      results.push({ path: fullPath, name: entry.name });
    }
  }

  return results;
}

// ---------------------------------------------------------------------
// Generischer XML -> Objekt Parser für Deluge-Patch-XML
// (deckt sowohl das alte "verschachtelte Tags"- als auch das neue
// "Attribute"-Format ab, siehe Deluge-Synth-Editor README)
// ---------------------------------------------------------------------

function elementToObject(el) {
  const obj = {};

  for (const attr of Array.from(el.attributes || [])) {
    obj[attr.name] = attr.value;
  }

  for (const child of Array.from(el.children || [])) {
    const hasStructure = child.children.length > 0 || child.attributes.length > 0;
    const childValue = hasStructure ? elementToObject(child) : child.textContent.trim();

    if (Object.prototype.hasOwnProperty.call(obj, child.tagName)) {
      if (!Array.isArray(obj[child.tagName])) {
        obj[child.tagName] = [obj[child.tagName]];
      }
      obj[child.tagName].push(childValue);
    } else {
      obj[child.tagName] = childValue;
    }
  }

  return obj;
}

/**
 * Eine Check-Datei auf der SD-Karte wird beim Nachbauen immer wieder mit
 * dem aktuellen Zwischenstand überschrieben. Wird sie dabei kleiner als
 * ihre vorige Version, aktualisiert FAT nur die gespeicherte Dateigröße —
 * der Datenbereich dahinter wird nicht genullt. Die vom Deluge gemeldete
 * Größe deckt dann noch ein Stück der alten (längeren) Version ab, und
 * readFile() liest dieses Reststück mit ein. Ergebnis: gültiges XML,
 * gefolgt von Müll, was DOMParser als "Extra content at the end of the
 * document" ablehnt. Wir schneiden daher alles nach dem schliessenden Tag
 * des Wurzelelements ab, bevor wir parsen.
 *
 * Ein zweites, unabhängiges Problem betrifft SEHR alte Presets (Firmware
 * <3.0, "2.0.0-beta"-Ära -- reale, unveränderte Werksdateien, nicht nur
 * BOD01-artige neuere): <firmwareVersion>/<earliestCompatibleFirmware>
 * stehen dort als GESCHWISTER-Elemente VOR <sound>, nicht als Attribut
 * AUF <sound> wie bei neueren Dateien -- kein gültiges XML mit genau
 * einem Wurzelelement. Die ursprüngliche, generische "nimm das ERSTE Tag,
 * schneide bei DESSEN schliessendem Tag ab"-Logik traf dabei auf
 * <firmwareVersion> statt auf <sound> und verwarf damit die GESAMTE
 * restliche Datei (<sound> und alles darin) VOR dem Parsen -- jedes Feld
 * las sich danach als "in der Datei fehlend" und fiel auf seinen eigenen
 * Init-Default zurück, für buchstäblich jedes von diesem Modul geprüfte
 * Feld (real gemeldet, live UND file-basiert: "not only for adsr also for
 * noise level... same for all factory presets... loading bod01 patches,
 * everything works"). app.js's eigener Parser (parseDelugeXml() dort) hat
 * genau dieses Problem schon lange gelöst -- dieselbe Lösung hier
 * übernommen, statt sie ein zweites Mal separat zu erfinden: gezielt nach
 * <sound (nicht "irgendein erstes Tag") und dessen EIGENEM schliessenden
 * Tag suchen, per lastIndexOf (nicht die erste Fundstelle danach) genau
 * wie dort.
 */
function extractFirstXmlDocument(xmlText) {
  const start = xmlText.indexOf('<sound');
  const end = xmlText.lastIndexOf('</sound>');
  if (start === -1 || end === -1) return xmlText;
  return xmlText.slice(start, end + '</sound>'.length);
}

/** Parst einen Deluge-Patch-XML-String in ein einfaches JS-Objekt. */
function parseDelugeXml(xmlText) {
  const doc = new DOMParser().parseFromString(extractFirstXmlDocument(xmlText), "application/xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) {
    throw new Error("XML konnte nicht geparst werden: " + errorNode.textContent);
  }
  const obj = elementToObject(doc.documentElement);
  // Same compressor/sidechain tag-name drift handled by app.js's own
  // parseDelugeXml() (older firmware wrote <compressor>, newer <sidechain>,
  // identical attack/release/syncLevel shape) -- normalize here too, since
  // this is an independent parser and buildCheckSteps()'s sidechain fields
  // (path "sidechain.attack" etc.) are resolved against ITS output, not
  // app.js's. Without this, the on-device check would never be able to
  // compare a sidechain value against a target/actual file that used the
  // older tag name.
  if (!obj.sidechain && obj.compressor) obj.sidechain = obj.compressor;
  // Envelope1/2 can appear EITHER as a top-level sibling of <defaultParams>
  // OR nested inside it -- both real, confirmed shapes (see app.js's own
  // envStep()/etc.: "patch.envelope1 || get(dp, 'envelope1')", the exact
  // same defensive fallback, needed for the exact same reason). Every
  // field path in THIS module assumes the nested shape
  // ("defaultParams.envelope1.attack", both FIELD_TO_MIDIFOLLOW_PARAM and
  // buildCheckSteps()'s own env1/env2 fields), so a preset using the
  // top-level shape silently made getValueAtPath() return undefined for
  // its REAL envelope values -- falling through to the "field omitted"
  // init default for BOTH the file-based Check Now flow and MIDI-Follow
  // live tracking (both resolve paths against this same parsed object).
  // Reported directly against real hardware, live: a preset's envelope1
  // read as a false "ok" (green) before any knob was touched (both target
  // and live were silently being compared as "init" against "init"), then
  // flipped to "unexpected" (red, wrong-direction arrows) once correctly
  // dialled in to its real, non-default target (now comparing the real,
  // non-default live value against the same wrongly-init'd "target").
  obj.defaultParams = obj.defaultParams || {};
  if (!obj.defaultParams.envelope1 && obj.envelope1) obj.defaultParams.envelope1 = obj.envelope1;
  if (!obj.defaultParams.envelope2 && obj.envelope2) obj.defaultParams.envelope2 = obj.envelope2;
  // Same pre-June-2017 numeric `polyphonic` drift app.js's own parser
  // normalizes ("0"->auto, "2"->choke, firmware source: util/functions.cpp
  // stringToPolyphonyMode()) -- normalize here too so buildCheckSteps()'s
  // "General"/Polyphony field compares the real name on both sides
  // consistently, not a raw digit that would never match a modern file's
  // own name-based value. Anything else unrecognized (any other digit, a
  // typo, ...) falls through to firmware's own final `else` and resolves
  // to POLY, same as app.js's parser.
  if (obj.polyphonic === '0') obj.polyphonic = 'auto';
  else if (obj.polyphonic === '2') obj.polyphonic = 'choke';
  else if (obj.polyphonic && !['mono', 'auto', 'legato', 'choke', 'poly'].includes(obj.polyphonic)) obj.polyphonic = 'poly';
  return obj;
}

// ---------------------------------------------------------------------
// Referenz: der echte Deluge-Init-Patch (1:1 aus synths/Init.XML), damit
// wir "wurde dieses Feld überhaupt schon angefasst?" mit derselben
// Pfad-Auflösung (getValueAtPath) wie target/actual beantworten können,
// statt eine zweite, von Hand gepflegte Werteliste im Patchbook-eigenen
// Pfadschema nachzubauen.
// ---------------------------------------------------------------------
const INIT_PATCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sound
	firmwareVersion="c1.3.0"
	earliestCompatibleFirmware="4.1.0-alpha"
	polyphonic="poly"
	voicePriority="1"
	mode="subtractive"
	transpose="0"
	cents="0"
	clippingAmount="0"
	modFXType="none"
	lpfMode="24dB"
	hpfMode="HPLadder"
	filterRoute="H2L"
	maxVoices="8">
	<osc1
		type="square"
		transpose="0"
		cents="0"
		retrigPhase="-1" />
	<osc2
		type="square"
		transpose="0"
		cents="0"
		retrigPhase="-1" />
	<modulator1
		transpose="0"
		cents="0"
		retrigPhase="-1" />
	<modulator2
		transpose="0"
		cents="0"
		retrigPhase="-1"
		toModulator1="0" />
	<lfo1 type="triangle" syncLevel="0" syncType="0" />
	<lfo2 type="triangle" syncLevel="0" syncType="0" />
	<lfo3 type="triangle" syncLevel="0" syncType="0" />
	<lfo4 type="triangle" syncLevel="0" syncType="0" />
	<unison num="1" detune="8" spread="0" />
	<defaultParams
		portamento="0x80000000"
		compressorShape="0xDC28F5B2"
		oscAVolume="0x7FFFFFFF"
		oscAPulseWidth="0x00000000"
		oscAWavetablePosition="0x00000000"
		oscBVolume="0x80000000"
		oscBPulseWidth="0x00000000"
		oscBWavetablePosition="0x00000000"
		noiseVolume="0x80000000"
		volume="0x4CCCCCA8"
		pan="0x00000000"
		lpfFrequency="0x7FFFFFFF"
		lpfResonance="0x80000000"
		hpfFrequency="0x80000000"
		hpfResonance="0x80000000"
		lfo1Rate="0x1999997E"
		lfo2Rate="0x00000000"
		lfo3Rate="0x1999997E"
		lfo4Rate="0x00000000"
		modulator1Amount="0x80000000"
		modulator1Feedback="0x80000000"
		modulator2Amount="0x80000000"
		modulator2Feedback="0x80000000"
		carrier1Feedback="0x80000000"
		carrier2Feedback="0x80000000"
		modFXRate="0x00000000"
		modFXDepth="0x00000000"
		delayRate="0x00000000"
		delayFeedback="0x80000000"
		reverbAmount="0x80000000"
		arpeggiatorRate="0x00000000"
		stutterRate="0x00000000"
		sampleRateReduction="0x80000000"
		bitCrush="0x80000000"
		modFXOffset="0x00000000"
		modFXFeedback="0x00000000"
		compressorThreshold="0x00000000"
		arpeggiatorGate="0x00000000"
		noteProbability="0x7FFFFFFF"
		bassProbability="0x80000000"
		swapProbability="0x80000000"
		glideProbability="0x80000000"
		reverseProbability="0x80000000"
		chordProbability="0x80000000"
		ratchetProbability="0x80000000"
		ratchetAmount="0x80000000"
		sequenceLength="0x80000000"
		chordPolyphony="0x80000000"
		rhythm="0x80000000"
		spreadVelocity="0x80000000"
		spreadGate="0x80000000"
		spreadOctave="0x80000000"
		lpfMorph="0x80000000"
		hpfMorph="0x80000000"
		waveFold="0x80000000">
		<envelope1
			attack="0x80000000"
			decay="0xE6666654"
			sustain="0x7FFFFFFF"
			release="0x80000000" />
		<envelope2
			attack="0xE6666654"
			decay="0xE6666654"
			sustain="0xFFFFFFE9"
			release="0xE6666654" />
		<envelope3
			attack="0x00000000"
			decay="0x00000000"
			sustain="0x00000000"
			release="0x00000000" />
		<envelope4
			attack="0x00000000"
			decay="0x00000000"
			sustain="0x00000000"
			release="0x00000000" />
		<patchCables>
			<patchCable
				source="velocity"
				destination="volume"
				polarity="unipolar"
				amount="0x3FFFFFE8" />
			<patchCable
				source="aftertouch"
				destination="volume"
				polarity="unipolar"
				amount="0x2A3D7094" />
			<patchCable
				source="y"
				destination="lpfFrequency"
				polarity="bipolar"
				amount="0x19999990" />
		</patchCables>
		<equalizer
			bass="0x00000000"
			treble="0x00000000"
			bassFrequency="0x00000000"
			trebleFrequency="0x00000000" />
	</defaultParams>
	<arpeggiator
		mode="off"
		syncLevel="7"
		numOctaves="2"
		syncType="0"
		arpMode="off"
		chordType="0"
		noteMode="up"
		octaveMode="up"
		mpeVelocity="off"
		stepRepeat="1"
		randomizerLock="0"
		kitArp="1"
		notePattern="000002000003000603020900010D0803" />
	<modKnobs>
		<modKnob controlsParam="pan" />
		<modKnob controlsParam="volumePostFX" />
		<modKnob controlsParam="lpfResonance" />
		<modKnob controlsParam="lpfFrequency" />
		<modKnob controlsParam="env1Release" />
		<modKnob controlsParam="env1Attack" />
		<modKnob controlsParam="delayFeedback" />
		<modKnob controlsParam="delayRate" />
		<modKnob controlsParam="reverbAmount" />
		<modKnob controlsParam="volumePostReverbSend" patchAmountFromSource="compressor" />
		<modKnob controlsParam="pitch" patchAmountFromSource="lfo1" />
		<modKnob controlsParam="lfo1Rate" />
		<modKnob controlsParam="portamento" />
		<modKnob controlsParam="stutterRate" />
		<modKnob controlsParam="bitcrushAmount" />
		<modKnob controlsParam="sampleRateReduction" />
	</modKnobs>
	<midiOutput
		channel="255"
		noteForDrum="255" />
	<delay
		pingPong="1"
		analog="0"
		syncLevel="7"
		syncType="0" />
	<sidechain
		attack="327244"
		release="936"
		syncLevel="6"
		syncType="0" />
	<audioCompressor
		attack="83886080"
		release="83886080"
		thresh="0"
		ratio="1073741824"
		compHPF="0"
		compBlend="2147483647" />
	<stutter
		quantized="1"
		reverse="0"
		pingPong="0" />
</sound>`;

let _initPatchObj = null;
/** Der geparste Init-Patch, nur einmal geparst und dann zwischengespeichert. */
function getInitPatchObj() {
  if (!_initPatchObj) _initPatchObj = parseDelugeXml(INIT_PATCH_XML);
  return _initPatchObj;
}

// ---------------------------------------------------------------------
// Pfad-Auflösung ("oscillators.oscA.type", "envelopes[0].attack", ...)
// ---------------------------------------------------------------------

/**
 * Liest einen Wert aus einem geparsten Patch-Objekt anhand eines
 * Punkt-/Klammer-Pfads. Gibt undefined zurück, wenn der Pfad nicht
 * existiert (z.B. weil der Patch das Feld gar nicht gesetzt hat).
 */
function getValueAtPath(obj, path) {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// ---------------------------------------------------------------------
// Patch-Cables: eine Liste statt eines festen Pfads (siehe cableField()
// in app.js) -- Zugriff daher über "finde den Eintrag mit diesem
// source/destination", nicht über getValueAtPath().
// ---------------------------------------------------------------------

/** Normalisiert patchCables.patchCable auf ein Array (kann 0, 1 oder N sein). */
function getPatchCables(obj) {
  const raw = getValueAtPath(obj, "defaultParams.patchCables.patchCable");
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function findCable(obj, source, destination) {
  return getPatchCables(obj).find((c) => c && c.source === source && c.destination === destination) || null;
}

/**
 * Findet die EINE Cable mit source===depthSource, die die eigene
 * Modulationstiefe der (source,destination)-Cable ihrerseits moduliert
 * ("double mod") -- unabhängig davon, welche der zwei real vorkommenden
 * XML-Formen benutzt wird (siehe app.js' cablesOf() für die volle
 * Herleitung, hier dieselbe Logik dupliziert, da dieses Modul seinen
 * eigenen, unabhängigen Parser hat):
 *  - Modern (Firmware >=3.2.0): verschachtelt, <patchCable ...>
 *    <depthControlledBy><patchCable source="..." amount="..."/>
 *    ...(kann MEHR ALS EINE enthalten!)...</depthControlledBy>
 *    </patchCable>.
 *  - Legacy (nie neu gespeicherter alter Preset): flach, eine oder mehrere
 *    eigenständige <patchCable source="X" destination="range" amount="Y" />,
 *    deren Ziel NICHT über die Reihenfolge im File aufgelöst wird, sondern
 *    global: erst wird die GANZE Cable-Liste durchsucht nach der (letzten)
 *    mit rangeAdjustable="1" markierten Cable, danach wird JEDE
 *    "range"-Cable (egal ob davor oder danach im File) dieser einen Cable
 *    zugeordnet -- exakt das Verhalten des Firmware-eigenen Readers
 *    (readPatchCablesFromFile() liest zuerst alles ein, löst erst danach in
 *    einem separaten Schritt auf). Auf einem echten Gerätepreset
 *    (Bod01_06-Roygbass.XML) kommt die "range"-Cable tatsächlich VOR ihrer
 *    eigenen rangeAdjustable-Markierung im File -- eine erste Version dieser
 *    Funktion nahm die umgekehrte Reihenfolge an und übersah das dadurch.
 *
 * MEHRFACH-MOD: ein anderer echter Preset (BOC01/BOD01_49-From the
 * distance.XML) hat ZWEI "range"-Cables (source=lfo1 UND source=random),
 * die beide auf dieselbe rangeAdjustable-Cable zeigen -- d.h. eine Cable
 * kann von mehr als einer zweiten Quelle gleichzeitig moduliert werden.
 * `depthSource` wählt genau diese eine aus; eine frühere Version dieser
 * Funktion nahm implizit "höchstens eine" an und hätte hier stillschweigend
 * nur die zuletzt gefundene zurückgegeben.
 */
function resolveDepthModulatorCable(obj, source, destination, depthSource) {
  const cables = getPatchCables(obj);
  const outer = cables.find((c) => c && c.source === source && c.destination === destination);
  if (outer) {
    const innerRaw = outer.depthControlledBy && outer.depthControlledBy.patchCable;
    const innerList = innerRaw ? (Array.isArray(innerRaw) ? innerRaw : [innerRaw]) : [];
    const match = innerList.find((i) => i && i.source === depthSource);
    if (match) return match;
  }
  let rangeAdjustableTarget = null;
  for (const c of cables) {
    if (c && c.source && c.destination && c.destination !== "range" && c.rangeAdjustable && c.rangeAdjustable !== "0") {
      rangeAdjustableTarget = { source: c.source, destination: c.destination };
    }
  }
  if (rangeAdjustableTarget && rangeAdjustableTarget.source === source && rangeAdjustableTarget.destination === destination) {
    return cables.find((c) => c && c.source === depthSource && c.destination === "range") || null;
  }
  return null;
}

/**
 * Löst ein Feld in {targetValue, actualValue, initValue} auf. Normale
 * Felder gehen über getValueAtPath(); ein `cable`-Feld (siehe cableField()
 * in app.js) sucht statt eines Pfads die passende source/destination in
 * der jeweiligen Cable-Liste. "connect" vergleicht nur, ob die Verbindung
 * überhaupt existiert (String "connected" vs. undefined); "amount"
 * vergleicht die Tiefe der gefundenen Verbindung wie jeden anderen
 * Rohwert.
 */
function resolveFieldValues(field, targetObj, actualObj, initObj) {
  if (field.cable) {
    const { source, destination, mode } = field.cable;
    const t = findCable(targetObj, source, destination);
    const a = findCable(actualObj, source, destination);
    const i = findCable(initObj, source, destination);
    if (mode === "connect") {
      return {
        targetValue: t ? "connected" : undefined,
        actualValue: a ? "connected" : undefined,
        initValue: i ? "connected" : undefined,
      };
    }
    if (mode === "polarity") {
      // Plain string compare (valuesMatch()'s non-numeric fallback) --
      // "bipolar"/"unipolar" was never meant to be numeric. Confirmed
      // real, switchable and AUDIBLE via real-hardware testing; X/Y
      // sources are excluded from ever generating this field at all (see
      // app.js's cableHasPolarity()), since the firmware itself never
      // lets their polarity change.
      //
      // <polarity> is an optional tag -- omitted on any preset saved
      // before it existed (confirmed real: BOD01_06-Roygbass.XML, an
      // older-format device preset, has none on any cable). Firmware's
      // own reader (patch_cable_set.cpp readPatchCablesFromFile()) does
      // NOT treat that as unknown: it starts from a hardcoded BIPOLAR,
      // overridden to UNIPOLAR only for source==aftertouch, then
      // overridden again only if the tag is actually present -- and
      // since the firmware ALWAYS writes the tag back out on save, an
      // "actual" (rebuilt/resaved) file will have it explicitly even
      // when an older-format "target" file doesn't. Backfilling here the
      // same way the firmware itself would have resolved the omitted
      // target tag keeps that comparison meaningful instead of reading
      // as a false mismatch (or a false match via two undefineds).
      const defaultPolarity = (src) => (src === "aftertouch" ? "unipolar" : "bipolar");
      return {
        targetValue: t ? (t.polarity || defaultPolarity(source)) : undefined,
        actualValue: a ? (a.polarity || defaultPolarity(source)) : undefined,
        initValue: i ? (i.polarity || defaultPolarity(source)) : undefined,
      };
    }
    return {
      targetValue: t ? t.amount : undefined,
      actualValue: a ? a.amount : undefined,
      initValue: i ? i.amount : undefined,
    };
  }
  if (field.cableDepth) {
    const { source, destination, depthSource, mode } = field.cableDepth;
    const t = resolveDepthModulatorCable(targetObj, source, destination, depthSource);
    const a = resolveDepthModulatorCable(actualObj, source, destination, depthSource);
    const i = resolveDepthModulatorCable(initObj, source, destination, depthSource);
    if (mode === "polarity") {
      // Same reasoning as field.cable's own "polarity" branch above -- a
      // chained depth modulator is its own cable with its own polarity,
      // independent of the outer connection's, and just as likely to omit
      // an explicit <polarity> tag on an older-format preset.
      const defaultPolarity = (src) => (src === "aftertouch" ? "unipolar" : "bipolar");
      return {
        targetValue: t ? (t.polarity || defaultPolarity(depthSource)) : undefined,
        actualValue: a ? (a.polarity || defaultPolarity(depthSource)) : undefined,
        initValue: i ? (i.polarity || defaultPolarity(depthSource)) : undefined,
      };
    }
    return {
      targetValue: t ? t.amount : undefined,
      actualValue: a ? a.amount : undefined,
      initValue: i ? i.amount : undefined,
    };
  }
  const initValue = getValueAtPath(initObj, field.path);
  let targetValue = getValueAtPath(targetObj, field.path);
  let actualValue = getValueAtPath(actualObj, field.path);
  // BUG FIX: a preset's XML can omit an attribute entirely when it happens
  // to match the firmware's own built-in default (some export/editing
  // tools skip writing default-valued attributes) -- leaving targetValue
  // as undefined in that case meant valuesMatch() compared it as the
  // string "" against every real value, which can never equal init OR any
  // value the user dials in. That field could then never read "ok", no
  // matter what -- it just oscillated between "untouched" (near init) and
  // "changed" (away from it) forever. Falling back to initValue here
  // mirrors what actually happens when the Deluge itself loads such a
  // preset (a missing attribute just means "use the default"), which is
  // also the correct value to check against.
  //
  // SECOND BUG FIX: the exact same omission can equally happen on the
  // *actual* (on-device progress file) side -- the Deluge's own save
  // routine is the same one either file went through, so a device state
  // that happens to sit exactly at the firmware default can omit that
  // attribute too. Only falling back for targetValue (as an earlier
  // version of this function did) meant a field the user had genuinely,
  // correctly matched -- both files omitting the SAME attribute because
  // both are legitimately at the default -- compared a real hex/enum
  // string (target, backfilled from init) against actualValue's bare
  // `undefined`, which can never match. A whole-library sweep against
  // every real preset in synths/ (self-check: read a preset back as if it
  // were its own "device state") found this silently broke roughly a
  // THIRD of all checkable fields across nearly the entire library --
  // exactly the "step doesn't check out even though it's correct on the
  // device" class of report this was found from, and clearly not scoped
  // to any one field.
  if (targetValue === undefined) targetValue = initValue;
  if (actualValue === undefined) actualValue = initValue;
  return { targetValue, actualValue, initValue };
}

// ---------------------------------------------------------------------
// Wertevergleich mit Toleranz
// ---------------------------------------------------------------------

/**
 * Deluge speichert viele Parameter als 32-Bit-Integer (teils hex, teils
 * dezimal, je nach XML-Format). Diese Funktion versucht, einen Rohwert
 * in eine Zahl umzuwandeln; gibt NaN zurück, wenn es kein numerischer
 * Parameter ist (z.B. "saw", "square" bei Oscillator-Typ).
 *
 * An 8-digit hex value here is always the Deluge's signed 32-bit
 * fixed-point encoding for a continuous parameter (0x80000000 = -2^31 ..
 * 0x7FFFFFFF = 2^31-1, same convention app.js's own signed32()/isQ31()
 * use) -- BUG FIX: this used to just parseInt(str, 16) without the sign
 * flip, which reads 0x80000000 as the plain positive integer 2147483648,
 * landing it numerically ADJACENT to 0x7FFFFFFF (2147483647) instead of
 * ~4.3 billion apart, its true distance as opposite ends of the real
 * range. That silently broke valuesMatch() for exactly the pairs most
 * likely to occur in practice -- an init value near one extreme compared
 * against a target near the other -- e.g. it could report a value sitting
 * at its untouched init default as "matching" a target at the opposite
 * extreme, or report a target that's genuinely far from default as
 * "targetIsDefault" (mislabeling a real "changed, not there yet" field as
 * "unexpected" instead).
 */
function parseNumericValue(raw) {
  if (raw === undefined || raw === null) return NaN;
  if (typeof raw === "number") return raw;
  const str = String(raw).trim();
  if (/^0x[0-9a-f]{8}$/i.test(str)) {
    let n = parseInt(str, 16);
    if (n > 0x7fffffff) n -= 0x100000000;
    return n;
  }
  if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16);
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d*\.\d+$/.test(str)) return parseFloat(str);
  return NaN;
}

// Vollständiger Wertebereich eines signed 32-Bit-Parameters, wie ihn die
// Deluge-XML für kontinuierliche Werte nutzt. Toleranzen werden als
// Prozentsatz DIESES Bereichs interpretiert (siehe deluge-check-settings.js).
// ANNAHME — bitte gegenprüfen: falls eure App die Rohwerte bereits auf eine
// 0-50 bzw. 0-127 Anzeige-Skala normalisiert, bevor sie hier ankommen,
// sollte diese Konstante entsprechend angepasst werden (siehe Anleitung).
const RAW_PARAM_RANGE = 0x7fffffff;

/**
 * Der Wert, den das Deluge-Display für einen q31-Parameter tatsächlich
 * zeigt (0-50, dieselbe Formel wie app.js's eigenes dv()/q31Pct()) --
 * NICHT der Rohwert selbst. Ein fester Prozentsatz des vollen Rohbereichs
 * kann NIEMALS gleichzeitig garantieren, dass (a) zwei Rohwerte mit
 * IDENTISCHEM Display-Wert immer als Treffer gelten UND (b) zwei
 * BENACHBARTE Display-Werte immer als Unterschied gelten -- das
 * doppelte Runden (Rohwert -> 0-100 -> 0-50) kann bei einem festen 2%-
 * Toleranzfenster echte, unvermeidbare Lücken von >2% zwischen zwei Werten
 * lassen, die auf dem Gerät (und im Guide-Text) als exakt dieselbe Zahl
 * angezeigt werden. Real bestätigt: Factory/148 Warm 5th Pad.XML, LPF-
 * Resonanz Ziel 0x9C000000 vs. ein Rebuild 0x9EB851E6 -- beide zeigen
 * "6", liegen aber ~2.12% auseinander (Standardtoleranz: 2%). Direkt
 * gemeldet als kritisch ("wie soll dies der user merken? wert deuge und
 * app identisch, feld grün. da ist keine toleranz"). evaluateSteps()
 * nutzt dies als zusätzliches ODER-Kriterium NUR für ungeranged q31-Felder
 * (kein eigenes field.rawRange -- Sync-Level/Unison/etc. haben ihre
 * eigene, bereits korrekt skalierte Toleranz und sind hier nicht
 * betroffen), NIE als Ersatz für den Prozentsatz-Vergleich.
 */
function dvValue(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^0x[0-9a-f]{8}$/i.test(str)) return null;
  let n = parseInt(str, 16);
  if (n > 0x7fffffff) n -= 0x100000000;
  const f = n / 2147483648;
  const pct = Math.round(((f + 1) / 2) * 100);
  return Math.round(pct / 2);
}

// Same idea as dvValue(), but for the handful of "half precision" fields
// (oscillator pulse width -- see app.js's dvHalfPrecision() for the full
// firmware-source explanation of why these use a different raw<->display
// formula) that only ever use the positive half of the raw range.
function dvHalfPrecisionValue(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^0x[0-9a-f]{8}$/i.test(str)) return null;
  let n = parseInt(str, 16);
  if (n > 0x7fffffff) n -= 0x100000000;
  return Math.floor((n * 100 + 2147483648) / 4294967296);
}

/**
 * Vergleicht Ziel- und Ist-Wert. Bei numerischen Werten wird die
 * Toleranz (in Roheinheiten, siehe resolveToleranceAbsolute in
 * deluge-check-settings.js) angewendet. Bei nicht-numerischen Werten
 * (Enums wie Oscillator-Typ) wird exakt (case-insensitive) verglichen.
 */
function valuesMatch(targetRaw, actualRaw, toleranceAbs) {
  const targetNum = parseNumericValue(targetRaw);
  const actualNum = parseNumericValue(actualRaw);

  if (!Number.isNaN(targetNum) && !Number.isNaN(actualNum)) {
    return Math.abs(targetNum - actualNum) <= toleranceAbs;
  }

  // Fallback: String-Vergleich für Enums/Text-Parameter
  const targetStr = targetRaw === undefined ? "" : String(targetRaw).trim().toLowerCase();
  const actualStr = actualRaw === undefined ? "" : String(actualRaw).trim().toLowerCase();
  return targetStr === actualStr;
}

// ---------------------------------------------------------------------
// Step-Auswertung
// ---------------------------------------------------------------------

/**
 * Ein Step sieht so aus (Beispiel Envelope 1 mit 4 Feldern):
 *
 * {
 *   id: "env1",
 *   label: "Envelope 1 (Filter)",
 *   fields: [
 *     { key: "env1.attack",  label: "Attack",  path: "sound.envelope1.attack" },
 *     { key: "env1.decay",   label: "Decay",   path: "sound.envelope1.decay" },
 *     { key: "env1.sustain", label: "Sustain", path: "sound.envelope1.sustain" },
 *     { key: "env1.release", label: "Release", path: "sound.envelope1.release" },
 *   ],
 * }
 *
 * `key` wird für die Toleranz-Overrides in den Settings verwendet
 * (siehe deluge-check-settings.js) — sollte pro Feld eindeutig und
 * stabil sein (nicht bei jeder Neu-Generierung des Patchbooks ändern).
 *
 * `path` muss auf die Struktur passen, die parseDelugeXml() erzeugt.
 * Am einfachsten: dieselben Tag-/Attributnamen verwenden, die der
 * bestehende Patchbook-Step-Generator schon aus der Ziel-XML liest.
 */

/**
 * Ordnet einem Feld eines von vier Status zu (siehe Modul-Kommentar oben
 * für die Bedeutung). `ok` entscheidet zuerst -- ein Feld, das zufällig
 * auf dem Init-Wert steht UND das auch der Ziel-Wert ist, gilt als Match,
 * nicht als "unexpected".
 */
function fieldStatus(ok, targetIsDefault, actualIsDefault) {
  if (targetIsDefault && !actualIsDefault) return "unexpected";
  if (ok) return "ok";
  if (!actualIsDefault) return "changed";
  return "untouched";
}

/**
 * Wertet alle Steps gegen Ziel-, Ist- und Init-Objekt aus. Mutiert die
 * übergebenen Steps NICHT, sondern gibt neue, annotierte Objekte zurück:
 *
 * {
 *   ...step,
 *   complete: boolean,
 *   fields: [ { key, label, ok, status, resetValue? } ]
 * }
 *
 * `key` bleibt drin, damit der Aufrufer (app.js) Feld-Status auf seine
 * eigenen, key-getaggten Guide-Steps zurückmappen kann (siehe ck()/cf() in
 * app.js) -- Roh-Werte (target/actual) werden ansonsten absichtlich NICHT
 * zurückgegeben, siehe Modul-Kommentar oben ("soll nicht vorsagen").
 *
 * EINE gezielte Ausnahme: `resetValue`, nur gesetzt wenn status ===
 * "unexpected". Per Definition (siehe fieldStatus() oben:
 * targetIsDefault && !actualIsDefault) ist targetValue in genau diesem Fall
 * IMMER gleich initValue -- das Feld zeigt also keinen unvollendeten
 * Baufortschritt, sondern etwas, das komplett außerhalb des Ziel-Patches
 * liegt und einfach nur zurückgesetzt gehört. Für so ein Feld existiert oft
 * gar kein Guide-Step, der den nötigen Wert je erwähnt (buildGuide()
 * erzeugt nur für Nicht-Default-Werte Steps) -- "hier ist etwas falsch"
 * ohne "und zwar das" zu sagen, war für den Nutzer nicht aktionabel genug
 * (real gemeldet: "OSC1 cents ist zu generisch, der user muss wissen auf
 * welchen wert er zurückstellen muss"). Kein Spoiler fürs eigentliche
 * Bauen des Patches -- es beschreibt nur den Init-Zustand, den es so oder
 * so schon gäbe, wäre dieses Feld nie angefasst worden.
 *
 * @param {Array} steps
 * @param {object} targetObj  geparster Ziel-Patch (aus dem das Patchbook stammt)
 * @param {object} actualObj  geparste Check-Datei (aktueller Fortschritt)
 * @param {object} settings   siehe deluge-check-settings.js (resolveToleranceAbsolute)
 */
// Same as valuesMatch(), but for a field with no custom rawRange (i.e. a
// plain, full-range q31 parameter meant to be read via the Deluge's own
// 0-50 display, not a small integer like a sync level or unison count
// that already has its own correctly-scaled range) ALSO accepts a match
// whenever both values round to the identical dv() display number -- see
// dvValue()'s own comment for why the percentage tolerance alone can't
// guarantee that on its own.
function matchesWithDisplayFallback(a, b, toleranceAbs, field) {
  if (valuesMatch(a, b, toleranceAbs)) return true;
  if (field.rawRange) return false; // has its own already-correct scale -- not a dv() field
  const da = dvValue(a);
  const db = dvValue(b);
  return da !== null && db !== null && da === db;
}

function evaluateSteps(steps, targetObj, actualObj, settings) {
  const initObj = getInitPatchObj();
  return steps.map((step) => {
    const fields = step.fields.map((field) => {
      const { targetValue, actualValue, initValue } = resolveFieldValues(field, targetObj, actualObj, initObj);
      const toleranceAbs = settings.resolveToleranceAbsolute(field.key, field);
      const ok = matchesWithDisplayFallback(targetValue, actualValue, toleranceAbs, field);
      const targetIsDefault = matchesWithDisplayFallback(targetValue, initValue, toleranceAbs, field);
      const actualIsDefault = matchesWithDisplayFallback(actualValue, initValue, toleranceAbs, field);
      const status = fieldStatus(ok, targetIsDefault, actualIsDefault);
      // `key` doubles as the lookup app.js's ck()/cf() markers use -- for a
      // normal field it's the same string as `path`, for a cable field
      // it's cableField()'s "cable:<mode>:<source>-><destination>".
      return { key: field.key, label: field.label, ok, status, resetValue: status === 'unexpected' ? initValue : undefined };
    });
    const complete = fields.every((f) => f.ok);
    return { ...step, fields, complete };
  });
}

// ---------------------------------------------------------------------
// Haupt-Klasse: verwaltet den Check-Pfad für die laufende Session
// ---------------------------------------------------------------------

class DelugeCheck {
  /** @param {import("./deluge-sysex.js").DelugeSysex} deluge */
  constructor(deluge) {
    this.deluge = deluge;
    // Bewusst NUR im Speicher — kein localStorage. Neue Session => neue Wahl.
    this._checkPath = null;
  }

  hasCheckPath() {
    return this._checkPath !== null;
  }

  getCheckPath() {
    return this._checkPath;
  }

  /** Setzt die Auswahl zurück, z.B. für einen "Andere Datei wählen"-Link. */
  reset() {
    this._checkPath = null;
  }

  /** Listet mögliche Check-Dateien für den Picker (rekursiv unter /SYNTHS). */
  async listCandidateFiles(baseDir = "/SYNTHS") {
    return listXmlFilesRecursive(this.deluge, baseDir);
  }

  /**
   * Stellt sicher, dass ein Check-Pfad vorhanden ist.
   * Ruft den Picker-Callback NUR auf, wenn noch keiner gewählt wurde.
   *
   * @param {(files: {path:string, name:string}[]) => Promise<string|null>} onPickerNeeded
   */
  async ensureCheckPath(onPickerNeeded) {
    if (this._checkPath) return this._checkPath;

    const files = await this.listCandidateFiles();
    if (files.length === 0) {
      throw new Error(
        "Keine XML-Dateien in /SYNTHS gefunden. Bitte zuerst einmal den " +
          "Fortschritts-Patch auf dem Deluge speichern.",
      );
    }

    const chosen = await onPickerNeeded(files);
    if (!chosen) {
      throw new Error("Keine Check-Datei ausgewählt.");
    }
    this._checkPath = chosen;
    return chosen;
  }

  /**
   * Führt den Check durch: liest die Check-Datei vom Deluge, vergleicht
   * sie Step für Step (inkl. Einzelfelder) gegen den Ziel-Patch und gibt
   * annotierte Steps zurück, bereit fürs Abhaken im UI.
   *
   * Zeigt den Picker genau dann (und nur dann), wenn in dieser Session
   * noch kein Check-Pfad gewählt wurde.
   *
   * @param {Array} steps  Patchbook-Steps, siehe Kommentar bei evaluateSteps()
   * @param {string} targetPatchXmlText  XML-Text des Ziel-Patches (aus dem
   *        das Patchbook generiert wurde — i.d.R. schon im State der App)
   * @param {object} settings  aus deluge-check-settings.js
   * @param {(files) => Promise<string|null>} onPickerNeeded
   */
  async runCheck(steps, targetPatchXmlText, settings, onPickerNeeded) {
    const path = await this.ensureCheckPath(onPickerNeeded);

    let buffer;
    try {
      buffer = await this.deluge.readFile(path);
    } catch (err) {
      throw new Error(
        `Check-Datei "${path}" konnte nicht gelesen werden (existiert sie noch auf der SD-Karte?): ${err.message}`,
      );
    }

    const actualXmlText = new TextDecoder().decode(buffer);
    const targetObj = parseDelugeXml(targetPatchXmlText);
    const actualObj = parseDelugeXml(actualXmlText);
    const evaluatedSteps = evaluateSteps(steps, targetObj, actualObj, settings);

    return { path, steps: evaluatedSteps, targetObj, actualObj };
  }
}

return { parseDelugeXml, getValueAtPath, parseNumericValue, RAW_PARAM_RANGE, valuesMatch, dvValue, dvHalfPrecisionValue, evaluateSteps, DelugeCheck };
})();

// ---------------------------------------------------------------------
// Beispiel-Verdrahtung (auskommentiert, zur Orientierung)
// ---------------------------------------------------------------------
//
// import { DelugeSysex } from "./deluge-sysex.js";
// import { DelugeCheck } from "./deluge-check.js";
// import { loadSettings } from "./deluge-check-settings.js";
//
// const deluge = new DelugeSysex();
// const check = new DelugeCheck(deluge);
// const settings = loadSettings();
//
// checkButton.addEventListener("click", async () => {
//   try {
//     const result = await check.runCheck(
//       currentPatchbookSteps,      // aus eurem bestehenden Step-Generator
//       currentTargetPatchXmlText,  // roher XML-Text des geladenen Ziel-Patches
//       settings,
//       async (files) => showFilePickerModal(files), // -> Promise<string|null>
//     );
//     renderPatchbookSteps(result.steps); // Häkchen pro Feld + pro Step
//   } catch (err) {
//     showError(err.message);
//   }
// });
