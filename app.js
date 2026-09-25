// ---------------------------------------------------------------------------
// Optional live-hardware features: Web MIDI/SysEx connection to a real
// Deluge (loading presets straight off its SD card, and checking your
// in-progress rebuild against the target patch). Everything above this
// still works with zero MIDI hardware present -- these modules are only
// touched from inside the button handlers wired near the bottom of this
// file, so a browser/session with no Deluge connected never calls into them.
//
// Loaded as plain classic scripts (modules/*.js, included via <script src>
// in index.html before this file), not ES modules -- this app is designed
// to be opened straight from disk (file://, no server), and Chrome/Edge
// refuse to fetch <script type="module"> from file:// at all (CORS), which
// would otherwise break the whole page, not just this feature.
// ---------------------------------------------------------------------------
const { DelugeSysex } = window.DelugeSysexModule;
const { DelugeCheck } = window.DelugeCheckModule;
const { loadSettings, saveSettings, renderSettingsPanel } = window.DelugeCheckSettingsModule;

// ---------------------------------------------------------------------------
// Deluge XML -> plain JS object
// ---------------------------------------------------------------------------
// Deluge preset XML exists in two shapes depending on firmware age: an old
// "everything is a nested element" style (firmware <3.0) and a newer
// "everything is an attribute" style (firmware >=3.0). This converter folds
// both into the same plain-object shape, so the rest of the app never has to
// care which one it's looking at: <osc1 type="saw"/> and
// <osc1><type>saw</type></osc1> both become { type: "saw" }.
const PLURAL_TAGS = new Set(['sampleRange', 'patchCable', 'modKnob', 'midiKnob']);

function xmlToObj(el) {
  const obj = {};
  for (const a of Array.from(el.attributes || [])) {
    obj[a.name] = a.value;
  }
  const groups = {};
  for (const c of Array.from(el.children)) {
    const tag = c.tagName;
    const value = (c.children.length === 0 && c.attributes.length === 0)
      ? c.textContent.trim()
      : xmlToObj(c);
    (groups[tag] = groups[tag] || []).push(value);
  }
  for (const [tag, arr] of Object.entries(groups)) {
    obj[tag] = PLURAL_TAGS.has(tag) ? arr : (arr.length === 1 ? arr[0] : arr);
  }
  return obj;
}

// A handful of real-world preset files carry isolated byte-level corruption
// in one attribute value (a stray literal '<', or a doubled closing '"') --
// almost certainly a firmware or SD-card write glitch, not anything to do
// with the sound design itself (observed e.g. in BOC01's "Reversed tones"
// presets, on the unrelated hpfMode/lpfMode attribute, not on the FM
// modulator chaining). A strict parser rejects the whole file over that one
// byte, discarding an otherwise-intact preset, so a failed parse gets one
// retry after these two narrowly-scoped, attribute-value-only repairs.
function repairXmlFragment(fragment) {
  return fragment
    .replace(/="([^"]*)""/g, '="$1"')
    .replace(/="([^"]*)"/g, (m, val) => `="${val.replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`);
}
// The only 5 valid modern polyphonic-mode strings (firmware source,
// util/functions.cpp's polyphonyModeToString()) -- anything else (a stray
// digit, a typo, ...) firmware's own stringToPolyphonyMode() silently
// resolves to POLY via its final `else` (aside from "0"/"2", its two
// documented pre-June-2017 numeric special cases, handled separately).
const VALID_POLYPHONIC_MODES = new Set(['mono', 'auto', 'legato', 'choke', 'poly']);
function parseDelugeXml(xmlText) {
  // Older Deluge firmware (<3.0) writes <firmwareVersion> and <sound> as
  // sibling top-level elements, which is not well-formed XML (a document can
  // only have one root). Rather than parse the whole document, slice out just
  // the <sound>...</sound> fragment, which is always well-formed on its own.
  const start = xmlText.indexOf('<sound');
  const end = xmlText.lastIndexOf('</sound>');
  const fragment = (start !== -1 && end !== -1) ? xmlText.slice(start, end + '</sound>'.length) : xmlText;
  let doc = new DOMParser().parseFromString(fragment, 'application/xml');
  let soundEl = doc.querySelector('sound');
  if (!soundEl || doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(repairXmlFragment(fragment), 'application/xml');
    soundEl = doc.querySelector('sound');
    if (!soundEl || doc.querySelector('parsererror')) return null;
  }
  const sound = xmlToObj(soundEl);
  if (!sound.firmwareVersion) {
    const fwMatch = xmlText.match(/<firmwareVersion>([^<]*)<\/firmwareVersion>/);
    if (fwMatch) sound.firmwareVersion = fwMatch[1].trim();
  }
  // Older firmware wrote the sidechain compressor's own element as
  // <compressor attack=... release=... syncLevel=... />; newer firmware
  // renamed it to <sidechain ...> with the identical attribute shape (same
  // naming drift already handled for patch-cable sources, see the comment
  // above SOURCE_LABEL). ~1500 of the ~2050 real presets in synths/ use the
  // older tag -- normalize here, once, so every consumer of `sound.sidechain`
  // (buildGuide, buildSignalPathSvg, the library filter, ...) sees it
  // regardless of which tag name this particular file used, instead of
  // each needing its own fallback.
  if (!sound.sidechain && sound.compressor) sound.sidechain = sound.compressor;
  // Firmware pre-June-2017 wrote `polyphonic` as a raw numeric string
  // ("0"=auto, "2"=choke) instead of the modern name ("auto"/"poly"/
  // "mono"/"legato"/"choke") -- confirmed via firmware source
  // (util/functions.cpp's stringToPolyphonyMode(), both cases explicitly
  // commented "Old firmware, pre June 2017") and against 8 real, unmodified
  // Factory presets that still carry it (e.g. "080 House.XML"). Left
  // un-normalized, the guide/check would show/compare the literal digit
  // ("Polyphony: 0"), not a name the SELECT knob's menu actually has.
  // Reported directly ("SHIFT+POLYPHONY, turn SELECT to 1."): firmware's
  // own stringToPolyphonyMode() only special-cases "0" and "2" -- EVERY
  // other unrecognized string (any other digit, a typo, ...) falls through
  // to its final `else` and resolves to POLY, not left as the raw digit.
  // "1" specifically was never a documented old numeric code for anything;
  // it just happens to hit that same catch-all default.
  if (sound.polyphonic === '0') sound.polyphonic = 'auto';
  else if (sound.polyphonic === '2') sound.polyphonic = 'choke';
  else if (sound.polyphonic && !VALID_POLYPHONIC_MODES.has(sound.polyphonic)) sound.polyphonic = 'poly';
  return sound;
}

// ---------------------------------------------------------------------------
// Q31 fixed-point decoding, and the real Deluge on-screen display scales.
// ---------------------------------------------------------------------------
// Deluge stores most continuous parameters as signed 32-bit fixed point
// covering the range [-1, +1) (0x80000000 = -1, 0x00000000 = 0,
// 0x7FFFFFFF = ~+1). q31Pct is only an internal 0-100 proxy used for
// diffing against init; the dv*() functions below are what the Deluge's own
// screen actually shows, verified against firmware source
// (SynthstromAudible/DelugeFirmware, src/definitions_cxx.hpp and
// src/deluge/gui/menu_item/value_scaling.cpp / patch_cable_strength.cpp):
//   - regular params:      0 to 50        (kMaxMenuValue)
//   - pan & pitch only:    -25 to +25     (kMin/MaxMenuRelativeValue)
//   - patch cable depth:   -5000 to +5000, decoded from a DIFFERENT internal
//                          full-scale (+-2^30, not +-2^31) -- confirmed by
//                          patch_cable_strength.cpp's `>> 30` (not `>> 32`).
function isQ31(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{8}$/.test(v);
}
function signed32(v) {
  if (!isQ31(v)) return null;
  let n = parseInt(v, 16);
  if (n > 0x7fffffff) n -= 0x100000000;
  return n;
}
function decodeQ31(v) {
  const n = signed32(v);
  return n === null ? null : n / 2147483648;
}
function q31Pct(v) {
  const f = decodeQ31(v);
  if (f === null) return null;
  return Math.round(((f + 1) / 2) * 100);
}
// Expert-mode display: the raw signed internal value as a percentage
// (-100% to 100%), not remapped to the Deluge's own 0-100%-of-its-0-50-dial
// convention that q31Pct/dv use -- so direction/sign is always visible.
function rawPct(v) {
  const f = decodeQ31(v);
  return f === null ? null : Math.round(f * 100);
}
function q31Differs(a, b, epsPct = 3) {
  const pa = q31Pct(a), pb = q31Pct(b);
  if (pa === null || pb === null) return a !== b;
  return Math.abs(pa - pb) > epsPct;
}
// Deluge-displayed value for a standard (unipolar) parameter: 0-50.
function dv(v) {
  const p = q31Pct(v);
  return p === null ? null : Math.round(p / 2);
}
// Deluge-displayed value for pan/pitch only: -25 to +25.
function dvPan(v) {
  const f = decodeQ31(v);
  return f === null ? null : Math.round(f * 25);
}
// A small number of params use a DIFFERENT raw<->display conversion than
// every other 0-50 knob: oscillator pulse width and the (not yet exposed
// in this app) audio-compressor attack/release/threshold/ratio params
// (firmware: gui/menu_item/osc/pulse_width.h, audio_compressor/
// compressor_params.h -- both override readCurrentValue()/getFinalValue()
// with computeCurrentValueForHalfPrecisionMenuItem()/
// computeFinalValueForHalfPrecisionMenuItem(), NOT the standard
// computeCurrentValueForStandardMenuItem() every other unipolar param
// uses). CONFIRMED, bit-exact, via a real device's own file-format
// migration: resaving BOD01_06-Roygbass.XML in the newer format (same
// sound, untouched by the user) changed oscAPulseWidth's raw from
// 0x547AE138 to 0x51EB8500 -- and computeFinalValueForHalfPrecisionMenuItem
// (the firmware's OWN menu-value-to-raw formula, reimplemented below as the
// inverse check) applied to 33 gives EXACTLY 0x547AE138, zero rounding
// error, while applied to 32 gives 0x51EB8510 (16 off, negligible) -- i.e.
// the real device internally treats that original raw as displaying "33",
// shifts to "32" purely from the resave's own rounding, and never touches
// "41" (what dv()'s standard formula reads it as) at any point. An earlier,
// less conclusive real-hardware test (cross-checked only via MIDI CC, which
// follows the STANDARD 0-50<->0-127 scale regardless of which formula
// governs the underlying raw value, so it couldn't actually discriminate
// between the two hypotheses) had briefly pointed the other way and led to
// a wrong revert to dv()/rawPct() for this field -- superseded by this
// exact-match evidence. "Half precision" means the raw value only ever
// uses the POSITIVE half of the full signed 32-bit range to represent the
// full 0-50 display scale (firmware's own pulse_width.h comment: "osc pulse
// width ... aren't set up for negative inputs") -- using dv()'s FULL-range
// assumption on that half-range value reads it as roughly 8-10 units higher
// than what the device itself shows.
function dvHalfPrecision(v) {
  const n = signed32(v);
  if (n === null) return null;
  return Math.floor((n * 100 + 2147483648) / 4294967296);
}
function pctHalfPrecision(v) {
  const d = dvHalfPrecision(v);
  return d === null ? null : Math.round((d / 50) * 100);
}
// Deluge-displayed modulation depth for a patch cable: -50.00 to +50.00.
// PatchCableStrength is a Decimal menu item with an internal range of
// -5000..+5000 (kMin/MaxMenuPatchCableValue) but getNumDecimalPlaces()==2,
// so the actual on-screen number is that internal value / 100.
function dvCable(v) {
  const n = signed32(v);
  if (n === null) return null;
  const internal = Math.max(-5000, Math.min(5000, Math.round((n * 5000) / 1073741824)));
  return internal / 100;
}
function fmtCable(v) {
  const d = dvCable(v);
  return d === null ? '' : d.toFixed(2);
}
// Percentage-of-max, used only in expert-mode text, computed from the
// correct display scale for whichever kind of value this is (so pan/cable
// aren't just the old, wrong 0-100%-of-2^31 mapping).
function pctOfCable(v) { const d = dvCable(v); return d === null ? null : Math.round((d / 50) * 100); }
function pctOfPan(v) { const d = dvPan(v); return d === null ? null : Math.round((d / 25) * 100); }
function plainDiffers(a, b) {
  if (a === undefined || a === null) return false;
  return String(a) !== String(b);
}
function get(obj, path, fallback) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

// ---------------------------------------------------------------------------
// "Init preset" reference values.
// ---------------------------------------------------------------------------
// Taken directly from synths/Init.XML (the real Deluge init patch), not
// guessed. Used only to decide whether a step is worth showing -- a preset
// that never touched a parameter shouldn't get a step telling the user to
// set it to its own default.
const INIT = {
  polyphonic: 'poly',
  mode: 'subtractive',
  oscAVolume: '0x7FFFFFFF',
  oscBVolume: '0x80000000',
  oscAPulseWidth: '0x00000000',
  oscBPulseWidth: '0x00000000',
  noiseVolume: '0x80000000',
  // The overall voice's own output level (DEST_SHORTCUT calls its shortcut
  // pad "LEVEL") -- distinct from oscAVolume/oscBVolume (the two
  // oscillators' own MIX balance). Found completely uncovered anywhere in
  // this app via a direct diff against a real target/actual pair
  // (BOD01_06-Roygbass.XML vs. the rebuilt Patchbook.XML): the real target
  // wanted this at roughly 19% of range, the rebuild was still sitting at
  // this exact init default (~60%) because nothing ever asked for it to be
  // touched -- about as large and audible a gain-staging gap as this guide
  // could have, and it went completely unmentioned.
  volume: '0x4CCCCCA8',
  pan: '0x00000000',
  lpfFrequency: '0x7FFFFFFF',
  lpfResonance: '0x80000000',
  hpfFrequency: '0x80000000',
  hpfResonance: '0x80000000',
  lpfMode: '24dB',
  hpfMode: 'HPLadder',
  filterRoute: 'H2L',
  env1: { attack: '0x80000000', decay: '0xE6666654', sustain: '0x7FFFFFFF', release: '0x80000000' },
  env2: { attack: '0xE6666654', decay: '0xE6666654', sustain: '0xFFFFFFE9', release: '0xE6666654' },
  lfo1Rate: '0x1999997E',
  lfo2Rate: '0x00000000',
  modFXType: 'none',
  modFXOffset: '0x00000000',
  modFXFeedback: '0x00000000',
  delayRate: '0x00000000',
  delayFeedback: '0x80000000',
  delaySyncLevel: '7',
  // Confirmed via a real-corpus scan (~2053 files): 1663 have pingPong="1"
  // vs only 99 with "0" -- ping-pong ON is the true, overwhelmingly common
  // firmware default (matches deluge-check.js's own INIT_PATCH_XML
  // fixture), not "0"/off as the naive on/off flag reading below used to
  // assume.
  delayPingPong: '1',
  reverbAmount: '0x80000000',
  arpMode: 'off',
  arpeggiatorRate: '0x00000000',
  arpeggiatorGate: '0x00000000',
  arpSyncLevel: '7',
  arpNumOctaves: '2',
  modulatorAmount: '0x80000000',
  clippingAmount: '0',
  bitCrush: '0x80000000',
  sampleRateReduction: '0x80000000',
  waveFold: '0x80000000',
  portamento: '0x80000000',
  unisonDetune: '8',
  sidechain: { attack: '327244', release: '936', syncLevel: '6' },
  audioCompressor: { attack: '83886080', release: '83886080', thresh: '0', ratio: '1073741824' },
};

// The init patch itself already ships 3 baked-in modulation routings, so
// every untouched preset carries them too -- they shouldn't be presented as
// a deliberate custom choice unless their depth OR polarity was actually
// changed. Polarity added after real-hardware testing confirmed a real,
// audible bug: velocity->volume's own AMOUNT matching init made
// cableIsDefault() skip it entirely -- no step, no check field at all --
// even though its POLARITY (bipolar vs unipolar, see cableHasPolarity()'s
// own comment) genuinely differed from the target. A cable's amount
// matching its init default no longer means "nothing to check here" if
// its polarity doesn't also match.
const INIT_CABLES = [
  { source: 'velocity', destination: 'volume', amount: '0x3FFFFFE8', polarity: 'unipolar' },
  { source: 'aftertouch', destination: 'volume', amount: '0x2A3D7094', polarity: 'unipolar' },
  { source: 'y', destination: 'lpfFrequency', amount: '0x19999990', polarity: 'bipolar' },
];
function cableIsDefault(c) {
  const ref = INIT_CABLES.find(d => d.source === c.source && d.destination === c.destination);
  if (!ref) return false;
  if (q31Differs(c.amount, ref.amount, 5)) return false;
  if (cableHasPolarity(c.source) && c.polarity && c.polarity !== ref.polarity) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Library category sniffing (for the preset-list filter chips).
// ---------------------------------------------------------------------------
// Cheap, regex-only sniff of a preset's RAW XML text for the handful of
// flags the library filter chips need -- deliberately not a full DOMParser +
// xmlToObj() pass (that's parseDelugeXml(), reserved for when a preset is
// actually opened): with ~2000 tiny files in a real synths folder, running
// the full parse on every one just to read a few attributes at load time
// would multiply ingestFiles()'s work for information the guide itself only
// ever needs once, lazily, for whichever single preset gets selected.
//
// Deluge preset XML ships in two shapes depending on firmware age (see the
// big comment above xmlToObj()): newer firmware writes everything as
// attributes (`<osc1 type="sample" .../>`), older firmware nests everything
// as child elements (`<osc1><type>sample</type></osc1>`). Verified against
// the real ~2000-preset library at ../synths (both shapes are common -- 1761
// presets use attribute-style <unison num="n"/>, 291 use nested
// <unison><num>n</num></unison>), so every check below handles both.
//
// Engine mode: real preset XML uses `mode="fm"`/`mode="ringmod"` (or the
// nested `<mode>fm</mode>`/`<mode>ringmod</mode>`) ONLY for the top-level
// engine attribute and the arpeggiator's mode (off/up/down/both/random) --
// two completely disjoint value sets, so it's safe to search the whole file
// for either value without having to scope the match to <sound>'s own
// attributes first.
function sniffEngineMode(text) {
  // NOTE: no trailing \b after the closing quote -- the character right
  // after it in real XML is always whitespace, "/" or ">" (all non-word),
  // so a trailing \b there would never match anything and silently miss
  // every attribute-style file (caught in testing against the real
  // library: it undercounted fm/ringmod to exactly the nested-style-only
  // counts, 68/14, instead of the true 133/66 combined total).
  if (/\bmode="fm"/.test(text) || /<mode>fm<\/mode>/.test(text)) return 'fm';
  if (/\bmode="ringmod"/.test(text) || /<mode>ringmod<\/mode>/.test(text)) return 'ringmod';
  return 'subtractive'; // also the correct default when the attribute is absent entirely
}
// Oscillator source: multisample (a <sampleRanges> block under osc1/osc2,
// however many zones it holds -- the tag itself always appears right after
// the oscillator opens, even when the zone list runs long) beats single
// sample (osc.type="sample" with no sampleRanges) beats synthesized
// waveform, the common case. "Sample"/"multisample" here mean EITHER
// oscillator uses one, not just OSC1 -- the more useful framing for a
// library filter than tracking OSC1/OSC2 separately (a preset with OSC1 a
// waveform and OSC2 a sample is vanishingly rare in the real library, and
// still surfaces correctly as "sample" under this definition).
function sniffOscSource(text) {
  if (/<sampleRanges\b/.test(text)) return 'multisample';
  // Same no-trailing-\b lesson as sniffEngineMode() above.
  if (/<osc[12]\b[^>]*\btype="sample"/.test(text)) return 'sample';
  const nestedOscRe = /<osc[12]>([\s\S]*?)<\/osc[12]>/g;
  let m;
  while ((m = nestedOscRe.exec(text))) {
    if (/<type>sample<\/type>/.test(m[1])) return 'sample';
  }
  return 'waveform';
}
// Unison: >1 voice. Mirrors the exact gate buildGuide() uses to decide
// whether to show a "Stack voices" step (`patch.unison && parseInt(uni.num,
// 10) > 1`) so the filter can't drift from what the guide itself would say.
function sniffUnisonVoices(text) {
  const attrMatch = text.match(/<unison\b[^>]*\bnum="(\d+)"/);
  if (attrMatch) return parseInt(attrMatch[1], 10);
  const blockMatch = text.match(/<unison>([\s\S]*?)<\/unison>/);
  if (blockMatch) {
    const numMatch = blockMatch[1].match(/<num>(\d+)<\/num>/);
    if (numMatch) return parseInt(numMatch[1], 10);
  }
  return 1;
}
// Arpeggiator: mode !== "off". Mirrors buildGuide()'s own gate
// (`arp && arp.mode && arp.mode !== 'off'`) for the same reason as above.
// Scoped to the <arpeggiator>...</arpeggiator> block itself (rather than
// searching the whole file for a bare mode value) since that's the only way
// to tell its mode apart from the engine's own mode attribute using a cheap
// regex -- see sniffEngineMode()'s comment on why the two value sets happen
// to be disjoint, which is what makes even that shortcut safe.
function sniffHasArp(text) {
  const attrMatch = text.match(/<arpeggiator\b[^>]*\bmode="([a-zA-Z]+)"/);
  if (attrMatch) return attrMatch[1] !== 'off';
  const blockMatch = text.match(/<arpeggiator>([\s\S]*?)<\/arpeggiator>/);
  if (blockMatch) {
    const modeMatch = blockMatch[1].match(/<mode>([a-zA-Z]+)<\/mode>/);
    if (modeMatch) return modeMatch[1] !== 'off';
  }
  return false;
}
// Patch cables: reuses the real cableIsDefault() predicate (not a
// reimplementation of it) against cheaply-extracted {source, destination,
// amount} triples, so "has custom cables" can never drift from what the mod
// matrix / guide already call a non-default routing.
function sniffCables(text) {
  const cables = [];
  const attrRe = /<patchCable\b([^>]*)\/?>/g;
  let m;
  while ((m = attrRe.exec(text))) {
    const attrs = m[1];
    const source = (attrs.match(/\bsource="([^"]*)"/) || [])[1];
    const destination = (attrs.match(/\bdestination="([^"]*)"/) || [])[1];
    const amount = (attrs.match(/\bamount="([^"]*)"/) || [])[1];
    if (source && destination) cables.push({ source, destination, amount });
  }
  const nestedRe = /<patchCable>([\s\S]*?)<\/patchCable>/g;
  while ((m = nestedRe.exec(text))) {
    const block = m[1];
    const source = (block.match(/<source>([^<]*)<\/source>/) || [])[1];
    const destination = (block.match(/<destination>([^<]*)<\/destination>/) || [])[1];
    const amount = (block.match(/<amount>([^<]*)<\/amount>/) || [])[1];
    if (source && destination) cables.push({ source, destination, amount });
  }
  return cables;
}
function sniffHasCables(text) {
  return sniffCables(text).some(c => !cableIsDefault(c));
}
// Sidechain compressor: mirrors buildGuide()'s own gate exactly
// (`sc && (attack/release/syncLevel any differ from INIT.sidechain)`).
// Tries the newer <sidechain> tag first, then the older <compressor> tag
// (same element, renamed -- see parseDelugeXml()'s sound.compressor ->
// sound.sidechain aliasing and the big comment above SOURCE_LABEL on the
// same drift for patch-cable sources); ~1500 of the ~2050 real presets in
// synths/ use the older name, so skipping this fallback would make the
// Sidechain filter chip miss almost every real match.
function sniffSidechain(text) {
  function readAttrs(tagName) {
    let attack, release, syncLevel;
    let m = text.match(new RegExp(`<${tagName}\\b([^>]*)/?>`));
    if (m) {
      const attrs = m[1];
      attack = (attrs.match(/\battack="([^"]*)"/) || [])[1];
      release = (attrs.match(/\brelease="([^"]*)"/) || [])[1];
      syncLevel = (attrs.match(/\bsyncLevel="([^"]*)"/) || [])[1];
    }
    if (attack === undefined && release === undefined && syncLevel === undefined) {
      m = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
      if (m) {
        attack = (m[1].match(/<attack>([^<]*)<\/attack>/) || [])[1];
        release = (m[1].match(/<release>([^<]*)<\/release>/) || [])[1];
        syncLevel = (m[1].match(/<syncLevel>([^<]*)<\/syncLevel>/) || [])[1];
      }
    }
    return { attack, release, syncLevel };
  }
  let { attack, release, syncLevel } = readAttrs('sidechain');
  if (attack === undefined && release === undefined && syncLevel === undefined) {
    ({ attack, release, syncLevel } = readAttrs('compressor'));
  }
  if (attack === undefined && release === undefined && syncLevel === undefined) return false;
  return plainDiffers(attack, INIT.sidechain.attack) || plainDiffers(release, INIT.sidechain.release) || plainDiffers(syncLevel, INIT.sidechain.syncLevel);
}
// Full sniff, used by ingestFiles() (and anywhere else a local library item
// gets built from a fully-read file -- see the "Load from Deluge" handler
// near the bottom of this file). `partial` is set by the (experimental,
// device-side) partial-read categorizer below to signal that hasArp/
// hasCables/hasSidechain could not be determined from a short read and
// should be treated as "unknown" (false) rather than a confident "no".
function sniffCategories(text, { partial = false } = {}) {
  return {
    engine: sniffEngineMode(text),
    oscSource: sniffOscSource(text),
    hasUnison: sniffUnisonVoices(text) > 1,
    hasArp: partial ? false : sniffHasArp(text),
    hasCables: partial ? false : sniffHasCables(text),
    hasSidechain: partial ? false : sniffSidechain(text),
    partial,
  };
}
// Does this item's sniffed categories satisfy the currently-selected filter
// chips? Category-less items (categories == null, e.g. a device-browser
// entry never categorized) always pass -- filters only ever narrow what's
// already known, never hide the unknown.
function presetMatchesFilters(categories, filters) {
  if (!categories) return true;
  if (filters.engine !== 'all' && categories.engine !== filters.engine) return false;
  if (filters.oscSource !== 'all' && categories.oscSource !== filters.oscSource) return false;
  if (filters.hasArp && !categories.hasArp) return false;
  if (filters.hasUnison && !categories.hasUnison) return false;
  if (filters.hasCables && !categories.hasCables) return false;
  if (filters.hasSidechain && !categories.hasSidechain) return false;
  return true;
}

// Source pad labels straight from the Deluge manual's "Modulation Source
// Shortcuts" grid (sec 6.1). A mod connection is made by [SHIFT]+dest pad,
// then [SHIFT]+source pad (same manual section).
// NOTE: real preset XML never actually uses source="sidechain" for a patch
// cable -- the sidechain compressor's cable-source attribute is "compressor"
// (verified against ~2000 real presets: 212 use source="compressor", zero
// use source="sidechain"). Both keys are mapped to the same label/pad name
// ("SIDECHAIN", manual sec 6.1: "SIDECHAIN. Compressor patchable to
// anything.") so a cable sourced from the compressor doesn't fall through to
// the generic humanize() fallback and render a "SHIFT+COMPRESSOR" shortcut
// that doesn't exist on the grid.
const SOURCE_LABEL = { velocity: 'VELOCITY', aftertouch: 'AFTERTOUCH', envelope1: 'ENV 1', envelope2: 'ENV 2', lfo1: 'LFO 1', lfo2: 'LFO 2', random: 'RANDOM', sidechain: 'SIDECHAIN', compressor: 'SIDECHAIN', 'sidechain-comp': 'SIDECHAIN', note: 'NOTE', y: 'Y', x: 'X' };
// Destinations that have their own dedicated shortcut pad (manual sec 4.6/4.8).
const DEST_SHORTCUT = {
  volume: 'LEVEL', pan: 'PAN', oscBVolume: 'OSC2 LEVEL', oscAVolume: 'OSC1 LEVEL',
  lpfFrequency: 'FREQUENCY (LPF)', lpfResonance: 'RESONANCE (LPF)',
  hpfFrequency: 'FREQUENCY (HPF)', hpfResonance: 'RESONANCE (HPF)',
  oscAPhaseWidth: 'OSC1 PW', oscBPhaseWidth: 'OSC2 PW',
  oscAPitch: 'OSC1 TRANSPOSE', oscBPitch: 'OSC2 TRANSPOSE', pitch: 'MASTER TRANSPOSE',
  lfo1Rate: 'LFO1 RATE', lfo2Rate: 'LFO2 RATE',
  modFXRate: 'RATE (MOD-FX)', modFXDepth: 'DEPTH (MOD-FX)',
  delayRate: 'RATE (DELAY)', arpRate: 'RATE (ARP)',
};
// camelCase raw XML name -> readable label, for anything without a known
// shortcut pad (still correct info, just reached via the SOUND menu).
function humanize(name) {
  const s = name
    .replace(/^oscA/, 'OSC1 ').replace(/^oscB/, 'OSC2 ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2');
  return s.replace(/\b\w/g, c => c.toUpperCase()).trim();
}
// A handful of destinations use one raw XML name for patch-cable routing
// purposes but a DIFFERENT name for the same parameter's own displayed
// concept -- confirmed real, not a naming-drift artifact: oscAPhaseWidth/
// oscBPhaseWidth is genuinely the firmware's own patch-cable-destination
// name for what the UI (and every base-value attribute, oscAPulseWidth) it
// otherwise always calls "pulse width" -- humanize()'s generic camelCase
// splitter has no way to know that, so it rendered "Phase Width" wherever a
// cable targets this destination (mod matrix column/step title/tooltips),
// reading as a different, wrong parameter next to the correct "pulse width"
// wording everywhere else that same knob is mentioned.
const DEST_DISPLAY_OVERRIDE = { oscAPhaseWidth: 'OSC1 Pulse Width', oscBPhaseWidth: 'OSC2 Pulse Width' };
function destDisplayName(destination) { return DEST_DISPLAY_OVERRIDE[destination] || humanize(destination); }

// A patch cable's own polarity (bipolar vs unipolar) -- confirmed real,
// switchable, and AUDIBLE via real-hardware testing, but previously
// completely untracked anywhere in this app. Firmware source
// (modulation/patch/patch_cable.cpp, PatchCable::hasPolarity()): X and Y
// (MPE expression) can't have their polarity changed at all, so they're
// the only sources this is never worth mentioning for; every other source
// (velocity, aftertouch, envelope1/2, lfo1/2, random, note, sidechain/
// compressor) supports it. getDefaultPolarity() shows WHY this can't be
// treated like every other "is this at its own default" field: aftertouch/
// Y/X/sidechain each have a fixed, hardcoded default, but every other
// source's default is `FlashStorage::defaultPatchCablePolarity` -- a
// GLOBAL, per-DEVICE preference that isn't stored in the preset file at
// all and this app has no way to know. So polarity is always shown/
// checked explicitly here rather than only when "changed from default",
// unlike every other cable property.
const POLARITY_FIXED_SOURCES = new Set(['x', 'y']);
function cableHasPolarity(source) { return !POLARITY_FIXED_SOURCES.has(source); }
// A cable's own <polarity> tag is OPTIONAL in the XML -- omitted on every
// preset that predates this attribute existing (and, per patch_cable_set.cpp,
// on every cable a still-current save never had reason to touch it on).
// readPatchCablesFromFile() confirms the firmware itself does NOT leave this
// ambiguous when the tag is missing: it starts each cable at a hardcoded
// `Polarity polarity = Polarity::BIPOLAR;` local (not the per-device
// FlashStorage default, which only applies when a cable is freshly created
// via the grid UI, never when a file is read), then overrides it to UNIPOLAR
// only for source==AFTERTOUCH, then overrides it again only if the file
// actually has an explicit <polarity> tag. So an omitted tag has one exact,
// known resulting value -- not an unknowable one -- and this app can and
// should fill it in the same way, rather than silently hiding the whole
// bipolar/unipolar step for every cable a file happens to predate the tag on
// (confirmed real: BOD01_06-Roygbass.XML, an older-format preset, omits
// <polarity> on every one of its cables).
function cableDefaultPolarity(source) { return source === 'aftertouch' ? 'unipolar' : 'bipolar'; }
// Confirmed via firmware source (model/voice/voice.cpp's per-unison render
// loop): SUBTRACTIVE renders through renderBasicSource() and RINGMOD has
// its own dedicated branch (`if (synthMode == SynthMode::RINGMOD) { ... }`,
// straight dsp::Oscillator::renderOsc(), no feedback parameter passed at
// all) -- the carrier/modulator feedback rendering code (renderSineWave
// WithFeedback()/renderFMWithFeedbackAdd(), reading LOCAL_CARRIER_n_
// FEEDBACK/LOCAL_MODULATOR_n_FEEDBACK) only runs in the sibling "else (FM)"
// branch. So these destinations aren't just menu-hidden outside FM mode
// (like OSC1/OSC2 LEVEL in Ring Mod, see isRingmod's own comment) -- they
// are a complete DSP no-op there, never read at all. Confirmed present as
// real, non-default, functionless leftover data in shipped factory presets
// too (e.g. Factory/125 Evolving Pad.XML, mode="ringmod": two genuine
// patch cables into carrier1Feedback, plus non-default base values for
// both carriers -- all inert). Reported directly: "factory/125 (ringmod)
// demands carrier feedback, but ringmod does not support that. even on
// the device, i see the cables, but cant change them" -- matches
// firmware's osc/source/feedback.h isRelevant(): `sound->getSynthMode()
// == SynthMode::FM` gates the ENTIRE menu route to this destination, so a
// cable already routed there can be seen in a cable-list overview but
// never opened/edited on a non-FM patch.
const FM_ONLY_CABLE_DESTINATIONS = new Set([
  'carrier1Feedback', 'carrier2Feedback',
  'modulator1Volume', 'modulator2Volume',
  'modulator1Feedback', 'modulator2Feedback',
  'modulator1Pitch', 'modulator2Pitch',
]);
function cablesOf(patch) {
  const cablesRaw = get(patch.defaultParams || {}, 'patchCables.patchCable', []) || [];
  const isFmPatch = patch.mode === 'fm';
  const cablesList = (Array.isArray(cablesRaw) ? cablesRaw : [cablesRaw])
    .filter(c => isFmPatch || !FM_ONLY_CABLE_DESTINATIONS.has(c.destination));
  // A cable's own depth can itself be modulated by a second source (real,
  // documented Deluge feature -- e.g. LFO1 -> pitch, whose *depth* is in
  // turn modulated by LFO1 again, a "double mod"). Two different XML
  // encodings exist for this, both confirmed against the firmware source
  // (modulation/patch/patch_cable_set.cpp):
  //  - Current (firmware >=3.2.0): nested <patchCable ...><depthControlledBy>
  //    <patchCable source="..." amount="..." /></depthControlledBy>
  //    </patchCable> -- no destination on the inner one, since it's
  //    modulating a depth, not a parameter.
  //  - Legacy (an older preset that's never been resaved since): a flat,
  //    separate top-level <patchCable source="X" destination="range"
  //    amount="Y" />, whose real target is resolved via a GLOBAL,
  //    file-order-INDEPENDENT rule -- confirmed via param.cpp's
  //    fileStringToParamConst(), which special-cases the literal string
  //    "range" to PLACEHOLDER_RANGE "for compatibility reading files from
  //    before V3.2.0", and patch_cable_set.cpp's readPatchCablesFromFile():
  //    it first reads EVERY cable in the file, tracking whichever one most
  //    recently (anywhere in the file, "back when only one range adjustable
  //    cable was allowed") carried rangeAdjustable="1"/<rangeAdjustable>1
  //    </rangeAdjustable> -- then, only in a SEPARATE PASS AFTER the whole
  //    file has been read, retroactively points every PLACEHOLDER_RANGE
  //    cable at that one target. A "range" cable can therefore appear
  //    BEFORE its own rangeAdjustable-marked target in the file, as it
  //    does on a real device preset (Bod01_06-Roygbass.XML: the lfo1->range
  //    cable is 4 entries before the lfo1->pitch rangeAdjustable="1" one) --
  //    an earlier, single-pass version of this resolver required the
  //    marker to come first and silently missed it there, still showing a
  //    nonsense flat "Patch: LFO1 -> Range" step/matrix-column.
  // A cable's depth can be modulated by MORE THAN ONE second source at
  // once -- confirmed on real presets (e.g. BOC01/BOD01_49-From the
  // distance.XML: LFO1 -> pitch's own vibrato depth is modulated by BOTH
  // lfo1 AND random simultaneously, two separate destination="range"
  // cables retroactively resolved to the same single rangeAdjustable
  // target) and by the firmware's own write path (patch_cable_set.cpp's
  // writePatchCablesToFile() loops over EVERY cable matching the same
  // destinationParamDescriptor when writing <depthControlledBy>, not just
  // the first one it finds). Never carried as a single `depthModulator` --
  // that silently collapsed a real two-source case down to just the last
  // one seen (a Map keyed by target, overwritten on each match). Carried
  // as `depthModulators: [{source, amount}, ...]` instead, so
  // buildModMatrixTable()'s extra column(s), buildGuide()'s
  // depthModStep()(s), and buildSignalPathSvg()'s loop/arrow(s) can all
  // show every one of them, not just one.
  let rangeAdjustableTarget = null; // "source\0destination" of the LAST rangeAdjustable cable anywhere in the file
  for (const c of cablesList) {
    if (c.source && c.destination && c.destination !== 'range' && c.rangeAdjustable && c.rangeAdjustable !== '0') {
      rangeAdjustableTarget = `${c.source}\u0000${c.destination}`;
    }
  }
  const legacyDepthsByTarget = new Map(); // target key -> [{source, amount, polarity}, ...]
  if (rangeAdjustableTarget) {
    for (const c of cablesList) {
      if (c.source && c.destination === 'range') {
        if (!legacyDepthsByTarget.has(rangeAdjustableTarget)) legacyDepthsByTarget.set(rangeAdjustableTarget, []);
        legacyDepthsByTarget.get(rangeAdjustableTarget).push({ source: c.source, amount: c.amount, polarity: c.polarity });
      }
    }
  }
  return cablesList.filter(c => c.source && c.destination && c.destination !== 'range').map(c => {
    // Same "same tag name always normalizes to an array, even a lone one"
    // rule this parser applies to patchCables.patchCable itself applies
    // here too, since the inner element is *also* named <patchCable> --
    // found via a real preset where this stayed a single-element array
    // rather than a plain object, silently defeating a first version of
    // this check that assumed the latter.
    const innerRaw = c.depthControlledBy && c.depthControlledBy.patchCable;
    const innerList = innerRaw ? (Array.isArray(innerRaw) ? innerRaw : [innerRaw]) : [];
    const modernDepths = innerList.filter(i => i && i.source).map(i => ({ source: i.source, amount: i.amount, polarity: i.polarity }));
    const rawDepthModulators = modernDepths.length ? modernDepths : (legacyDepthsByTarget.get(`${c.source}\u0000${c.destination}`) || []);
    // A chained depth modulator is its OWN cable (firmware: patch_cable_set.cpp
    // reads/writes a <polarity> tag on the inner <patchCable> exactly like any
    // other), with its own polarity independent of the outer connection's --
    // backfilled the same way and for the same reason as the outer cable's own
    // polarity (see cableDefaultPolarity()'s comment): real hardware report,
    // "dial in amount AND Bi/Uni" for this exact nested modulator.
    const depthModulators = rawDepthModulators.map(m => ({ ...m, polarity: m.polarity || cableDefaultPolarity(m.source) }));
    // depthModulator/depthModulatedBy (singular) kept only as a
    // convenience alias for the FIRST modulator -- every real consumer
    // should iterate depthModulators instead.
    const polarity = c.polarity || cableDefaultPolarity(c.source);
    return depthModulators.length
      ? { ...c, polarity, depthModulators, depthModulator: depthModulators[0], depthModulatedBy: depthModulators[0].source }
      : { ...c, polarity };
  });
}

// A cable whose (source, destination) matches one of the patch's own
// <modKnob controlsParam="Y" patchAmountFromSource="X"/> entries is
// directly controlled by turning a physical gold knob -- confirmed real
// via the corpus: Init.XML's own default vibrato-depth knob assignment
// (controlsParam="pitch" patchAmountFromSource="lfo1") exists with NO
// backing <patchCable> at all (depth 0 = simply no cable yet), so the
// cable only appears once that knob is actually turned away from center.
// Its exact resulting depth is whatever the physical knob's position
// happened to be at that moment -- not something any step ever instructs
// the user to dial to a precise value the way a normal mod-matrix
// "Patch: X → Y" SELECT+DEPTH turn does. Reported directly ("when mapping
// the gold knobs, and they are not perfect on 0, the corresponding patch
// cables can occur, thats no error then") -- its own DEPTH is therefore
// never checked (see the two checkFields call sites below), while
// whether it's connected at all, and its polarity, still are.
function goldKnobControlledCables(patch) {
  const knobsRaw = get(patch, 'modKnobs.modKnob', []) || [];
  const knobs = Array.isArray(knobsRaw) ? knobsRaw : [knobsRaw];
  const pairs = new Set();
  for (const k of knobs) {
    if (k && k.patchAmountFromSource && k.controlsParam) {
      pairs.add(`${k.patchAmountFromSource}\u0000${k.controlsParam}`);
    }
  }
  return pairs;
}

// The Deluge has no dedicated per-parameter knobs beyond two contextual gold
// (UPPER)/(LOWER) rotaries. Sixteen "slots" (8 buttons x upper/lower) map to
// parameters by default; a preset's <modKnobs> list overrides them positionally
// in this exact order. Source: Deluge Official Manual, "Parameter Affect Group
// Reference: Clip View" (section 2.8) and Init.XML.
const KNOB_SLOTS = [
  { button: 'LEVEL / PAN', pos: 'LOWER', param: 'pan' },
  { button: 'LEVEL / PAN', pos: 'UPPER', param: 'volumePostFX' },
  { button: 'CUTOFF / RES', pos: 'LOWER', param: 'lpfResonance' },
  { button: 'CUTOFF / RES', pos: 'UPPER', param: 'lpfFrequency' },
  { button: 'ATTACK / RELEASE', pos: 'LOWER', param: 'env1Release' },
  { button: 'ATTACK / RELEASE', pos: 'UPPER', param: 'env1Attack' },
  { button: 'DELAY TIME / AMOUNT', pos: 'LOWER', param: 'delayFeedback' },
  { button: 'DELAY TIME / AMOUNT', pos: 'UPPER', param: 'delayRate' },
  { button: 'SIDECHAIN / REVERB', pos: 'LOWER', param: 'reverbAmount' },
  { button: 'SIDECHAIN / REVERB', pos: 'UPPER', param: 'volumePostReverbSend' },
  { button: 'MOD RATE / DEPTH', pos: 'LOWER', param: 'pitch' },
  { button: 'MOD RATE / DEPTH', pos: 'UPPER', param: 'lfo1Rate' },
  { button: 'STUTTER / CUSTOM 1', pos: 'LOWER', param: 'portamento' },
  { button: 'STUTTER / CUSTOM 1', pos: 'UPPER', param: 'stutterRate' },
  { button: 'CUSTOM 2 / CUSTOM 3', pos: 'LOWER', param: 'bitcrushAmount' },
  { button: 'CUSTOM 2 / CUSTOM 3', pos: 'UPPER', param: 'sampleRateReduction' },
];

// ---------------------------------------------------------------------------
// Step-guide generation
// ---------------------------------------------------------------------------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiNoteName(n) {
  n = parseInt(n, 10);
  if (Number.isNaN(n)) return String(n);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 2;
  return `${name}${octave}`;
}

// A "sync level" (LFO1/LFO2/Delay/Sidechain tempo sync) is NOT a continuous
// numeric value -- it's a fixed list the Deluge's own SYNC menu scrolls
// through. Showing the raw stored integer alone (e.g. "sync level 6") told
// the user nothing about which menu option to actually select (reported
// directly: "delay sync ist kein int value, sondern eine liste").
//
// The NAME shown for a given raw value is NOT fixed across devices/songs --
// confirmed against firmware source: model/song.h's getInputTickMagnitude()
// = insideWorldTickMagnitude + a per-song BPM-derived offset, and
// model/song.cpp's own file-reading code
// (`insideWorldTickMagnitude = reader.readTagOrAttributeValueInt();`)
// shows this value is read from EACH SONG FILE itself, not a fixed global
// -- a standalone preset file never carries it (model/sync.h's own
// comment: "these names are correct only for default resolution"). The
// manual documents the note-name list assuming the bare FACTORY default
// (FlashStorage::defaultMagnitude = 2): "Options 2 bar, 1 bar, 2nd, 4th,
// 8th, 16th, 32nd, 64th, 128th" -- this table originally used that list
// directly, but TWO separate real-hardware reports ("32nd on deluge is 64
// on app", then "shows 2bar on device, but one bar on app") both landed
// exactly one step off from it, in the same direction every time. Both are
// bit-exact matches for tickMagnitude=1 instead of the factory default 2
// (verified by directly reimplementing model/sync.cpp's
// getNoteMagnitudeFfromNoteLength()/getNoteLengthNameFromMagnitude() and
// sweeping every level at both tickMagnitude values) -- so this table uses
// that resolution instead, since it's now the twice-confirmed real match
// rather than a theoretical default. A "show the raw click-count instead"
// attempt at hedging this turned out useless in practice either way --
// reported directly ("i dont see the int value on the hardware"): the
// Deluge's own SYNC menu only ever displays the NAME, never the number, so
// a step that can't be visually cross-checked against the real screen is
// worse than one that's usually right. Still not a universal guarantee --
// a device/song whose OWN resolution differs from what both real reports
// so far agreed on can still read one step off -- so the ambiguity is
// still explained via the LFO/delay/sidechain concept's "why" text.
const SYNC_LEVEL_NAMES = ['OFF', '4-Bar', '2-Bar', '1-Bar', '2nd', '4th', '8th', '16th', '32nd', '64th'];
function syncLevelName(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return String(raw);
  if (n === 0) return 'OFF';
  if (n <= 9) return SYNC_LEVEL_NAMES[n];
  if (n <= 18) return `${SYNC_LEVEL_NAMES[n - 9]} (triplets)`;
  if (n <= 27) return `${SYNC_LEVEL_NAMES[n - 18]} (dotted)`;
  return String(raw);
}

// Real device XML files store sync as TWO SEPARATE attributes -- syncLevel
// (the plain 0-9 sub-level) and syncType (0=even/straight, 10=triplet,
// 19=dotted -- firmware's own SyncType enum values, model/sync.h) -- NOT
// the single packed 0-27 "menu option" value syncLevelName() above expects
// (confirmed against firmware source: LFO/Delay/Sidechain are all
// read/written as these two independent fields, model/sound.cpp and
// mod_controllable_audio.cpp; the packed 0-27 scheme is purely an in-
// memory/menu-navigation encoding, never what's written to a file).
// Confirmed real, not just theoretical: a real preset (BOC01/BOD01_34-
// Reversed tones My 2.XML) has <delay syncLevel="8" syncType="19"/>, a
// genuinely dotted-synced delay -- syncLevelName(delay.syncLevel) alone
// would decode "8" as plain "32nd", silently dropping the "(dotted)"
// qualifier a real preset actually has. Reconstructs the packed value the
// same way firmware's own syncTypeAndLevelToMenuOption() (model/sync.cpp)
// does: the plain level IS the packed value for the default "even" type,
// but triplet/dotted subtract one extra step since their own numbering
// starts at their type constant + 1 (level 1), not + 0.
function packedSyncOption(syncLevel, syncType) {
  const level = parseInt(syncLevel, 10);
  const type = parseInt(syncType, 10) || 0;
  if (!level || Number.isNaN(level)) return 0;
  return type === 0 ? level : type + level - 1;
}

// Is the arpeggiator on at all -- confirmed via firmware source
// (modulation/arpeggiator.cpp's own file reader): `arpMode` (when present)
// is the CURRENT firmware's sole on/off flag; the older `mode` attribute is
// only ever consulted for files older than community firmware 1.1.0 (and
// even then only if noteMode/octaveMode are still at their class defaults),
// so for any reasonably modern file `arpMode` is authoritative and `mode`
// is pure write-time backward-compat filler. Falls back to `mode` only when
// `arpMode` is absent entirely (a genuinely pre-split file, which never had
// noteMode/octaveMode to disagree with `mode` in the first place).
function arpModeOn(arp) {
  if (!arp) return false;
  const raw = arp.arpMode !== undefined ? arp.arpMode : arp.mode;
  return !!raw && raw !== 'off';
}

// The friendly preset name shown on the real device's own MODE shortcut pad
// (gui/menu_item/arpeggiator/preset_mode.h's PresetMode) is NOT what's
// stored in the file for a modern preset -- confirmed via firmware source:
// current firmware's `mode`/`arpMode` attributes are only ever "off" or
// "arp" (a plain on/off flag; the old up/down/both/random vocabulary was
// retired when noteMode+octaveMode were split out), so displaying
// arp.mode.toUpperCase() directly showed the literal, useless text "ARP"
// for every real modern preset with the arp enabled (confirmed: of 112 real
// files with both `mode` and `arpMode`, 111 have `mode` already reduced to
// "arp"/"off" too, not a pattern name) -- reported directly ("Arp mode ist
// auch daneben"). Reconstructs the same preset firmware would show by
// reversing its own ArpeggiatorSettings::updatePresetFromCurrentSettings().
// A pre-split file (no arpMode at all) instead has its ONE legacy `mode`
// attribute already carry the preset name directly (up/down/both/random),
// confirmed firmware-equivalent via oldModeToArpNoteMode()/
// oldModeToArpOctaveMode() reducing back to exactly those same 4 presets.
function arpPresetName(arp) {
  if (!arpModeOn(arp)) return 'OFF';
  if (arp.arpMode === undefined) return arp.mode.toUpperCase();
  const noteMode = arp.noteMode || 'up';
  const octaveMode = arp.octaveMode || 'up';
  if (octaveMode === 'up' && noteMode === 'up') return 'UP';
  if (octaveMode === 'down' && noteMode === 'down') return 'DOWN';
  if (octaveMode === 'alt' && noteMode === 'up') return 'BOTH';
  if (octaveMode === 'random' && noteMode === 'random') return 'RANDOM';
  if (octaveMode === 'alt' && noteMode === 'walk2') return 'WALK';
  return 'CUSTOM';
}

// ---------------------------------------------------------------------------
// "Show manual reference" (manual/community reference per step) + "Show tips"
// (why-this-matters) reference data.
// ---------------------------------------------------------------------------
// Page numbers below are physical PDF page numbers (i.e. what a PDF viewer's
// #page=N fragment jumps to), verified two ways: (1) against this project's
// own tests/fixtures/manual.txt, a text extraction of the real OS 4.1 manual
// PDF with page breaks preserved, and (2) spot-checked against the S3-hosted
// OS 4.0 manual PDF linked below by downloading it and running `pdftotext -f
// N -l N` for every page number used here -- both PDFs happen to share the
// same 338-page count and, for every page cited below, the same section
// content at that physical page. Where a spot-check showed the two versions
// had drifted out of alignment (e.g. the "Loading Multisamples" procedure,
// which sits at a page in the 4.1 extraction that's still mid-table in the
// 4.0 PDF), no page/link is given -- see manualRefPlain() below.
const MANUAL_PDF_URL = 'https://synthstrom-audible-deluge.s3.us-east-2.amazonaws.com/Deluge-Guidebook-4p0.pdf';
const COMMUNITY_FEATURES_URL = 'https://delugecommunity.com/features/community_features/';
function manualRef(section, page) {
  return { text: `Deluge Official Manual, ${section}, p.${page}`, url: `${MANUAL_PDF_URL}#page=${page}`, community: false };
}
// For a real manual section where the 4.0/4.1 page numbers are known to have
// drifted (or where no page was confidently pinned down) -- cited by section
// name only, no link, rather than guessing a page number that might be wrong.
function manualRefPlain(section) {
  return { text: `Deluge Official Manual, ${section}`, url: null, community: false };
}
// For a mechanic that tests/fixtures/community_features.txt confirms is a
// community-firmware addition, absent from the official manual entirely
// (verified by grepping manual.txt too -- see the offline research this
// session did before writing these citations). `anchor` is a heading id
// straight from delugecommunity.com/features/community_features/'s own HTML
// (confirmed present via a live fetch+grep of that page, not guessed).
function communityRef(section, anchor) {
  return {
    text: `Community firmware feature (not in the official manual) — ${section}`,
    url: anchor ? `${COMMUNITY_FEATURES_URL}#${anchor}` : COMMUNITY_FEATURES_URL,
    community: true,
  };
}

// "Why this matters" (+ an optional "try this" nudge), keyed by a short
// concept id -- one entry per distinct parameter *family* (there are ~25),
// not per preset or per step, so it improves every preset for free. Shown
// under a step when "Show tips" is on. See makeStep()'s `extra.conceptKey`.
const PARAM_CONCEPTS = {
  'osc.type': { why: 'The waveform is the raw timbre before anything else touches it -- a square is hollow/reedy, a saw is bright/buzzy, a triangle is soft/flute-like. Everything else in this guide (filter, envelope, effects) shapes this starting point.', tryThis: 'Cycle through the other waveform options on the same oscillator and listen to how differently the filter and envelope steps below end up shaping each one.' },
  'osc.sample': { why: 'A sample replaces the synthesized waveform with a recorded one, so the "oscillator" step becomes about picking source material rather than a shape -- everything downstream (filter, envelope, effects) still applies on top of it exactly the same way.' },
  'osc.transpose': { why: 'Transpose shifts this oscillator’s pitch in semitones independent of the note played -- used to stack an oscillator an octave up/down or a fifth apart from the other one for a fuller or more harmonic tone.' },
  'osc.pulseWidth': { why: 'Pulse width reshapes the waveform itself, not just its pitch or level -- pushed away from center it gets thinner and more nasal (further from a full, fat square wave), which is also exactly what a patch cable modulating it in real time (classic PWM) sweeps through continuously.' },
  'osc.retrigPhase': { why: 'Left off, each new note continues the waveform from wherever its cycle happens to be (free-running) -- turned on, every note-on snaps the oscillator back to a fixed point in its cycle first, so notes attack more consistently (useful for punchy/plucky sounds) instead of subtly varying note to note.' },
  'mixer.level': { why: 'This is the voice’s own overall output level -- set independently of the OSC1/OSC2 balance below it, and easy to overlook since nothing else in the signal chain depends on it being touched. Left at its own default here, this preset would sit noticeably louder or quieter than intended.' },
  'mixer.balance': { why: 'Blending OSC1 and OSC2 is how two different waveforms combine into one composite tone -- equal levels give an even blend, a big gap means one oscillator is really just coloring the other.', tryThis: 'Solo OSC1 by turning OSC2 all the way down, listen, then bring OSC2 back up gradually to hear exactly what it’s adding.' },
  'mixer.noise': { why: 'A dash of noise adds breath/air/grit on top of the tuned oscillators -- useful for percussive attacks (a drum "chiff") or airy pads, without it being a pitched part of the sound.' },
  'mixer.pan': { why: 'Pan places the sound in the stereo field. On its own it just moves the source left/right, but it matters a lot once several patches share a mix -- spreading similar sounds apart in pan keeps a track from turning into mono mud.' },
  'unison': { why: 'Unison stacks multiple detuned copies of the same voice on one note -- more voices + more detune is the classic "fat" analog-supersaw sound, at the cost of using up more of the Deluge’s limited polyphony per note.', tryThis: 'Turn detune to 0 with several voices still stacked -- the "fatness" disappears and it sounds almost like one voice again, since detune (not voice count alone) is what creates the chorus-like beating.' },
  'portamento': { why: 'Portamento glides pitch smoothly from one note to the next instead of jumping -- classic on monophonic bass/lead lines, and almost always left off for chords or percussive hits where a clean pitch jump is wanted.' },
  'filter.lpf': { why: 'The low-pass filter is the single most-used tone-shaping tool on any subtractive synth: closing the cutoff removes high frequencies (muffled/dark), resonance emphasizes the frequencies right at the cutoff point (nasal/whistly, self-oscillating at extreme settings).', tryThis: 'Sweep the cutoff from fully open down to fully closed while holding a note -- that sweep alone is most of what "subtractive synthesis" means.' },
  'filter.hpf': { why: 'The high-pass filter removes low frequencies instead -- used far more subtly than the LPF, usually just to thin out mud/rumble rather than as the main tone-shaping filter.' },
  'filter.route': { why: 'When both filters are active, routing decides whether the signal passes through them one after another (series -- each filter’s output feeds the next, so their effects compound) or side-by-side with the results mixed back together (parallel -- each filter hears the same unfiltered signal, so neither one’s output passes through the other).' },
  'envelope.amp': { why: 'Envelope 1 shapes loudness over time (Attack/Decay/Sustain/Release) -- a fast attack is percussive/plucky, a slow attack is a swell/pad; a short release stops dead on note-off, a long one keeps ringing after you let go.', tryThis: 'Push attack all the way up on a patch that’s normally percussive -- the same waveform and filter suddenly feel like a completely different, more atmospheric patch.' },
  'envelope.filter': { why: 'Envelope 2 defaults to shaping the filter cutoff over time rather than loudness -- this is what gives a "wah"/pluck-like movement to the tone itself (bright at the start, darkening as the note continues, or the reverse), independent of the amp envelope.' },
  'lfo': { why: 'An LFO is a slow, repeating wave used as a *modulation source* rather than heard directly -- it continuously nudges whatever it’s routed to (pitch = vibrato, cutoff = filter wobble, volume = tremolo) at the rate you set. If a SYNC step is shown, note its named option (e.g. "32nd") is only a best guess at your device\'s factory-default SONG > DEFAULT RESOLUTION setting -- if that\'s been changed, the real menu may show a name one step off from what\'s listed here.', tryThis: 'Slow the rate right down until you can count the individual cycles -- that’s exactly what’s happening much faster at a normal "wobble" rate, just easier to hear happening.' },
  'vibrato': { why: 'Vibrato is LFO1 modulating pitch specifically -- common enough that it gets its own dedicated shortcut pad instead of the generic two-step "pick destination, pick source" patching procedure used for every other routing.' },
  'modmatrix': { why: 'A patch cable is a modulation routing: some source (an envelope, LFO, velocity, aftertouch...) continuously controls some destination parameter’s value in real time, on top of whatever that parameter is manually set to -- this is what makes a patch feel alive/responsive rather than static.' },
  'arpeggiator': { why: 'The arpeggiator automatically steps through the notes of whatever chord you hold, one at a time, at a set rate -- turns a single held chord into a moving, rhythmic pattern without you having to play it.' },
  'modfx': { why: 'Mod FX (chorus/flanger/phaser) all work by mixing a signal with a very slightly delayed, modulated copy of itself -- chorus thickens/widens, flanger sweeps a metallic comb-filter sound, phaser sweeps notches instead of peaks. Same underlying trick, different flavor of delay/feedback.' },
  'delay': { why: 'Delay repeats the sound after a gap, each repeat quieter (feedback controls how many repeats you hear/how slowly they decay) -- ping-pong bounces each repeat between left/right instead of straight back on both sides. If a SYNC step is shown, note its named option (e.g. "32nd") is only a best guess at your device\'s factory-default SONG > DEFAULT RESOLUTION setting -- if that\'s been changed, the real menu may show a name one step off from what\'s listed here.' },
  'reverb': { why: 'Reverb simulates the sound reflecting around a physical space -- it’s what separates a "dry"/close-up sound from one that feels like it’s playing in a room or hall.' },
  'sidechain': { why: 'A sidechain compressor ducks (temporarily quiets) this sound every time it receives a trigger -- the classic use is ducking a bass/pad under every kick drum hit so the kick always cuts through, without you having to automate volume by hand. If a SYNC step is shown, note its named option (e.g. "32nd") is only a best guess at your device\'s factory-default SONG > DEFAULT RESOLUTION setting -- if that\'s been changed, the real menu may show a name one step off from what\'s listed here.' },
  'distortion': { why: 'Saturation, bitcrush and sample-rate reduction (decimation) are three different flavors of "make it dirtier": saturation rounds off peaks (warm/analog-ish), bitcrush reduces bit depth (harsh, stair-stepped digital grit), decimation reduces the effective sample rate (aliased, lo-fi/glitchy).' },
  'eq': { why: 'This EQ is a simple 2-band bass/treble tone control -- a much coarser tool than the LPF/HPF, useful for a quick tonal nudge rather than the LPF/HPF’s dramatic sweeping effect.' },
  'wavefold': { why: 'A wavefolder reflects ("folds") a signal back on itself once it crosses a threshold instead of clipping it flat -- produces a harmonically rich, often metallic character that’s different from ordinary clipping distortion, and gets more extreme as you push the input hotter.' },
  'goldknob': { why: 'The Deluge only has two general-purpose physical knobs (the gold UPPER/LOWER rotaries); which parameter each of the 8 buttons’ upper/lower position controls is reassignable per-patch via LEARN, which is how a patch can put an unusual parameter (e.g. reverb amount, or a patch-cable depth) under real-time knob control during a performance instead of only reachable through the menu.' },
  'fm': { why: 'FM (frequency modulation) synthesis uses one oscillator (the modulator) to rapidly modulate another’s (the carrier’s) pitch -- fast enough that instead of hearing vibrato, you hear new overtones appear, which is what gives FM patches their metallic/bell-like/electric-piano character that subtractive synthesis can’t easily produce.' },
};

// ---------------------------------------------------------------------------
// Session 3: per-cable "why this matters" text.
// ---------------------------------------------------------------------------
// Project-owner feedback on session 2: PARAM_CONCEPTS['modmatrix'] (above)
// is one static blurb shown under *every* patch-cable step, describing
// modulation-in-the-abstract rather than what THIS source->destination
// routing concretely does to the sound. There are ~10 real source keys x
// ~40+ real destination keys (see the grep-verified lists below), too many
// combinations to hand-write individually -- so this composes a "what the
// source does" clause with a "what the destination controls" clause into
// one sentence instead. `dvCable()`'s signed depth (-50..+50) picks which
// direction (up/down) the composed clause describes.
//
// Source behaviors: covers every source key that actually appears in real
// preset XML (verified with `grep -oh 'source="[a-zA-Z0-9-]*"' -r synths/`
// across ~2000 real presets -- velocity/lfo1/random/envelope2/lfo2/
// envelope1/y/aftertouch/compressor/note/x, exactly SOURCE_LABEL's keys).
const SOURCE_BEHAVIOR = {
  velocity: 'how hard the key is hit',
  aftertouch: 'how hard you keep pressing the key after it’s already down',
  envelope1: 'ENV1’s attack/decay/sustain/release shape, once per note',
  envelope2: 'ENV2’s attack/decay/sustain/release shape, once per note',
  lfo1: 'LFO1’s slow, repeating wave',
  lfo2: 'LFO2’s slow, repeating wave',
  random: 'a fresh random value picked at the start of every note',
  compressor: 'the sidechain compressor ducking on every trigger it receives',
  'sidechain-comp': 'the sidechain compressor ducking on every trigger it receives',
  sidechain: 'the sidechain compressor ducking on every trigger it receives',
  note: 'the pitch of the note being played (higher notes push harder)',
  x: 'the X finger-position value on an X/Y/pressure-capable controller',
  y: 'the Y finger-position value on an X/Y/pressure-capable controller',
};
// Destination effects: covers every destination key that actually appears
// in real preset XML (verified the same way -- `grep -oh
// 'destination="[a-zA-Z0-9]*"' -r synths/` across ~2000 real presets, 43
// distinct keys, all present here). `up`/`down` describe the audible result
// as the source's value rises/falls with a positive/negative cable depth.
const DEST_EFFECT = {
  volume: { name: 'this voice’s output level', up: 'louder', down: 'quieter' },
  oscAVolume: { name: 'OSC1’s level in the mix', up: 'louder relative to OSC2', down: 'quieter relative to OSC2' },
  oscBVolume: { name: 'OSC2’s level in the mix', up: 'louder relative to OSC1', down: 'quieter relative to OSC1' },
  noiseVolume: { name: 'the noise generator’s level', up: 'hissier/breathier', down: 'thinner, drier' },
  modulator1Volume: { name: 'FM modulator 1’s output level (its influence on the carrier)', up: 'a brighter, more metallic overtone content', down: 'a cleaner tone, closer to a plain sine' },
  modulator2Volume: { name: 'FM modulator 2’s output level (its influence on the carrier)', up: 'a brighter, more metallic overtone content', down: 'a cleaner tone, closer to a plain sine' },
  pan: { name: 'stereo pan position', up: 'pushed toward the right speaker', down: 'pushed toward the left speaker' },
  lpfFrequency: { name: 'the low-pass filter cutoff', up: 'brighter, more open', down: 'darker, more muffled' },
  lpfResonance: { name: 'low-pass filter resonance', up: 'a stronger, nasal/whistly emphasis right at the cutoff', down: 'a flatter, less emphasized cutoff' },
  lpfMorph: { name: 'the low-pass filter’s morph/character control', up: 'a different filter character', down: 'a different filter character' },
  hpfFrequency: { name: 'the high-pass filter cutoff', up: 'thinner, with more low end removed', down: 'fuller, with more low end restored' },
  hpfResonance: { name: 'high-pass filter resonance', up: 'a stronger emphasis right at the cutoff', down: 'a flatter cutoff' },
  pitch: { name: 'overall pitch', up: 'sharp, pitching upward', down: 'flat, pitching downward' },
  oscAPitch: { name: 'OSC1’s pitch independent of OSC2', up: 'sharp against OSC2 (detuning/beating between the two)', down: 'flat against OSC2 (detuning/beating between the two)' },
  oscBPitch: { name: 'OSC2’s pitch independent of OSC1', up: 'sharp against OSC1 (detuning/beating between the two)', down: 'flat against OSC1 (detuning/beating between the two)' },
  modulator1Pitch: { name: 'FM modulator 1’s pitch (its ratio to the carrier)', up: 'higher, shifting which overtones the FM produces', down: 'lower, shifting which overtones the FM produces' },
  modulator2Pitch: { name: 'FM modulator 2’s pitch (its ratio to the carrier)', up: 'higher, shifting which overtones the FM produces', down: 'lower, shifting which overtones the FM produces' },
  oscAPhaseWidth: { name: 'OSC1’s pulse width', up: 'thinner and more nasal (further from a square wave)', down: 'closer to a full, fat square wave' },
  oscBPhaseWidth: { name: 'OSC2’s pulse width', up: 'thinner and more nasal (further from a square wave)', down: 'closer to a full, fat square wave' },
  oscAWavetablePosition: { name: 'OSC1’s position within its wavetable', up: 'scanned forward through the table’s timbres', down: 'scanned backward through the table’s timbres' },
  oscBWavetablePosition: { name: 'OSC2’s position within its wavetable', up: 'scanned forward through the table’s timbres', down: 'scanned backward through the table’s timbres' },
  carrier1Feedback: { name: 'carrier 1’s FM feedback amount', up: 'progressively harsher and noisier', down: 'cleaner and simpler' },
  carrier2Feedback: { name: 'carrier 2’s FM feedback amount', up: 'progressively harsher and noisier', down: 'cleaner and simpler' },
  modulator1Feedback: { name: 'FM modulator 1’s own feedback amount', up: 'a rougher, more inharmonic edge on the overtones it produces', down: 'a cleaner set of overtones' },
  modulator2Feedback: { name: 'FM modulator 2’s own feedback amount', up: 'a rougher, more inharmonic edge on the overtones it produces', down: 'a cleaner set of overtones' },
  waveFold: { name: 'wavefolder amount', up: 'more folded and harmonically rich, verging on metallic', down: 'closer to the clean, unfolded waveform' },
  env1Attack: { name: 'ENV1 (amp) attack time', up: 'a slower fade-in', down: 'a snappier, more percussive onset' },
  env1Decay: { name: 'ENV1 (amp) decay time', up: 'a slower drop to the sustain level', down: 'a quicker drop to the sustain level' },
  env1Sustain: { name: 'ENV1 (amp) sustain level', up: 'a louder held level', down: 'a quieter (or more percussive, near-zero) held level' },
  env1Release: { name: 'ENV1 (amp) release time', up: 'more ring-out after note-off', down: 'a quicker stop after note-off' },
  env2Attack: { name: 'ENV2’s attack time (filter cutoff by default)', up: 'a slower filter opening/closing at the start of the note', down: 'a snappier filter movement at the start of the note' },
  env2Decay: { name: 'ENV2’s decay time (filter cutoff by default)', up: 'a slower move to the sustain point', down: 'a quicker move to the sustain point' },
  env2Sustain: { name: 'ENV2’s sustain level (filter cutoff by default)', up: 'a brighter, more open held tone', down: 'a darker, more closed held tone' },
  env2Release: { name: 'ENV2’s release time (filter cutoff by default)', up: 'the filter drifting closed/open more slowly after note-off', down: 'the filter snapping back more quickly after note-off' },
  lfo1Rate: { name: 'LFO1’s speed', up: 'a faster wobble', down: 'a slower wobble' },
  lfo2Rate: { name: 'LFO2’s speed', up: 'a faster wobble', down: 'a slower wobble' },
  modFXRate: { name: 'the mod-FX (chorus/flanger/phaser) sweep speed', up: 'a faster sweep', down: 'a slower sweep' },
  modFXDepth: { name: 'the mod-FX (chorus/flanger/phaser) depth', up: 'a more pronounced, wider effect', down: 'a subtler effect' },
  delayRate: { name: 'the delay repeat rate', up: 'faster repeats', down: 'slower repeats' },
  delayFeedback: { name: 'how many delay repeats are heard', up: 'more repeats before they die out', down: 'fewer repeats' },
  volumePostReverbSend: { name: 'this voice’s send level into the reverb', up: 'more of it audible in the reverb tail', down: 'less of it audible in the reverb tail' },
  arpRate: { name: 'the arpeggiator’s step rate', up: 'a faster arpeggio', down: 'a slower arpeggio' },
  range: { name: 'the arpeggiator’s octave range', up: 'a wider octave spread', down: 'a narrower octave spread' },
  none: { name: 'nothing (this cable’s destination is disconnected)', up: 'no audible effect', down: 'no audible effect' },
};
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
// Composes one concrete, source/destination-specific "why this matters"
// sentence for a real patch cable, in place of PARAM_CONCEPTS['modmatrix']'s
// generic modulation-in-the-abstract text. `amount` is the signed cable
// depth (dvCable(c.amount), -50..+50) -- its sign picks the up/down clause.
// Falls back to a still source/destination-named (if less vivid) sentence
// for a pairing this session didn't hand-tune an effect description for,
// rather than throwing or silently reusing the old generic line.
function cableWhyText(source, destination, amount) {
  const srcLabelText = SOURCE_LABEL[source] || humanize(source);
  const destLabelText = destDisplayName(destination);
  const behavior = SOURCE_BEHAVIOR[source] || `${srcLabelText}’s value`;
  const effect = DEST_EFFECT[destination];
  const goesUp = !(typeof amount === 'number' && amount < 0);
  if (effect) {
    const dir = goesUp ? effect.up : effect.down;
    return `${cap(behavior)} continuously pushes ${effect.name} ${goesUp ? 'up' : 'down'}, toward ${dir}.`;
  }
  return `This cable routes ${behavior} into ${destLabelText} (${srcLabelText} → ${destLabelText}): whatever that source is doing at any moment gets added on top of ${destLabelText}’s own knob setting, ${goesUp ? 'pushing it higher' : 'pulling it lower'} as the source rises.`;
}

// checkFields (optional): [{ path, label }], `path` being the same `key`
// string a buildCheckSteps() field uses below -- the raw-XML path for a
// normal field() / intField(), or cableField()'s "cable:<mode>:<source>-
// ><destination>" for a patch-cable field. `label` is a short per-value
// tag (e.g. "A"/"D"/"S"/"R" for an envelope step) so a device check can
// not only color/tick the whole step but mark each of its individual
// values. Left undefined for steps that have no equivalent in the check
// schema (gold-knob reassignments, engine mode, polyphony, ...).
//
// `extra` (optional, 5th param): { manualRef, conceptKey, why } -- bundled
// as one options object rather than more positional args since all three
// are optional and independent of checkFields. `manualRef` is a descriptor
// from manualRef()/manualRefPlain()/communityRef() above (shown by "Show
// sources"); `conceptKey` is a key into PARAM_CONCEPTS above (shown by
// "Show tips"); `why` (session 3) overrides that lookup with an already-
// computed, per-instance string (used by patch-cable steps, where the
// "why" text depends on this cable's specific source/destination/depth
// rather than being one fixed blurb per concept -- see cableWhyText()
// above). A step can have any combination of these, or none.
function makeStep(title, beginnerHtml, expertHtml, checkFields, extra) {
  extra = extra || {};
  return {
    title, beginner: beginnerHtml, expert: expertHtml,
    checkFields: checkFields || null,
    manualRef: extra.manualRef || null,
    conceptKey: extra.conceptKey || null,
    why: extra.why || null,
    // Rendered indented, directly under the step right before it (see
    // renderGuide()) -- for a step that only makes sense as a follow-on to
    // the one before it (e.g. depthModStep()'s chained-depth step depends
    // on its parent cable already being connected), so that dependency
    // reads visually instead of the two looking like independent peers.
    indent: !!extra.indent,
  };
}
function cf(path, label) { return { path, label }; }
// Wraps one instruction fragment (e.g. "SHIFT+ATTACK 31") in a marker
// renderGuide() finds after a device check to color it in place -- green if
// this exact value matches, yellow if edited but not there yet, red if it's
// an unwanted change, left alone if still untouched. `key` must be one of
// this step's checkFields paths (same string passed to cf() below).
function ck(key, html) { return `<span class="check-value" data-check-path="${key}">${html}</span>`; }
function val(text) { return `<span class="value">${text}</span>`; }

// Round encoder-icon badges, matching delugecommunity.com's own convention
// exactly (checked against their actual page markup, not just a screenshot):
// they icon-badge the physical round encoders (Select, the gold-assignable
// knobs, Tempo) with a filled circle + 3-letter abbreviation, but render
// every button and grid-shortcut pad (Shift, named pads, Learn/Input) as
// plain text with NO icon -- those aren't illustrated on their site at all.
// Colors decoded from their real SVGs: gold #AD7309/#E2AD5D/#FFECD2 for the
// assignable knobs, near-black #1E1E1E/#949494/#D0D0D0 for Select.
function iconEncoder(fill, stroke, textFill, abbr) {
  return `<svg width="15" height="15" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/><text x="14" y="15" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-weight="bold" font-size="9" letter-spacing="-0.5" fill="${textFill}">${abbr}</text></svg>`;
}
const ICON_SELECT = iconEncoder('var(--select-fill)', 'var(--select-stroke)', 'var(--select-text)', 'SEL');
const ICON_GOLD = iconEncoder('var(--gold)', 'var(--gold-stroke)', 'var(--gold-text)', 'GLD');

// A single physical grid pad, e.g. kbd('OSC1 TYPE') -> the TYPE pad in the
// OSC1 column. Deluge Official Manual section 4.8, "Sound Editor: Grid
// Shortcuts": columns are function groups (OSC1, ENVELOPE1, LPF, ...), rows
// are the parameter printed on each pad.
function kbd(label) {
  if (label === 'SELECT') return `<span class="kbd">${ICON_SELECT}${label}</span>`;
  if (label === 'UPPER' || label === 'LOWER') return `<span class="kbd">${ICON_GOLD}${label}</span>`;
  return `<span class="kbd">${label}</span>`;
}
// The documented way to trigger any grid shortcut: hold SHIFT (or AUDITION)
// and press the pad, then turn SELECT to change the value (manual 4.8).
function shift(label) { return `${kbd('SHIFT')}+${kbd(label)}`; }
function selectMenu(path) { return `${kbd('SELECT')} → ${path}`; }

// The Deluge's SD card browser opens straight into this folder, so the
// leading segment is implied rather than something you'd ever navigate to.
function stripSamplesRoot(p) { return p.replace(/^SAMPLES\//, ''); }
function folderOf(fileName) {
  const i = fileName.lastIndexOf('/');
  return stripSamplesRoot(i === -1 ? fileName : fileName.slice(0, i));
}
// Pulse width is a base per-oscillator parameter, not tied to sample/
// waveform-picking at all -- separate from describeOsc() (which returns a
// single step or null) since a patch can change both the waveform AND the
// pulse width independently, and should get two focused steps rather than
// one crowded one. Previously not covered anywhere at all (found via
// real-hardware testing against a preset that moves it) -- DEST_SHORTCUT/
// DEST_EFFECT already had entries for it (used when a patch cable targets
// it), just never as its own base-value step.
// NOTE: this base-value attribute really is oscAPulseWidth/oscBPulseWidth,
// always -- an earlier version of this comment called it "a.k.a. phase
// width", which was wrong. "oscAPhaseWidth"/"oscBPhaseWidth" is a DIFFERENT
// raw name the firmware genuinely also uses, but only as a patch-cable
// DESTINATION for this exact same knob (see DEST_DISPLAY_OVERRIDE's own
// comment) -- never as the base-value attribute itself.
function describePulseWidth(dp, label, oscNum) {
  const key = oscNum === 1 ? 'oscAPulseWidth' : 'oscBPulseWidth';
  const path = `defaultParams.${key}`;
  const value = dp[key];
  if (!value || !q31Differs(value, INIT[key])) return null;
  const shortcut = DEST_SHORTCUT[oscNum === 1 ? 'oscAPhaseWidth' : 'oscBPhaseWidth']; // e.g. "OSC1 PW"
  // dvHalfPrecision()/pctHalfPrecision(), NOT dv()/rawPct() -- see their
  // own comment: pulse width uses a different raw<->display conversion
  // than every other 0-50 knob, confirmed bit-exact against real hardware.
  return makeStep(`${label}: pulse width`,
    `${ck(path, `${shift(shortcut)} to ${val(dvHalfPrecision(value))}`)}.`,
    `${ck(path, `Pulse width ${val(pctHalfPrecision(value) + '%')}`)}.`,
    [cf(path, 'Pulse width')],
    { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Oscillator column)', 88), conceptKey: 'osc.pulseWidth' });
}

function describeOsc(osc, label, oscNum) {
  if (!osc) return null;
  const col = `OSC${oscNum}`;
  // The BROWSE shortcut pad for loading audio is labelled SAMPLE1/SAMPLE2 on
  // the grid once TYPE is set to Sample, not OSC1/OSC2 (those cover the
  // oscillator's own params like TYPE/TRANSPOSE regardless of source type).
  const sampleCol = `SAMPLE${oscNum}`;
  if (osc.sampleRanges && osc.sampleRanges.sampleRange) {
    const ranges = Array.isArray(osc.sampleRanges.sampleRange) ? osc.sampleRanges.sampleRange : [osc.sampleRanges.sampleRange];
    const rows = ranges.slice(0, 6).map(r =>
      `<tr><td>up to ${r.rangeTopNote ? midiNoteName(r.rangeTopNote) : 'top of keyboard'}</td><td>${stripSamplesRoot(r.fileName)}</td></tr>`).join('');
    const more = ranges.length > 6 ? `<tr><td colspan="2">&hellip; and ${ranges.length - 6} more zones</td></tr>` : '';
    // Deluge Official Manual, "Loading Multisamples Into a Synth": you don't
    // pick individual files -- you browse to the FOLDER holding them, then
    // press & hold SELECT and turn it to choose MULTI (labelled MULTISAMPLES
    // in the full walkthrough); Deluge auto-detects pitch per file and maps
    // every sample across the keyboard, filling gaps in the set if needed.
    // No check field for multisample zones -- excluded from buildCheckSteps()
    // for the same list-shape reason as patch cables (see comment there).
    return makeStep(`${label}: load multisample (${ranges.length} zones)`,
      `${shift(`${col} TYPE`)}, turn SELECT to ${val('SAMPLE')}. Then ${shift(`${sampleCol} BROWSE`)} and navigate to the folder ${val(folderOf(ranges[0].fileName))}.
       With the folder in focus, press &amp; hold ${kbd('SELECT')} and turn it to choose ${val('MULTI')}, then press ${kbd('SELECT')} to confirm &mdash; Deluge auto-detects pitch and maps every sample in the folder across these key ranges:
       <table><tr><th>key range</th><th>sample</th></tr>${rows}${more}</table>`,
      `Load the ${ranges.length}-zone multisample into ${label} (a different recorded sample per key range) instead of a synthesized waveform.`,
      null,
      // Section number/procedure confirmed real (same §9.10 "Sampling into a
      // Synth Instrument" as the single-sample step below), but the 4.1
      // extraction's page for this specific sub-procedure (191) landed
      // mid-table rather than on this heading in the 4.0 PDF used for the
      // link -- pagination drift spot-checked and confirmed, so cited by
      // section name only rather than guessing a page/link (see the big
      // comment above PARAM_CONCEPTS for the verification method).
      { manualRef: manualRefPlain('§9.10 "Sampling into a Synth Instrument" (Loading Multisamples)'), conceptKey: 'osc.sample' });
  }
  if (osc.type === 'sample' && osc.fileName) {
    return makeStep(`${label}: load sample`,
      `${ck(`osc${oscNum}.type`, `${shift(`${col} TYPE`)}, turn SELECT to ${val('SAMPLE')}`)}. Then ${ck(`osc${oscNum}.fileName`, `${shift(`${sampleCol} BROWSE`)}, navigate to ${val(stripSamplesRoot(osc.fileName))} and press ${kbd('SELECT')} once to load it as a single chromatic sample (same sample, auto-tuned per note)`)}.
       ${ck(`osc${oscNum}.transpose`, `${shift(`${col} TRANSPOSE`)} to ${val(osc.transpose || 0)} semitones${osc.cents ? ` (${val(osc.cents)} cents fine-tune)` : ''}`)}.`,
      `${label} plays back ${ck(`osc${oscNum}.fileName`, `the sample ${val(stripSamplesRoot(osc.fileName))}`)} (${ck(`osc${oscNum}.transpose`, `transpose ${osc.transpose || 0} st`)}) rather than a synthesized waveform.`,
      [cf(`osc${oscNum}.type`, 'Type'), cf(`osc${oscNum}.fileName`, 'Sample'), cf(`osc${oscNum}.transpose`, 'Transpose')],
      { manualRef: manualRef('§9.10 "Sampling into a Synth Instrument" (Loading an Audio Sample into a Synth)', 190), conceptKey: 'osc.sample' });
  }
  const type = osc.type || 'square';
  const transpose = osc.transpose || '0';
  const cents = osc.cents || '0';
  const beginnerExtras = [];
  const expertExtras = [];
  if (transpose !== '0') {
    beginnerExtras.push(ck(`osc${oscNum}.transpose`, `${shift(`${col} TRANSPOSE`)} ${val(transpose + ' st')}`));
    expertExtras.push(ck(`osc${oscNum}.transpose`, `transpose ${val(transpose + ' st')}`));
  }
  // Was previously plain, un-wrapped text in the EXPERT line only (never
  // shown in Beginner mode at all, and not individually check-colorable
  // even in Expert) -- a real preset with a non-zero cents value (-9, a
  // clearly audible fine-tune) checked out fully "green" here purely
  // because nothing was ever actually comparing it, exactly the "sounds
  // different despite all-green steps" class of report this was found
  // from. Now shown in both modes and independently checkable, same
  // treatment as transpose right above it.
  if (cents !== '0') {
    beginnerExtras.push(ck(`osc${oscNum}.cents`, `${shift(`${col} TRANSPOSE`)} fine-tune to ${val(cents + ' cents')}`));
    expertExtras.push(ck(`osc${oscNum}.cents`, `fine-tune ${val(cents + ' cents')}`));
  }
  if (osc.oscillatorSync === '1') { beginnerExtras.push(`${shift('OSC SYNC')} on`); expertExtras.push(`${val('oscillator sync ON')} (hard-syncs to the other oscillator)`); }
  return makeStep(`${label}: waveform`,
    `${ck(`osc${oscNum}.type`, `${shift(`${col} TYPE`)}, turn SELECT to ${val(type)}`)}.${beginnerExtras.length ? ' Then ' + beginnerExtras.join(', ') + '.' : ''}`,
    `Set ${label} to ${ck(`osc${oscNum}.type`, `a ${val(type)} wave`)}${expertExtras.length ? ', ' + expertExtras.join(', ') : ''}.`,
    [cf(`osc${oscNum}.type`, 'Type'), cf(`osc${oscNum}.transpose`, 'Transpose'), cf(`osc${oscNum}.cents`, 'Cents')],
    { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Oscillator column)', 88), conceptKey: 'osc.type' });
}

// Real-hardware testing found the oscillator's phase-reset behavior
// completely uncovered: manual §4.8 confirms a dedicated shortcut, RETRIG
// PHASE ("Phase in degrees that the oscillator will be reset on note-on.
// Also can be switched off."), under the same OSCILLATOR 1/2 grid column
// as TRANSPOSE/PULSE WIDTH -- but raw retrigPhase="-1" (off) vs any other
// value is a real, audible difference (fixed phase alignment on every
// note vs. free-running) this guide never mentioned at all. Kept as its
// own step (same reasoning as pulse width: an independent on/off setting,
// not tied to waveform/transpose).
//
// Confirmed via firmware source (gui/menu_item/osc/retrigger_phase.h's own
// readCurrentValue(): `this->setValue(value / 11930464)`, with the menu's
// own getMinValue()/getMaxValue() of -1/360) and verified against the real
// corpus (every one of 28 distinct real raw values divides out to an exact
// multiple of 10 degrees, e.g. raw="238609280" -> 20 deg, one exception at
// 115 deg from manual fine-editing) -- the raw stored number is a signed
// reinterpretation of the same uint32 the menu divides by 11930464 to get
// whole degrees (0-360). Reported directly: "phase in the osc should be
// off, 0, 10, 20, 30, ..., 360. now some big integer values are shown".
function retrigPhaseDegrees(raw) {
  if (raw === undefined || raw === null) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n === -1) return null;
  const u = n < 0 ? n + 0x100000000 : n;
  return Math.floor(u / 11930464);
}
function describeRetrigPhase(osc, label, oscNum) {
  if (!osc || osc.retrigPhase === undefined) return null;
  const path = `osc${oscNum}.retrigPhase`;
  const off = osc.retrigPhase === '-1';
  if (off) return null; // "-1" is the off/free-running default -- nothing to build
  const col = `OSC${oscNum}`;
  const deg = retrigPhaseDegrees(osc.retrigPhase);
  return makeStep(`${label}: retrigger phase`,
    `${ck(path, `${shift(`${col} RETRIG PHASE`)} on, at ${val(deg + '°')} (0° = the very start of the waveform) instead of left off/free-running`)}.`,
    `${ck(path, `Retrigger phase: on (${val(deg + '°')})`)}.`,
    [cf(path, 'Retrig phase')],
    { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Oscillator column, Retrigger Phase)', 88), conceptKey: 'osc.retrigPhase' });
}

// Same real, audible on/off toggle as describeRetrigPhase() above, but for
// FM's operators -- confirmed via firmware source (gui/menu_item/generate/
// g_menus.inc: modulator0PhaseMenu/modulator1PhaseMenu are real
// osc::RetriggerPhase menu items, SHIFT+RETRIG PHASE in the MOD1/MOD2
// shortcut-pad row) and the real corpus (65 of 133 FM presets have
// modulator1.retrigPhase set, same -1=off / 0=on-at-start-of-waveform
// convention osc1/osc2 already use) -- previously not covered anywhere in
// this app at all for either modulator. Reported directly ("retriger ohe
// ... have shortcuts as well").
function describeModulatorRetrigPhase(mod, label, modNum) {
  if (!mod || mod.retrigPhase === undefined) return null;
  const path = `modulator${modNum}.retrigPhase`;
  if (mod.retrigPhase === '-1') return null; // off/free-running default
  const col = `MOD${modNum}`;
  const deg = retrigPhaseDegrees(mod.retrigPhase);
  return makeStep(`${label}: retrigger phase`,
    `${ck(path, `${shift(`${col} RETRIG PHASE`)} on, at ${val(deg + '°')} (0° = the very start of the waveform) instead of left off/free-running`)}.`,
    `${ck(path, `Retrigger phase: on (${val(deg + '°')})`)}.`,
    [cf(path, 'Retrig phase')],
    { manualRef: manualRef('§4.1 "Synthesizer Concepts" (FM Synthesis)', 81), conceptKey: 'fm' });
}

// Mod FX (chorus/flanger/phaser/...) params aren't uniformly available
// across every type -- confirmed via firmware source (gui/menu_item/mod_fx/
// {depth_patched,depth_unpatched,offset,feedback}.h's own isRelevant()):
// e.g. FLANGER has no Depth or Offset control at all, only Rate and
// Feedback. Reported directly ("flanger has no depth and offset. only rate
// and feedback"). Rate is relevant for every type except NONE (mod FX off
// entirely), so it's never gated here.
const MODFX_DEPTH_TYPES = new Set(['chorus', 'StereoChorus', 'grainFX', 'phaser', 'TapeWarble', 'dimension']);
const MODFX_OFFSET_TYPES = new Set(['chorus', 'StereoChorus', 'grainFX', 'TapeWarble', 'dimension']);
const MODFX_FEEDBACK_TYPES = new Set(['flanger', 'phaser', 'grainFX', 'TapeWarble']);

function buildGuide(patch) {
  const sections = [];
  const dp = patch.defaultParams || {};
  const isFm = patch.mode === 'fm';
  // Confirmed directly against firmware source (gui/menu_item/osc/source/
  // volume.h's own isRelevant(): `return sound->getSynthMode() !=
  // SynthMode::RINGMOD;`) -- the OSC1/OSC2 LEVEL menu item is not just
  // unused but literally hidden/inaccessible on real hardware in Ring Mod
  // mode, since the two oscillators are multiplied rather than mixed at
  // independent levels. Reported directly: "ringmod does not support osc
  // level, but step is shown".
  const isRingmod = patch.mode === 'ringmod';
  const push = (title, steps) => {
    const s = steps.filter(Boolean);
    if (s.length) sections.push({ title, steps: s });
  };

  // --- Getting started -----------------------------------------------
  push('Getting started', [
    makeStep('Start from an init patch',
      `Create a fresh synth clip with ${shift('SYNTH')} (creates a blank subtractive square-wave patch) so you start from Deluge's own init sound before dialling in the steps below.`,
      `Start from the Deluge init preset.`,
      null,
      { manualRef: manualRef('§4.7 "Creating a New Synthesizer"', 93) }),
    patch.mode && patch.mode !== INIT.mode
      ? makeStep('Synth engine mode',
          `${shift('SYNTH MODE')}, turn SELECT to ${ck('mode', val(patch.mode.toUpperCase()))} before anything else &mdash; the FM/ring-mod engine changes what the oscillator controls do.`,
          `This patch uses the ${ck('mode', val(patch.mode))} engine rather than subtractive.`,
          [cf('mode', 'Mode')],
          { manualRef: manualRef('"Selecting FM, Ring Mod or Subtractive Synthesizer"', 94), conceptKey: patch.mode === 'fm' ? 'fm' : undefined })
      : null,
    // Level/Pan/Master transpose grouped here (rather than Level/Pan
    // staying back in the Mixer section) because they're physically
    // adjacent on real hardware -- confirmed against firmware source
    // (gui/ui/menus.cpp's paramShortcutsForSounds grid: &volumeMenu,
    // &masterTransposeMenu, &vibratoMenu, &panMenu and &synthModeMenu all
    // sit in the same shortcut-grid column). Reported directly: "would be
    // nice if after synth mode, master level, then pan and then master
    // transpose would follow, as they are shown in the same [grid
    // column]". Vibrato is deliberately left out of this reordering --
    // it's really "LFO1 routed to pitch" and belongs with the rest of the
    // modulation-routing steps, not as a standalone defaultParams field.
    (dp.volume && q31Differs(dp.volume, INIT.volume))
      ? makeStep('Level',
          `${ck('defaultParams.volume', `${shift('LEVEL')} set to ${val(dv(dp.volume))}`)}.`,
          `${ck('defaultParams.volume', `Overall level: ${val(rawPct(dp.volume) + '%')}`)}.`,
          [cf('defaultParams.volume', 'Level')],
          { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Level)', 88), conceptKey: 'mixer.level' })
      : null,
    (dp.pan && q31Differs(dp.pan, INIT.pan))
      ? makeStep('Pan',
          `${ck('defaultParams.pan', `${shift('PAN')} set to ${val(dvPan(dp.pan))} (range -25 left to +25 right)`)}.`,
          `${ck('defaultParams.pan', `Pan: ${val(pctOfPan(dp.pan) + '%')}`)} (negative = left).`,
          [cf('defaultParams.pan', 'Pan')],
          { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Pan)', 92), conceptKey: 'mixer.pan' })
      : null,
    // Confirmed real via firmware source (gui/menu_item/master_transpose.h)
    // and the real preset corpus (58 files with a genuine non-zero value,
    // e.g. Factory/070 Glockenspiel.XML=12, Factory/146 Atmospheric Squares
    // Pad.XML=-8) -- this is the WHOLE-PATCH transpose (Sound::transpose),
    // separate from OSC1/OSC2's own per-oscillator transpose steps below.
    // Reported directly against real hardware: SHIFT+XPOSE, in the MASTER
    // section -- corrects an earlier, wrong assumption (drawn from the
    // shortcut-pad grid in firmware source alone) that there was no
    // dedicated pad for this. Gate also fires on cents alone (fine-tune
    // can differ even while whole-semitone transpose stays 0) -- found via
    // a systematic audit of every buildCheckSteps() field ("its own field
    // has no visible step" class of bug, same as several others this
    // session): 'cents' was always an unconditional check field, but this
    // whole step -- the only place it's ever mentioned -- used to gate on
    // transpose alone.
    (patch.transpose && patch.transpose !== '0') || (patch.cents && patch.cents !== '0')
      ? makeStep('Master transpose',
          `${ck('transpose', `${shift('XPOSE')} (under MASTER) to ${val(patch.transpose || 0)} semitones${patch.cents && patch.cents !== '0' ? ` (${val(patch.cents)} cents fine-tune)` : ''}`)}.`,
          `Master transpose: ${ck('transpose', val((patch.transpose || 0) + ' st'))}${patch.cents && patch.cents !== '0' ? `, ${ck('cents', val(patch.cents + ' cents'))} fine-tune` : ''}.`,
          [cf('transpose', 'Transpose'), cf('cents', 'Cents')])
      : null,
    (patch.polyphonic && patch.polyphonic !== INIT.polyphonic)
      ? makeStep('Polyphony',
          `${shift('POLYPHONY')}, turn SELECT to ${ck('polyphonic', val(patch.polyphonic.toUpperCase()))}.`,
          `Polyphony: ${ck('polyphonic', val(patch.polyphonic))}.`,
          [cf('polyphonic', 'Polyphony')],
          { manualRef: manualRef('§4.11 "Deluge Voices" (Setting the Synth Polyphony)', 105) })
      : null,
  ]);

  // --- Oscillators ------------------------------------------------------
  // In FM mode, osc1/osc2 are plain-sine carriers (their "type" is not
  // selectable), and modulator1/2 are the actual FM operators shaping them
  // -- so the waveform-picking steps used for subtractive/ringmod don't apply.
  const oscSteps = [];
  if (patch.mode === 'fm') {
    const fmRef = { manualRef: manualRef('§4.1 "Synthesizer Concepts" (FM Synthesis)', 81), conceptKey: 'fm' };
    // Carriers can self-feedback too, just like the modulators -- confirmed
    // via firmware source (gui/ui/menus.cpp's shortcut grid: source0/
    // source1FeedbackMenu sit in the SAME row as Volume/Transpose/Type,
    // SHIFT+FEEDBACK) and the real corpus (many FM presets have a
    // genuinely non-default carrier1Feedback/carrier2Feedback, e.g.
    // Fmhh.XML/Fmsn.XML at the max 0x7FFFFFFF) -- previously not covered
    // anywhere in this app at all. Reported directly: a real preset's
    // status line read fewer matches than every visible (green) step
    // could account for -- a gold knob reassigned straight to
    // carrier1Feedback (no matching guide step or check field at all) was
    // one of the two invisible gaps.
    const carrier1Fb = (dp.carrier1Feedback && q31Differs(dp.carrier1Feedback, INIT.modulatorAmount)) ? dp.carrier1Feedback : null;
    const carrier2Fb = (dp.carrier2Feedback && q31Differs(dp.carrier2Feedback, INIT.modulatorAmount)) ? dp.carrier2Feedback : null;
    if (patch.osc1) oscSteps.push(makeStep('FM Carrier 1',
      `${ck('osc1.transpose', `${shift('OSC1 TRANSPOSE')} ${val((patch.osc1.transpose || 0) + ' st')}${patch.osc1.cents && patch.osc1.cents !== '0' ? ` (fine-tune ${val(patch.osc1.cents + ' cents')})` : ''}`)}${carrier1Fb ? `. ${ck('defaultParams.carrier1Feedback', `${shift('OSC1 FEEDBACK')} ${val(dv(carrier1Fb))}`)}` : ''}.`,
      `${ck('osc1.transpose', `Carrier 1 transpose ${val(patch.osc1.transpose || 0)} st`)}${carrier1Fb ? `, ${ck('defaultParams.carrier1Feedback', `feedback ${val(rawPct(carrier1Fb) + '%')}`)}` : ''}.`,
      [cf('osc1.transpose', 'Transpose'), carrier1Fb && cf('defaultParams.carrier1Feedback', 'Feedback')].filter(Boolean), fmRef));
    if (patch.osc2) oscSteps.push(makeStep('FM Carrier 2',
      `${ck('osc2.transpose', `${shift('OSC2 TRANSPOSE')} ${val((patch.osc2.transpose || 0) + ' st')}${patch.osc2.cents && patch.osc2.cents !== '0' ? ` (fine-tune ${val(patch.osc2.cents + ' cents')})` : ''}`)}${carrier2Fb ? `. ${ck('defaultParams.carrier2Feedback', `${shift('OSC2 FEEDBACK')} ${val(dv(carrier2Fb))}`)}` : ''}.`,
      `${ck('osc2.transpose', `Carrier 2 transpose ${val(patch.osc2.transpose || 0)} st`)}${carrier2Fb ? `, ${ck('defaultParams.carrier2Feedback', `feedback ${val(rawPct(carrier2Fb) + '%')}`)}` : ''}.`,
      [cf('osc2.transpose', 'Transpose'), carrier2Fb && cf('defaultParams.carrier2Feedback', 'Feedback')].filter(Boolean), fmRef));
    if (patch.modulator1) {
      const amt = (dp.modulator1Amount && q31Differs(dp.modulator1Amount, INIT.modulatorAmount)) ? dp.modulator1Amount : null;
      const fb = (dp.modulator1Feedback && q31Differs(dp.modulator1Feedback, INIT.modulatorAmount)) ? dp.modulator1Feedback : null;
      oscSteps.push(makeStep('FM Modulator 1 (shapes Carrier 1 & 2)',
        `${ck('modulator1.transpose', `${shift('MOD1 TRANSPOSE')} ${val((patch.modulator1.transpose || 0) + ' st')}`)}${amt ? `. ${ck('defaultParams.modulator1Amount', `${shift('MOD1 LEVEL')} ${val(dv(amt))}`)}` : ''}${fb ? `. ${ck('defaultParams.modulator1Feedback', `${shift('MOD1 FEEDBACK')} ${val(dv(fb))}`)}` : ''}.`,
        `${ck('modulator1.transpose', `Modulator 1: transpose ${val(patch.modulator1.transpose || 0)} st`)}${amt ? `, ${ck('defaultParams.modulator1Amount', `amount ${val(rawPct(amt) + '%')}`)}` : ''}${fb ? `, ${ck('defaultParams.modulator1Feedback', `feedback ${val(rawPct(fb) + '%')}`)}` : ''}.`,
        [cf('modulator1.transpose', 'Transpose'), cf('defaultParams.modulator1Amount', 'Amount'), cf('defaultParams.modulator1Feedback', 'Feedback')], fmRef));
      oscSteps.push(describeModulatorRetrigPhase(patch.modulator1, 'FM Modulator 1', 1));
    }
    if (patch.modulator2) {
      const amt = (dp.modulator2Amount && q31Differs(dp.modulator2Amount, INIT.modulatorAmount)) ? dp.modulator2Amount : null;
      const fb = (dp.modulator2Feedback && q31Differs(dp.modulator2Feedback, INIT.modulatorAmount)) ? dp.modulator2Feedback : null;
      const feedsMod1 = patch.modulator2.toModulator1 && patch.modulator2.toModulator1 !== '0';
      oscSteps.push(makeStep('FM Modulator 2 (shapes Carrier 2)',
        `${ck('modulator2.transpose', `${shift('MOD2 TRANSPOSE')} ${val((patch.modulator2.transpose || 0) + ' st')}`)}${amt ? `. ${ck('defaultParams.modulator2Amount', `${shift('MOD2 LEVEL')} ${val(dv(amt))}`)}` : ''}${fb ? `. ${ck('defaultParams.modulator2Feedback', `${shift('MOD2 FEEDBACK')} ${val(dv(fb))}`)}` : ''}${feedsMod1 ? `. ${ck('modulator2.toModulator1', `${shift('MOD2 DESTINATION')} set to ${val('MOD1')} so it also feeds Modulator 1`)}` : ''}.`,
        `${ck('modulator2.transpose', `Modulator 2: transpose ${val(patch.modulator2.transpose || 0)} st`)}${amt ? `, ${ck('defaultParams.modulator2Amount', `amount ${val(rawPct(amt) + '%')}`)}` : ''}${fb ? `, ${ck('defaultParams.modulator2Feedback', `feedback ${val(rawPct(fb) + '%')}`)}` : ''}${feedsMod1 ? `, ${ck('modulator2.toModulator1', 'feeding into modulator 1')}` : ''}.`,
        [cf('modulator2.transpose', 'Transpose'), cf('defaultParams.modulator2Amount', 'Amount'), cf('defaultParams.modulator2Feedback', 'Feedback'), feedsMod1 && cf('modulator2.toModulator1', 'Destination')].filter(Boolean), fmRef));
      oscSteps.push(describeModulatorRetrigPhase(patch.modulator2, 'FM Modulator 2', 2));
    }
  } else {
    oscSteps.push(describeOsc(patch.osc1, 'Oscillator 1', 1));
    oscSteps.push(describePulseWidth(dp, 'Oscillator 1', 1));
    oscSteps.push(describeRetrigPhase(patch.osc1, 'Oscillator 1', 1));
    oscSteps.push(describeOsc(patch.osc2, 'Oscillator 2', 2));
    oscSteps.push(describePulseWidth(dp, 'Oscillator 2', 2));
    oscSteps.push(describeRetrigPhase(patch.osc2, 'Oscillator 2', 2));
  }
  push('Oscillators', oscSteps);

  // --- Mixer / levels -----------------------------------------------
  // Level and Pan moved up into "Getting started" (see the comment there) --
  // they're physically adjacent to Synth mode/Master transpose on real
  // hardware, in the same shortcut-grid column.
  const mixSteps = [];
  // Previously assumed OSC1 always stays at its own default ("near full")
  // whenever OSC2's level was the one that changed, and never checked
  // oscAVolume itself at all -- silently dropping OSC1's own level
  // whenever IT was the one actually changed (reported directly against
  // real hardware: "osc1 level step missing", a preset with OSC1 LEVEL
  // turned down and OSC2 left at default). Now checks both independently
  // and only claims "stays near full" about whichever one truly didn't
  // change.
  const oscAVolChanged = !isRingmod && dp.oscAVolume && q31Differs(dp.oscAVolume, INIT.oscAVolume);
  const oscBVolChanged = !isRingmod && dp.oscBVolume && q31Differs(dp.oscBVolume, INIT.oscBVolume);
  if (oscAVolChanged || oscBVolChanged) {
    const beginnerParts = [
      oscAVolChanged && ck('defaultParams.oscAVolume', `${shift('OSC1 LEVEL')} to ${val(dv(dp.oscAVolume))}`),
      oscBVolChanged && ck('defaultParams.oscBVolume', `${shift('OSC2 LEVEL')} to ${val(dv(dp.oscBVolume))}`),
    ].filter(Boolean);
    const expertParts = [
      oscAVolChanged && ck('defaultParams.oscAVolume', `OSC1 level ${val(rawPct(dp.oscAVolume) + '%')}`),
      oscBVolChanged && ck('defaultParams.oscBVolume', `OSC2 level ${val(rawPct(dp.oscBVolume) + '%')}`),
    ].filter(Boolean);
    const caveat = (oscAVolChanged && oscBVolChanged) ? ''
      : oscAVolChanged ? ` (OSC2 stays near full via ${kbd('OSC2 LEVEL')})`
      : ` (OSC1 stays near full via ${kbd('OSC1 LEVEL')})`;
    mixSteps.push(makeStep('Balance OSC1 / OSC2',
      `${beginnerParts.join('. ')}${caveat}.`,
      `${expertParts.join(', ')}${caveat}.`,
      [oscAVolChanged && cf('defaultParams.oscAVolume', 'OSC1 level'), oscBVolChanged && cf('defaultParams.oscBVolume', 'OSC2 level')].filter(Boolean),
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Oscillator column)', 88), conceptKey: 'mixer.balance' }));
  }
  if (dp.noiseVolume && q31Differs(dp.noiseVolume, INIT.noiseVolume)) {
    mixSteps.push(makeStep('Add noise',
      `${ck('defaultParams.noiseVolume', `${shift('NOISE')} set to ${val(dv(dp.noiseVolume))}`)}.`,
      `${ck('defaultParams.noiseVolume', `Blend in noise at ${val(rawPct(dp.noiseVolume) + '%')}`)}.`,
      [cf('defaultParams.noiseVolume', 'Noise')],
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Noise Level)', 89), conceptKey: 'mixer.noise' }));
  }
  push('Mixer', mixSteps);

  // --- Unison -----------------------------------------------------------
  const uni = patch.unison;
  const voiceSteps = [];
  if (uni && parseInt(uni.num, 10) > 1) {
    voiceSteps.push(makeStep('Stack voices',
      `${ck('unison.num', `${shift('NUMBER')} (under VOICE) set to ${val(uni.num)}`)}${plainDiffers(uni.detune, INIT.unisonDetune) ? `. ${ck('unison.detune', `${shift('DETUNE')} to ${val(uni.detune || 0)}`)}` : ''}${uni.spread && uni.spread !== '0' ? `. ${ck('unison.spread', `Spread to ${val(uni.spread)} via the SOUND menu (no dedicated shortcut pad for spread)`)}.` : ''}.`,
      `${ck('unison.num', `${val(uni.num)}-voice unison`)}, ${ck('unison.detune', `detune ${val(uni.detune || 0)}`)}${uni.spread && uni.spread !== '0' ? `, ${ck('unison.spread', `spread ${val(uni.spread)}`)}` : ''}.`,
      [cf('unison.num', 'Voices'), cf('unison.detune', 'Detune'), cf('unison.spread', 'Spread')],
      // Voice count/detune are official (grid table, p.90); stereo spread
      // specifically is a community-firmware addition (community_features.txt
      // §4.5.2 "Unison Stereo Spread") -- mixed step, so the primary citation
      // stays the official one rather than conflating the two.
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Unison)', 90), conceptKey: 'unison' }));
  }
  if (dp.portamento && q31Differs(dp.portamento, INIT.portamento)) {
    voiceSteps.push(makeStep('Portamento (glide)',
      `${ck('defaultParams.portamento', `${shift('PORTA')} (under VOICE) set to ${val(dv(dp.portamento))}`)}.`,
      `${ck('defaultParams.portamento', `Portamento: ${val(rawPct(dp.portamento) + '%')}`)}.`,
      [cf('defaultParams.portamento', 'Portamento')],
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Portamento)', 90), conceptKey: 'portamento' }));
  }
  push('Unison', voiceSteps);

  // --- Filter -------------------------------------------------------
  // FM mode has no filter at all -- confirmed via firmware source
  // (processing/sound/sound.cpp's readFromFile(): "old FM patches can have
  // a filter mode saved in them even though it wouldn't have rendered at
  // the time"). That stale lpfMode/hpfMode data isn't just cosmetically
  // wrong when the patch predates some firmware version -- it's NEVER
  // relevant for FM, on any firmware, since the filter section never
  // applies to this engine at all. Found on a real preset ("Fmbd.XML"):
  // lpfMode="flanger" (not even a real filter-slope value, apparently a
  // stray leftover from mod-fx state) produced a guide step reading
  // "cycle the filter slope to FLANGER" -- nonsensical on hardware that
  // has no LPF menu to even find in FM mode. Skips the whole section
  // rather than only the Mode steps, since Frequency/Resonance are
  // equally irrelevant here regardless of what their own stale values say.
  if (!isFm) {
    const filterSteps = [];
    // Frequency/Resonance get their own step, split off from Mode: both are
    // real MIDI-Follow-mappable params, but bundling lpfMode's enum into the
    // same step's checkFields used to disqualify the *whole* step from ever
    // going live (see isLiveStep()'s "one uncovered field disqualifies the
    // whole step" rule) -- found via real-hardware testing reporting these
    // as never showing live despite turning the actual FREQUENCY/RESONANCE
    // knobs. Mode keeps its own inline display here (still individually
    // check-colored via its own data-check-path span) but moves to a
    // separate conditional step below so its file-check status doesn't
    // silently stop being tracked.
    if (dp.lpfFrequency && (q31Differs(dp.lpfFrequency, INIT.lpfFrequency) || (dp.lpfResonance && q31Differs(dp.lpfResonance, INIT.lpfResonance)))) {
      const lpfMode = patch.lpfMode || INIT.lpfMode;
      filterSteps.push(makeStep('Low-pass filter',
        `${ck('defaultParams.lpfFrequency', `${shift('FREQUENCY')} (under LPF) to ${val(dv(dp.lpfFrequency))}`)}${dp.lpfResonance ? `. ${ck('defaultParams.lpfResonance', `${shift('RESONANCE')} to ${val(dv(dp.lpfResonance))}`)}` : ''}.`,
        `LPF (${ck('lpfMode', val(lpfMode))}) ${ck('defaultParams.lpfFrequency', `cutoff ${val(rawPct(dp.lpfFrequency) + '%')}`)}, ${ck('defaultParams.lpfResonance', `resonance ${val(dp.lpfResonance ? rawPct(dp.lpfResonance) + '%' : '0%')}`)}.`,
        [cf('defaultParams.lpfFrequency', 'Freq'), cf('defaultParams.lpfResonance', 'Res')],
        { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (LPF)', 89), conceptKey: 'filter.lpf' }));
    }
    const lpfModeNow = patch.lpfMode || INIT.lpfMode;
    if (plainDiffers(lpfModeNow, INIT.lpfMode)) {
      filterSteps.push(makeStep('Low-pass filter mode',
        `${ck('lpfMode', `${shift('DB/OCT')} (under LPF) to cycle the filter slope to ${val(lpfModeNow)}`)}.`,
        `LPF mode: ${ck('lpfMode', val(lpfModeNow))}.`,
        [cf('lpfMode', 'Mode')],
        { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (LPF)', 89), conceptKey: 'filter.lpf' }));
    }
    // Same OR-gate as LPF above (resonance alone, frequency still at
    // default, must still show the step) -- found via a systematic audit
    // of every buildCheckSteps() field: 'defaultParams.hpfResonance' was
    // always unconditionally checked, but this HPF gate, unlike the LPF
    // one right above it, never considered resonance on its own a reason
    // to show the step at all.
    if (dp.hpfFrequency && (q31Differs(dp.hpfFrequency, INIT.hpfFrequency) || (dp.hpfResonance && q31Differs(dp.hpfResonance, INIT.hpfResonance)))) {
      const hpfMode = patch.hpfMode || INIT.hpfMode;
      filterSteps.push(makeStep('High-pass filter',
        `${ck('defaultParams.hpfFrequency', `${shift('FREQUENCY')} (under HPF) to ${val(dv(dp.hpfFrequency))}`)}${dp.hpfResonance ? `. ${ck('defaultParams.hpfResonance', `${shift('RESONANCE')} to ${val(dv(dp.hpfResonance))}`)}` : ''}.`,
        `HPF (${ck('hpfMode', val(hpfMode))}) ${ck('defaultParams.hpfFrequency', `cutoff ${val(rawPct(dp.hpfFrequency) + '%')}`)}.`,
        [cf('defaultParams.hpfFrequency', 'Freq'), cf('defaultParams.hpfResonance', 'Res')],
        { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (HPF)', 89), conceptKey: 'filter.hpf' }));
    }
    const hpfModeNow = patch.hpfMode || INIT.hpfMode;
    if (plainDiffers(hpfModeNow, INIT.hpfMode)) {
      filterSteps.push(makeStep('High-pass filter mode',
        `${ck('hpfMode', `HPF type to ${val(hpfModeNow)} via the SOUND menu (${selectMenu('HPF &gt; MODE')}; no dedicated shortcut pad)`)}.`,
        `HPF mode: ${ck('hpfMode', val(hpfModeNow))}.`,
        [cf('hpfMode', 'Mode')],
        { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (HPF)', 89), conceptKey: 'filter.hpf' }));
    }
    if (patch.filterRoute && patch.filterRoute !== INIT.filterRoute) {
      filterSteps.push(makeStep('Filter routing',
        `${ck('filterRoute', `${selectMenu('SOUND &gt; FILTER ROUTE')} set to ${val(patch.filterRoute)}`)}.`,
        `${ck('filterRoute', `Filter route: ${val(patch.filterRoute)}`)}.`,
        [cf('filterRoute', 'Route')],
        // Confirmed via grep: no "FILTER ROUTE"/"Parallel" mention anywhere in
        // the official manual text, but community_features.txt documents it
        // explicitly ("FILTER ROUTE is accessible via the SOUND menu only...")
        // under its "4.2.1 - Filters" heading.
        { manualRef: communityRef('§4.2.1 "Filters" (Filter Route)', '421---filters'), conceptKey: 'filter.route' }));
    }
    push('Filter', filterSteps);
  }

  // --- Envelopes ----------------------------------------------------
  function envStep(env, initEnv, label, envNum) {
    if (!env) return null;
    const fields = ['attack', 'decay', 'sustain', 'release'];
    const changed = fields.some(f => env[f] && q31Differs(env[f], initEnv[f]));
    if (!changed) return null;
    const path = (f) => `defaultParams.envelope${envNum}.${f}`;
    const expertParts = fields.map(f => ck(path(f), `${f[0].toUpperCase()}${f.slice(1)} ${val((env[f] ? rawPct(env[f]) : 0) + '%')}`));
    const beginnerParts = fields.map(f => ck(path(f), `${shift(f.toUpperCase())} ${val(env[f] ? dv(env[f]) : 0)}`));
    return makeStep(label,
      `Under ENVELOPE ${envNum}: ${beginnerParts.join(', ')}.`,
      `${label}: ${expertParts.join(', ')}.`,
      fields.map(f => cf(path(f), f[0].toUpperCase())),
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Envelope ' + envNum + ')', 89), conceptKey: envNum === 1 ? 'envelope.amp' : 'envelope.filter' });
  }
  push('Envelopes', [
    envStep(patch.envelope1 || get(dp, 'envelope1'), INIT.env1, 'Envelope 1 (amp)', 1),
    envStep(patch.envelope2 || get(dp, 'envelope2'), INIT.env2, 'Envelope 2 (filter)', 2),
  ]);

  // --- LFOs & modulation matrix --------------------------------------
  const cables = cablesOf(patch);
  const goldKnobCables = goldKnobControlledCables(patch);
  const lfoSteps = [];
  ['lfo1', 'lfo2'].forEach((key, i) => {
    const n = i + 1;
    const lfo = patch[key];
    const rateKey = `lfo${n}Rate`;
    const routed = cables.some(c => c.source === key);
    const rateChanged = dp[rateKey] && q31Differs(dp[rateKey], INIT[rateKey] || '0x00000000');
    // Sync being turned on is its own reason to show this LFO's step, same
    // as being routed or having its rate changed -- previously missing
    // from this gate entirely, so a preset with ONLY syncLevel set (rate
    // still default, not yet routed anywhere) showed no LFO step at all,
    // silently dropping the one place syncLevel is ever mentioned.
    // Reported directly against real hardware ("lfo sync steps missing")
    // using a test patch built exactly that way.
    const syncChanged = lfo && lfo.syncLevel && lfo.syncLevel !== '0';
    // Shape is its own reason to show this LFO's step too, same as being
    // routed/rate-changed/synced -- "triangle" is the real firmware
    // default (confirmed: deluge-check.js's own INIT_PATCH_XML fixture),
    // matching the display fallback `lfo.type || 'triangle'` just below.
    // Previously missing from this gate entirely, so a preset with ONLY
    // its shape changed (still unrouted, rate/sync both at default) showed
    // no LFO step at all, yet buildCheckSteps() still checked shape
    // unconditionally -- an invisible mismatch with no step to explain
    // it. Reported directly via the "Still to check" popup itself
    // ("still to check lfo shape, but no lfo steps visible").
    const shapeChanged = lfo && lfo.type && lfo.type !== 'triangle';
    if (!lfo || (!routed && !rateChanged && !syncChanged && !shapeChanged)) return;
    // Rate gets its own step, split off from Shape/Sync: Rate is a real
    // MIDI-Follow-mappable param, but Shape (an enum) and Sync (a list, see
    // syncLevelName()'s own comment) are neither -- bundling all three into
    // one step's checkFields used to disqualify the *whole* step from ever
    // going live (isLiveStep()'s "one uncovered field disqualifies the
    // whole step" rule), same class of bug as the earlier LPF/HPF Mode
    // split. Reported directly against real hardware: "lfo rate also"
    // [should be live].
    lfoSteps.push(makeStep(`LFO ${n}`,
      `${ck(`lfo${n}.type`, `${shift(`LFO${n} SHAPE`)} to ${val(lfo.type || 'triangle')}`)}${lfo.syncLevel && lfo.syncLevel !== '0' ? `. ${ck(`lfo${n}.syncLevel`, `${shift(`LFO${n} SYNC`)} to ${val(syncLevelName(packedSyncOption(lfo.syncLevel, lfo.syncType)))}`)}` : ''}.`,
      `${ck(`lfo${n}.type`, `LFO${n}: ${val(lfo.type || 'triangle')} wave`)}${lfo.syncLevel && lfo.syncLevel !== '0' ? `, ${ck(`lfo${n}.syncLevel`, `synced to ${val(syncLevelName(packedSyncOption(lfo.syncLevel, lfo.syncType)))}`)}` : ''}.`,
      // buildCheckSteps() only covers lfo1/lfo2 -- no check field for lfo3/lfo4.
      (n === 1 || n === 2)
        ? [cf(`lfo${n}.type`, 'Shape'), cf(`lfo${n}.syncLevel`, 'Sync')]
        : null,
      { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (LFO ' + n + ')', 90), conceptKey: 'lfo' }));
    if (rateChanged) {
      lfoSteps.push(makeStep(`LFO ${n} rate`,
        `${ck(`defaultParams.lfo${n}Rate`, `${shift(`LFO${n} RATE`)} to ${val(dv(dp[rateKey]))}`)}.`,
        `${ck(`defaultParams.lfo${n}Rate`, `LFO${n} rate ${val(rawPct(dp[rateKey]) + '%')}`)}.`,
        (n === 1 || n === 2) ? [cf(`defaultParams.lfo${n}Rate`, 'Rate')] : null,
        { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (LFO ' + n + ')', 90), conceptKey: 'lfo' }));
    }
  });
  push('LFOs', lfoSteps);

  // The init patch itself already ships 3 default routings (INIT_CABLES); skip
  // showing them as a "step" unless their depth was actually changed, same
  // treatment as every other section.
  // A cable whose own depth is itself modulated by a second source (a real
  // "double mod", see cablesOf()'s own comment) gets its own SEPARATE step
  // here -- previously only a footnote sentence tacked onto the outer
  // cable's step, which real usage found effectively invisible ("fehlt
  // gänzlich", i.e. reads as entirely missing) next to Mod Matrix's own
  // extra column and Signal Path's own loop arrow both giving it a genuine
  // first-class, separately-noticeable spot. Its own checkbox also lets
  // "I've set the main depth" and "I've set the chained depth" be ticked
  // off independently, instead of one shared checkbox covering both.
  // Real-hardware-confirmed gesture (not in the official manual, but
  // verified directly on a device rather than guessed at): don't leave the
  // connection's own depth menu after turning SELECT for its base depth --
  // press SELECT a second time right there to open that SAME connection's
  // own "modulate depth" menu. An earlier version of this text said the
  // second source is picked by holding its shortcut pad (same gesture as
  // the OUTER connection) -- corrected directly against real hardware: at
  // THIS nested depth, there's no shortcut-pad step at all, it's entirely
  // SELECT-encoder-driven -- turn SELECT to choose the source, press SELECT
  // again to open its own depth screen, then turn SELECT there for its
  // depth (and, like any other polarity-eligible source, press MIDI/CV
  // while still in that screen to set ITS OWN bipolar/unipolar -- reported
  // directly: "dial in amount AND Bi/Uni"). Not vibrato-specific --
  // confirmed generic to any patched cable, since the firmware source's own
  // PatchCableStrength/SourceSelection menu items handle a normal cable and
  // a range-adjusting one through the identical UI, just gated on whether
  // the destination is a plain param or another cable's depth.
  // `modulator` is one specific entry of c.depthModulators -- a cable's
  // depth can be modulated by MORE THAN ONE second source at once
  // (confirmed on a real preset: BOC01/BOD01_49-From the distance.XML has
  // LFO1's own vibrato depth modulated by BOTH lfo1 AND random
  // simultaneously), so this generates one step PER modulator, called once
  // per entry in c.depthModulators below -- never collapsed to just one.
  // `depthAmountKey` includes the modulator's own source specifically
  // (cableDepthField()'s key format matches) so two modulators on the same
  // cable get two independently-checkable fields, not one shared key that
  // only the last one written would win.
  function depthModStep(parentTitle, c, modulator, disambiguate) {
    const depthAmountKey = `cable:depth:${c.source}->${c.destination}:${modulator.source}`;
    const depthSrcLabel = SOURCE_LABEL[modulator.source] || humanize(modulator.source);
    const depthBeginnerAmt = fmtCable(modulator.amount);
    const depthExpertAmt = pctOfCable(modulator.amount) + '%';
    const title = disambiguate ? `${parentTitle}: chained depth modulation (${depthSrcLabel})` : `${parentTitle}: chained depth modulation`;
    // This nested modulator is its own cable with its own polarity (see
    // cablesOf()'s own comment) -- same eligibility rule and gesture as any
    // other cable's polarity (cableHasPolarity()), just reached one menu
    // level deeper.
    const depthPolarityEligible = cableHasPolarity(modulator.source) && modulator.polarity;
    const depthPolarityKey = `cable:depth:polarity:${c.source}->${c.destination}:${modulator.source}`;
    const depthPolarityButton = modulator.polarity === 'unipolar' ? 'CV' : 'MIDI';
    const depthPolarityNote = depthPolarityEligible
      ? ` While still in that screen: press ${kbd(depthPolarityButton)} to set its polarity to ${ck(depthPolarityKey, val(modulator.polarity.toUpperCase()))}.`
      : '';
    const checkFields = depthPolarityEligible
      ? [cf(depthAmountKey, 'Depth mod'), cf(depthPolarityKey, 'Depth mod polarity')]
      : [cf(depthAmountKey, 'Depth mod')];
    return makeStep(title,
      `Right after setting that depth above -- don't back out of the menu: press SELECT once more to open this connection's own "modulate depth" menu, turn SELECT to choose ${val(depthSrcLabel)} as the second source, press SELECT again to open its own depth screen, then turn SELECT there to set its depth to ${ck(depthAmountKey, val(depthBeginnerAmt))} (range -50.00 to 50.00).${depthPolarityNote}`,
      `${ck(depthAmountKey, `Depth-of-depth (${val(depthSrcLabel)}): ${val(depthExpertAmt)}`)}.${depthPolarityNote}`,
      checkFields,
      {
        manualRef: manualRef('§6.1 "Modulation Routing Basics"', 124), conceptKey: 'modmatrix',
        why: `A "double mod": ${depthSrcLabel} doesn't modulate ${destDisplayName(c.destination)} directly here -- it modulates how STRONG ${parentTitle}'s own connection is, moment to moment, on top of that connection's own base depth.`,
        indent: true,
      });
  }
  // One depthModStep() per entry in c.depthModulators, tagging each one's
  // title with its source only when there's more than one (the common
  // single-modulator case keeps the plainer, un-suffixed title).
  function depthModSteps(parentTitle, c) {
    if (!c.depthModulators) return [];
    return c.depthModulators.map(m => depthModStep(parentTitle, c, m, c.depthModulators.length > 1));
  }
  const cableSteps = cables
    .filter(c => c.source && c.destination && !cableIsDefault(c))
    .flatMap(c => {
      const srcLabel = SOURCE_LABEL[c.source] || humanize(c.source);
      const beginnerAmt = fmtCable(c.amount);
      const expertAmt = pctOfCable(c.amount) + '%';
      // Matches cableField()'s own key format exactly -- see deluge-check.js.
      const connectKey = `cable:connect:${c.source}->${c.destination}`;
      const amountKey = `cable:amount:${c.source}->${c.destination}`;
      // Brief pointer only -- depthModStep() above carries the full
      // instruction, its own checkable field, and its own "why".
      const depthNote = !c.depthModulators ? ''
        : c.depthModulators.length > 1
          ? ' (see the next steps: this connection’s own depth is itself further modulated by more than one source.)'
          : ' (see the next step: this connection’s own depth is itself further modulated.)';
      // Polarity (bipolar vs unipolar) -- real, switchable, confirmed
      // audible via real-hardware testing, but with no reliable "is this
      // at its own default" answer (see cableHasPolarity()'s own comment),
      // so always stated explicitly rather than only mentioned when
      // "changed". Real-hardware-confirmed gesture (firmware source,
      // PatchCableStrength::buttonAction(): a hardcoded {MIDI: BIPOLAR,
      // CV: UNIPOLAR} map): while still in this connection's own depth
      // menu (the same one the depth turn/chained-depth-mod steps use),
      // press the dedicated MIDI button for bipolar or the dedicated CV
      // button for unipolar.
      const polarityEligible = cableHasPolarity(c.source) && c.polarity;
      const polarityKey = `cable:polarity:${c.source}->${c.destination}`;
      const polarityButton = c.polarity === 'unipolar' ? 'CV' : 'MIDI';
      const polarityNote = polarityEligible
        ? ` While still in that depth menu: press ${kbd(polarityButton)} to set its polarity to ${ck(polarityKey, val(c.polarity.toUpperCase()))}.`
        : '';
      const goldKnobControlled = goldKnobCables.has(`${c.source}\u0000${c.destination}`);
      const checkFields = [
        cf(connectKey, 'Connect'),
        !goldKnobControlled && cf(amountKey, 'Depth'),
        polarityEligible && cf(polarityKey, 'Polarity'),
      ].filter(Boolean);
      // LFO1 -> pitch has its own dedicated single-pad shortcut (VIBRATO,
      // manual §4.8: "Depth of modulation between LFO1 and pitch") for the
      // plain single-source case. Real-hardware testing confirmed that
      // shortcut does NOT expose the "press SELECT again to chain a second
      // source" gesture depthModStep() below needs -- only the generic
      // two-step destination+source patching path (MASTER TRANSPOSE, same
      // mechanism as any other modulation destination) does, so a chained
      // cable here uses that path instead, even though it's still the same
      // underlying "pitch" parameter either way.
      if (c.source === 'lfo1' && c.destination === 'pitch') {
        const vibratoTitle = 'Vibrato (LFO1 → pitch)';
        const vibratoStep = c.depthModulators
          ? makeStep(vibratoTitle,
              `${ck(connectKey, `${shift(DEST_SHORTCUT.pitch)} to select the destination, then ${shift(srcLabel)} (in the modulation section) to connect it`)}. Turn SELECT to set ${ck(amountKey, `depth to ${val(beginnerAmt)}`)} (range -50.00 to 50.00).${polarityNote}${depthNote}`,
              `${ck(connectKey, 'Vibrato')} depth (LFO1 → pitch): ${ck(amountKey, val(expertAmt))}.${polarityNote}${depthNote}`,
              checkFields,
              { manualRef: manualRef('§6.1 "Modulation Routing Basics"', 124), conceptKey: 'vibrato' })
          : makeStep(vibratoTitle,
              `${ck(connectKey, shift('VIBRATO'))} set ${ck(amountKey, `depth to ${val(beginnerAmt)}`)} (range -50.00 to 50.00).${polarityNote}`,
              `${ck(connectKey, 'Vibrato')} depth (LFO1 → pitch): ${ck(amountKey, val(expertAmt))}.${polarityNote}`,
              checkFields,
              { manualRef: manualRef('§4.8 "Sound Editor: Grid Shortcuts" (Vibrato)', 89), conceptKey: 'vibrato' });
        return [vibratoStep, ...depthModSteps(vibratoTitle, c)];
      }
      const destReadable = destDisplayName(c.destination);
      const destShortcut = DEST_SHORTCUT[c.destination];
      const beginnerDest = destShortcut ? shift(destShortcut) : `${selectMenu(destReadable)} (no shortcut pad for this one)`;
      // Session 3: a per-cable, source/destination-specific "why this
      // matters" (cableWhyText()) instead of the flat PARAM_CONCEPTS
      // ['modmatrix'] blurb -- conceptKey stays 'modmatrix' too (so a future
      // modmatrix demo, or a pairing cableWhyText() can't say anything
      // useful about, still has a reasonable fallback), but `why` takes
      // priority when rendering (see renderStepFootnotes()).
      const patchTitle = `Patch: ${srcLabel} → ${destReadable}`;
      const patchStep = makeStep(patchTitle,
        `${ck(connectKey, `${beginnerDest} to select the destination, then ${shift(srcLabel)} (in the modulation section) to connect it`)}. Turn SELECT to set ${ck(amountKey, `depth to ${val(beginnerAmt)}`)} (range -50.00 to 50.00).${polarityNote}${depthNote}`,
        `${ck(connectKey, `Route ${val(srcLabel)} → ${val(destReadable)}`)} at ${ck(amountKey, val(expertAmt))}.${polarityNote}${depthNote}`,
        checkFields,
        { manualRef: manualRef('§6.1 "Modulation Routing Basics"', 124), conceptKey: 'modmatrix', why: cableWhyText(c.source, c.destination, dvCable(c.amount)) });
      return [patchStep, ...depthModSteps(patchTitle, c)];
    });
  push('Modulation matrix', cableSteps);

  // --- Arpeggiator ----------------------------------------------------
  const arp = patch.arpeggiator;
  const arpSteps = [];
  if (arpModeOn(arp)) {
    const presetName = arpPresetName(arp);
    // Checked fields cover BOTH the plain on/off flag (arpeggiator.mode --
    // always present, even on a pre-split file) AND, for a modern file, the
    // real noteMode/octaveMode pair the displayed preset name is derived
    // from -- the on/off flag alone can't distinguish e.g. UP from DOWN, so
    // checking only `mode` (which is just "arp" for any modern on preset)
    // would never flag a real pattern mismatch.
    const modeCheckFields = arp.arpMode !== undefined
      ? [cf('arpeggiator.mode', 'Mode'), cf('arpeggiator.noteMode', 'Note mode'), cf('arpeggiator.octaveMode', 'Octave mode')]
      : [cf('arpeggiator.mode', 'Mode')];
    arpSteps.push(makeStep('Enable arpeggiator',
      `${ck('arpeggiator.mode', `${shift('MODE')} (under VOICE) to ${val(presetName)}`)}.`,
      `${ck('arpeggiator.mode', `Arpeggiator: ${val(presetName)} mode`)}.`,
      modeCheckFields,
      { manualRef: manualRef('§4.12 "Arpeggiator"', 108), conceptKey: 'arpeggiator' }));
  }
  // Sync gets its own step, same reasoning as LFO/Delay/Sidechain sync
  // (see syncLevelName()'s own comment) -- and the SAME real bug class
  // already fixed there: gating on syncLevel alone misses a syncType-only
  // (triplet/dotted) change. Confirmed real encoding via firmware source
  // (gui/menu_item/arpeggiator/sync.h's Sync menu item calls the exact same
  // syncTypeAndLevelToMenuOption()/syncValueToSyncLevel() firmware
  // functions LFO/Delay/Sidechain use) -- packedSyncOption()/
  // syncLevelName() apply unchanged. INIT default confirmed via the real
  // corpus: syncLevel="7" (syncType absent/0) on ~1720 of ~1830 real files
  // with an <arpeggiator> element, by far the most common value.
  const arpSyncChanged = arp && (plainDiffers(arp.syncLevel, INIT.arpSyncLevel) || (arp.syncType && arp.syncType !== '0'));
  if (arpSyncChanged) {
    arpSteps.push(makeStep('Arpeggiator sync',
      `${ck('arpeggiator.syncLevel', `${shift('SYNC')} (under VOICE) to ${val(syncLevelName(packedSyncOption(arp.syncLevel, arp.syncType)))}`)}.`,
      `Arpeggiator ${ck('arpeggiator.syncLevel', `synced to ${val(syncLevelName(packedSyncOption(arp.syncLevel, arp.syncType)))}`)}.`,
      [cf('arpeggiator.syncLevel', 'Sync')],
      { manualRef: manualRef('§4.12 "Arpeggiator"', 108), conceptKey: 'arpeggiator' }));
  }
  // Rate/Gate get their own step, independent of whether the arp is
  // currently ON -- both are real MIDI-Follow-mappable params (see
  // FIELD_TO_MIDIFOLLOW_PARAM: arpRate/arpGate), and a non-default value
  // here still matters for an exact rebuild even while Mode is "off" --
  // it's what the arp will use the moment it's turned on. Previously
  // bundled into the SAME step as Mode (an enum) AND the whole step was
  // gated on mode !== 'off', so a preset with rate/gate set but the arp
  // not yet enabled showed NOTHING for either. Reported directly against
  // real hardware ("ARP Steps missing") using a test patch that set rate/
  // gate without also enabling the arp.
  const arpRateChanged = dp.arpeggiatorRate && q31Differs(dp.arpeggiatorRate, INIT.arpeggiatorRate);
  const arpGateChanged = dp.arpeggiatorGate && q31Differs(dp.arpeggiatorGate, INIT.arpeggiatorGate);
  if (arpRateChanged || arpGateChanged) {
    const beginnerParts = [
      arpGateChanged && ck('defaultParams.arpeggiatorGate', `${shift('GATE')} (under VOICE) to ${val(dv(dp.arpeggiatorGate))}`),
      arpRateChanged && ck('defaultParams.arpeggiatorRate', `${shift('RATE')} (under VOICE) to ${val(dv(dp.arpeggiatorRate))}`),
    ].filter(Boolean);
    const expertParts = [
      arpGateChanged && ck('defaultParams.arpeggiatorGate', `gate ${val(rawPct(dp.arpeggiatorGate) + '%')}`),
      arpRateChanged && ck('defaultParams.arpeggiatorRate', `rate ${val(rawPct(dp.arpeggiatorRate) + '%')}`),
    ].filter(Boolean);
    arpSteps.push(makeStep('Arpeggiator rate/gate',
      `${beginnerParts.join('. ')}.`,
      `Arpeggiator ${expertParts.join(', ')}.`,
      [arpGateChanged && cf('defaultParams.arpeggiatorGate', 'Gate'), arpRateChanged && cf('defaultParams.arpeggiatorRate', 'Rate')].filter(Boolean),
      { manualRef: manualRef('§4.12 "Arpeggiator"', 108), conceptKey: 'arpeggiator' }));
  }
  // Octaves gets its OWN step, same "matters regardless of Mode" reasoning
  // as Rate/Gate above, but deliberately NOT merged into that same step:
  // Rate/Gate are real MIDI-Follow-mappable params, but Octaves (a small
  // integer count) isn't, and isLiveStep()'s "one uncovered field
  // disqualifies the whole step" rule means bundling it in would silently
  // stop Rate/Gate from ever going live too. Previously only mentioned
  // inside "Enable arpeggiator" (gated on Mode being on), so a preset with
  // Octaves changed but Mode still "off" showed nothing for it at all --
  // found via a systematic audit of every buildCheckSteps() field.
  const arpOctavesChanged = arp && arp.numOctaves && arp.numOctaves !== INIT.arpNumOctaves;
  if (arpOctavesChanged) {
    arpSteps.push(makeStep('Arpeggiator octaves',
      `${ck('arpeggiator.numOctaves', `${shift('NUMBER OF OCTAVES')} (under VOICE) to ${val(arp.numOctaves)}`)}.`,
      `Arpeggiator ${ck('arpeggiator.numOctaves', `${val(arp.numOctaves)} octave(s)`)}.`,
      [cf('arpeggiator.numOctaves', 'Octaves')],
      { manualRef: manualRef('§4.12 "Arpeggiator"', 108), conceptKey: 'arpeggiator' }));
  }
  if (arpSteps.length) push('Arpeggiator', arpSteps);

  // --- Mod FX / Delay / Reverb / Sidechain ----------------------------
  const fxSteps = [];
  if (patch.modFXType && patch.modFXType !== INIT.modFXType) {
    // OFFSET ("Chorus offset") and FEEDBACK ("Flanger & phaser feedback")
    // are both real, manual-documented MOD-FX shortcut pads (§4.8/§11.7)
    // that were previously never mentioned anywhere in this app at all --
    // found via a real target/actual diff where the target's own
    // modFXOffset was a real, substantial non-default value the rebuild
    // had no way to even know needed setting.
    // Depth/Offset/Feedback aren't all relevant to every Mod FX type --
    // see MODFX_DEPTH_TYPES/MODFX_OFFSET_TYPES/MODFX_FEEDBACK_TYPES above.
    const depthShown = dp.modFXDepth && MODFX_DEPTH_TYPES.has(patch.modFXType);
    const offsetChanged = dp.modFXOffset && MODFX_OFFSET_TYPES.has(patch.modFXType) && q31Differs(dp.modFXOffset, INIT.modFXOffset);
    const feedbackChanged = dp.modFXFeedback && MODFX_FEEDBACK_TYPES.has(patch.modFXType) && q31Differs(dp.modFXFeedback, INIT.modFXFeedback);
    const modFxCheckFields = [cf('modFXType', 'Type'), cf('defaultParams.modFXRate', 'Rate')];
    if (depthShown) modFxCheckFields.push(cf('defaultParams.modFXDepth', 'Depth'));
    if (MODFX_OFFSET_TYPES.has(patch.modFXType)) modFxCheckFields.push(cf('defaultParams.modFXOffset', 'Offset'));
    if (MODFX_FEEDBACK_TYPES.has(patch.modFXType)) modFxCheckFields.push(cf('defaultParams.modFXFeedback', 'Feedback'));
    fxSteps.push(makeStep('Mod FX',
      `${ck('modFXType', `${shift('TYPE')} (under MOD-FX) to ${val(patch.modFXType)}`)}${dp.modFXRate ? `. ${ck('defaultParams.modFXRate', `${shift('RATE')} to ${val(dv(dp.modFXRate))}`)}` : ''}${depthShown ? `. ${ck('defaultParams.modFXDepth', `${shift('DEPTH')} to ${val(dv(dp.modFXDepth))}`)}` : ''}${offsetChanged ? `. ${ck('defaultParams.modFXOffset', `${shift('OFFSET')} to ${val(dv(dp.modFXOffset))}`)}` : ''}${feedbackChanged ? `. ${ck('defaultParams.modFXFeedback', `${shift('FEEDBACK')} to ${val(dv(dp.modFXFeedback))}`)}` : ''}.`,
      `${ck('modFXType', val(patch.modFXType))}${dp.modFXRate ? ` ${ck('defaultParams.modFXRate', `rate ${rawPct(dp.modFXRate)}%`)}` : ''}${depthShown ? `, ${ck('defaultParams.modFXDepth', `depth ${rawPct(dp.modFXDepth)}%`)}` : ''}${offsetChanged ? `, ${ck('defaultParams.modFXOffset', `offset ${rawPct(dp.modFXOffset)}%`)}` : ''}${feedbackChanged ? `, ${ck('defaultParams.modFXFeedback', `feedback ${rawPct(dp.modFXFeedback)}%`)}` : ''}.`,
      modFxCheckFields,
      { manualRef: manualRef('§11.7 "Modulation Effects"', 235), conceptKey: 'modfx' }));
  }
  const delay = patch.delay;
  // Amount/Rate get their own step, split off from PingPong/Analog/Sync:
  // both are real MIDI-Follow-mappable params, but PingPong/Analog (plain
  // on/off flags) and Sync (a list, see syncLevelName()'s own comment) are
  // neither -- bundling all five into one step's checkFields used to
  // disqualify the *whole* step from ever going live (isLiveStep()'s "one
  // uncovered field disqualifies the whole step" rule), same class of bug
  // as the earlier LPF/HPF Mode split. Reported directly against real
  // hardware: "Delay amount and rate are live values".
  // Gate also fires on Rate alone (Feedback still at default) -- found via
  // a systematic audit of every buildCheckSteps() field: 'defaultParams.
  // delayRate' was always unconditionally checked, but this was the only
  // place it's ever mentioned, and it only used to gate on Feedback.
  const delayFeedbackChanged = dp.delayFeedback && q31Differs(dp.delayFeedback, INIT.delayFeedback);
  const delayRateChanged = dp.delayRate && q31Differs(dp.delayRate, INIT.delayRate);
  if (delayFeedbackChanged || delayRateChanged) {
    fxSteps.push(makeStep('Delay',
      `${delayFeedbackChanged ? ck('defaultParams.delayFeedback', `${shift('AMOUNT')} (under FX/DELAY) to ${val(dv(dp.delayFeedback))}`) : ''}${delayFeedbackChanged && delayRateChanged ? '. ' : ''}${delayRateChanged ? ck('defaultParams.delayRate', `${shift('RATE')} (under FX/DELAY) to ${val(dv(dp.delayRate))}`) : ''}.`,
      `${delayFeedbackChanged ? ck('defaultParams.delayFeedback', `Delay feedback ${val(rawPct(dp.delayFeedback) + '%')}`) : ''}${delayFeedbackChanged && delayRateChanged ? ', ' : ''}${delayRateChanged ? ck('defaultParams.delayRate', `rate ${val(rawPct(dp.delayRate) + '%')}`) : ''}.`,
      [delayFeedbackChanged && cf('defaultParams.delayFeedback', 'Amount'), delayRateChanged && cf('defaultParams.delayRate', 'Rate')].filter(Boolean),
      { manualRef: manualRef('§11.5 "Delay"', 228), conceptKey: 'delay' }));
  }
  // Delay's own tempo-sync (manual §11.5/grid shortcuts: "SYNC -- Time
  // interval to sync the Delay or OFF") was previously uncovered here --
  // asymmetric with the SAME "SYNC" concept already tracked for the
  // sidechain compressor below. A real target/actual diff found this
  // genuinely differing (target wanted sync level 8, the rebuild was still
  // sitting at the init default 7) -- a real, audible difference in delay
  // repeat timing, not just cosmetic.
  const delaySyncChanged = delay && plainDiffers(delay.syncLevel, INIT.delaySyncLevel);
  // Found via the systematic "check all parameters" audit, using real-corpus
  // data: this used to gate on `pingPong === '1'` (treating "on" as the
  // one describable/checkable state), but a corpus scan of ~2053 real files
  // shows pingPong="1" in 1663 of them vs only 99 with "0" -- ping-pong ON
  // IS the near-universal true default. So the old gate fired for almost
  // every ordinary preset (unhelpfully restating the default) while never
  // surfacing the rarer, more meaningful case: a preset that deliberately
  // turns ping-pong OFF. Fixed to gate (and describe) on whether it DIFFERS
  // from its own default, same as every other field in this file.
  const delayPingPongChanged = delay && delay.pingPong !== undefined && delay.pingPong !== INIT.delayPingPong;
  const delayAnalogOn = delay && delay.analog === '1';
  if (delayPingPongChanged || delayAnalogOn || delaySyncChanged) {
    const pingPongOn = delay.pingPong === '1';
    const beginnerParts = [
      // Gesture confirmed directly against real hardware: SHIFT+STEREO,
      // not SHIFT+PINGPONG -- the physical pad under DELAY is silkscreened
      // "STEREO" even though the internal parameter/menu name is PingPong.
      delayPingPongChanged && ck('delay.pingPong', `${shift('STEREO')} ${pingPongOn ? 'on' : 'off'}`),
      delayAnalogOn && ck('delay.analog', `${shift('TYPE')} to ${val('ANALOG')}`),
      delaySyncChanged && ck('delay.syncLevel', `${shift('SYNC')} to ${val(syncLevelName(packedSyncOption(delay.syncLevel, delay.syncType)))}`),
    ].filter(Boolean);
    const expertParts = [
      delayPingPongChanged && ck('delay.pingPong', `ping-pong ${pingPongOn ? 'on' : 'off'}`),
      delayAnalogOn && ck('delay.analog', 'analog'),
      delaySyncChanged && ck('delay.syncLevel', `synced to ${val(syncLevelName(packedSyncOption(delay.syncLevel, delay.syncType)))}`),
    ].filter(Boolean);
    // checkFields mirrors exactly what's shown above -- a field whose own
    // condition is false here (e.g. pingPong unchanged, only Analog/Sync
    // mentioned) previously stayed in this list unconditionally, so an
    // "unexpected" pingPong mismatch could still turn the WHOLE step red
    // even though nothing about ping-pong ever appeared in its text.
    // Reported directly ("delay ping pong ... is checked, but not shown in
    // the step").
    const checkFields = [
      delayPingPongChanged && cf('delay.pingPong', 'PingPong'),
      delayAnalogOn && cf('delay.analog', 'Analog'),
      delaySyncChanged && cf('delay.syncLevel', 'Sync'),
    ].filter(Boolean);
    fxSteps.push(makeStep('Delay settings',
      `${beginnerParts.join('. ')}.`,
      `${expertParts.join(', ')}.`,
      checkFields,
      { manualRef: manualRef('§11.5 "Delay"', 228), conceptKey: 'delay' }));
  }
  if (dp.reverbAmount && q31Differs(dp.reverbAmount, INIT.reverbAmount)) {
    fxSteps.push(makeStep('Reverb send',
      `${ck('defaultParams.reverbAmount', `${shift('AMOUNT')} (under REVERB) to ${val(dv(dp.reverbAmount))}`)}.`,
      `${ck('defaultParams.reverbAmount', `Reverb send ${val(rawPct(dp.reverbAmount) + '%')}`)}.`,
      [cf('defaultParams.reverbAmount', 'Amount')],
      { manualRef: manualRef('§11.6 "Reverb"', 230), conceptKey: 'reverb' }));
  }
  push('Effects', fxSteps);

  // --- Sidechain compressor -------------------------------------------
  const sc = patch.sidechain;
  if (sc && (plainDiffers(sc.attack, INIT.sidechain.attack) || plainDiffers(sc.release, INIT.sidechain.release) || plainDiffers(sc.syncLevel, INIT.sidechain.syncLevel))) {
    push('Sidechain compressor', [makeStep('Ducking envelope',
      `${ck('sidechain.attack', shift('ATTACK'))} and ${ck('sidechain.release', shift('RELEASE'))} (under SIDECHAIN COMPRESSOR) to ${ck('sidechain.attack', `attack ${val(sc.attack)}`)}, ${ck('sidechain.release', `release ${val(sc.release)}`)}${sc.syncLevel && sc.syncLevel !== '0' ? `. ${ck('sidechain.syncLevel', `${shift('SYNC')} to ${val(syncLevelName(packedSyncOption(sc.syncLevel, sc.syncType)))}`)}` : ''}.`,
      `Sidechain compressor: ${ck('sidechain.attack', `attack ${val(sc.attack)}`)}, ${ck('sidechain.release', `release ${val(sc.release)}`)}.`,
      [cf('sidechain.attack', 'Attack'), cf('sidechain.release', 'Release'), cf('sidechain.syncLevel', 'Sync')],
      { manualRef: manualRef('§6.4 "Sidechain Compressor"', 133), conceptKey: 'sidechain' })]);
  }

  // --- Distortion / character --------------------------------------
  const charSteps = [];
  if (patch.clippingAmount && patch.clippingAmount !== '0') {
    charSteps.push(makeStep('Saturation / clipping',
      `${ck('clippingAmount', `${shift('SATURATION')} to ${val(patch.clippingAmount)}`)}.`,
      `${ck('clippingAmount', `Saturation amount: ${val(patch.clippingAmount)}`)}.`,
      [cf('clippingAmount', 'Amount')],
      { manualRef: manualRef('§11.3 "Distortion Effects"', 223), conceptKey: 'distortion' }));
  }
  if (dp.bitCrush && q31Differs(dp.bitCrush, INIT.bitCrush)) {
    charSteps.push(makeStep('Bitcrush',
      `${ck('defaultParams.bitCrush', `${shift('BITCRUSH')} to ${val(dv(dp.bitCrush))}`)}.`,
      `${ck('defaultParams.bitCrush', `Bitcrush ${val(rawPct(dp.bitCrush) + '%')}`)}.`,
      [cf('defaultParams.bitCrush', 'Amount')],
      { manualRef: manualRef('§11.3 "Distortion Effects"', 223), conceptKey: 'distortion' }));
  }
  if (dp.sampleRateReduction && q31Differs(dp.sampleRateReduction, INIT.sampleRateReduction)) {
    charSteps.push(makeStep('Sample-rate reduction (decimation)',
      `${ck('defaultParams.sampleRateReduction', `${shift('DECIMATION')} to ${val(dv(dp.sampleRateReduction))}`)}.`,
      `${ck('defaultParams.sampleRateReduction', `Decimation ${val(rawPct(dp.sampleRateReduction) + '%')}`)}.`,
      [cf('defaultParams.sampleRateReduction', 'Amount')],
      { manualRef: manualRef('§11.3 "Distortion Effects"', 223), conceptKey: 'distortion' }));
  }
  if (dp.waveFold && q31Differs(dp.waveFold, INIT.waveFold)) {
    charSteps.push(makeStep('Wavefolder',
      `${ck('defaultParams.waveFold', `Set wavefold to ${val(dv(dp.waveFold))} via the SOUND menu (${selectMenu('SOUND &gt; WAVEFOLD')}; newer firmware only, no shortcut pad documented)`)}.`,
      `${ck('defaultParams.waveFold', `Wavefold ${val(rawPct(dp.waveFold) + '%')}`)}.`,
      [cf('defaultParams.waveFold', 'Amount')],
      // Confirmed community-only: manual.txt has no "wavefold"/"wave fold"
      // hit anywhere; community_features.txt §4.2.7 "Patchable Wavefolding
      // Distortion" documents exactly this parameter.
      { manualRef: communityRef('§4.2.7 "Patchable Wavefolding Distortion"', '427---patchable-wavefolding-distortion'), conceptKey: 'wavefold' }));
  }
  // EQ bass/treble is a boost-only UnpatchedParam on the firmware side (no
  // getMinValue() override), so -- unlike pan -- it's 0-50, not bipolar.
  const eq = dp.equalizer;
  if (eq && (q31Differs(eq.bass || '0x00000000', '0x00000000') || q31Differs(eq.treble || '0x00000000', '0x00000000'))) {
    charSteps.push(makeStep('EQ',
      `${ck('defaultParams.equalizer.bass', `${shift('ADJUST (BASS)')} to ${val(dv(eq.bass || '0x00000000'))}`)}. ${ck('defaultParams.equalizer.treble', `${shift('ADJUST (TREBLE)')} to ${val(dv(eq.treble || '0x00000000'))}`)}.`,
      `${ck('defaultParams.equalizer.bass', `EQ bass boost ${val(rawPct(eq.bass || '0x00000000') + '%')}`)}, ${ck('defaultParams.equalizer.treble', `treble boost ${val(rawPct(eq.treble || '0x00000000') + '%')}`)}.`,
      [cf('defaultParams.equalizer.bass', 'Bass'), cf('defaultParams.equalizer.treble', 'Treble')],
      { manualRef: manualRef('§11.4 "EQ - Equalisation"', 225), conceptKey: 'eq' }));
  }
  // Separate from the bass/treble boost knobs above: which frequency each
  // shelf actually pivots at. Previously not covered anywhere at all (found
  // via real-hardware testing against a preset that moves both). Gesture
  // confirmed directly against real hardware: SHIFT+BASS / SHIFT+TREBLE --
  // the same pads as the plain gain step above, held with SHIFT (matches
  // firmware's own shortcut-pad grid: bassFreqMenu/trebleFreqMenu sit
  // directly below bassMenu/trebleMenu in the same column) -- corrects an
  // earlier, wrong assumption that there was no dedicated pad for these.
  if (eq && (q31Differs(eq.bassFrequency || '0x00000000', '0x00000000') || q31Differs(eq.trebleFrequency || '0x00000000', '0x00000000'))) {
    charSteps.push(makeStep('EQ frequency',
      `${ck('defaultParams.equalizer.bassFrequency', `${shift('BASS')} to ${val(dv(eq.bassFrequency || '0x00000000'))}`)}. ${ck('defaultParams.equalizer.trebleFrequency', `${shift('TREBLE')} to ${val(dv(eq.trebleFrequency || '0x00000000'))}`)}.`,
      `${ck('defaultParams.equalizer.bassFrequency', `EQ bass shelf frequency ${val(rawPct(eq.bassFrequency || '0x00000000') + '%')}`)}, ${ck('defaultParams.equalizer.trebleFrequency', `treble shelf frequency ${val(rawPct(eq.trebleFrequency || '0x00000000') + '%')}`)}.`,
      [cf('defaultParams.equalizer.bassFrequency', 'Bass freq'), cf('defaultParams.equalizer.trebleFrequency', 'Treble freq')],
      { manualRef: manualRef('§11.4 "EQ - Equalisation"', 225), conceptKey: 'eq' }));
  }
  push('Character & distortion', charSteps);

  // --- Performance (gold knob reassignments) ---------------------------
  // Presets almost always keep the default 16-slot layout (see KNOB_SLOTS);
  // this only shows the slots a preset actually reassigns.
  const knobsRaw = get(patch, 'modKnobs.modKnob', []) || [];
  const knobs = Array.isArray(knobsRaw) ? knobsRaw : [knobsRaw];
  const reassigned = [];
  knobs.forEach((k, i) => {
    const slot = KNOB_SLOTS[i];
    if (!slot || !k || !k.controlsParam || k.controlsParam === slot.param) return;
    reassigned.push({ slot, controlsParam: k.controlsParam, patchAmountFromSource: k.patchAmountFromSource });
  });
  if (reassigned.length) {
    const rows = reassigned.map(r =>
      `<tr><td>${kbd(r.slot.button)} (${r.slot.pos})</td><td>${r.controlsParam}${r.patchAmountFromSource ? ` from ${r.patchAmountFromSource}` : ''}</td></tr>`).join('');
    const first = reassigned[0];
    push('Performance knob layout', [makeStep('Reassign gold knobs',
      `This patch moves some gold-knob controls off their defaults. For each row: press the named button (e.g. ${kbd(first.slot.button)}), navigate to the target parameter in the SOUND menu, then press &amp; hold ${kbd('LEARN / INPUT')} and turn the ${kbd(first.slot.pos)} rotary until the display reads ${val('LEARNED')}:
       <table><tr><th>button (position)</th><th>now controls</th></tr>${rows}</table>`,
      `Custom gold-knob assignments: ${reassigned.map(r => `${r.slot.button} ${r.slot.pos} → ${r.controlsParam}`).join('; ')}.`,
      null,
      { manualRef: manualRef('§6.6 "Custom Parameter Affect Controls" (LEARN)', 137), conceptKey: 'goldknob' })]);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Live-device check: field schema for deluge-check.js's evaluateSteps().
// ---------------------------------------------------------------------------
// Paths below are attribute/element names straight from the raw preset XML
// (not this file's own decoded dv()/dvPan()/dvCable() display values) --
// deluge-check.js parses target and actual XML text itself, independently
// of parseDelugeXml() above, so field.path has to match ITS parser's object
// shape. For current (>=3.0, attribute-based) firmware that shape is
// identical to what xmlToObj() produces here (attributes -> keys, child
// elements -> nested objects), which is how these paths were determined:
// against real files in synths/, e.g. envelope1/envelope2 live under
// defaultParams (see synths/Init.XML), not at the top level.
//
// Most fields here are Q31 fixed-point (attack, cutoff, rates, sends, ...)
// and are left with the default tolerance denominator (the full signed
// 32-bit range) that deluge-check-settings.js falls back to. A handful are
// small plain integers instead (voice counts, transpose in semitones, sync
// levels, on/off flags) -- for those, a percent of the full 32-bit range
// would dwarf the entire real value range and silently pass any mismatch,
// so they're explicitly given a small rawRange instead.
const CHECK_SMALL_INT_RANGE = 128;
// A "sync level" (delay/sidechain/LFO tempo-sync: manual's own list is
// "OFF" + 9 note divisions, so ~10 real distinct values) is far too small
// a range for even CHECK_SMALL_INT_RANGE's own default 2% tolerance
// (2% of 128 = 2.56) -- verified against a real target/actual pair where
// a genuine, audible 1-step difference (7 vs 8) still read as "ok" under
// that looser tolerance. rawRange scales the SAME percentage-based
// tolerance down to fit this field's actual real-world scale instead.
const CHECK_SYNC_LEVEL_RANGE = 16;
// Unison detune/spread's own real range is manual-confirmed 0-50 (§4.x
// "UNISON DETUNE... A value between 0-50"; stereo spread documented as the
// same style of parameter, community_features.txt §4.5.2) -- found via a
// SECOND real target/actual pair still showing a genuine, audible 2-step
// difference (6 vs 8) reading as "ok" under CHECK_SMALL_INT_RANGE's 2.56
// tolerance, same class of bug as the sync levels above.
const CHECK_UNISON_RANGE = 50;
// A plain on/off flag (delay ping-pong, delay analog/digital) has exactly
// two valid values -- ANY nonzero tolerance is wrong for it, since "off"
// and "on" are never "close enough" to each other. Small deliberately not
// zero (some settings UIs treat a literal 0 tolerance as "disabled" and
// fall back to a default), but tiny enough that a real 0-vs-1 difference
// can never be masked by rounding.
const CHECK_BINARY_RANGE = 2;
// Pulse width (see dvHalfPrecision()'s own comment) only ever uses the
// POSITIVE half of the raw q31 range to represent its full 0-50 display
// scale, unlike every other field this generic percent-of-range tolerance
// was designed for (which spans the FULL signed range for the same 0-50).
// Leaving it at the RAW_PARAM_RANGE default silently doubles its real
// tolerance: the same "2%" ends up covering a FULL display step here
// instead of the roughly half-a-step every standard field gets, and a real
// target/actual pair confirmed this let a genuine, audible 9-step gap
// (target 32, actual 41 -- the actual having been rebuilt by following an
// earlier, wrong "standard formula" guide instruction) read as "ok". Half
// of the standard range restores the same relative strictness.
const CHECK_HALF_PRECISION_RANGE = 0x40000000;
function intField(label, path, rawRange) { return { key: path, label, path, rawRange: rawRange || CHECK_SMALL_INT_RANGE }; }
function field(label, path) { return { key: path, label, path }; }

// Patch cables are a list (patchCables.patchCable), not a fixed set of
// attribute paths -- unlike every other field above, so instead of a
// `path`, this carries a `cable` descriptor that deluge-check.js's
// evaluateSteps() resolves by *finding* the matching source/destination
// pair in target/actual/init, rather than walking a fixed path. `mode`
// splits one connection into two independently-checkable things:
// - "connect": did this exact source→destination pairing get made at
//   all, regardless of depth (matches as soon as *a* cable exists there).
// - "amount": given the pairing exists, does its depth match the target's.
// This is what lets "select destination, select source" read as done
// (green) the moment the routing exists, while "set depth" stays its own
// yellow/green signal for whether that depth is actually dialled in.
function cableField(label, source, destination, mode) {
  return { key: `cable:${mode}:${source}->${destination}`, label, cable: { source, destination, mode } };
}

// A cable's own depth can itself be modulated by MORE THAN ONE second
// source at once (see cablesOf()'s own comment -- confirmed on a real
// preset) -- this is one such depth's own amount, checkable independently
// of the outer cable's connect/amount fields above AND of any other
// depth-modulator on the same cable. `depthSource` (the modulator's own
// source) is folded into the key so two modulators on one cable get two
// distinct, independently-checkable fields rather than colliding on one
// shared key. Key format otherwise mirrors cableField()'s
// (`cable:<mode>:<source>-><destination>`) so it resolves through the same
// lastCheckFieldStatus lookup in stepCheckStatus()/ck() -- just a
// different "mode" segment (deluge-check.js's resolveFieldValues()
// dispatches on the presence of `cableDepth` rather than `cable`, since the
// target cable to look up isn't this pair itself, it's whatever depth-
// modulates it).
function cableDepthField(label, source, destination, depthSource, mode) {
  // `mode` defaults to "amount" (the depth-modulator's own strength) and
  // keeps the ORIGINAL key format for backward compatibility with every
  // existing amount field; "polarity" (see depthModStep()'s own comment --
  // a chained depth modulator has its own bipolar/unipolar, independent of
  // the outer connection's) gets its own distinct key segment instead.
  const key = mode === 'polarity'
    ? `cable:depth:polarity:${source}->${destination}:${depthSource}`
    : `cable:depth:${source}->${destination}:${depthSource}`;
  return { key, label, cableDepth: { source, destination, depthSource, mode: mode || 'amount' } };
}

// Deliberately NOT covered yet (kept out rather than guessed at):
// - modKnob reassignments, a list with the same single-vs-multiple-entries
//   XML quirk patch cables used to have (see cableField() above for how
//   that got solved here -- the same approach would work for modKnobs too).
// - multisample zones (sampleRanges.sampleRange), same list-shape reason.
function buildCheckSteps(patch) {
  const isFm = patch.mode === 'fm';
  // See buildGuide()'s own isRingmod comment: OSC1/OSC2 LEVEL is hidden by
  // firmware itself in Ring Mod mode, so it must not be a checkable field
  // there either -- a value the user can never reach or verify on the
  // device should never be able to turn a step red.
  const isRingmod = patch.mode === 'ringmod';
  const steps = [
    // Previously had no check fields at all in either buildGuide()'s own
    // "Synth engine mode"/"Polyphony" steps or here -- a real gap found via
    // real-hardware testing (reported as "polyphony bleibt weiss", i.e.
    // never colors itself no matter what's actually on the device).
    { id: 'general', label: 'General', fields: [
        field('Synth mode', 'mode'),
        field('Polyphony', 'polyphonic'),
        field('Master transpose', 'transpose'),
        field('Master cents', 'cents'),
      ] },
    { id: 'osc', label: 'Oscillators', fields: isFm ? [
        field('Carrier 1 transpose', 'osc1.transpose'),
        field('Carrier 2 transpose', 'osc2.transpose'),
        field('Carrier 1 feedback', 'defaultParams.carrier1Feedback'),
        field('Carrier 2 feedback', 'defaultParams.carrier2Feedback'),
        intField('Modulator 1 transpose', 'modulator1.transpose'),
        intField('Modulator 2 transpose', 'modulator2.transpose'),
        intField('Modulator 1 retrig phase', 'modulator1.retrigPhase'),
        intField('Modulator 2 retrig phase', 'modulator2.retrigPhase'),
        field('Modulator 1 amount', 'defaultParams.modulator1Amount'),
        field('Modulator 2 amount', 'defaultParams.modulator2Amount'),
        field('Modulator 1 feedback', 'defaultParams.modulator1Feedback'),
        field('Modulator 2 feedback', 'defaultParams.modulator2Feedback'),
        intField('Modulator 2 destination', 'modulator2.toModulator1', CHECK_BINARY_RANGE),
      ] : [
        field('OSC1 type', 'osc1.type'),
        intField('OSC1 transpose', 'osc1.transpose'),
        intField('OSC1 cents', 'osc1.cents'),
        intField('OSC1 retrig phase', 'osc1.retrigPhase'),
        field('OSC1 sample', 'osc1.fileName'),
        intField('OSC1 pulse width', 'defaultParams.oscAPulseWidth', CHECK_HALF_PRECISION_RANGE),
        field('OSC2 type', 'osc2.type'),
        intField('OSC2 transpose', 'osc2.transpose'),
        intField('OSC2 cents', 'osc2.cents'),
        intField('OSC2 retrig phase', 'osc2.retrigPhase'),
        field('OSC2 sample', 'osc2.fileName'),
        intField('OSC2 pulse width', 'defaultParams.oscBPulseWidth', CHECK_HALF_PRECISION_RANGE),
      ] },
    { id: 'mixer', label: 'Mixer', fields: [
        field('Level', 'defaultParams.volume'),
        !isRingmod && field('OSC1 level', 'defaultParams.oscAVolume'),
        !isRingmod && field('OSC2 level', 'defaultParams.oscBVolume'),
        field('Noise level', 'defaultParams.noiseVolume'),
        field('Pan', 'defaultParams.pan'),
      ].filter(Boolean) },
    { id: 'unison', label: 'Unison', fields: [
        intField('Voice count', 'unison.num'),
        // Detune/Spread only matter with 2+ voices actually stacked -- with
        // a single voice there's nothing to detune/spread AGAINST, so
        // firmware lets these sit at whatever leftover value regardless
        // (same "irrelevant, unrendered" class as FM's stale lpfMode or a
        // non-flanger Mod FX's stale feedback). Confirmed real: real
        // Factory/148 Warm 5th Pad.XML has num=1 with detune=4 -- a
        // meaningless value buildGuide()'s own "Stack voices" step already
        // never shows a step for (gated the same way, `num > 1`), so
        // checking it unconditionally here blocked a perfect match on a
        // field with no visible step at all to explain it.
        (patch.unison && parseInt(patch.unison.num, 10) > 1) ? intField('Detune', 'unison.detune', CHECK_UNISON_RANGE) : null,
        (patch.unison && parseInt(patch.unison.num, 10) > 1) ? intField('Spread', 'unison.spread', CHECK_UNISON_RANGE) : null,
        field('Portamento', 'defaultParams.portamento'),
      ].filter(Boolean) },
    // FM mode has no filter at all -- see buildGuide()'s own comment (real
    // preset "Fmbd.XML": lpfMode="flanger", a stale, never-rendered value
    // that would otherwise show as a bogus "changed" filter mismatch here).
    { id: 'filter', label: 'Filter', fields: isFm ? [] : [
        field('LPF frequency', 'defaultParams.lpfFrequency'),
        field('LPF resonance', 'defaultParams.lpfResonance'),
        field('LPF mode', 'lpfMode'),
        field('HPF frequency', 'defaultParams.hpfFrequency'),
        field('HPF resonance', 'defaultParams.hpfResonance'),
        field('HPF mode', 'hpfMode'),
        field('Filter route', 'filterRoute'),
      ] },
    { id: 'env1', label: 'Envelope 1', fields: ['attack', 'decay', 'sustain', 'release'].map(f =>
        field(`Envelope 1 ${f}`, `defaultParams.envelope1.${f}`)) },
    { id: 'env2', label: 'Envelope 2', fields: ['attack', 'decay', 'sustain', 'release'].map(f =>
        field(`Envelope 2 ${f}`, `defaultParams.envelope2.${f}`)) },
    { id: 'lfo', label: 'LFOs', fields: [
        field('LFO1 shape', 'lfo1.type'),
        field('LFO1 rate', 'defaultParams.lfo1Rate'),
        intField('LFO1 sync level', 'lfo1.syncLevel', CHECK_SYNC_LEVEL_RANGE),
        field('LFO2 shape', 'lfo2.type'),
        field('LFO2 rate', 'defaultParams.lfo2Rate'),
        intField('LFO2 sync level', 'lfo2.syncLevel', CHECK_SYNC_LEVEL_RANGE),
      ] },
    { id: 'arp', label: 'Arpeggiator', fields: [
        field('Arp mode', 'arpeggiator.mode'),
        field('Arp note mode', 'arpeggiator.noteMode'),
        field('Arp octave mode', 'arpeggiator.octaveMode'),
        intField('Arp octaves', 'arpeggiator.numOctaves'),
        intField('Arp sync level', 'arpeggiator.syncLevel', CHECK_SYNC_LEVEL_RANGE),
        field('Arp gate', 'defaultParams.arpeggiatorGate'),
        field('Arp rate', 'defaultParams.arpeggiatorRate'),
      ] },
    { id: 'fx', label: 'Effects', fields: [
        field('Mod FX type', 'modFXType'),
        // Rate (like Depth/Offset/Feedback below) is irrelevant when Mod FX
        // is off entirely (firmware source: gui/menu_item/mod_fx/rate.h's
        // own isRelevant(), "type != NONE") -- found via a systematic audit
        // of every buildCheckSteps() field: with type="none" there's no
        // Mod FX step at all (nothing to show a rate for), yet this was
        // still checked unconditionally.
        patch.modFXType !== INIT.modFXType ? field('Mod FX rate', 'defaultParams.modFXRate') : null,
        // Depth/Offset/Feedback aren't all relevant to every Mod FX type --
        // see MODFX_DEPTH_TYPES/MODFX_OFFSET_TYPES/MODFX_FEEDBACK_TYPES.
        MODFX_DEPTH_TYPES.has(patch.modFXType) ? field('Mod FX depth', 'defaultParams.modFXDepth') : null,
        MODFX_OFFSET_TYPES.has(patch.modFXType) ? field('Mod FX offset', 'defaultParams.modFXOffset') : null,
        MODFX_FEEDBACK_TYPES.has(patch.modFXType) ? field('Mod FX feedback', 'defaultParams.modFXFeedback') : null,
        intField('Delay ping-pong', 'delay.pingPong', CHECK_BINARY_RANGE),
        intField('Delay analog', 'delay.analog', CHECK_BINARY_RANGE),
        intField('Delay sync level', 'delay.syncLevel', CHECK_SYNC_LEVEL_RANGE),
        field('Delay rate', 'defaultParams.delayRate'),
        field('Delay feedback', 'defaultParams.delayFeedback'),
        field('Reverb send', 'defaultParams.reverbAmount'),
      ].filter(Boolean) },
    { id: 'sidechain', label: 'Sidechain compressor', fields: [
        field('Sidechain attack', 'sidechain.attack'),
        field('Sidechain release', 'sidechain.release'),
        intField('Sidechain sync level', 'sidechain.syncLevel', CHECK_SYNC_LEVEL_RANGE),
      ] },
    { id: 'character', label: 'Character & distortion', fields: [
        intField('Saturation amount', 'clippingAmount'),
        field('Bitcrush', 'defaultParams.bitCrush'),
        field('Sample-rate reduction', 'defaultParams.sampleRateReduction'),
        field('Wavefolder', 'defaultParams.waveFold'),
        field('EQ bass', 'defaultParams.equalizer.bass'),
        field('EQ treble', 'defaultParams.equalizer.treble'),
        field('EQ bass frequency', 'defaultParams.equalizer.bassFrequency'),
        field('EQ treble frequency', 'defaultParams.equalizer.trebleFrequency'),
      ] },
    { id: 'modmatrix', label: 'Modulation matrix', fields: cablesOf(patch)
        .filter(c => c.source && c.destination && !cableIsDefault(c))
        .flatMap(c => {
          const label = `${humanize(c.source)} → ${destDisplayName(c.destination)}`;
          // A gold-knob-controlled cable's own depth is never checked --
          // see goldKnobControlledCables()'s own comment.
          const goldKnobControlled = goldKnobControlledCables(patch).has(`${c.source}\u0000${c.destination}`);
          const fields = [
            cableField(`${label} (connected)`, c.source, c.destination, 'connect'),
          ];
          if (!goldKnobControlled) fields.push(cableField(`${label} (depth)`, c.source, c.destination, 'amount'));
          // X/Y (MPE expression) can't have their polarity changed at all
          // (see cableHasPolarity()'s own comment) -- no field for those.
          if (cableHasPolarity(c.source)) {
            fields.push(cableField(`${label} (polarity)`, c.source, c.destination, 'polarity'));
          }
          for (const m of c.depthModulators || []) {
            const depthSrcLabel = SOURCE_LABEL[m.source] || humanize(m.source);
            fields.push(cableDepthField(`${label} (depth modulated by ${depthSrcLabel})`, c.source, c.destination, m.source));
            // A chained depth modulator has its own polarity, independent
            // of the outer connection's (see depthModStep()'s comment).
            if (cableHasPolarity(m.source)) {
              fields.push(cableDepthField(`${label} (depth modulated by ${depthSrcLabel}, polarity)`, c.source, c.destination, m.source, 'polarity'));
            }
          }
          return fields;
        }) },
  ];
  return steps;
}

// ---------------------------------------------------------------------------
// Mod Matrix tab: every patch cable in this preset, as a reference table.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Pinch-to-zoom + pan wrapper, shared by the Mod Matrix table and the Signal
// Path / Compare SVG diagrams -- all three can be wider (or, once zoomed,
// taller) than a phone screen and hard to read at native size even with the
// plain horizontal scroll they already had. Panning after a pinch is native
// browser scrolling, not custom drag logic: the only custom part is the
// pinch gesture itself (mapped to a CSS scale on `.zoom-content`) and a
// double-tap/button reset. `.zoom-content` is sized to its natural
// (unscaled) content and absolutely positioned inside `.zoom-spacer`, whose
// width/height are set in JS to naturalSize*scale -- that's what makes
// `.zoom-viewport`'s native overflow:auto scrollbars/panning cover the
// actual zoomed footprint instead of the transform (which alone never
// affects layout size).
// ---------------------------------------------------------------------------
function makeZoomable(innerHtml, extraClass) {
  return `<div class="zoom-wrap">
    <div class="zoom-toolbar"><button type="button" class="zoom-reset-btn" hidden>&#8634; Reset zoom</button></div>
    <div class="zoom-viewport${extraClass ? ' ' + extraClass : ''}">
      <div class="zoom-spacer"><div class="zoom-content">${innerHtml}</div></div>
    </div>
  </div>`;
}

function initZoomViewport(viewportEl) {
  if (!viewportEl || viewportEl.dataset.zoomInit) return;
  viewportEl.dataset.zoomInit = '1';
  const spacer = viewportEl.querySelector(':scope > .zoom-spacer');
  const content = spacer && spacer.querySelector(':scope > .zoom-content');
  const resetBtn = viewportEl.parentElement.querySelector(':scope > .zoom-toolbar > .zoom-reset-btn');
  if (!content || !resetBtn) return;

  let scale = 1, naturalW = 0, naturalH = 0, pinch = null, lastTapTime = 0;

  function apply() {
    content.style.transformOrigin = '0 0';
    content.style.transform = `scale(${scale})`;
    spacer.style.width = (naturalW * scale) + 'px';
    spacer.style.height = (naturalH * scale) + 'px';
    viewportEl.classList.toggle('is-zoomed', scale > 1);
    resetBtn.hidden = scale === 1;
  }

  function measure() {
    content.style.transform = 'none';
    const r = content.getBoundingClientRect();
    naturalW = r.width;
    naturalH = r.height;
    apply();
  }

  function setScale(newScale, focalClientX, focalClientY) {
    newScale = Math.min(4, Math.max(1, newScale));
    const vr = viewportEl.getBoundingClientRect();
    const beforeX = viewportEl.scrollLeft + (focalClientX - vr.left);
    const beforeY = viewportEl.scrollTop + (focalClientY - vr.top);
    const ratio = scale ? newScale / scale : 1;
    scale = newScale;
    apply();
    viewportEl.scrollLeft = beforeX * ratio - (focalClientX - vr.left);
    viewportEl.scrollTop = beforeY * ratio - (focalClientY - vr.top);
  }

  const dist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  const mid = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });

  viewportEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinch = { startDist: dist(e.touches[0], e.touches[1]), startScale: scale };
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapTime < 300) setScale(1, e.touches[0].clientX, e.touches[0].clientY);
      lastTapTime = now;
    }
  }, { passive: false });

  viewportEl.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const m = mid(e.touches[0], e.touches[1]);
      setScale(pinch.startScale * (d / pinch.startDist), m.x, m.y);
    }
  }, { passive: false });

  viewportEl.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
  viewportEl.addEventListener('touchcancel', () => { pinch = null; });

  resetBtn.addEventListener('click', () => {
    const vr = viewportEl.getBoundingClientRect();
    setScale(1, vr.left + vr.width / 2, vr.top + vr.height / 2);
  });

  // Mod Matrix / Signal Path start out inside a `display:none` inactive tab
  // panel, where getBoundingClientRect() reads 0x0 -- a plain call right
  // after render can't measure real content size yet. ResizeObserver fires
  // again once the tab is switched to and the content actually lays out, so
  // natural size gets picked up correctly whenever that happens instead of
  // needing tab-switch code to know about zoom internals.
  new ResizeObserver(() => { if (scale === 1) measure(); }).observe(content);
  measure();
}

function buildModMatrixTable(patch) {
  const cables = cablesOf(patch);
  if (!cables.length) {
    return '<div class="empty-note">This patch has no modulation routings at all (not even the usual velocity/aftertouch defaults).</div>';
  }
  // Cross-tab: one row per source, one column per destination, value (and
  // default/custom state) at the intersection. Each (source, destination)
  // pair is unique on the Deluge, so at most one cable ever lands in a cell.
  const sourceOrder = [];
  const destOrder = [];
  const destLabel = new Map();
  const cellByKey = new Map();
  for (const c of cables) {
    if (!sourceOrder.includes(c.source)) sourceOrder.push(c.source);
    if (!destOrder.includes(c.destination)) { destOrder.push(c.destination); destLabel.set(c.destination, destDisplayName(c.destination)); }
    cellByKey.set(`${c.source}\u0000${c.destination}`, c);
    // See cablesOf()'s own comment: a cable's own depth can itself be
    // modulated by MORE THAN ONE second source at once (a "double mod",
    // confirmed on a real preset with two simultaneous modulators).
    // Previously only a hover-only "†" footnote on the outer cell --
    // upgraded to a real, synthetic extra column PER modulator instead. The
    // COLUMN is labeled with the OUTER cable's own source (what's actually
    // being touched -- "LFO1's own depth"), not the modulator's source --
    // an earlier version of this mislabeled it with the modulator's own
    // source instead, so e.g. RANDOM modulating LFO1's depth showed as a
    // nonsense "random -> random" row/column pair instead of the correct
    // "random -> LFO1" reading.
    for (const m of c.depthModulators || []) {
      const depthSrc = m.source;
      const depthKey = `__depth__${c.source}__${c.destination}__${depthSrc}`;
      if (!sourceOrder.includes(depthSrc)) sourceOrder.push(depthSrc);
      if (!destOrder.includes(depthKey)) { destOrder.push(depthKey); destLabel.set(depthKey, SOURCE_LABEL[c.source] || humanize(c.source)); }
      cellByKey.set(`${depthSrc}\u0000${depthKey}`, { isDepthCell: true, amount: m.amount, ofSource: c.source, ofDestination: c.destination });
    }
  }
  const destHeaderCells = destOrder.map(d => d.startsWith('__depth__')
    ? `<th class="mm-depth-col" title="Depth modulation -- this column is another cable's own modulation depth, not a normal destination">${destLabel.get(d)}</th>`
    : `<th>${destLabel.get(d)}</th>`).join('');
  const bodyRows = sourceOrder.map(s => {
    const cells = destOrder.map(d => {
      const c = cellByKey.get(`${s}\u0000${d}`);
      if (!c) return '<td class="mm-empty">&middot;</td>';
      const amt = dvCable(c.amount);
      const magnitudePct = (Math.abs(amt) / 50) * 100;
      const barLeft = amt < 0 ? 50 - magnitudePct / 2 : 50;
      const barWidth = magnitudePct / 2;
      if (c.isDepthCell) {
        const ofLabel = `${SOURCE_LABEL[c.ofSource] || humanize(c.ofSource)} → ${destDisplayName(c.ofDestination)}`;
        return `<td class="mm-cell mm-depth-cell" title="Depth of ${escapeHtml(ofLabel)}'s own modulation amount">
          <span class="amount-bar"><span style="left:${barLeft}%;width:${barWidth}%"></span></span>${fmtCable(c.amount)}
        </td>`;
      }
      const isDefault = cableIsDefault(c);
      return `<td class="mm-cell${isDefault ? ' is-default' : ''}" title="${isDefault ? 'Default (unchanged from init)' : 'Custom routing'}">
        <span class="amount-bar"><span style="left:${barLeft}%;width:${barWidth}%"></span></span>${fmtCable(c.amount)}
      </td>`;
    }).join('');
    return `<tr><th class="mm-rowhead">${SOURCE_LABEL[s] || humanize(s)}</th>${cells}</tr>`;
  }).join('');
  const table = `<table class="data-table matrix-grid">
      <thead><tr><th class="mm-corner">Source &darr; / Destination &rarr;</th>${destHeaderCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  return `
    <p class="empty-note" style="padding:0 0 12px">Depth shown is the Deluge's own -50.00 to 50.00 scale. Muted cells are
      unchanged from the init patch's built-in routings; highlighted cells are this preset's own choices.
      A shaded column header (e.g. "LFO 1") isn't a normal destination -- it's another cable's own modulation
      depth, itself being modulated by a second source (a "double mod").</p>
    ${makeZoomable(table)}`;
}

// ---------------------------------------------------------------------------
// Signal Path tab: an SVG diagram of this preset's actual signal flow.
// ---------------------------------------------------------------------------
function svgEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function sdBox(x, y, w, h, label, sublabel, cls, tooltip, color) {
  const lines = [];
  // Deliberately no native SVG <title> here: browsers (notably Safari) show
  // their own delayed native tooltip for it *in addition to* the custom
  // data-tooltip one wired up in the Wiring section, producing two
  // overlapping popups. The custom one is the only one we want.
  const style = color ? ` style="--src-color:${color}"` : '';
  lines.push(`<rect class="sd-box ${cls || ''}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"${style}/>`);
  lines.push(`<text class="sd-label" x="${x + w / 2}" y="${y + h / 2 - (sublabel ? 6 : -4)}" text-anchor="middle">${label}</text>`);
  if (sublabel) lines.push(`<text class="sd-sublabel" x="${x + w / 2}" y="${y + h / 2 + 12}" text-anchor="middle">${sublabel}</text>`);
  const svg = tooltip
    ? `<g class="sd-hoverable" data-tooltip="${svgEscape(tooltip)}">${lines.join('')}</g>`
    : lines.join('');
  return { svg, cx: x + w / 2, cy: y + h / 2, left: x, right: x + w, top: y, bottom: y + h };
}
function sdArrow(x1, y1, x2, y2, dashed, label, color) {
  const style = color ? ` style="stroke:${color}"` : '';
  const path = `<path class="sd-arrow${dashed ? ' mod' : ''}" d="M${x1},${y1} C${x1 + (x2 - x1) / 2},${y1} ${x1 + (x2 - x1) / 2},${y2} ${x2},${y2}"${style}/>`;
  const lbl = label ? `<text class="sd-mod-label" x="${(x1 + x2) / 2}" y="${Math.min(y1, y2) - 4}" text-anchor="middle">${label}</text>` : '';
  return path + lbl;
}
// A source modulating its own outgoing cable's depth (a real "double mod",
// see cablesOf()'s own comment) has no second box to point at -- drawn as a
// small loop leaving and re-entering the SAME box's bottom edge instead.
// Always the dashed/"mod" style (see sdArrow() above): no arrowhead, same
// muted-but-colored treatment as every other modulation-only line.
// `loopIndex` (0, 1, 2, ...) nudges each additional loop off the SAME box
// further down, so two simultaneous self-loops (a cable modulated by its
// own source in more than one way -- rare, but the underlying data model
// allows it) don't draw exactly on top of each other.
function sdSelfLoop(box, label, color, loopIndex) {
  const x1 = box.cx + (box.right - box.left) * 0.18, x2 = box.cx - (box.right - box.left) * 0.18;
  const y0 = box.bottom, loopY = y0 + 22 + (loopIndex || 0) * 18;
  const style = color ? ` style="stroke:${color}"` : '';
  const path = `<path class="sd-arrow mod" d="M${x1},${y0} C${x1},${loopY} ${x2},${loopY} ${x2},${y0}"${style}/>`;
  const lbl = label ? `<text class="sd-mod-label" x="${box.cx}" y="${loopY + 11}" text-anchor="middle">${label}</text>` : '';
  return path + lbl;
}
// One fixed, distinct color per modulation source, consistent across every
// preset -- so "this is the same source" is recognizable by color instead of
// needing to trace which of many arrows leaving one crowded box goes where.
const SOURCE_COLORS = {
  envelope1: '#f0705e', envelope2: '#f0a35e',
  lfo1: '#5ec8f0', lfo2: '#5e93f0',
  velocity: '#b05ef0', aftertouch: '#e05ef0',
  random: '#5ef0a3', note: '#5ef0d9',
  'sidechain-comp': '#f05e8f', x: '#c3f05e', y: '#f0d95e', modulator2: '#c3a8f0',
};
function sourceColor(key) { return SOURCE_COLORS[key] || '#9aa0b0'; }

const VALID_FILTER_MODES = new Set(['12dB', '24dB', '24dBDrive', 'SVF_Band', 'SVF_Notch', 'HPLadder']);

function buildSignalPathSvg(patch, idPrefix) {
  // `idPrefix` namespaces this diagram's internal SVG ids (currently just
  // the arrowhead marker) so two copies of this function's output can be
  // rendered into the document at once (the Compare tab does exactly that)
  // without one diagram's <marker id> colliding with the other's. Defaults
  // to 'sp' for the single-diagram Signal Path tab, which never renders
  // alongside a second copy of itself.
  const svgId = `sigpath-${idPrefix || 'sp'}`;
  const markerId = `sd-arrowhead-${idPrefix || 'sp'}`;
  const dp = patch.defaultParams || {};
  const cables = cablesOf(patch);
  const isFm = patch.mode === 'fm';
  const isRingmod = patch.mode === 'ringmod';
  const noiseOn = dp.noiseVolume && q31Differs(dp.noiseVolume, INIT.noiseVolume);
  const env1 = patch.envelope1 || get(dp, 'envelope1');
  const env1On = env1 && ['attack', 'decay', 'sustain', 'release'].some(f => env1[f] && q31Differs(env1[f], INIT.env1[f]));
  const lpfOn = dp.lpfFrequency && q31Differs(dp.lpfFrequency, INIT.lpfFrequency);
  const hpfOn = dp.hpfFrequency && q31Differs(dp.hpfFrequency, INIT.hpfFrequency);
  const modFxOn = patch.modFXType && patch.modFXType !== INIT.modFXType;
  const delayOn = dp.delayFeedback && q31Differs(dp.delayFeedback, INIT.delayFeedback);
  const reverbOn = dp.reverbAmount && q31Differs(dp.reverbAmount, INIT.reverbAmount);
  const arp = patch.arpeggiator;
  const arpOn = arpModeOn(arp);
  const uni = patch.unison;
  const uniOn = uni && parseInt(uni.num, 10) > 1;
  const sc = patch.sidechain;
  const scOn = sc && (plainDiffers(sc.attack, INIT.sidechain.attack) || plainDiffers(sc.release, INIT.sidechain.release) || plainDiffers(sc.syncLevel, INIT.sidechain.syncLevel));
  const satOn = patch.clippingAmount && patch.clippingAmount !== '0';
  const crushOn = dp.bitCrush && q31Differs(dp.bitCrush, INIT.bitCrush);
  const decimOn = dp.sampleRateReduction && q31Differs(dp.sampleRateReduction, INIT.sampleRateReduction);
  const driveOn = satOn || crushOn || decimOn;
  const validMode = m => VALID_FILTER_MODES.has(m) ? m : null;
  const nonDefaultCables = cables.filter(c => !cableIsDefault(c));
  // Multi-value details go in the hover tooltip only -- cramming them as an
  // in-box sublabel (e.g. "fb 2, rate 25, ping-pong") doesn't fit and reads
  // as noise at this box size; short single-token sublabels stay in-box.
  const driveTip = [satOn && `Saturation: ${patch.clippingAmount}`, crushOn && `Bitcrush: ${dv(dp.bitCrush)}`, decimOn && `Decimation: ${dv(dp.sampleRateReduction)}`].filter(Boolean).join('\n') || 'No saturation, bitcrush or decimation.';
  const eq = dp.equalizer;
  const eqOn = eq && (q31Differs(eq.bass || '0x00000000', '0x00000000') || q31Differs(eq.treble || '0x00000000', '0x00000000'));
  const eqTip = eqOn ? `Bass boost: ${dv(eq.bass || '0x00000000')}\nTreble boost: ${dv(eq.treble || '0x00000000')}` : 'No EQ boost.';
  const delayTip = delayOn
    ? `Feedback: ${dv(dp.delayFeedback)}${dp.delayRate ? `\nRate: ${dv(dp.delayRate)}` : ''}\n${patch.delay && patch.delay.pingPong === '1' ? 'Ping-pong: on' : 'Ping-pong: off'}\n${patch.delay && patch.delay.analog === '1' ? 'Type: analog' : 'Type: digital'}`
    : 'Delay is off (feedback at init).';
  const reverbTip = reverbOn ? `Amount: ${dv(dp.reverbAmount)}` : 'Reverb send is off.';

  // The <style> override beats styles.css's global `.sd-arrow { marker-end:
  // url(#sd-arrowhead) }` on specificity (an id selector always wins over a
  // bare class one), so each diagram's arrows point at its OWN namespaced
  // marker rather than whichever same-named marker happens to be first in
  // the document. `:not(.mod)` matters here: without it, this id-scoped
  // rule would itself outrank styles.css's `.sd-arrow.mod { marker-end:
  // none }` (an id beats two classes regardless of class count) and put
  // the arrowhead back on modulation lines -- which is exactly the bug
  // that rule exists to avoid (their curved tangent often points the wrong
  // way at the target). Modulation lines never get an arrowhead, in any
  // diagram, full stop.
  const defs = `<defs><marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--text-dim)"/></marker></defs><style>#${svgId} .sd-arrow:not(.mod){marker-end:url(#${markerId})}</style>`;
  const boxes = [];
  const arrows = [];
  let maxY = 0;
  const place = (b) => { boxes.push(b.svg); maxY = Math.max(maxY, b.bottom); return b; };
  const link = (a, b, dashed, label) => { arrows.push(sdArrow(a.right, a.cy, b.left, b.cy, dashed, label)); };

  // ROW_Y is comfortably below TOP+30 (the FM MOD1/MOD2 row's bottom) so
  // CARRIER1/2 -- which sit at ROW_Y -- don't crowd right up against them.
  const TOP = 34, ROW_Y = 170, BH = 50;
  // Shared size for every mod-source node (both the bottom lane and the
  // left-of-oscillators column) -- wide enough that "AFTERTOUCH" fits
  // comfortably rather than feeling cramped.
  const MOD_NODE_W = 92, MOD_NODE_H = 26, MOD_NODE_GAP = 10;
  let x = 20;
  const col = (w) => { const b = x; x += w + 26; return b; };

  // One lane node per (source, destination-box) pair, not per individual
  // cable: a source with two cables landing on the *same* box (e.g. both
  // lpfFrequency and lpfResonance) is one connection to look at, not two
  // identical-looking arrows stacked onto the same target. Nodes from the
  // same source still share a fixed color (see SOURCE_COLORS) so which
  // arrows belong together is visible without needing a shared crowded box.
  const nodes = []; // { key, label, box, targets: [{destLabel, amountText}] }
  const boxIndex = new Map();
  let nextBoxIndex = 0;
  const idxOf = (box) => { if (!boxIndex.has(box)) boxIndex.set(box, nextBoxIndex++); return boxIndex.get(box); };
  const nodeByKeyAndBox = new Map();
  const addNode = (key, label, box, destLabel, amountText) => {
    const mapKey = `${key}::${idxOf(box)}`;
    let node = nodeByKeyAndBox.get(mapKey);
    if (!node) {
      node = { key, label, box, targets: [] };
      nodeByKeyAndBox.set(mapKey, node);
      nodes.push(node);
    }
    node.targets.push({ destLabel, amountText });
  };

  // Boxes that a left-side gap column of mod sources will target (see
  // leftGapNodes below), hoisted so the lane-layout code can reach them
  // regardless of which branch below set them.
  let mod1 = null, mod2 = null;
  let sources = [];
  if (isFm) {
    const m1Amt = dp.modulator1Amount && q31Differs(dp.modulator1Amount, INIT.modulatorAmount) ? dv(dp.modulator1Amount) : null;
    const m2Amt = dp.modulator2Amount && q31Differs(dp.modulator2Amount, INIT.modulatorAmount) ? dv(dp.modulator2Amount) : null;
    const m1FbOn = dp.modulator1Feedback && q31Differs(dp.modulator1Feedback, INIT.modulatorAmount);
    const m2FbOn = dp.modulator2Feedback && q31Differs(dp.modulator2Feedback, INIT.modulatorAmount);
    const feedsMod1 = patch.modulator2 && patch.modulator2.toModulator1 && patch.modulator2.toModulator1 !== '0';
    // MOD1/MOD2's column starts right of where sources targeting them get
    // parked (see leftGapNodes below) -- CARRIER1/2 sit directly beneath
    // MOD1/2, so anything reaching them from the shared bottom lane would
    // have to visually cross straight through the carrier boxes to get there.
    const MOD_X = 20 + MOD_NODE_W + 24;
    mod1 = place(sdBox(MOD_X, TOP + 30, 76, 40, 'MOD 1', null, (m1Amt !== null || m1FbOn) ? 'changed' : '',
      `Transpose: ${patch.osc1 ? patch.osc1.transpose || 0 : 0} st${m1Amt !== null ? `\nAmount: ${m1Amt}` : ''}${m1FbOn ? `\nFeedback: ${dv(dp.modulator1Feedback)}` : ''}`));
    const car1 = place(sdBox(mod1.left, ROW_Y, 76, BH, 'CARRIER 1', patch.osc1 && patch.osc1.transpose && patch.osc1.transpose !== '0' ? `${patch.osc1.transpose}st` : null, patch.osc1 && patch.osc1.transpose !== '0' ? 'changed' : '', `Transpose: ${patch.osc1 ? patch.osc1.transpose || 0 : 0} st`));
    x = mod1.left; col(76);
    mod2 = place(sdBox(col(76), TOP + 30, 76, 40, 'MOD 2', null, (m2Amt !== null || m2FbOn || feedsMod1) ? 'changed' : '',
      `Transpose: ${patch.osc2 ? patch.osc2.transpose || 0 : 0} st${m2Amt !== null ? `\nAmount: ${m2Amt}` : ''}${m2FbOn ? `\nFeedback: ${dv(dp.modulator2Feedback)}` : ''}`));
    const car2 = place(sdBox(mod2.left, ROW_Y, 76, BH, 'CARRIER 2', patch.osc2 && patch.osc2.transpose && patch.osc2.transpose !== '0' ? `${patch.osc2.transpose}st` : null, patch.osc2 && patch.osc2.transpose !== '0' ? 'changed' : '', `Transpose: ${patch.osc2 ? patch.osc2.transpose || 0 : 0} st`));
    arrows.push(sdArrow(mod1.cx, mod1.bottom, car1.cx, car1.top, true));
    arrows.push(sdArrow(mod2.cx, mod2.bottom, car2.cx, car2.top, true));
    // Modulator 2 optionally feeds Modulator 1 too (a chained FM operator).
    // Rather than a direct box-to-box arrow reusing MOD2 itself as "the
    // source" (cramped, and inconsistent with every other modulation on this
    // diagram), it's added as its own lane node like LFO1/ENV1/etc: a
    // separate color-coded badge, laid out and made hoverable the same way.
    if (feedsMod1) addNode('modulator2', 'MOD 2', mod1, 'Modulator 1', 'chained FM feed');
    sources = [car1, car2];
  } else {
    // Oscillator column starts to the right of where mod sources targeting
    // it will be parked (see leftGapNodes below) -- OSC2/NOISE sit directly
    // beneath OSC1, so anything reaching OSC1 from the shared bottom lane
    // would have to visually cross straight through them to get there.
    const OSC_X = 20 + MOD_NODE_W + 24;
    const osc1Changed = patch.osc1 && ((patch.osc1.type && patch.osc1.type !== 'square') || (patch.osc1.transpose && patch.osc1.transpose !== '0'));
    const osc2Changed = patch.osc2 && ((patch.osc2.type && patch.osc2.type !== 'square') || (patch.osc2.transpose && patch.osc2.transpose !== '0'));
    const oscTip = o => `Type: ${o && o.type ? o.type : 'square'}${o && o.transpose && o.transpose !== '0' ? `\nTranspose: ${o.transpose} st` : ''}${o && o.cents && o.cents !== '0' ? `\nCents: ${o.cents}` : ''}${o && o.oscillatorSync === '1' ? '\nOscillator sync: on' : ''}`;
    const osc1 = place(sdBox(OSC_X, TOP + 30, 90, BH, 'OSC 1', patch.osc1 && patch.osc1.type ? patch.osc1.type : 'square', osc1Changed ? 'changed' : '', oscTip(patch.osc1)));
    const osc2 = place(sdBox(OSC_X, osc1.bottom + 60, 90, BH, 'OSC 2', patch.osc2 && patch.osc2.type ? patch.osc2.type : 'square', osc2Changed ? 'changed' : '', oscTip(patch.osc2)));
    sources = [osc1, osc2];
    if (noiseOn) sources.push(place(sdBox(OSC_X, osc2.bottom + 60, 90, BH, 'NOISE', null, 'changed', `Level: ${dv(dp.noiseVolume)}`)));
    x = OSC_X + 90 + 26;
  }

  // A note-generation stage upstream of the oscillators, only drawn when used.
  if (arpOn) {
    // Target the topmost box in the column, not sources[0] -- in FM mode
    // sources[0] is CARRIER1, which sits *below* MOD1. Since boxes are drawn
    // on top of arrows, an arrow aimed past MOD1 down to CARRIER1 would be
    // hidden behind MOD1's box, making it look like a second, separate line
    // meets CARRIER1 from above (right where MOD1's own real arrow does).
    const arpTarget = isFm ? mod1 : sources[0];
    const arpBox = place(sdBox(arpTarget.left, 4, 90, 40, 'ARP', arpPresetName(arp), 'changed'));
    arrows.push(sdArrow(arpBox.cx, arpBox.bottom, arpTarget.cx, arpTarget.top, true));
  }

  const portaOn = dp.portamento && q31Differs(dp.portamento, INIT.portamento);
  // OSC1/OSC2 LEVEL is hidden by firmware itself in Ring Mod mode (see
  // buildGuide()'s isRingmod comment) -- showing a level here would
  // describe a control the user can't actually reach on the device.
  const mixTipLines = isRingmod ? [] : [
    `OSC1 level: ${dp.oscAVolume ? dv(dp.oscAVolume) : 50}`,
    `OSC2 level: ${dp.oscBVolume ? dv(dp.oscBVolume) : 0}`,
  ];
  if (noiseOn) mixTipLines.push(`Noise level: ${dv(dp.noiseVolume)}`);
  mixTipLines.push(uniOn ? `Unison voices: ${uni.num}${uni.detune ? `, detune ${uni.detune}` : ''}${uni.spread && uni.spread !== '0' ? `, spread ${uni.spread}` : ''}` : 'No unison (1 voice)');
  if (portaOn) mixTipLines.push(`Portamento: ${dv(dp.portamento)}`);
  const mixChanged = uniOn || portaOn || (!isRingmod && dp.oscBVolume && q31Differs(dp.oscBVolume, INIT.oscBVolume)) || noiseOn;
  const mixSublabelParts = [uniOn ? `×${uni.num} unison` : null, portaOn ? 'glide' : null].filter(Boolean);
  const mixer = place(sdBox(col(60), ROW_Y, 60, BH, 'MIX', mixSublabelParts.length ? mixSublabelParts.join(', ') : null, mixChanged ? 'changed' : '', mixTipLines.join('\n')));
  sources.forEach(s => link(s, mixer, false));

  let prev = mixer;
  let hpfBoxRef, lpfBoxRef;
  const hpfTip = `Mode: ${validMode(patch.hpfMode) || validMode(INIT.hpfMode) || patch.hpfMode || 'n/a'}\nFrequency: ${dv(dp.hpfFrequency)}${dp.hpfResonance ? `\nResonance: ${dv(dp.hpfResonance)}` : ''}`;
  const lpfTip = `Mode: ${validMode(patch.lpfMode) || validMode(INIT.lpfMode) || patch.lpfMode || 'n/a'}\nFrequency: ${dv(dp.lpfFrequency)}${dp.lpfResonance ? `\nResonance: ${dv(dp.lpfResonance)}` : ''}`;
  const makeHpf = (y) => sdBox(col(70), y, 70, BH, 'HPF', validMode(patch.hpfMode) || validMode(INIT.hpfMode), hpfOn ? 'changed' : 'bypassed', hpfTip);
  const makeLpf = (y) => sdBox(col(70), y, 70, BH, 'LPF', validMode(patch.lpfMode) || validMode(INIT.lpfMode), lpfOn ? 'changed' : 'bypassed', lpfTip);

  if (patch.filterRoute === 'Parallel') {
    // Both filters fed straight from the mixer and summed afterward, rather
    // than one feeding the other's input (manual: docs/menus/filter/routing.md).
    const hpfP = place(makeHpf(ROW_Y - 35));
    x -= 96; // reuse the same column for the paired LPF box below it
    const lpfP = place(makeLpf(ROW_Y + 35));
    link(mixer, hpfP, false); link(mixer, lpfP, false);
    const sum = place(sdBox(col(40), ROW_Y, 40, BH, '+', 'sum'));
    link(hpfP, sum, false); link(lpfP, sum, false);
    hpfBoxRef = hpfP; lpfBoxRef = lpfP; prev = sum;
  } else {
    const lpfFirst = patch.filterRoute !== 'L2H';
    const first = lpfFirst ? place(makeHpf(ROW_Y)) : place(makeLpf(ROW_Y));
    link(prev, first, false); prev = first;
    const second = lpfFirst ? place(makeLpf(ROW_Y)) : place(makeHpf(ROW_Y));
    link(prev, second, false); prev = second;
    hpfBoxRef = lpfFirst ? first : second;
    lpfBoxRef = lpfFirst ? second : first;
  }

  const ampTip = env1
    ? `Attack: ${dv(env1.attack)}\nDecay: ${dv(env1.decay)}\nSustain: ${dv(env1.sustain)}\nRelease: ${dv(env1.release)}`
    : 'Amp envelope (Envelope 1).';
  const amp = place(sdBox(col(70), ROW_Y, 70, BH, 'AMP', 'env 1', env1On ? 'changed' : '', ampTip));
  link(prev, amp, false); prev = amp;

  const drive = place(sdBox(col(70), ROW_Y, 70, BH, 'DRIVE', null, driveOn ? 'changed' : 'bypassed', driveTip));
  link(prev, drive, false); prev = drive;

  const eqBox = place(sdBox(col(60), ROW_Y, 60, BH, 'EQ', null, eqOn ? 'changed' : 'bypassed', eqTip));
  link(prev, eqBox, false); prev = eqBox;

  const modFxTip = modFxOn ? `Type: ${patch.modFXType}${dp.modFXRate ? `\nRate: ${dv(dp.modFXRate)}` : ''}${dp.modFXDepth ? `\nDepth: ${dv(dp.modFXDepth)}` : ''}` : 'Mod FX is off.';
  const modfx = place(sdBox(col(70), ROW_Y, 70, BH, 'MOD-FX', modFxOn ? patch.modFXType : null, modFxOn ? 'changed' : 'bypassed', modFxTip));
  const delayB = place(sdBox(col(70), ROW_Y, 70, BH, 'DELAY', null, delayOn ? 'changed' : 'bypassed', delayTip));
  const reverbB = place(sdBox(col(70), ROW_Y, 70, BH, 'REVERB', null, reverbOn ? 'changed' : 'bypassed', reverbTip));
  [modfx, delayB, reverbB].forEach(b => { link(prev, b, false); prev = b; });

  const panChanged = dp.pan && q31Differs(dp.pan, INIT.pan);
  const out = place(sdBox(col(60), ROW_Y, 60, BH, 'OUT', panChanged ? `pan ${dvPan(dp.pan)}` : null, panChanged ? 'changed' : '', panChanged ? `Pan: ${dvPan(dp.pan)} (range -25 left to +25 right)` : 'Pan is centered.'));
  link(prev, out, false);

  // One horizontal lane of modulation sources below the main chain -- each
  // unique source (real cables, plus the two structural connections that
  // aren't cables: ENV2 is always the filter envelope, sidechain always
  // ducks the amp) drawn once, fanning out to every box it actually
  // modulates. Hovering a source shows its full target + amount list.
  // A whole-library sweep (every non-default cable in every real preset)
  // found this list covered only a fraction of the destinations cables
  // actually target in practice -- ~400 real cables across the library
  // landed on a destination this map didn't know, so their source was
  // silently missing from the diagram entirely (reported as "random fehlt
  // im Signalpfad" for one specific case, but the same class of gap hit
  // dozens of other destinations too). Extended to cover every destination
  // that maps cleanly onto a box already drawn somewhere in this diagram;
  // see below (near the lane-node loops) for lfo1Rate/lfo2Rate and the
  // envelope attack/decay/sustain/release destinations, which don't have a
  // "signal chain" box at all and are handled the same way as a cable's
  // own chained depth modulator instead (an arrow to that source's own
  // lane node, or a self-loop).
  const DEST_TO_BOX = {
    volume: amp, pan: out, volumePostReverbSend: out,
    lpfFrequency: lpfBoxRef, lpfResonance: lpfBoxRef,
    hpfFrequency: hpfBoxRef, hpfResonance: hpfBoxRef,
    oscAVolume: sources[0], oscAPhaseWidth: sources[0], oscAPitch: sources[0], oscAWavetablePosition: sources[0],
    oscBVolume: sources[1], oscBPhaseWidth: sources[1], oscBPitch: sources[1], oscBWavetablePosition: sources[1],
    noiseVolume: sources[2],
    pitch: mixer,
    modulator1Volume: mod1, modulator1Pitch: mod1, modulator1Feedback: mod1, carrier1Feedback: sources[0],
    modulator2Volume: mod2, modulator2Pitch: mod2, modulator2Feedback: mod2, carrier2Feedback: sources[1],
    modFXRate: modfx, modFXDepth: modfx,
    delayRate: delayB, delayFeedback: delayB,
  };
  // Envelope 1 -> amp volume is exactly as structural/always-on as envelope
  // 2 -> filter cutoff (neither is an explicit patch cable), so it gets the
  // same treatment rather than being the one always-on connection left out.
  addNode('envelope1', 'ENV 1', amp, 'Amp volume', 'structural, always on');
  addNode('envelope2', 'ENV 2', lpfBoxRef, 'Filter cutoff', 'structural, always on');
  if (scOn) addNode('sidechain-comp', 'SIDECHAIN', amp, 'Amp volume (ducking)', `attack ${sc.attack}, release ${sc.release}`);
  // Some destinations aren't on the main audio-signal chain at all -- they
  // ARE another modulation source's own rate/envelope-time (e.g. LFO2
  // speeding up LFO1, or velocity shortening ENV1's attack). No box in
  // this diagram represents "LFO1"/"ENV1" as a destination the way
  // lpfFrequency/amp/etc. do, so these skip DEST_TO_BOX entirely and are
  // instead handled below alongside chained depth modulators, pointed at
  // that source's own lane node (a self-loop if the modulator IS that same
  // source, an ordinary lane-to-lane arrow otherwise) -- the exact same
  // "no destination box, point at a lane node instead" treatment.
  const RATE_OR_ENV_DEST_TO_SOURCE_KEY = {
    lfo1Rate: 'lfo1', lfo2Rate: 'lfo2',
    env1Attack: 'envelope1', env1Decay: 'envelope1', env1Sustain: 'envelope1', env1Release: 'envelope1',
    env2Attack: 'envelope2', env2Decay: 'envelope2', env2Sustain: 'envelope2', env2Release: 'envelope2',
  };
  nonDefaultCables.forEach(c => {
    if (RATE_OR_ENV_DEST_TO_SOURCE_KEY[c.destination]) return; // handled below
    const target = DEST_TO_BOX[c.destination];
    if (!target) return;
    // A patch cable from the compressor (real XML source="compressor") is
    // the same physical modulation source as the always-on ducking
    // connection above -- key it the same so it gets the same lane color
    // and its tooltip merges into the one SIDECHAIN node instead of
    // spawning a second, differently-colored, mislabeled "Compressor" node.
    const key = c.source === 'compressor' ? 'sidechain-comp' : c.source;
    addNode(key, SOURCE_LABEL[key] || humanize(c.source), target, destDisplayName(c.destination), fmtCable(c.amount));
  });

  // A node's own source settings (its ADSR, shape/rate, etc.) shown above
  // its target(s) -- otherwise ENV1/ENV2/LFO1/LFO2's own values were only
  // visible if you happened to already know they existed. One line per
  // parameter, not comma-joined, so it's actually easy to scan on hover.
  const ownInfo = new Map();
  if (env1) ownInfo.set('envelope1', `Attack: ${dv(env1.attack)}\nDecay: ${dv(env1.decay)}\nSustain: ${dv(env1.sustain)}\nRelease: ${dv(env1.release)}`);
  const env2 = patch.envelope2 || get(dp, 'envelope2');
  if (env2) ownInfo.set('envelope2', `Attack: ${dv(env2.attack)}\nDecay: ${dv(env2.decay)}\nSustain: ${dv(env2.sustain)}\nRelease: ${dv(env2.release)}`);
  ['lfo1', 'lfo2'].forEach((key, i) => {
    const n = i + 1, lfo = patch[key], rateKey = `lfo${n}Rate`;
    if (lfo) ownInfo.set(key, `Shape: ${lfo.type || 'triangle'}${dp[rateKey] ? `\nRate: ${dv(dp[rateKey])}` : ''}`);
  });

  // Every node from the same source shows the SAME full tooltip -- its own
  // settings plus *everywhere* that source goes, in matching color -- no
  // matter which one of its (possibly several) nodes you're hovering.
  const targetsByKey = new Map();
  nodes.forEach(n => {
    if (!targetsByKey.has(n.key)) targetsByKey.set(n.key, []);
    n.targets.forEach(t => targetsByKey.get(n.key).push(`→ ${t.destLabel}: ${t.amountText}`));
  });
  const tooltipFor = key => [ownInfo.get(key), ...(targetsByKey.get(key) || [])].filter(Boolean).join('\n');

  // Shared 1-D layout: place items near their natural position (anchorOf),
  // but when several land on essentially the same spot, spread them out
  // centered on that shared spot instead of stacking off to one side of it;
  // a final sweep then nudges apart any two groups that would still overlap.
  function spreadCentered(entries, anchorOf, size, gap, minPos) {
    const sorted = entries.map(e => ({ e, anchor: anchorOf(e) })).sort((a, b) => a.anchor - b.anchor);
    const clusters = [];
    for (const item of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && item.anchor - last[last.length - 1].anchor < size + gap) last.push(item);
      else clusters.push([item]);
    }
    const positioned = [];
    for (const cluster of clusters) {
      const avg = cluster.reduce((s, m) => s + m.anchor, 0) / cluster.length;
      cluster.forEach((m, i) => positioned.push({ e: m.e, pos: avg + (i - (cluster.length - 1) / 2) * (size + gap) }));
    }
    positioned.forEach((p, i) => {
      p.pos = i === 0 ? Math.max(p.pos, minPos) : Math.max(p.pos, positioned[i - 1].pos + size + gap);
    });
    return positioned;
  }

  // Sources that land on a box with something else stacked directly beneath
  // it -- the OSC1/OSC2/[NOISE] column (non-FM), or MOD1/MOD2 sitting right
  // above their own CARRIER (FM) -- get parked in a column to the LEFT
  // instead of the shared bottom lane. Reaching OSC1 or MOD1 from a lane
  // below OSC2/NOISE or CARRIER1/2 would draw a line straight through those
  // boxes to get there, which reads as a second connection to them.
  const leftGapTargets = isFm ? [mod1, mod2].filter(Boolean) : sources;
  const leftGapNodes = nodes.filter(n => leftGapTargets.includes(n.box));
  const laneNodes = nodes.filter(n => !leftGapNodes.includes(n));

  // Placed lane-node box per source key -- needed below to draw a
  // depth-modulates-depth loop/arrow, which points at a SOURCE's own lane
  // node rather than at any destination box, so it has to wait until lane
  // nodes are actually positioned.
  const laneBoxByKey = new Map();
  if (leftGapNodes.length) {
    const gapLeft = 20;
    const gapTop = Math.min(...leftGapTargets.map(b => b.top));
    const gapPositioned = spreadCentered(leftGapNodes, n => n.box.cy, MOD_NODE_H, MOD_NODE_GAP, gapTop);
    gapPositioned.forEach(p => {
      const color = sourceColor(p.e.key);
      const node = place(sdBox(gapLeft, p.pos - MOD_NODE_H / 2, MOD_NODE_W, MOD_NODE_H, p.e.label, null, 'lane', tooltipFor(p.e.key), color));
      laneBoxByKey.set(p.e.key, node);
      arrows.push(sdArrow(node.right, node.cy, p.e.box.left, p.e.box.cy, true, null, color));
    });
  }

  const laneY = maxY + 40;
  const lanePositioned = spreadCentered(laneNodes, n => n.box.cx, MOD_NODE_W, MOD_NODE_GAP, 20 + MOD_NODE_W / 2);
  let laneRight = 20;
  lanePositioned.forEach(p => {
    const color = sourceColor(p.e.key);
    const node = place(sdBox(p.pos - MOD_NODE_W / 2, laneY, MOD_NODE_W, 30, p.e.label, null, 'lane', tooltipFor(p.e.key), color));
    laneBoxByKey.set(p.e.key, node);
    laneRight = Math.max(laneRight, node.right);
    arrows.push(sdArrow(node.cx, node.top, p.e.box.cx, p.e.box.bottom, true, null, color));
  });

  // Two kinds of connection have no "normal" destination box to point an
  // arrow at, because what they modulate IS another modulation source
  // itself, not a spot on the audio-signal chain:
  //  - a cable's own depth being modulated by a second source (see
  //    cablesOf()'s own comment, a "double mod") -- modulates the OUTER
  //    cable's source's own lane node.
  //  - a cable whose destination is literally another source's own rate/
  //    envelope-time (RATE_OR_ENV_DEST_TO_SOURCE_KEY above, e.g. LFO2 ->
  //    lfo1Rate) -- modulates THAT source's own lane node directly.
  // Both get the identical treatment: a genuine self-loop when the
  // modulator IS that same source (e.g. LFO1's own vibrato depth modulated
  // by LFO1 again), an ordinary arrow between two lane nodes otherwise.
  // Either side of that arrow might have no OTHER direct routing anywhere
  // in the signal chain (e.g. RANDOM used only to modulate a different
  // cable's own depth, or an LFO whose only "activity" is being modulated
  // by something else) -- addNode() never ran for it, so getOrCreateLaneBox
  // synthesizes a small lane node on demand instead of silently dropping
  // that source from the diagram entirely (reported: "random fehlt als
  // Modulationsquelle").
  function getOrCreateLaneBox(key) {
    const existing = laneBoxByKey.get(key);
    if (existing) return existing;
    const label = SOURCE_LABEL[key] || humanize(key);
    const box = place(sdBox(laneRight + MOD_NODE_GAP, laneY, MOD_NODE_W, 30, label, null, 'lane', ownInfo.get(key) || label, sourceColor(key)));
    laneBoxByKey.set(key, box);
    laneRight = Math.max(laneRight, box.right);
    return box;
  }
  // A cable can have MORE THAN ONE simultaneous depth-modulator (confirmed
  // on a real preset, BOC01/BOD01_49-From the distance.XML: LFO1's own
  // vibrato depth modulated by BOTH lfo1 AND random at once) --
  // loopCountByBox nudges each additional self-loop off the SAME box
  // further down so two loops never draw exactly on top of each other.
  let loopBottom = 0;
  const loopCountByBox = new Map();
  function drawSourceToSourceArrow(targetKey, modulatorKey) {
    const targetBox = getOrCreateLaneBox(targetKey);
    if (modulatorKey === targetKey) {
      const loopIndex = loopCountByBox.get(targetBox) || 0;
      loopCountByBox.set(targetBox, loopIndex + 1);
      arrows.push(sdSelfLoop(targetBox, null, sourceColor(targetKey), loopIndex));
      loopBottom = Math.max(loopBottom, targetBox.bottom + 33 + loopIndex * 18);
    } else {
      const modBox = getOrCreateLaneBox(modulatorKey);
      arrows.push(sdArrow(modBox.cx, modBox.bottom, targetBox.cx, targetBox.bottom, true, null, sourceColor(modulatorKey)));
    }
  }
  nonDefaultCables.forEach(c => {
    for (const m of c.depthModulators || []) {
      const outerKey = c.source === 'compressor' ? 'sidechain-comp' : c.source;
      const depthKey = m.source === 'compressor' ? 'sidechain-comp' : m.source;
      drawSourceToSourceArrow(outerKey, depthKey);
    }
    const rateOrEnvTarget = RATE_OR_ENV_DEST_TO_SOURCE_KEY[c.destination];
    if (rateOrEnvTarget) {
      const modKey = c.source === 'compressor' ? 'sidechain-comp' : c.source;
      drawSourceToSourceArrow(rateOrEnvTarget, modKey);
    }
  });

  const totalWidth = Math.max(x, out.right + 20, laneRight + 20);
  const totalHeight = Math.max(maxY + 24, loopBottom + 10);
  const svg = `<svg id="${svgId}" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">${defs}${arrows.join('')}${boxes.join('')}</svg>`;
  return makeZoomable(svg, 'signal-diagram-wrap');
}

// ---------------------------------------------------------------------------
// Idea 7: side-by-side preset comparison (Compare tab).
// ---------------------------------------------------------------------------
// Session 5 (project-owner feedback): an earlier version of this also had a
// ~16-row coarse on/off flag table alongside the diagrams. Dropped entirely
// -- it lost most of the real difference between two presets that are often
// close variations of each other, and the two full Signal Path diagrams
// below are the whole comparison now, not a supplementary detail view.
//
// The two diagrams stack one above the other -- the same
// buildSignalPathSvg() used by the single-preset Signal Path tab, so every
// box's hover tooltip carries real parameter values on both sides.
//
// Own comparison logic, separate from buildSignalPathSvg()'s per-diagram
// "differs from init" .changed flag (each diagram already computes that
// independently for its own preset): this instead flags boxes that differ
// BETWEEN the two rendered diagrams, by matching them on their visible
// label text and comparing their already-computed tooltip strings (which
// encode every real value for that stage) -- no separate parameter-diffing
// logic against the raw patch objects needed.
function flagCompareDifferences(colA, colB) {
  const byLabel = (col) => {
    const map = new Map();
    col.querySelectorAll('.sd-hoverable').forEach(g => {
      const labelEl = g.querySelector('.sd-label');
      if (!labelEl) return;
      const key = labelEl.textContent.trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(g);
    });
    return map;
  };
  const mapA = byLabel(colA), mapB = byLabel(colB);
  let flagged = 0;
  mapA.forEach((nodesA, key) => {
    const nodesB = mapB.get(key);
    if (!nodesB || nodesB.length !== nodesA.length) return;
    nodesA.forEach((gA, i) => {
      const gB = nodesB[i];
      if ((gA.dataset.tooltip || '') !== (gB.dataset.tooltip || '')) {
        gA.querySelector('.sd-box').classList.add('compare-differs');
        gB.querySelector('.sd-box').classList.add('compare-differs');
        flagged++;
      }
    });
  });
  return flagged;
}

function renderCompareTab() {
  const el = document.getElementById('compareContent');
  if (!currentPreset || !currentPatch) { el.innerHTML = '<div class="empty-note">Pick a preset first.</div>'; return; }
  const others = library.filter(l => l.id !== currentPreset.id);
  const prevSelected = el.dataset.selectedId;
  const selectedId = (prevSelected && others.some(o => o.id === prevSelected)) ? prevSelected : (others[0] && others[0].id);
  el.innerHTML = `
    <p class="empty-note" style="padding:0 0 12px">Compare this preset's signal path against another already-loaded preset &mdash; hover any box in either diagram for its real values, same as the Signal Path tab. A yellow border means that box differs between the two, the same color the Signal Path tab uses for "differs from init".</p>
    <div class="compare-picker">
      <label>Compare <b>${escapeHtml(currentPreset.name)}</b> against
        <select id="comparePresetSelect"></select>
      </label>
    </div>
    <div id="compareDiagrams" class="compare-diagrams"></div>`;
  if (!others.length) {
    document.getElementById('compareDiagrams').innerHTML = '<div class="empty-note">Load more than one preset to compare.</div>';
    return;
  }
  const select = document.getElementById('comparePresetSelect');
  for (const o of others) {
    const opt = document.createElement('option');
    opt.value = o.id; opt.textContent = `${o.pack} / ${o.name}`;
    if (o.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
  async function renderFor(otherId) {
    el.dataset.selectedId = otherId;
    const other = others.find(o => o.id === otherId);
    const diagramsWrap = document.getElementById('compareDiagrams');
    if (!other) { diagramsWrap.innerHTML = ''; return; }
    diagramsWrap.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    const text = await other.file.text();
    const otherPatch = parseDelugeXml(text);
    if (!otherPatch) { diagramsWrap.innerHTML = '<div class="empty-note">Could not parse that preset.</div>'; return; }

    diagramsWrap.innerHTML = `
      <div class="compare-col">
        <h4 class="compare-col-title">${escapeHtml(currentPreset.name)}</h4>
        ${buildSignalPathSvg(currentPatch, 'cmpA')}
      </div>
      <div class="compare-col">
        <h4 class="compare-col-title">${escapeHtml(other.name)}</h4>
        ${buildSignalPathSvg(otherPatch, 'cmpB')}
      </div>`;
    const cols = diagramsWrap.querySelectorAll('.compare-col');
    flagCompareDifferences(cols[0], cols[1]);
    diagramsWrap.querySelectorAll('.zoom-viewport').forEach(initZoomViewport);
  }
  select.addEventListener('change', () => renderFor(select.value));
  renderFor(selectedId);
}

// ---------------------------------------------------------------------------
// Idea 8: built-in synthesis glossary.
// ---------------------------------------------------------------------------
// Static reference content, opened from the "Glossary" button above the tab
// bar. (Scope note: the original idea also proposed opening a specific
// entry by clicking a term inline inside a guide step; this first version
// ships the reference panel itself with all core terms, reachable from one
// button, rather than the per-term deep-linking, which would need wiring
// clickable spans through every occurrence of these words across dozens of
// differently-phrased step templates for comparatively little teaching
// value over "click Glossary, it's right there".)
const GLOSSARY = [
  { term: 'ADSR envelope', body: 'Attack/Decay/Sustain/Release: a shape applied over time to some parameter (usually volume, sometimes filter cutoff) every time a note plays. Attack = time to reach full value; Decay = time to fall from full to the sustain level; Sustain = the level held while the note is held; Release = time to fall to zero after the note is let go.' },
  { term: 'LFO (Low-Frequency Oscillator)', body: 'A slow, repeating wave used to continuously modulate some other parameter (pitch, cutoff, volume, ...) rather than being heard directly. Rate sets how fast it repeats; the shape (sine/saw/square/triangle) sets how it moves between its extremes.' },
  { term: 'Patch cable / mod matrix', body: 'A routing that connects a modulation source (an envelope, LFO, velocity, aftertouch, ...) to a destination parameter, so that source continuously nudges the destination’s value in real time on top of whatever it’s manually set to. The Deluge calls the source→destination pairing plus its depth a "patch cable".' },
  { term: 'FM: carrier & modulator', body: 'In FM (frequency modulation) synthesis, a "modulator" oscillator rapidly modulates a "carrier" oscillator’s pitch. Fast enough, this produces new overtones rather than audible vibrato, which is what gives FM patches their metallic/bell-like/electric-piano character.' },
  { term: 'Filter modes (LPF/HPF, slopes, ladder vs SVF)', body: 'LPF (low-pass) removes highs, HPF (high-pass) removes lows. "12dB"/"24dB" describe the slope (how sharply frequencies past the cutoff are removed -- steeper = more dramatic). "Ladder" filters are modeled on classic analog designs; "SVF" (state-variable filter) is a different, cleaner-sounding topology community firmware added alongside the originals.' },
  { term: 'Unison & detune', body: 'Unison stacks several copies of one voice on a single note. Detune spreads their pitches slightly apart, which creates a chorus-like beating between them -- the classic "fat" supersaw sound. More voices and more detune both cost more of the Deluge’s limited simultaneous-note polyphony.' },
  { term: 'Sidechain compression', body: 'A compressor that ducks (briefly quiets) a sound every time it receives a trigger -- classically used to duck a bass/pad under every kick drum hit so the kick always cuts through, without hand-automating volume.' },
  { term: 'Patch cable depth / amount', body: 'How strongly a modulation source affects its destination, on the Deluge’s own -50.00 to +50.00 scale. A negative depth inverts the source’s effect (e.g. velocity making a sound quieter instead of louder).' },
];
function openGlossary() {
  openModal(box => {
    const h = document.createElement('h3');
    h.textContent = 'Synthesis glossary';
    box.appendChild(h);
    const list = document.createElement('div');
    list.className = 'glossary-list';
    list.innerHTML = GLOSSARY.map(g =>
      `<div class="glossary-entry"><div class="glossary-term">${escapeHtml(g.term)}</div><div class="glossary-body">${escapeHtml(g.body)}</div></div>`
    ).join('');
    box.appendChild(list);
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.style.marginTop = '14px';
    close.addEventListener('click', closeModal);
    box.appendChild(close);
  });
}

// ---------------------------------------------------------------------------
// User Guide: one consolidated reference for everything the app used to
// explain piecemeal (a "Reading the steps" box above every guide, several
// paragraphs above "Check now", a description above the loader buttons) --
// those all got read once and then just took up permanent space for anyone
// who came back. Static HTML (not escaped/generated from a plain-text
// array like GLOSSARY above) since it needs real formatting -- kbd()/
// shift() badges, bold, lists -- not just a term + one-line body.
// ---------------------------------------------------------------------------
function userGuideSections() {
  return [
    { title: 'Loading presets', body: `
      <p>Click <b>Choose synths folder&hellip;</b> and select your <code>SYNTHS</code> folder
      &mdash; copy it off the Deluge's SD card onto your computer first (card reader, or via
      USB), or connect the Deluge directly (see below). Nothing is uploaded anywhere; every file
      is read locally in your browser.</p>
      <p>Once loaded, use the search box and filter chips above the preset list to narrow it
      down by engine, oscillator source, or features like Arp/Unison/Sidechain.</p>` },
    { title: 'Beginner vs Expert', body: `
      <p>The toggle top-right switches every step between real Deluge-hardware instructions
      (${shift('PARAM')} shortcuts, on-device values) and terser synthesis-language
      descriptions.</p>` },
    { title: 'Reading the steps', body: `
      <p>${shift('PARAM')} means hold ${kbd('SHIFT')} and press the named pad on the grid
      (printed per function column, e.g. all OSC1 params share a column), then turn
      ${kbd('SELECT')} to change the value. Every shortcut is also reachable the slower way via
      the nested SOUND menu: press ${kbd('SELECT')} to open it, turn to navigate, press to drill
      in.</p>` },
    { title: 'The four tabs', body: `
      <p><b>Steps</b> &mdash; the build guide itself, tick items off as you go.
      <b>Mod Matrix</b> &mdash; every modulation routing as a table.
      <b>Signal Path</b> &mdash; a diagram of the preset's actual signal flow, hover any box or
      source for real values.
      <b>Compare</b> &mdash; the same diagram for two loaded presets, stacked, with differences
      flagged.</p>
      <p><b>Show manual reference</b> and <b>Show tips</b> (above the step list) add a citation
      or a short "why this matters" line under select steps.</p>` },
    { title: 'Checking your progress on the Deluge', body: `
      <p>The idea: while you're actually building the patch on the Deluge, you don't have to
      just trust you got a step right and move on &mdash; you can check your real progress
      against this guide at any point, and see exactly which values still need work before you
      continue.</p>
      <p>To do that: save your in-progress patch to the SD card (any name, anywhere under
      <code>/SYNTHS</code>), then click <b>Check now</b> &mdash; you'll pick that file once, and
      every click after just re-reads it. Steps color themselves automatically: green once a
      value is a perfect match, yellow if you've changed it but it's not there yet, red if you
      changed something this preset doesn't actually use. <b>Check settings</b> loosens or
      tightens how exact a match needs to be. The first time EVERY field matches at once, that
      preset gets a &#9733; in the library list for good &mdash; a permanent record that it CAN
      be built correctly, independent of whatever the Deluge's own song happens to look like the
      next time you open it.</p>` },
    { title: 'Live updates (MIDI Follow)', body: `
      <p>Needs enabling <b>on the Deluge itself</b> first: <b>SETTINGS &rarr; MIDI &rarr;
      MIDI-FOLLOW &rarr; FEEDBACK &rarr; CHANNEL</b> must be set to an actual channel, not OFF.
      Once that's on, a handful of steps (envelopes, oscillator/noise levels, pan) get tagged
      <span class="step-badge step-badge-live">live</span> and update the moment you turn the
      real knob &mdash; no SD card round trip for those. An arrow next to a live value shows
      ${'▲'} if it's too high or ${'▼'} if it's too low. Most parameters still can't be
      tracked this way (patch cables, dropdown-style settings, Unison, Sidechain timing) and
      always need <b>Check now</b> instead &mdash; a step never mixes the two.</p>` },
    { title: 'Connecting a Deluge (optional)', body: `
      <p>Chrome, Edge or Opera only (Community Firmware 1.3+). Clicking <b>Connect
      Deluge&hellip;</b> makes the browser ask for MIDI access including
      <b>"system exclusive" (SysEx) messages</b> &mdash; that permission prompt sounds alarming,
      but it's the standard, required permission for any browser-based MIDI tool that reads
      files or device settings, and it's exactly what this app needs to browse/load presets and
      check your progress. It's a direct USB connection between your browser and the Deluge:
      nothing is uploaded, nothing leaves your computer.</p>
      <p>Once connected: <b>Load a preset from connected Deluge&hellip;</b> browses
      <code>/SYNTHS</code> on the device itself, no SD card needed.</p>
      <p><b>On an iPhone/iPad:</b> every browser app is required to use Safari's engine
      underneath (even ones named Chrome), and that engine doesn't support Web MIDI at all --
      you'll need a dedicated WebMIDI-enabled browser app from the App Store instead of your
      regular one. On a Mac, a real Chrome/Edge/Opera works exactly like on Windows/Linux.</p>` },
    { title: 'MIDI Monitor', body: `
      <p>Shows every raw MIDI message arriving from the Deluge in real time &mdash; the tool to
      reach for if live updates (above) don't seem to be working: it'll show whether anything is
      arriving at all, on which port, and whether a given CC actually resolves to a tracked
      field.</p>` },
    { title: 'More', body: `
      <p><b>Glossary</b> (above the tab bar) is a quick reference for core synthesis terms.
      <b>Print / export cheat sheet</b> opens a self-contained, printable version of the current
      guide in a new tab.</p>` },
  ];
}
function openUserGuide() {
  openModal(box => {
    box.classList.add('user-guide-box');
    const h = document.createElement('h3');
    h.textContent = 'User Guide';
    box.appendChild(h);
    const list = document.createElement('div');
    list.className = 'user-guide-list';
    list.innerHTML = userGuideSections().map(s =>
      `<div class="user-guide-entry"><div class="user-guide-title">${escapeHtml(s.title)}</div><div class="user-guide-body">${s.body}</div></div>`
    ).join('');
    box.appendChild(list);
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.style.marginTop = '14px';
    close.addEventListener('click', closeModal);
    box.appendChild(close);
  });
}

// ---------------------------------------------------------------------------
// Idea 2: WebAudio "hear the concept" mini-demos.
// ---------------------------------------------------------------------------
// Deliberately generic (a plain oscillator, not this preset's actual sound
// or any bundled sample) -- per feature-ideas.md, that's what keeps this
// fully offline/dependency-free: nothing here needs bundled audio assets or
// a live Deluge connection, just the Web Audio API already built into
// Chrome/Edge. Reduced scope to the 4 concepts feature-ideas.md called out
// as the core teaching win: filter cutoff/resonance, ADSR shape, LFO
// rate/depth, and unison detune/voice-count.
// `var` (not `let`) deliberately: this file is a classic script, where
// `var` at top level attaches to `window` and `let`/`const` do not -- and
// Playwright tests check the real AudioContext state via
// `window.sharedAudioCtx`, not just the button label, to confirm a demo
// actually produces audio rather than just flipping UI text.
var sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
  return sharedAudioCtx;
}
// Cleanup for whichever demo is currently making sound, if any -- called
// when a demo is stopped/replaced, and when the modal hosting it closes, so
// audio never keeps playing after its controls have gone away.
let activeDemoStop = null;
function stopActiveDemo() {
  if (activeDemoStop) {
    try { activeDemoStop(); } catch (e) { /* already stopped */ }
    activeDemoStop = null;
  }
}
function demoRangeRow(cls, label, min, max, value, step) {
  return `<label class="demo-row">${label} <input type="range" class="${cls}" min="${min}" max="${max}" value="${value}" step="${step || 1}"><span class="${cls}-val demo-val"></span></label>`;
}
const AUDIO_DEMOS = {
  'filter': {
    title: 'Hear it: low-pass filter cutoff &amp; resonance',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-cutoff', 'Cutoff', 0, 100, 60)}
          ${demoRangeRow('demo-res', 'Resonance', 0, 100, 20)}
        </div>`;
      const playBtn = container.querySelector('.demo-playstop');
      const cutoffSlider = container.querySelector('.demo-cutoff');
      const resSlider = container.querySelector('.demo-res');
      const cutoffVal = container.querySelector('.demo-cutoff-val');
      const resVal = container.querySelector('.demo-res-val');
      const cutoffHz = pct => Math.round(80 * Math.pow(8000 / 80, pct / 100));
      function updateLabels() {
        cutoffVal.textContent = cutoffHz(+cutoffSlider.value) + ' Hz';
        resVal.textContent = resSlider.value + ' / 100';
      }
      updateLabels();
      let playing = false, osc, filter;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
        filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
        filter.frequency.value = cutoffHz(+cutoffSlider.value);
        filter.Q.value = (+resSlider.value / 100) * 20;
        const gain = ctx.createGain(); gain.gain.value = 0.22;
        osc.connect(filter).connect(gain).connect(ctx.destination);
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      cutoffSlider.addEventListener('input', () => { updateLabels(); if (filter) filter.frequency.value = cutoffHz(+cutoffSlider.value); });
      resSlider.addEventListener('input', () => { updateLabels(); if (filter) filter.Q.value = (+resSlider.value / 100) * 20; });
    },
  },
  'envelope': {
    title: 'Hear it: ADSR envelope shape',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          ${demoRangeRow('demo-a', 'Attack', 0, 100, 5)}
          ${demoRangeRow('demo-d', 'Decay', 0, 100, 30)}
          ${demoRangeRow('demo-s', 'Sustain', 0, 100, 60)}
          ${demoRangeRow('demo-r', 'Release', 0, 100, 40)}
          <div class="demo-envelope-svg-wrap">
            <svg class="demo-envelope-svg" viewBox="0 0 280 90" width="280" height="90">
              <line class="env-baseline" x1="0" y1="82" x2="280" y2="82"></line>
              <path class="env-curve-path" d=""></path>
              <circle class="env-playhead" r="4" cx="0" cy="82" style="display:none"></circle>
            </svg>
          </div>
          <p class="audio-demo-note">Loops a short note automatically so a slider drag is audible on the very next cycle -- no need to keep re-clicking Play.</p>
        </div>`;
      const a = container.querySelector('.demo-a'), d = container.querySelector('.demo-d'), s = container.querySelector('.demo-s'), r = container.querySelector('.demo-r');
      const aVal = container.querySelector('.demo-a-val'), dVal = container.querySelector('.demo-d-val'), sVal = container.querySelector('.demo-s-val'), rVal = container.querySelector('.demo-r-val');
      const msFor = slider => Math.round(10 * Math.pow(2000 / 10, +slider.value / 100));
      function updateLabels() {
        aVal.textContent = msFor(a) + 'ms'; dVal.textContent = msFor(d) + 'ms';
        sVal.textContent = s.value + '%'; rVal.textContent = msFor(r) + 'ms';
      }

      // Same shape logic the real GainNode automation below uses (atk/dec
      // hold at sustain briefly/rel, in seconds) -- reused for the curve so
      // the picture and the sound never disagree. Session 3 (project-owner
      // feedback): a static curve of the current A/D/S/R, redrawn live.
      const SUSTAIN_HOLD = 0.5; // matches the brief hold before release below
      const svg = container.querySelector('.demo-envelope-svg');
      const path = container.querySelector('.env-curve-path');
      const playhead = container.querySelector('.env-playhead');
      const W = 280, BASE_Y = 82, PEAK_Y = 8;
      function envTimesSec() {
        return { atk: msFor(a) / 1000, dec: msFor(d) / 1000, sus: +s.value / 100, rel: msFor(r) / 1000 };
      }
      // Breakpoints (x, y) for the current A/D/S/R, scaled into the SVG's
      // fixed 280x90 viewBox -- visual widths are proportional to the real
      // times (a fixed on-screen budget for the sustain hold, since it's a
      // hold, not a settable duration).
      function envBreakpoints() {
        const { atk, dec, sus, rel } = envTimesSec();
        const susY = BASE_Y - sus * (BASE_Y - PEAK_Y);
        const total = Math.max(atk + dec + SUSTAIN_HOLD + rel, 0.05);
        const scale = W / total;
        const x0 = 0, x1 = x0 + atk * scale, x2 = x1 + dec * scale, x3 = x2 + SUSTAIN_HOLD * scale, x4 = x3 + rel * scale;
        return { x0, x1, x2, x3, x4, y0: BASE_Y, y1: PEAK_Y, y2: susY, y3: susY, y4: BASE_Y, atk, dec, sus, rel };
      }
      function updateCurve() {
        const bp = envBreakpoints();
        path.setAttribute('d', `M ${bp.x0},${bp.y0} L ${bp.x1},${bp.y1} L ${bp.x2},${bp.y2} L ${bp.x3},${bp.y3} L ${bp.x4},${bp.y4}`);
        return bp;
      }
      updateLabels();
      updateCurve();
      [a, d, s, r].forEach(sl => sl.addEventListener('input', () => { updateLabels(); updateCurve(); }));

      // Loop period: long enough for attack+decay+hold+release to finish
      // before the next note fires (so it never retriggers mid-release),
      // clamped to a sensible min/max so a very short or very long ADSR
      // doesn't produce an unusably fast or glacially slow loop.
      const GAP = 0.15; // brief silence between notes so the retrigger is clearly audible
      function loopPeriodSec(atk, dec, rel) {
        return Math.max(0.6, Math.min(4, atk + dec + SUSTAIN_HOLD + rel + GAP));
      }

      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, rafId = null, currentOsc = null;
      let noteStartCtxTime = 0, noteBreakpoints = null, notePeriodSec = 0;

      function stopPlayhead() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        playhead.style.display = 'none';
      }
      // Nice-to-have (session 3): animate a playhead marker along the curve
      // in sync with the currently-playing note, using the same breakpoints
      // just drawn -- purely visual, has no bearing on the actual audio.
      function animatePlayhead() {
        const ctx = sharedAudioCtx;
        if (!looping || !ctx || !noteBreakpoints) { stopPlayhead(); return; }
        const elapsedMs = (ctx.currentTime - noteStartCtxTime) * 1000;
        const bp = noteBreakpoints;
        const atkMs = bp.atk * 1000, decMs = bp.dec * 1000, holdMs = SUSTAIN_HOLD * 1000, relMs = bp.rel * 1000;
        let x, y;
        if (elapsedMs <= atkMs) {
          const t = atkMs > 0 ? elapsedMs / atkMs : 1;
          x = bp.x0 + (bp.x1 - bp.x0) * t; y = bp.y0 + (bp.y1 - bp.y0) * t;
        } else if (elapsedMs <= atkMs + decMs) {
          const t = decMs > 0 ? (elapsedMs - atkMs) / decMs : 1;
          x = bp.x1 + (bp.x2 - bp.x1) * t; y = bp.y1 + (bp.y2 - bp.y1) * t;
        } else if (elapsedMs <= atkMs + decMs + holdMs) {
          x = bp.x2 + (bp.x3 - bp.x2) * ((elapsedMs - atkMs - decMs) / Math.max(holdMs, 0.001)); y = bp.y3;
        } else if (elapsedMs <= atkMs + decMs + holdMs + relMs) {
          const t = relMs > 0 ? (elapsedMs - atkMs - decMs - holdMs) / relMs : 1;
          x = bp.x3 + (bp.x4 - bp.x3) * t; y = bp.y3 + (bp.y4 - bp.y3) * t;
        } else {
          stopPlayhead();
          return;
        }
        playhead.style.display = '';
        playhead.setAttribute('cx', x); playhead.setAttribute('cy', y);
        rafId = requestAnimationFrame(animatePlayhead);
      }
      function triggerNote() {
        const ctx = getAudioCtx();
        const bp = updateCurve();
        const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220;
        const gain = ctx.createGain(); gain.gain.value = 0;
        osc.connect(gain).connect(ctx.destination);
        const now = ctx.currentTime;
        const { atk, dec, sus, rel } = bp;
        const peak = 0.28;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(peak, now + Math.max(atk, 0.005));
        gain.gain.linearRampToValueAtTime(peak * sus, now + atk + dec + 0.005);
        const releaseStart = now + atk + dec + SUSTAIN_HOLD;
        gain.gain.setValueAtTime(peak * sus, releaseStart);
        gain.gain.linearRampToValueAtTime(0, releaseStart + Math.max(rel, 0.005));
        osc.start(now);
        osc.stop(releaseStart + rel + 0.05);
        currentOsc = osc;
        noteStartCtxTime = now;
        noteBreakpoints = bp;
        stopPlayhead();
        rafId = requestAnimationFrame(animatePlayhead);
        // Re-read the sliders at retrigger time (not the values captured
        // when this cycle started) so a mid-cycle drag changes the *next*
        // cycle's timing too, not just the one after that.
        notePeriodSec = loopPeriodSec(atk, dec, rel);
        loopTimer = setTimeout(() => { if (looping) triggerNote(); }, notePeriodSec * 1000);
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        if (currentOsc) { try { currentOsc.stop(); } catch (e) { /* already stopped */ } currentOsc = null; }
        stopPlayhead();
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        looping = true;
        playBtn.textContent = 'Stop looping';
        triggerNote();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
    },
  },
  'lfo': {
    title: 'Hear it: LFO rate &amp; depth',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          <label class="demo-row">Target
            <select class="demo-target"><option value="amp">Volume (tremolo)</option><option value="pitch">Pitch (vibrato)</option></select>
          </label>
          ${demoRangeRow('demo-rate', 'Rate', 1, 100, 30)}
          ${demoRangeRow('demo-depth', 'Depth', 0, 100, 50)}
        </div>`;
      const targetSelect = container.querySelector('.demo-target');
      const rateSlider = container.querySelector('.demo-rate');
      const depthSlider = container.querySelector('.demo-depth');
      const rateVal = container.querySelector('.demo-rate-val');
      const depthVal = container.querySelector('.demo-depth-val');
      const rateHz = pct => (0.2 + (pct / 100) * (12 - 0.2));
      function updateLabels() {
        rateVal.textContent = rateHz(+rateSlider.value).toFixed(1) + ' Hz';
        depthVal.textContent = depthSlider.value + '%';
      }
      updateLabels();
      const playBtn = container.querySelector('.demo-playstop');
      let playing = false, carrier, lfo, lfoGain, mainGain;
      function stop() {
        if (!playing) return;
        try { carrier.stop(); lfo.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function applyLive() {
        if (!playing) return;
        lfo.frequency.value = rateHz(+rateSlider.value);
        if (targetSelect.value === 'amp') lfoGain.gain.value = (+depthSlider.value / 100) * 0.15;
        else lfoGain.gain.value = (+depthSlider.value / 100) * 200; // cents
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        carrier = ctx.createOscillator(); carrier.type = 'sine'; carrier.frequency.value = 220;
        mainGain = ctx.createGain();
        lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = rateHz(+rateSlider.value);
        lfoGain = ctx.createGain();
        if (targetSelect.value === 'amp') {
          mainGain.gain.value = 0.15; // base level; LFO adds/subtracts around it, so it never goes negative
          lfoGain.gain.value = (+depthSlider.value / 100) * 0.15;
          lfo.connect(lfoGain).connect(mainGain.gain);
        } else {
          mainGain.gain.value = 0.22;
          lfoGain.gain.value = (+depthSlider.value / 100) * 200; // detune cents
          lfo.connect(lfoGain).connect(carrier.detune);
        }
        carrier.connect(mainGain).connect(ctx.destination);
        carrier.start(); lfo.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      [rateSlider, depthSlider].forEach(sl => sl.addEventListener('input', () => { updateLabels(); applyLive(); }));
      targetSelect.addEventListener('change', () => { if (playing) { stop(); start(); } });
    },
  },
  'unison': {
    title: 'Hear it: unison voices &amp; detune',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-voices', 'Voices', 1, 8, 4, 1)}
          ${demoRangeRow('demo-detune', 'Detune', 0, 100, 30)}
        </div>
        <p class="audio-demo-note">Changing voices while playing restarts the demo (the voice count changes how many oscillators exist, not just a live value).</p>`;
      const voicesSlider = container.querySelector('.demo-voices');
      const detuneSlider = container.querySelector('.demo-detune');
      const voicesVal = container.querySelector('.demo-voices-val');
      const detuneVal = container.querySelector('.demo-detune-val');
      function updateLabels() {
        voicesVal.textContent = voicesSlider.value;
        detuneVal.textContent = detuneSlider.value + '/100';
      }
      updateLabels();
      const playBtn = container.querySelector('.demo-playstop');
      let playing = false, oscs = [];
      function stop() {
        if (!playing) return;
        oscs.forEach(o => { try { o.stop(); } catch (e) { /* already stopped */ } });
        oscs = [];
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        const voices = +voicesSlider.value;
        const detuneCents = (+detuneSlider.value / 100) * 50;
        const master = ctx.createGain(); master.gain.value = 0.3 / Math.sqrt(voices); master.connect(ctx.destination);
        oscs = [];
        for (let i = 0; i < voices; i++) {
          const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
          const spread = voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1; // -1..1
          osc.detune.value = spread * detuneCents;
          osc.connect(master);
          osc.start();
          oscs.push(osc);
        }
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      detuneSlider.addEventListener('input', () => { updateLabels(); if (playing) { stop(); start(); } });
      voicesSlider.addEventListener('input', () => { updateLabels(); if (playing) { stop(); start(); } });
    },
  },

  // -------------------------------------------------------------------
  // Session 3: expanded WebAudio demo coverage. Per the project owner's
  // explicit, PERMANENT scope boundary, every demo below (and above) uses
  // only standard synthesized OscillatorNode waveforms -- never sample or
  // wavetable playback. See the final report for which PARAM_CONCEPTS keys
  // were deliberately left without a demo and why.
  // -------------------------------------------------------------------
  'hpf': {
    title: 'Hear it: high-pass filter cutoff &amp; resonance',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-hpf-cutoff', 'Cutoff', 0, 100, 25)}
          ${demoRangeRow('demo-hpf-res', 'Resonance', 0, 100, 10)}
        </div>`;
      const playBtn = container.querySelector('.demo-playstop');
      const cutoffSlider = container.querySelector('.demo-hpf-cutoff');
      const resSlider = container.querySelector('.demo-hpf-res');
      const cutoffVal = container.querySelector('.demo-hpf-cutoff-val');
      const resVal = container.querySelector('.demo-hpf-res-val');
      const cutoffHz = pct => Math.round(30 * Math.pow(4000 / 30, pct / 100));
      function updateLabels() {
        cutoffVal.textContent = cutoffHz(+cutoffSlider.value) + ' Hz';
        resVal.textContent = resSlider.value + ' / 100';
      }
      updateLabels();
      let playing = false, osc, filter;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
        filter = ctx.createBiquadFilter(); filter.type = 'highpass';
        filter.frequency.value = cutoffHz(+cutoffSlider.value);
        filter.Q.value = (+resSlider.value / 100) * 20;
        const gain = ctx.createGain(); gain.gain.value = 0.22;
        osc.connect(filter).connect(gain).connect(ctx.destination);
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      cutoffSlider.addEventListener('input', () => { updateLabels(); if (filter) filter.frequency.value = cutoffHz(+cutoffSlider.value); });
      resSlider.addEventListener('input', () => { updateLabels(); if (filter) filter.Q.value = (+resSlider.value / 100) * 20; });
    },
  },

  'filterroute': {
    title: 'Hear it: filter routing (series vs. parallel)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          <label class="demo-row">Routing
            <select class="demo-route-mode"><option value="series">Series (LPF &rarr; HPF)</option><option value="parallel">Parallel (both, summed)</option></select>
          </label>
          ${demoRangeRow('demo-route-lpf', 'LPF cutoff', 0, 100, 55)}
          ${demoRangeRow('demo-route-hpf', 'HPF cutoff', 0, 100, 35)}
        </div>`;
      const playBtn = container.querySelector('.demo-playstop');
      const modeSelect = container.querySelector('.demo-route-mode');
      const lpfSlider = container.querySelector('.demo-route-lpf');
      const hpfSlider = container.querySelector('.demo-route-hpf');
      const lpfVal = container.querySelector('.demo-route-lpf-val');
      const hpfVal = container.querySelector('.demo-route-hpf-val');
      const lpfHz = pct => Math.round(150 * Math.pow(6000 / 150, pct / 100));
      const hpfHz = pct => Math.round(30 * Math.pow(4000 / 30, pct / 100));
      function updateLabels() {
        lpfVal.textContent = lpfHz(+lpfSlider.value) + ' Hz';
        hpfVal.textContent = hpfHz(+hpfSlider.value) + ' Hz';
      }
      updateLabels();
      let playing = false, osc, lpf, hpf;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
        lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = lpfHz(+lpfSlider.value);
        hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hpfHz(+hpfSlider.value);
        const gain = ctx.createGain(); gain.gain.value = 0.22;
        gain.connect(ctx.destination);
        if (modeSelect.value === 'series') {
          // Signal passes through both filters one after another -- each
          // filter's output feeds the next, so their effects compound.
          osc.connect(lpf).connect(hpf).connect(gain);
        } else {
          // Same unfiltered signal reaches both filters independently;
          // their outputs are mixed back together (summed at `gain`).
          osc.connect(lpf).connect(gain);
          osc.connect(hpf).connect(gain);
        }
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      lpfSlider.addEventListener('input', () => { updateLabels(); if (lpf) lpf.frequency.value = lpfHz(+lpfSlider.value); });
      hpfSlider.addEventListener('input', () => { updateLabels(); if (hpf) hpf.frequency.value = hpfHz(+hpfSlider.value); });
      modeSelect.addEventListener('change', () => { if (playing) { stop(); start(); } });
    },
  },

  'pan': {
    title: 'Hear it: auto-pan (headphones recommended)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-pan-rate', 'Rate', 1, 100, 25)}
          ${demoRangeRow('demo-pan-depth', 'Depth', 0, 100, 80)}
        </div>
        <p class="audio-demo-note">Headphones or stereo speakers recommended -- this modulates left/right position, which a single mono speaker can't reproduce.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const rateSlider = container.querySelector('.demo-pan-rate');
      const depthSlider = container.querySelector('.demo-pan-depth');
      const rateVal = container.querySelector('.demo-pan-rate-val');
      const depthVal = container.querySelector('.demo-pan-depth-val');
      const rateHz = pct => (0.1 + (pct / 100) * (4 - 0.1));
      function updateLabels() {
        rateVal.textContent = rateHz(+rateSlider.value).toFixed(2) + ' Hz';
        depthVal.textContent = depthSlider.value + '%';
      }
      updateLabels();
      let playing = false, carrier, lfo, lfoGain, panner;
      function stop() {
        if (!playing) return;
        try { carrier.stop(); lfo.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        carrier = ctx.createOscillator(); carrier.type = 'triangle'; carrier.frequency.value = 220;
        const gain = ctx.createGain(); gain.gain.value = 0.22;
        panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = rateHz(+rateSlider.value);
        lfoGain = ctx.createGain(); lfoGain.gain.value = +depthSlider.value / 100;
        carrier.connect(gain);
        if (panner) {
          gain.connect(panner).connect(ctx.destination);
          lfo.connect(lfoGain).connect(panner.pan);
        } else {
          gain.connect(ctx.destination); // no StereoPannerNode support -- still audible, just not panned
        }
        carrier.start(); lfo.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      rateSlider.addEventListener('input', () => { updateLabels(); if (lfo) lfo.frequency.value = rateHz(+rateSlider.value); });
      depthSlider.addEventListener('input', () => { updateLabels(); if (lfoGain) lfoGain.gain.value = +depthSlider.value / 100; });
    },
  },

  'portamento': {
    title: 'Hear it: portamento (pitch glide)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          <label class="demo-row">Glide <input type="checkbox" class="demo-glide-on" checked></label>
          ${demoRangeRow('demo-glide-time', 'Glide time', 0, 100, 50)}
        </div>
        <p class="audio-demo-note">Alternates between two notes on a loop -- compare with glide on vs. off.</p>`;
      const glideOn = container.querySelector('.demo-glide-on');
      const glideSlider = container.querySelector('.demo-glide-time');
      const glideVal = container.querySelector('.demo-glide-time-val');
      const glideMs = pct => Math.round(20 * Math.pow(800 / 20, pct / 100));
      function updateLabels() { glideVal.textContent = glideOn.checked ? glideMs(+glideSlider.value) + 'ms' : 'off'; }
      updateLabels();
      glideSlider.addEventListener('input', updateLabels);
      glideOn.addEventListener('change', updateLabels);

      const NOTE_LO = 165, NOTE_HI = 247.5; // ~E3/B3, a clearly audible interval
      const STEP_SEC = 0.9;
      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, osc, gain, high = false;
      function stepNote() {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const target = high ? NOTE_HI : NOTE_LO;
        high = !high;
        if (glideOn.checked) {
          const g = Math.max(glideMs(+glideSlider.value) / 1000, 0.005);
          osc.frequency.cancelScheduledValues(now);
          osc.frequency.setValueAtTime(osc.frequency.value, now);
          osc.frequency.exponentialRampToValueAtTime(target, now + g);
        } else {
          osc.frequency.cancelScheduledValues(now);
          osc.frequency.setValueAtTime(target, now);
        }
        loopTimer = setTimeout(() => { if (looping) stepNote(); }, STEP_SEC * 1000);
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        if (osc) { try { osc.stop(); } catch (e) { /* already stopped */ } osc = null; }
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = NOTE_LO;
        gain = ctx.createGain(); gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        high = true; // so the very first stepNote() call jumps/glides to NOTE_HI, audibly different from the starting pitch
        looping = true;
        playBtn.textContent = 'Stop looping';
        stepNote();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
    },
  },

  // Waveform + transpose live in one demo rather than two: the "Oscillator
  // N: waveform" step is the only step buildGuide() ever tags 'osc.type'
  // (a separate 'osc.transpose' concept exists but no step uses it as its
  // primary conceptKey), so a standalone transpose-only demo would have no
  // real "Hear it" button pointing at it. Folding the transpose slider in
  // here instead means both are reachable from the one step that's
  // actually there.
  'oscType': {
    title: 'Hear it: oscillator waveform &amp; transpose',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          <label class="demo-row">Waveform
            <select class="demo-wave-type">
              <option value="sine">Sine</option>
              <option value="triangle">Triangle</option>
              <option value="sawtooth" selected>Sawtooth</option>
              <option value="square">Square</option>
            </select>
          </label>
          ${demoRangeRow('demo-transpose', 'Transpose', -24, 24, 0, 1)}
        </div>
        <p class="audio-demo-note">A fixed reference tone plays alongside the transposed oscillator so the interval between them is audible as you move the slider.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const typeSelect = container.querySelector('.demo-wave-type');
      const semSlider = container.querySelector('.demo-transpose');
      const semVal = container.querySelector('.demo-transpose-val');
      function updateLabels() { semVal.textContent = (+semSlider.value > 0 ? '+' : '') + semSlider.value + ' st'; }
      updateLabels();
      const REF_HZ = 220;
      let playing = false, refOsc, movOsc;
      function stop() {
        if (!playing) return;
        try { refOsc.stop(); movOsc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        refOsc = ctx.createOscillator(); refOsc.type = typeSelect.value; refOsc.frequency.value = REF_HZ;
        movOsc = ctx.createOscillator(); movOsc.type = typeSelect.value; movOsc.frequency.value = REF_HZ * Math.pow(2, +semSlider.value / 12);
        const refGain = ctx.createGain(); refGain.gain.value = 0.15;
        const movGain = ctx.createGain(); movGain.gain.value = 0.15;
        refOsc.connect(refGain).connect(ctx.destination);
        movOsc.connect(movGain).connect(ctx.destination);
        refOsc.start(); movOsc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      typeSelect.addEventListener('change', () => { if (refOsc) { refOsc.type = typeSelect.value; movOsc.type = typeSelect.value; } });
      semSlider.addEventListener('input', () => { updateLabels(); if (movOsc) movOsc.frequency.value = REF_HZ * Math.pow(2, +semSlider.value / 12); });
    },
  },

  'distortion': {
    title: 'Hear it: saturation / bitcrush-style distortion',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-drive', 'Drive', 0, 100, 30)}
        </div>
        <p class="audio-demo-note">One WaveShaperNode standing in for the whole "getting dirtier" family (saturation/bitcrush/decimation all push the signal harder against a hard edge, just with different curve shapes).</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const driveSlider = container.querySelector('.demo-drive');
      const driveVal = container.querySelector('.demo-drive-val');
      function updateLabels() { driveVal.textContent = driveSlider.value + ' / 100'; }
      updateLabels();
      // Classic WaveShaper "clipping" curve (k controls how hard the S-curve
      // clips) -- see e.g. the widely-cited Kevin Chapelier waveshaper formula.
      function makeClipCurve(amount) {
        const k = amount * 0.95;
        const n = 1024;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / n - 1;
          curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
        }
        return curve;
      }
      let playing = false, osc, shaper;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 165;
        shaper = ctx.createWaveShaper(); shaper.curve = makeClipCurve(+driveSlider.value / 100);
        const gain = ctx.createGain(); gain.gain.value = 0.18;
        osc.connect(shaper).connect(gain).connect(ctx.destination);
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      driveSlider.addEventListener('input', () => { updateLabels(); if (shaper) shaper.curve = makeClipCurve(+driveSlider.value / 100); });
    },
  },

  'wavefold': {
    title: 'Hear it: wavefolding',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-fold', 'Fold amount', 0, 100, 30)}
        </div>
        <p class="audio-demo-note">A folding curve reflects the signal back on itself past a threshold instead of flattening it -- contrast with the "distortion" demo's clipping curve.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const foldSlider = container.querySelector('.demo-fold');
      const foldVal = container.querySelector('.demo-fold-val');
      function updateLabels() { foldVal.textContent = foldSlider.value + ' / 100'; }
      updateLabels();
      // A genuine folding curve: drive the input hotter than [-1,1], then
      // reflect it back inward off the +-1 boundary as many times as it
      // takes to land back in range, instead of clamping it flat like a
      // clipper would -- each reflection is one more "fold".
      function makeFoldCurve(amount) {
        const drive = 1 + amount * 6;
        const n = 1024;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let x = ((i * 2) / n - 1) * drive;
          let guard = 0;
          while ((x > 1 || x < -1) && guard++ < 20) {
            if (x > 1) x = 2 - x;
            else if (x < -1) x = -2 - x;
          }
          curve[i] = x;
        }
        return curve;
      }
      let playing = false, osc, shaper;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 165;
        shaper = ctx.createWaveShaper(); shaper.curve = makeFoldCurve(+foldSlider.value / 100);
        const gain = ctx.createGain(); gain.gain.value = 0.18;
        osc.connect(shaper).connect(gain).connect(ctx.destination);
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      foldSlider.addEventListener('input', () => { updateLabels(); if (shaper) shaper.curve = makeFoldCurve(+foldSlider.value / 100); });
    },
  },

  'modfx': {
    title: 'Hear it: mod FX (chorus-style)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-modfx-rate', 'Rate', 1, 100, 20)}
          ${demoRangeRow('demo-modfx-depth', 'Depth', 0, 100, 60)}
        </div>`;
      const playBtn = container.querySelector('.demo-playstop');
      const rateSlider = container.querySelector('.demo-modfx-rate');
      const depthSlider = container.querySelector('.demo-modfx-depth');
      const rateVal = container.querySelector('.demo-modfx-rate-val');
      const depthVal = container.querySelector('.demo-modfx-depth-val');
      const rateHz = pct => (0.1 + (pct / 100) * (5 - 0.1));
      function updateLabels() {
        rateVal.textContent = rateHz(+rateSlider.value).toFixed(2) + ' Hz';
        depthVal.textContent = depthSlider.value + '%';
      }
      updateLabels();
      let playing = false, osc, dry, delayNode, lfo, lfoGain, wet;
      function stop() {
        if (!playing) return;
        try { osc.stop(); lfo.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220;
        dry = ctx.createGain(); dry.gain.value = 0.15;
        wet = ctx.createGain(); wet.gain.value = 0.15;
        // Mix the dry signal with a short, LFO-modulated delayed copy of
        // itself -- the same underlying trick chorus/flanger/phaser all use.
        delayNode = ctx.createDelay(0.05); delayNode.delayTime.value = 0.012;
        lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = rateHz(+rateSlider.value);
        lfoGain = ctx.createGain(); lfoGain.gain.value = (+depthSlider.value / 100) * 0.008;
        lfo.connect(lfoGain).connect(delayNode.delayTime);
        osc.connect(dry).connect(ctx.destination);
        osc.connect(delayNode).connect(wet).connect(ctx.destination);
        osc.start(); lfo.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      rateSlider.addEventListener('input', () => { updateLabels(); if (lfo) lfo.frequency.value = rateHz(+rateSlider.value); });
      depthSlider.addEventListener('input', () => { updateLabels(); if (lfoGain) lfoGain.gain.value = (+depthSlider.value / 100) * 0.008; });
    },
  },

  'delay': {
    title: 'Hear it: feedback delay',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          ${demoRangeRow('demo-delay-time', 'Delay time', 5, 100, 40)}
          ${demoRangeRow('demo-delay-fb', 'Feedback', 0, 90, 45)}
        </div>
        <p class="audio-demo-note">Replays a short pluck on a loop so the repeats have time to ring out and decay between hits.</p>`;
      const timeSlider = container.querySelector('.demo-delay-time');
      const fbSlider = container.querySelector('.demo-delay-fb');
      const timeVal = container.querySelector('.demo-delay-time-val');
      const fbVal = container.querySelector('.demo-delay-fb-val');
      const delaySec = pct => 0.05 + (pct / 100) * 0.75;
      function updateLabels() {
        timeVal.textContent = Math.round(delaySec(+timeSlider.value) * 1000) + 'ms';
        fbVal.textContent = fbSlider.value + '%';
      }
      updateLabels();
      const PLUCK_PERIOD_SEC = 1.8;
      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, delayNode, feedbackGain, wetGain, dryGain;
      function pluck() {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 330;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.28, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(g);
        g.connect(dryGain);
        g.connect(delayNode);
        osc.start(now);
        osc.stop(now + 0.35);
        loopTimer = setTimeout(() => { if (looping) pluck(); }, PLUCK_PERIOD_SEC * 1000);
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        dryGain = ctx.createGain(); dryGain.gain.value = 1;
        delayNode = ctx.createDelay(1); delayNode.delayTime.value = delaySec(+timeSlider.value);
        feedbackGain = ctx.createGain(); feedbackGain.gain.value = +fbSlider.value / 100;
        wetGain = ctx.createGain(); wetGain.gain.value = 0.9;
        dryGain.connect(ctx.destination);
        delayNode.connect(feedbackGain).connect(delayNode); // feedback loop
        delayNode.connect(wetGain).connect(ctx.destination);
        looping = true;
        playBtn.textContent = 'Stop looping';
        pluck();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
      timeSlider.addEventListener('input', () => { updateLabels(); if (delayNode) delayNode.delayTime.value = delaySec(+timeSlider.value); });
      fbSlider.addEventListener('input', () => { updateLabels(); if (feedbackGain) feedbackGain.gain.value = +fbSlider.value / 100; });
    },
  },

  'fm': {
    title: 'Hear it: FM (carrier + modulator)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-fm-ratio', 'Modulator ratio', 1, 12, 2, 1)}
          ${demoRangeRow('demo-fm-depth', 'Modulation index', 0, 100, 20)}
        </div>`;
      const playBtn = container.querySelector('.demo-playstop');
      const ratioSlider = container.querySelector('.demo-fm-ratio');
      const depthSlider = container.querySelector('.demo-fm-depth');
      const ratioVal = container.querySelector('.demo-fm-ratio-val');
      const depthVal = container.querySelector('.demo-fm-depth-val');
      const CARRIER_HZ = 220;
      const depthHz = pct => (pct / 100) * 800; // modulation index, in Hz of frequency deviation
      function updateLabels() {
        ratioVal.textContent = 'x' + ratioSlider.value;
        depthVal.textContent = Math.round(depthHz(+depthSlider.value)) + ' Hz';
      }
      updateLabels();
      let playing = false, carrier, modulator, modGain;
      function stop() {
        if (!playing) return;
        try { carrier.stop(); modulator.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        carrier = ctx.createOscillator(); carrier.type = 'sine'; carrier.frequency.value = CARRIER_HZ;
        modulator = ctx.createOscillator(); modulator.type = 'sine'; modulator.frequency.value = CARRIER_HZ * +ratioSlider.value;
        modGain = ctx.createGain(); modGain.gain.value = depthHz(+depthSlider.value);
        // The modulator's output scales into the carrier's own frequency
        // AudioParam -- fast enough (audio-rate) that it's heard as new
        // overtones on the carrier, not vibrato.
        modulator.connect(modGain).connect(carrier.frequency);
        const gain = ctx.createGain(); gain.gain.value = 0.2;
        carrier.connect(gain).connect(ctx.destination);
        carrier.start(); modulator.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      ratioSlider.addEventListener('input', () => { updateLabels(); if (modulator) modulator.frequency.value = CARRIER_HZ * +ratioSlider.value; });
      depthSlider.addEventListener('input', () => { updateLabels(); if (modGain) modGain.gain.value = depthHz(+depthSlider.value); });
    },
  },

  'arpeggiator': {
    title: 'Hear it: arpeggiator',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          ${demoRangeRow('demo-arp-rate', 'Rate', 0, 100, 55)}
          ${demoRangeRow('demo-arp-range', 'Octave range', 1, 3, 1, 1)}
        </div>
        <p class="audio-demo-note">Steps up and back down through a held chord on a loop -- try widening the octave range or speeding up the rate while it's playing.</p>`;
      const rateSlider = container.querySelector('.demo-arp-rate');
      const rangeSlider = container.querySelector('.demo-arp-range');
      const rateVal = container.querySelector('.demo-arp-rate-val');
      const rangeVal = container.querySelector('.demo-arp-range-val');
      const noteMs = pct => Math.round(480 - (pct / 100) * 390); // 480ms slow -> 90ms fast
      function updateLabels() {
        rateVal.textContent = noteMs(+rateSlider.value) + 'ms/note';
        rangeVal.textContent = rangeSlider.value + (rangeSlider.value === '1' ? ' octave' : ' octaves');
      }
      updateLabels();
      const ROOT_HZ = 220; // A3
      const CHORD = [0, 3, 7]; // minor triad, semitones from root
      const semi = n => ROOT_HZ * Math.pow(2, n / 12);
      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, step = 0, dir = 1;
      function sequence() {
        const octaves = +rangeSlider.value;
        const seq = [];
        for (let o = 0; o < octaves; o++) for (const c of CHORD) seq.push(c + o * 12);
        return seq;
      }
      function noteAt(i) {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const seq = sequence();
        const idx = ((i % seq.length) + seq.length) % seq.length;
        const dur = noteMs(+rateSlider.value) / 1000;
        const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = semi(seq[idx]);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, now);
        g.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.9);
        osc.connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + dur);
      }
      function tick() {
        const seq = sequence();
        noteAt(step);
        step += dir;
        if (step >= seq.length - 1) dir = -1;
        if (step <= 0) dir = 1;
        loopTimer = setTimeout(() => { if (looping) tick(); }, noteMs(+rateSlider.value));
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        step = 0; dir = 1;
        looping = true;
        playBtn.textContent = 'Stop looping';
        tick();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
      rateSlider.addEventListener('input', updateLabels);
      rangeSlider.addEventListener('input', updateLabels);
    },
  },

  'eq': {
    title: 'Hear it: 2-band EQ (bass/treble)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-eq-bass', 'Bass boost', -12, 12, 0, 1)}
          ${demoRangeRow('demo-eq-treble', 'Treble boost', -12, 12, 0, 1)}
        </div>
        <p class="audio-demo-note">A plain two-band shelf, not a sweepable filter -- push one band down and the other up to hear how coarse each one is next to the LPF/HPF demos.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const bassSlider = container.querySelector('.demo-eq-bass');
      const trebleSlider = container.querySelector('.demo-eq-treble');
      const bassVal = container.querySelector('.demo-eq-bass-val');
      const trebleVal = container.querySelector('.demo-eq-treble-val');
      function updateLabels() {
        bassVal.textContent = (+bassSlider.value > 0 ? '+' : '') + bassSlider.value + ' dB';
        trebleVal.textContent = (+trebleSlider.value > 0 ? '+' : '') + trebleSlider.value + ' dB';
      }
      updateLabels();
      let playing = false, osc, bassFilter, trebleFilter;
      function stop() {
        if (!playing) return;
        try { osc.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 165;
        bassFilter = ctx.createBiquadFilter(); bassFilter.type = 'lowshelf'; bassFilter.frequency.value = 200; bassFilter.gain.value = +bassSlider.value;
        trebleFilter = ctx.createBiquadFilter(); trebleFilter.type = 'highshelf'; trebleFilter.frequency.value = 2500; trebleFilter.gain.value = +trebleSlider.value;
        const gain = ctx.createGain(); gain.gain.value = 0.2;
        osc.connect(bassFilter).connect(trebleFilter).connect(gain).connect(ctx.destination);
        osc.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      bassSlider.addEventListener('input', () => { updateLabels(); if (bassFilter) bassFilter.gain.value = +bassSlider.value; });
      trebleSlider.addEventListener('input', () => { updateLabels(); if (trebleFilter) trebleFilter.gain.value = +trebleSlider.value; });
    },
  },

  'mixer.balance': {
    title: 'Hear it: OSC1 / OSC2 balance',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-balance', 'OSC1 &harr; OSC2', 0, 100, 50)}
        </div>
        <p class="audio-demo-note">OSC1 is a square wave, OSC2 a sawtooth, same pitch -- the slider crossfades between them without the overall loudness dipping in the middle.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const balSlider = container.querySelector('.demo-balance');
      const balVal = container.querySelector('.demo-balance-val');
      function updateLabels() {
        const v = +balSlider.value;
        balVal.textContent = `OSC1 ${100 - v}% / OSC2 ${v}%`;
      }
      updateLabels();
      let playing = false, oscA, oscB, gainA, gainB;
      // Equal-power crossfade (not a plain linear one) so the combined
      // loudness stays roughly constant across the whole slider range.
      function applyBalance() {
        const x = (+balSlider.value / 100) * (Math.PI / 2);
        if (gainA) gainA.gain.value = Math.cos(x) * 0.25;
        if (gainB) gainB.gain.value = Math.sin(x) * 0.25;
      }
      function stop() {
        if (!playing) return;
        try { oscA.stop(); oscB.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        oscA = ctx.createOscillator(); oscA.type = 'square'; oscA.frequency.value = 165;
        oscB = ctx.createOscillator(); oscB.type = 'sawtooth'; oscB.frequency.value = 165;
        gainA = ctx.createGain(); gainB = ctx.createGain();
        oscA.connect(gainA).connect(ctx.destination);
        oscB.connect(gainB).connect(ctx.destination);
        applyBalance();
        oscA.start(); oscB.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      balSlider.addEventListener('input', () => { updateLabels(); applyBalance(); });
    },
  },

  'mixer.noise': {
    title: 'Hear it: noise mixed under a tone',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-playstop">Play</button>
          ${demoRangeRow('demo-noise-level', 'Noise level', 0, 100, 30)}
        </div>
        <p class="audio-demo-note">A steady tone with white noise mixed underneath -- turn the level up to hear the noise start to dominate the sound.</p>`;
      const playBtn = container.querySelector('.demo-playstop');
      const levelSlider = container.querySelector('.demo-noise-level');
      const levelVal = container.querySelector('.demo-noise-level-val');
      function updateLabels() { levelVal.textContent = levelSlider.value + ' / 100'; }
      updateLabels();
      let playing = false, osc, toneGain, noiseSource, noiseGain;
      function makeNoiseBuffer(ctx) {
        const bufSec = 2;
        const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * bufSec), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
      }
      function stop() {
        if (!playing) return;
        try { osc.stop(); noiseSource.stop(); } catch (e) { /* already stopped */ }
        playing = false;
        playBtn.textContent = 'Play';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 165;
        toneGain = ctx.createGain(); toneGain.gain.value = 0.18;
        osc.connect(toneGain).connect(ctx.destination);
        noiseSource = ctx.createBufferSource(); noiseSource.buffer = makeNoiseBuffer(ctx); noiseSource.loop = true;
        noiseGain = ctx.createGain(); noiseGain.gain.value = (+levelSlider.value / 100) * 0.25;
        noiseSource.connect(noiseGain).connect(ctx.destination);
        osc.start(); noiseSource.start();
        playing = true;
        playBtn.textContent = 'Stop';
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
      levelSlider.addEventListener('input', () => { updateLabels(); if (noiseGain) noiseGain.gain.value = (+levelSlider.value / 100) * 0.25; });
    },
  },

  'reverb': {
    title: 'Hear it: reverb (send amount)',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          ${demoRangeRow('demo-reverb-wet', 'Reverb amount', 0, 100, 40)}
        </div>
        <p class="audio-demo-note">A generated echo-y tail standing in for the Deluge's real reverb algorithm, not a faithful reproduction of it -- replays a short pluck on a loop so the tail has time to ring out between hits.</p>`;
      const wetSlider = container.querySelector('.demo-reverb-wet');
      const wetVal = container.querySelector('.demo-reverb-wet-val');
      function updateLabels() { wetVal.textContent = wetSlider.value + ' / 100'; }
      updateLabels();
      const PLUCK_PERIOD_SEC = 1.6;
      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, convolver, wetGain, dryGain;
      // A short burst of noise shaped with an exponential decay envelope --
      // a synthesized stand-in for a real recorded impulse response, built
      // fresh each time the demo opens rather than loading any audio file.
      function makeImpulse(ctx) {
        const durSec = 2.2, decay = 3.5;
        const length = Math.floor(ctx.sampleRate * durSec);
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const data = impulse.getChannelData(ch);
          for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
        return impulse;
      }
      function pluck() {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 392;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.3, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.connect(g);
        g.connect(dryGain);
        g.connect(convolver);
        osc.start(now);
        osc.stop(now + 0.3);
        loopTimer = setTimeout(() => { if (looping) pluck(); }, PLUCK_PERIOD_SEC * 1000);
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        dryGain = ctx.createGain(); dryGain.gain.value = 1 - (+wetSlider.value / 100) * 0.7;
        convolver = ctx.createConvolver(); convolver.buffer = makeImpulse(ctx);
        wetGain = ctx.createGain(); wetGain.gain.value = (+wetSlider.value / 100) * 0.9;
        dryGain.connect(ctx.destination);
        convolver.connect(wetGain).connect(ctx.destination);
        looping = true;
        playBtn.textContent = 'Stop looping';
        pluck();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
      wetSlider.addEventListener('input', () => {
        updateLabels();
        if (dryGain) dryGain.gain.value = 1 - (+wetSlider.value / 100) * 0.7;
        if (wetGain) wetGain.gain.value = (+wetSlider.value / 100) * 0.9;
      });
    },
  },

  'sidechain': {
    title: 'Hear it: sidechain ducking',
    build(container) {
      container.innerHTML = `
        <div class="demo-controls">
          <button type="button" class="btn-primary demo-trigger">Start looping</button>
          ${demoRangeRow('demo-sc-attack', 'Attack', 0, 100, 20)}
          ${demoRangeRow('demo-sc-release', 'Release', 0, 100, 50)}
        </div>
        <p class="audio-demo-note">A repeating kick-like hit ducks the pad's volume on every beat -- Attack sets how fast the duck happens, Release sets how fast the pad recovers.</p>`;
      const atkSlider = container.querySelector('.demo-sc-attack');
      const relSlider = container.querySelector('.demo-sc-release');
      const atkVal = container.querySelector('.demo-sc-attack-val');
      const relVal = container.querySelector('.demo-sc-release-val');
      const atkSec = pct => 0.002 + (pct / 100) * 0.05; // 2ms - 52ms, a fast duck
      const relSec = pct => 0.05 + (pct / 100) * 0.6; // 50ms - 650ms recovery
      function updateLabels() {
        atkVal.textContent = Math.round(atkSec(+atkSlider.value) * 1000) + 'ms';
        relVal.textContent = Math.round(relSec(+relSlider.value) * 1000) + 'ms';
      }
      updateLabels();
      const BEAT_SEC = 1.0;
      const playBtn = container.querySelector('.demo-trigger');
      let looping = false, loopTimer = null, padOsc, padGain, kickGain;
      function duck() {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const atk = atkSec(+atkSlider.value), rel = relSec(+relSlider.value);
        padGain.gain.cancelScheduledValues(now);
        padGain.gain.setValueAtTime(padGain.gain.value, now);
        padGain.gain.linearRampToValueAtTime(0.03, now + atk);
        padGain.gain.linearRampToValueAtTime(0.22, now + atk + rel);
      }
      function kick() {
        const ctx = getAudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.35, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(g).connect(kickGain);
        osc.start(now);
        osc.stop(now + 0.22);
        duck();
        loopTimer = setTimeout(() => { if (looping) kick(); }, BEAT_SEC * 1000);
      }
      function stop() {
        looping = false;
        if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null; }
        if (padOsc) { try { padOsc.stop(); } catch (e) { /* already stopped */ } padOsc = null; }
        playBtn.textContent = 'Start looping';
      }
      function start() {
        stopActiveDemo();
        const ctx = getAudioCtx();
        padOsc = ctx.createOscillator(); padOsc.type = 'sawtooth'; padOsc.frequency.value = 196;
        padGain = ctx.createGain(); padGain.gain.value = 0.22;
        padOsc.connect(padGain).connect(ctx.destination);
        kickGain = ctx.createGain(); kickGain.gain.value = 1;
        kickGain.connect(ctx.destination);
        padOsc.start();
        looping = true;
        playBtn.textContent = 'Stop looping';
        kick();
        activeDemoStop = stop;
      }
      playBtn.addEventListener('click', () => { if (looping) stop(); else start(); });
      atkSlider.addEventListener('input', updateLabels);
      relSlider.addEventListener('input', updateLabels);
    },
  },
};
// conceptKey -> which demo (if any) is relevant to a step with that concept.
const DEMO_FOR_CONCEPT = {
  'filter.lpf': 'filter',
  'filter.hpf': 'hpf',
  'filter.route': 'filterroute',
  'envelope.amp': 'envelope',
  'envelope.filter': 'envelope',
  'lfo': 'lfo',
  'vibrato': 'lfo',
  'unison': 'unison',
  'mixer.pan': 'pan',
  'portamento': 'portamento',
  'osc.type': 'oscType',
  'distortion': 'distortion',
  'wavefold': 'wavefold',
  'modfx': 'modfx',
  'delay': 'delay',
  'fm': 'fm',
  'arpeggiator': 'arpeggiator',
  'eq': 'eq',
  'mixer.balance': 'mixer.balance',
  'mixer.noise': 'mixer.noise',
  // Folded into the waveform demo itself (below) rather than a separate
  // demo, so it's reachable from the one step that's actually tagged
  // 'osc.type' -- see the comment on AUDIO_DEMOS.oscType.
  'osc.transpose': 'oscType',
  'reverb': 'reverb',
  'sidechain': 'sidechain',
};
function openAudioDemo(kind) {
  const demo = AUDIO_DEMOS[kind];
  if (!demo) return;
  openModal(box => {
    const h = document.createElement('h3');
    h.innerHTML = demo.title;
    box.appendChild(h);
    const note = document.createElement('p');
    note.className = 'audio-demo-note';
    note.textContent = 'Generic oscillator demo, not this preset’s actual sound — plays through your computer speakers, not the Deluge.';
    box.appendChild(note);
    const container = document.createElement('div');
    container.className = 'audio-demo';
    box.appendChild(container);
    demo.build(container);
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.style.marginTop = '14px';
    close.addEventListener('click', closeModal);
    box.appendChild(close);
  });
}

// ---------------------------------------------------------------------------
// Idea 11: printable / exportable cheat sheet.
// ---------------------------------------------------------------------------
// A self-contained, light-on-ink HTML document (its own inline <style>, no
// dependency on the app's own dark-theme stylesheet) opened in a new tab and
// sent straight to the browser's print dialog -- from which "Save as PDF"
// doubles as the export path, so one mechanism covers both halves of the
// idea (print view + exportable file) without a separate download button.
function buildCheatSheetHtml(item, sections, beginner) {
  const body = sections.map(s => `
    <h3>${escapeHtml(s.title)}</h3>
    <ul>${s.steps.map(st => `<li><b>${escapeHtml(st.title)}:</b> ${beginner ? st.beginner : st.expert}</li>`).join('')}</ul>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(item.name)} — Deluge Patch Book cheat sheet</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #111; padding: 24px; max-width: 720px; margin: 0 auto; }
  .pack { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  h1 { font-size: 20px; margin: 2px 0 14px; }
  h3 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-top: 18px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin-bottom: 7px; font-size: 13px; line-height: 1.45; }
  .kbd { font-family: "SFMono-Regular", Consolas, Menlo, monospace; font-weight: 600; border: 1px solid #999; border-radius: 9px; padding: 0 6px; }
  .kbd svg { display: none; } /* the app's colored encoder-icon SVGs use CSS custom properties this page doesn't define */
  .value { font-weight: 700; }
  table { border-collapse: collapse; font-size: 12px; margin-top: 4px; }
  td, th { padding: 1px 8px 1px 0; text-align: left; }
  @media print { body { padding: 0; } }
</style></head><body>
<div class="pack">${escapeHtml(item.pack)}</div>
<h1>${escapeHtml(item.name)}</h1>
${body}
</body></html>`;
}
function printCheatSheet() {
  if (!currentPreset || !currentPatch) { alert('Pick a preset first.'); return; }
  const sections = buildGuide(currentPatch);
  const html = buildCheatSheetHtml(currentPreset, sections, isBeginnerMode());
  const w = window.open('', '_blank');
  if (!w) { alert('Could not open a new tab (popup blocked?). Allow popups for this page and try again.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  // Give the new tab a moment to lay out before invoking the print dialog.
  setTimeout(() => { try { w.print(); } catch (e) { /* user closed the tab first */ } }, 250);
}

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------
var library = []; // { id, name, pack, file }
// Kept sorted (pack, then name, both alphabetical) at every point something
// gets added to it -- ingestFiles() already sorted its own batch, but the
// two "load from connected Deluge" paths below (a single preset, or a
// whole device folder) each just push()ed onto whatever was already there,
// so a preset picked from the device could land at the end of the list in
// SD-card/SysEx directory order instead of alphabetically. Reported
// directly ("presets sollen jeweils sortiert werden sobald geladen").
function sortLibrary() {
  library.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
}
var currentPreset = null;
// The parsed object for currentPreset -- kept alongside it (rather than
// threading it through every call site that needs it) so the Compare tab,
// device-check flow, and print/export cheat sheet can all get at the
// currently loaded patch's real values without re-reading/re-parsing it.
var currentPatch = null;
// Same preset, parsed via DelugeCheckModule.parseDelugeXml() instead of this
// file's own parseDelugeXml() -- buildCheckSteps()'s field paths (and, by
// extension, MIDI-Follow live status -- see liveFieldStatus() in
// deluge-midi-follow.js) are resolved against THAT parser's output shape,
// not this file's, same as delugeCheck.runCheck() already re-parses the raw
// XML text itself rather than reusing currentPatch. Cached here so live CC
// updates (which can arrive many times a second) don't reparse on every one.
var currentCheckTargetObj = null;

function relPathParts(file) {
  const rel = file.webkitRelativePath || file.name;
  return rel.split('/');
}

async function ingestFiles(fileList, { autoSelectSingle = false } = {}) {
  // Skip macOS AppleDouble sidecar files (e.g. "._Init.XML") that tag along
  // when a folder was copied off the SD card on a Mac -- same extension,
  // not a real preset.
  const files = Array.from(fileList).filter(f => /\.xml$/i.test(f.name) && !f.name.startsWith('._'));
  const statusEl = document.getElementById('loadStatus');
  statusEl.textContent = `Reading ${files.length} files…`;
  // Read every file's raw text up front (concurrently, not one at a time)
  // so the library filter chips have real category data to filter on from
  // the moment the library loads, rather than only once each preset is
  // individually opened. This also means selectPreset() below never has to
  // re-read the same file a second time -- see its own comment.
  const texts = await Promise.all(files.map(f => f.text().catch(() => '')));
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rawText = texts[i];
    const parts = relPathParts(file);
    const pack = parts.length > 2 ? parts[parts.length - 2] : (parts.length > 1 ? parts[0] : 'Presets');
    items.push({
      id: file.webkitRelativePath || file.name,
      name: file.name.replace(/\.xml$/i, ''),
      pack, file, rawText,
      categories: sniffCategories(rawText),
    });
  }
  library = items;
  sortLibrary();
  statusEl.textContent = `Loaded ${items.length} presets.`;
  renderLibrary(document.getElementById('searchBox').value);
  document.getElementById('libraryBody').hidden = false;
  // #filesInput has no visible button anymore (see index.html's comment --
  // picking individual files used to silently replace the whole loaded
  // library, which broke Compare's "pick another loaded preset" list), but
  // stays wired as a headless single-file load path for the test suite.
  // Picking exactly one file there means there's nothing to pick from a
  // list, so still auto-opens its guide.
  if (autoSelectSingle && items.length === 1) {
    await selectPreset(items[0]);
  }
}

function renderLibrary(filterText) {
  const tree = document.getElementById('presetTree');
  const countEl = document.getElementById('presetCount');
  tree.innerHTML = '';
  const q = (filterText || '').toLowerCase().trim();
  const catFiltersActive = libraryFilters.engine !== 'all' || libraryFilters.oscSource !== 'all'
    || libraryFilters.hasArp || libraryFilters.hasUnison || libraryFilters.hasCables || libraryFilters.hasSidechain;
  const byPack = new Map();
  let shown = 0;
  for (const item of library) {
    // Text search narrows first, category chips narrow further -- AND, not
    // OR, so combining them always shrinks (or keeps steady) the list, same
    // logic a spreadsheet's "filter + search" combo would give.
    const matchesText = !q || item.name.toLowerCase().includes(q) || item.pack.toLowerCase().includes(q);
    if (!matchesText) continue;
    const matchesCategory = !catFiltersActive || presetMatchesFilters(item.categories, libraryFilters);
    if (!matchesCategory) continue;
    shown++;
    if (!byPack.has(item.pack)) byPack.set(item.pack, []);
    byPack.get(item.pack).push(item);
  }
  countEl.textContent = `${shown} / ${library.length} presets`;
  for (const [pack, items] of byPack) {
    const group = document.createElement('div');
    group.className = 'pack-group';
    const header = document.createElement('div');
    header.className = 'pack-header';
    header.innerHTML = `<span>${pack}</span><span>${items.length}</span>`;
    group.appendChild(header);
    const list = document.createElement('div');
    header.addEventListener('click', () => { list.hidden = !list.hidden; });
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'preset-item';
      if (currentPreset && currentPreset.id === item.id) el.classList.add('active');
      el.innerHTML = item.name + (isCompleted(item.id) ? `<span class="done-badge" title="Fully built correctly at least once (Check now matched every field)">&starf;</span>` : '');
      el.addEventListener('click', () => selectPreset(item));
      list.appendChild(el);
    }
    group.appendChild(list);
    tree.appendChild(group);
  }
}

async function selectPreset(item) {
  // Reuse the raw text ingestFiles() already read (and sniffed categories
  // from) instead of reading the same File a second time -- a real perf
  // win when the folder holds ~2000 presets, not just tidiness. Falls back
  // to reading it directly for any item that wasn't built by ingestFiles()
  // and therefore has no cached rawText.
  const text = item.rawText !== undefined ? item.rawText : await item.file.text();
  const patch = parseDelugeXml(text);
  if (!patch) {
    alert('Could not parse this file as a Deluge sound preset.');
    return;
  }
  currentPreset = item;
  currentPatch = patch;
  currentCheckTargetObj = DelugeCheckModule.parseDelugeXml(text);
  // Any on-device check result belonged to whatever preset was loaded when
  // it ran -- stale once a different preset is picked.
  lastCheckResult = null;
  lastCheckFieldStatus = null;
  const statusEl = document.getElementById('deviceCheckStatus');
  if (statusEl) statusEl.textContent = '';
  updateCheckStatusClickability();
  renderUnexpectedChanges([]);
  const sections = buildGuide(patch);
  renderGuide(item, sections);
  document.getElementById('modMatrixContent').innerHTML = buildModMatrixTable(patch);
  document.getElementById('modMatrixContent').querySelectorAll('.zoom-viewport').forEach(initZoomViewport);
  document.getElementById('signalPathContent').innerHTML = buildSignalPathSvg(patch);
  document.getElementById('signalPathContent').querySelectorAll('.zoom-viewport').forEach(initZoomViewport);
  renderLibrary(document.getElementById('searchBox').value);
}

// ---------------------------------------------------------------------------
// "Fully built" marker (one star per preset, kept in localStorage)
// ---------------------------------------------------------------------------
// Per-step progress ticking used to persist here too, but that state never
// reliably means anything the next time the guide is opened: the actual
// song/patch on the Deluge moves on independently of this app between
// sessions, so "step 4 was ticked last time" says nothing trustworthy about
// what's on the device NOW. Reported directly ("ich würde den progress
// wegnehmen, da das setup mit dem song auf dem deluge dann eh nie stimmt").
// Replaced with one durable, one-way fact per preset instead of dozens of
// stale per-step ones: has a full Check now EVER found every single field
// matching, at least once. That's still true regardless of what's on the
// device today -- it only asserts "this preset CAN be built correctly",
// shown as a star in the library list.
function completedKey(id) { return `delugePatchBook:completed:${id}`; }
function isCompleted(id) {
  try { return localStorage.getItem(completedKey(id)) === '1'; }
  catch (e) { return false; }
}
function markCompleted(id) {
  try { localStorage.setItem(completedKey(id), '1'); } catch (e) { /* storage unavailable */ }
}
function clearCompleted(id) {
  try { localStorage.removeItem(completedKey(id)); } catch (e) { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Guide rendering
// ---------------------------------------------------------------------------
// Toggle is Beginner (left, unchecked) <-> Expert (right, checked).
function isBeginnerMode() { return !document.getElementById('modeToggle').checked; }

// "Show manual reference" / "Show tips" toggles: same on/off pattern as other simple
// UI prefs in this app (see UI_BOOL_KEYS below) -- read straight off the
// checkbox, persisted to localStorage under their own keys so a reload keeps
// the setting. Defaults to on for "Show tips" (a pure teaching aid with no
// downside to always seeing) and off for "Show manual reference" (denser citation
// text some users may not want cluttering every step by default).
const UI_BOOL_KEYS = {
  showRefs: 'delugePatchBook:showRefs',
  showTips: 'delugePatchBook:showTips',
  // Library filter chips (checkbox-style, AND-combinable ones) get the same
  // treatment -- see libraryFilters/loadLibraryFilters() below.
  filterHasArp: 'delugePatchBook:filterHasArp',
  filterHasUnison: 'delugePatchBook:filterHasUnison',
  filterHasCables: 'delugePatchBook:filterHasCables',
  filterHasSidechain: 'delugePatchBook:filterHasSidechain',
  skipSaveConfirm: 'delugePatchBook:skipSaveConfirm',
};
function loadUiBool(key, fallback) {
  try {
    const v = localStorage.getItem(UI_BOOL_KEYS[key]);
    return v === null ? fallback : v === '1';
  } catch (e) { return fallback; }
}
function saveUiBool(key, value) {
  try { localStorage.setItem(UI_BOOL_KEYS[key], value ? '1' : '0'); } catch (e) { /* storage unavailable */ }
}
function isShowRefs() { return document.getElementById('refsToggle').checked; }
function isShowTips() { return document.getElementById('tipsToggle').checked; }

// The library's two single-select filter groups (engine / oscillator
// source) aren't booleans, so they get their own tiny string-valued key map
// following the exact same defensive-localStorage shape as loadUiBool/
// saveUiBool above, rather than being shoehorned into UI_BOOL_KEYS.
const UI_STRING_KEYS = {
  filterEngine: 'delugePatchBook:filterEngine',
  filterOscSource: 'delugePatchBook:filterOscSource',
};
function loadUiString(key, fallback) {
  try {
    const v = localStorage.getItem(UI_STRING_KEYS[key]);
    return v === null ? fallback : v;
  } catch (e) { return fallback; }
}
function saveUiString(key, value) {
  try { localStorage.setItem(UI_STRING_KEYS[key], value); } catch (e) { /* storage unavailable */ }
}

// Current state of the library filter chips (see renderLibrary()'s
// presetMatchesFilters() call, and wireLibraryFilters() below for the click
// handlers that mutate this and persist it). Restored from localStorage at
// startup so filters survive a reload, same treatment Beginner/Expert and
// Show tips/Show manual reference already get.
var libraryFilters = { engine: 'all', oscSource: 'all', hasArp: false, hasUnison: false, hasCables: false, hasSidechain: false };
function loadLibraryFilters() {
  libraryFilters.engine = loadUiString('filterEngine', 'all');
  libraryFilters.oscSource = loadUiString('filterOscSource', 'all');
  libraryFilters.hasArp = loadUiBool('filterHasArp', false);
  libraryFilters.hasUnison = loadUiBool('filterHasUnison', false);
  libraryFilters.hasCables = loadUiBool('filterHasCables', false);
  libraryFilters.hasSidechain = loadUiBool('filterHasSidechain', false);
}
// Reflects libraryFilters into the chip buttons' "active" class -- called
// once at startup (after loadLibraryFilters()) and again after every click,
// rather than trying to keep each button in sync by hand.
function syncLibraryFilterChips() {
  for (const btn of document.querySelectorAll('#libraryFilters .filter-chip[data-group="engine"]')) {
    btn.classList.toggle('active', btn.dataset.value === libraryFilters.engine);
  }
  for (const btn of document.querySelectorAll('#libraryFilters .filter-chip[data-group="oscSource"]')) {
    btn.classList.toggle('active', btn.dataset.value === libraryFilters.oscSource);
  }
  for (const btn of document.querySelectorAll('#libraryFilters .filter-chip[data-group="flags"]')) {
    btn.classList.toggle('active', !!libraryFilters[btn.dataset.value]);
  }
}
function wireLibraryFilters() {
  loadLibraryFilters();
  syncLibraryFilterChips();
  document.getElementById('libraryFilters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    const group = btn.dataset.group;
    const value = btn.dataset.value;
    if (group === 'engine') {
      libraryFilters.engine = value;
      saveUiString('filterEngine', value);
    } else if (group === 'oscSource') {
      libraryFilters.oscSource = value;
      saveUiString('filterOscSource', value);
    } else if (group === 'flags') {
      // Checkbox-style: clicking toggles that one flag on/off independently
      // of the others (AND-combinable), unlike the engine/oscSource radio
      // groups above where clicking a chip always selects it outright.
      libraryFilters[value] = !libraryFilters[value];
      const uiKey = 'filter' + value[0].toUpperCase() + value.slice(1);
      saveUiBool(uiKey, libraryFilters[value]);
    } else {
      return;
    }
    syncLibraryFilterChips();
    renderLibrary(document.getElementById('searchBox').value);
  });
}

// Filled in by the "Check on device" handler below: Map<path, {ok, status}>
// from the most recent evaluateSteps() result. null until a check has run
// for the currently loaded preset. Cleared whenever a different preset is
// selected, since it only means anything against the preset it was read for.
let lastCheckFieldStatus = null;

// Rebuilt by renderGuide() every time it runs: [{ el, body, step }]
// for exactly the steps it classified as "live" (see isLiveStep()) this
// time around. Consulted (not renderGuide() itself) whenever a live CC
// value changes, so a knob turn recolors just these few DOM nodes instead
// of rebuilding the whole guide -- see refreshLiveSteps() below.
let renderedLiveSteps = [];

// Colors one ck()-marked fragment from its live status, AND, whenever it's
// not yet (or no longer) a match, appends a small up/down arrow showing
// where the live value currently sits relative to target -- pointing up
// means "too high", down means "too low" (i.e. it shows CURRENT POSITION,
// not a "turn it this way" instruction -- see liveFieldDirection()'s own
// comment for why). The arrow element is created once and reused on every
// subsequent call (not recreated per refresh) so it doesn't flicker/reflow
// on every CC message while a knob is turned.
function applyLiveSpanVisuals(spanEl) {
  const path = spanEl.dataset.checkPath;
  spanEl.classList.remove('check-ok', 'check-changed', 'check-unexpected', 'check-untouched');
  const status = DelugeMidiFollowModule.liveFieldStatus(midiFollow, path, currentCheckTargetObj, checkSettings);
  if (status) spanEl.classList.add(`check-${status}`);
  let arrow = spanEl.nextElementSibling;
  if (!arrow || !arrow.classList.contains('live-arrow')) {
    arrow = document.createElement('span');
    arrow.className = 'live-arrow';
    spanEl.after(arrow);
  }
  const dir = (status && status !== 'ok') ? DelugeMidiFollowModule.liveFieldDirection(midiFollow, path, currentCheckTargetObj) : null;
  arrow.hidden = !dir;
  if (dir) {
    arrow.textContent = dir > 0 ? '▲' : '▼';
    arrow.title = dir > 0 ? 'Live value is too high' : 'Live value is too low';
    arrow.classList.toggle('live-arrow-up', dir > 0);
    arrow.classList.toggle('live-arrow-down', dir < 0);
  }
}

// Re-colors every currently-rendered live step from the tracker's latest
// values -- called from the MIDI Follow onUpdate() subscription (wired up
// near the `deluge`/`midiFollow` instances further down), which can fire
// many times a second while a knob is turned. Deliberately recomputes ALL
// live steps on every call rather than only the ones whose fields actually
// changed: there are only ever a handful of live steps in one guide, so the
// extra work is negligible, and it avoids needing a per-field -> step index.
function refreshLiveSteps() {
  for (const { el, body, step } of renderedLiveSteps) {
    const status = liveStepStatus(step);
    el.classList.remove('check-ok', 'check-changed', 'check-unexpected', 'check-untouched');
    el.classList.toggle('step-live-waiting', status === null);
    if (status) el.classList.add(`check-${status}`);
    for (const spanEl of body.querySelectorAll('[data-check-path]')) {
      applyLiveSpanVisuals(spanEl);
    }
  }
}

// Rolls a guide step's checkFields (see makeStep()) up into one status:
// "unexpected" wins even if some of the step's own fields are fine, since
// it flags an actual mistake; otherwise all-ok beats partial "changed".
// Returns null if this step has no check fields, or no check has run yet.
function stepCheckStatus(step) {
  if (!lastCheckFieldStatus || !step.checkFields || !step.checkFields.length) return null;
  const statuses = step.checkFields.map(f => lastCheckFieldStatus.get(f.path)).filter(Boolean);
  if (!statuses.length) return null;
  if (statuses.some(s => s.status === 'unexpected')) return 'unexpected';
  if (statuses.every(s => s.ok)) return 'ok';
  if (statuses.some(s => s.status === 'changed')) return 'changed';
  return 'untouched';
}

// A guide step is MIDI-Follow "live" only if it has check fields AND every
// single one is in DelugeMidiFollowModule.FIELD_TO_MIDIFOLLOW_PARAM -- the
// "never mix live and check-file values in one step" rule means one
// uncovered field (e.g. a filter step's enum-only "LPF mode") disqualifies
// the whole step back to ordinary check-file behavior, even though most of
// its other fields are perfectly live-mappable.
function isLiveStep(step) {
  return !!(step.checkFields && step.checkFields.length &&
    step.checkFields.every(f => DelugeMidiFollowModule.isLiveMappable(f.path)));
}

// Live counterpart of stepCheckStatus() above: same rollup priority
// (unexpected wins, then all-ok, then in-progress), reading live CC-derived
// values instead of the last file-based check. Returns null if not a
// single one of this step's fields has received a live CC value yet
// (device connected, but nothing's been turned since) -- callers show a
// "waiting" state, not a color, for that case (see step-live-waiting in
// renderGuide()).
//
// Unlike stepCheckStatus(), a per-field null here (that ONE field hasn't
// reported a live value yet) is NOT simply dropped from the rollup: with a
// file-based check, buildCheckSteps() always evaluates every field of a
// step in one pass, so partial data never happens in practice -- but with
// live CC feedback each field arrives independently as its own knob gets
// turned, so it's entirely normal for e.g. Envelope 1's Attack to have
// reported in while Decay/Sustain/Release haven't yet. Dropping those
// null fields (as if they simply didn't exist) would let a step read as
// "ok" -- and auto-tick its checkbox -- from just ONE of four fields
// happening to match, which is exactly the kind of premature/incorrect
// status this whole area got re-examined for. A field still pending now
// blocks "ok" specifically, while still allowing "changed" to show once
// real progress is visible, so the step doesn't misleadingly look
// untouched either.
function liveStepStatus(step) {
  if (!currentCheckTargetObj) return null;
  const statuses = step.checkFields
    .map(f => DelugeMidiFollowModule.liveFieldStatus(midiFollow, f.path, currentCheckTargetObj, checkSettings));
  if (statuses.every(s => s === null)) return null;
  if (statuses.some(s => s === 'unexpected')) return 'unexpected';
  if (statuses.every(s => s === 'ok')) return 'ok';
  if (statuses.every(s => s === 'untouched' || s === null)) return 'untouched';
  return 'changed';
}

// Anything with an "unexpected" status has, by definition, no home in the
// guide: buildGuide() only ever creates a step for what the TARGET patch
// actually uses, so a parameter this patch doesn't touch (e.g. bitcrush on
// a patch that never set it) has no step for renderGuide() to color. This
// scans two sources for those orphaned red flags:
// - every field buildCheckSteps() knows about (covers ordinary params like
//   bitcrush/EQ/etc. for free, since evaluateSteps() already classified
//   them -- buildCheckSteps() always emits these fields regardless of
//   whether the target patch uses them, only buildGuide() is selective);
// - patch cables the actual file has that the target doesn't want at all,
//   which can't show up in the first pass since buildCheckSteps() only
//   ever generates cable fields for the target's OWN cables in the first
//   place (see cableField() -- there's no field to classify against for a
//   routing the target never made).
// Idea 6: maps a buildCheckSteps() field key (or a cable's raw source/dest)
// back to the same PARAM_CONCEPTS id used by "Show tips" on the Steps tab,
// so an unexpected-change flag can carry a real "did you mean to...?"
// teaching note instead of just a bare parameter name. Substring matching
// on the raw path (not the display label) since it's the stable, known
// vocabulary buildCheckSteps()/cableField() themselves use.
function conceptForCheckKey(key) {
  const k = key.toLowerCase();
  // Checked first: a cable key's source/destination names (e.g.
  // "cable:connect:lfo1->pitch") can themselves contain substrings like
  // "lfo"/"envelope" that would otherwise misfire the parameter-family
  // checks below before this function ever gets to its own cable check.
  if (k.startsWith('cable:')) return 'modmatrix';
  if (k.includes('lpf')) return 'filter.lpf';
  if (k.includes('hpf')) return 'filter.hpf';
  if (k.includes('filterroute')) return 'filter.route';
  if (k.includes('envelope1')) return 'envelope.amp';
  if (k.includes('envelope2')) return 'envelope.filter';
  if (k.includes('lfo')) return 'lfo';
  if (k.includes('unison')) return 'unison';
  if (k.includes('portamento')) return 'portamento';
  if (k.includes('arpeggiator')) return 'arpeggiator';
  if (k.includes('modfx')) return 'modfx';
  if (k.includes('delay')) return 'delay';
  if (k.includes('reverb')) return 'reverb';
  if (k.includes('sidechain')) return 'sidechain';
  if (k.includes('bitcrush') || k.includes('sampleratereduction') || k.includes('clippingamount')) return 'distortion';
  if (k.includes('wavefold')) return 'wavefold';
  if (k.includes('equalizer')) return 'eq';
  if (k.endsWith('.volume')) return 'mixer.level';
  if (k.includes('oscbvolume') || k.includes('noisevolume') || k.includes('oscavolume')) return 'mixer.balance';
  if (k.includes('.pan') || k === 'pan') return 'mixer.pan';
  if (k.includes('modulator')) return 'fm';
  if (k.startsWith('osc') && k.includes('type')) return 'osc.type';
  if (k.startsWith('osc') && k.includes('transpose')) return 'osc.transpose';
  return null;
}

// "Unexpected" (see fieldStatus() in deluge-check.js) means the TARGET is
// at its default and the actual/device value ISN'T -- so the fix is always
// "put this back to its default", and there's frequently no guide step
// anywhere that ever mentions the shortcut, since buildGuide() only ever
// generates a step for a NON-default value. Reported as too generic to
// act on ("OSC1 cents ist zu generisch, der user muss wissen auf welchen
// wert er zurückstellen muss und wie") -- this maps a checkField's own
// path to the exact same shortcut wording buildGuide()'s own describeXXX()
// functions use for that field elsewhere, plus an optional display-format
// override for values that need a unit suffix or aren't raw q31 hex.
// Deliberately not exhaustive: a field missing here still shows its reset
// VALUE (see evaluateSteps()'s resetValue, always accurate, no guessing
// involved) with a generic "via the SOUND menu" fallback rather than
// silently showing nothing.
const CHECK_FIELD_RESET_HOW = {
  mode: { how: shift('SYNTH MODE'), format: v => v.toUpperCase() },
  polyphonic: { how: shift('POLYPHONY'), format: v => v.toUpperCase() },
  transpose: { how: `${shift('XPOSE')} (under MASTER)`, format: v => `${v} st` },
  cents: { how: `${shift('XPOSE')} (under MASTER, fine-tune)`, format: v => `${v} cents` },
  'osc1.type': { how: shift('OSC1 TYPE'), format: v => v.toUpperCase() },
  'osc1.transpose': { how: shift('OSC1 TRANSPOSE'), format: v => `${v} st` },
  'osc1.cents': { how: `${shift('OSC1 TRANSPOSE')} (fine-tune)`, format: v => `${v} cents` },
  'osc1.retrigPhase': { how: shift('OSC1 RETRIG PHASE'), format: v => v === '-1' ? 'off' : `${retrigPhaseDegrees(v)}°` },
  'osc2.type': { how: shift('OSC2 TYPE'), format: v => v.toUpperCase() },
  'osc2.transpose': { how: shift('OSC2 TRANSPOSE'), format: v => `${v} st` },
  'osc2.cents': { how: `${shift('OSC2 TRANSPOSE')} (fine-tune)`, format: v => `${v} cents` },
  'osc2.retrigPhase': { how: shift('OSC2 RETRIG PHASE'), format: v => v === '-1' ? 'off' : `${retrigPhaseDegrees(v)}°` },
  'modulator1.transpose': { how: shift('MOD1 TRANSPOSE'), format: v => `${v} st` },
  'modulator2.transpose': { how: shift('MOD2 TRANSPOSE'), format: v => `${v} st` },
  'modulator1.retrigPhase': { how: shift('MOD1 RETRIG PHASE'), format: v => v === '-1' ? 'off' : `${retrigPhaseDegrees(v)}°` },
  'modulator2.retrigPhase': { how: shift('MOD2 RETRIG PHASE'), format: v => v === '-1' ? 'off' : `${retrigPhaseDegrees(v)}°` },
  'defaultParams.modulator1Amount': { how: shift('MOD1 LEVEL') },
  'defaultParams.modulator2Amount': { how: shift('MOD2 LEVEL') },
  'defaultParams.carrier1Feedback': { how: shift('OSC1 FEEDBACK') },
  'defaultParams.carrier2Feedback': { how: shift('OSC2 FEEDBACK') },
  'defaultParams.modulator1Feedback': { how: shift('MOD1 FEEDBACK') },
  'defaultParams.modulator2Feedback': { how: shift('MOD2 FEEDBACK') },
  'modulator2.toModulator1': { how: shift('MOD2 DESTINATION'), format: v => v && v !== '0' ? 'MOD1' : 'CARRIER 2' },
  'defaultParams.oscAPulseWidth': { how: shift(DEST_SHORTCUT.oscAPhaseWidth), format: dvHalfPrecision },
  'defaultParams.oscBPulseWidth': { how: shift(DEST_SHORTCUT.oscBPhaseWidth), format: dvHalfPrecision },
  'defaultParams.volume': { how: shift(DEST_SHORTCUT.volume) },
  'defaultParams.oscAVolume': { how: shift('OSC1 LEVEL') },
  'defaultParams.oscBVolume': { how: shift('OSC2 LEVEL') },
  'defaultParams.noiseVolume': { how: shift('NOISE') },
  'defaultParams.pan': { how: shift('PAN'), format: v => dvPan(v) },
  'unison.num': { how: `${shift('NUMBER')} (under VOICE)` },
  'unison.detune': { how: `${shift('DETUNE')} (under VOICE)` },
  'unison.spread': { how: 'via the SOUND menu (no dedicated shortcut pad for spread)' },
  'defaultParams.portamento': { how: `${shift('PORTA')} (under VOICE)` },
  'defaultParams.lpfFrequency': { how: `${shift('FREQUENCY')} (under LPF)` },
  'defaultParams.lpfResonance': { how: `${shift('RESONANCE')} (under LPF)` },
  lpfMode: { how: `${shift('DB/OCT')} (under LPF)` },
  'defaultParams.hpfFrequency': { how: `${shift('FREQUENCY')} (under HPF)` },
  'defaultParams.hpfResonance': { how: `${shift('RESONANCE')} (under HPF)` },
  hpfMode: { how: `${selectMenu('HPF &gt; MODE')} (no dedicated shortcut pad)` },
  filterRoute: { how: selectMenu('SOUND &gt; FILTER ROUTE') },
  'defaultParams.envelope1.attack': { how: `${shift('ATTACK')} (Envelope 1)` },
  'defaultParams.envelope1.decay': { how: `${shift('DECAY')} (Envelope 1)` },
  'defaultParams.envelope1.sustain': { how: `${shift('SUSTAIN')} (Envelope 1)` },
  'defaultParams.envelope1.release': { how: `${shift('RELEASE')} (Envelope 1)` },
  'defaultParams.envelope2.attack': { how: `${shift('ATTACK')} (Envelope 2)` },
  'defaultParams.envelope2.decay': { how: `${shift('DECAY')} (Envelope 2)` },
  'defaultParams.envelope2.sustain': { how: `${shift('SUSTAIN')} (Envelope 2)` },
  'defaultParams.envelope2.release': { how: `${shift('RELEASE')} (Envelope 2)` },
  'lfo1.type': { how: shift('LFO1 SHAPE'), format: v => v.toUpperCase() },
  'defaultParams.lfo1Rate': { how: shift('LFO1 RATE') },
  'lfo1.syncLevel': { how: shift('LFO1 SYNC'), format: syncLevelName },
  'lfo2.type': { how: shift('LFO2 SHAPE'), format: v => v.toUpperCase() },
  'defaultParams.lfo2Rate': { how: shift('LFO2 RATE') },
  'lfo2.syncLevel': { how: shift('LFO2 SYNC'), format: syncLevelName },
  'arpeggiator.mode': { how: `${shift('MODE')} (under VOICE)`, format: v => v.toUpperCase() },
  'arpeggiator.noteMode': { how: `${shift('MODE')} (under VOICE)`, format: v => v.toUpperCase() },
  'arpeggiator.octaveMode': { how: `${shift('MODE')} (under VOICE)`, format: v => v.toUpperCase() },
  'arpeggiator.numOctaves': { how: `${shift('NUMBER OF OCTAVES')} (under VOICE)` },
  'arpeggiator.syncLevel': { how: `${shift('SYNC')} (under VOICE)`, format: v => syncLevelName(packedSyncOption(v, '0')) },
  'defaultParams.arpeggiatorGate': { how: `${shift('GATE')} (under VOICE)` },
  'defaultParams.arpeggiatorRate': { how: `${shift('RATE')} (under VOICE)` },
  modFXType: { how: `${shift('TYPE')} (under MOD-FX)`, format: v => v.toUpperCase() },
  'defaultParams.modFXRate': { how: `${shift('RATE')} (under MOD-FX)` },
  'defaultParams.modFXDepth': { how: `${shift('DEPTH')} (under MOD-FX)` },
  'defaultParams.modFXOffset': { how: `${shift('OFFSET')} (under MOD-FX)` },
  'defaultParams.modFXFeedback': { how: `${shift('FEEDBACK')} (under MOD-FX)` },
  'delay.pingPong': { how: `${shift('STEREO')} (under FX/DELAY)`, format: v => v === '1' ? 'on' : 'off' },
  'delay.analog': { how: `${shift('TYPE')} (under FX/DELAY)`, format: v => v === '1' ? 'ANALOG' : 'DIGITAL' },
  'delay.syncLevel': { how: `${shift('SYNC')} (under FX/DELAY)`, format: syncLevelName },
  'defaultParams.delayRate': { how: `${shift('RATE')} (under FX/DELAY)` },
  'defaultParams.delayFeedback': { how: `${shift('AMOUNT')} (under FX/DELAY)` },
  'defaultParams.reverbAmount': { how: `${shift('AMOUNT')} (under REVERB)` },
  'sidechain.attack': { how: `${shift('ATTACK')} (under SIDECHAIN COMPRESSOR)` },
  'sidechain.release': { how: `${shift('RELEASE')} (under SIDECHAIN COMPRESSOR)` },
  'sidechain.syncLevel': { how: `${shift('SYNC')} (under SIDECHAIN COMPRESSOR)`, format: syncLevelName },
  clippingAmount: { how: shift('SATURATION') },
  'defaultParams.bitCrush': { how: shift('BITCRUSH') },
  'defaultParams.sampleRateReduction': { how: shift('DECIMATION') },
  'defaultParams.waveFold': { how: `via the SOUND menu (${selectMenu('SOUND &gt; WAVEFOLD')})` },
  'defaultParams.equalizer.bass': { how: shift('ADJUST (BASS)') },
  'defaultParams.equalizer.treble': { how: shift('ADJUST (TREBLE)') },
  'defaultParams.equalizer.bassFrequency': { how: shift('BASS') },
  'defaultParams.equalizer.trebleFrequency': { how: shift('TREBLE') },
};
// Generic fallback: a raw q31 hex value formats the same way every other
// step's value does (0-50 scale via dv()); anything else (enum/plain int)
// is shown as-is, since it's already in a directly-readable shape.
function formatResetValue(path, raw) {
  const override = CHECK_FIELD_RESET_HOW[path];
  if (override && override.format) return override.format(raw);
  if (/^0x[0-9A-Fa-f]{8}$/.test(raw)) return dv(raw);
  return raw;
}

function findUnexpectedChanges(result) {
  const items = [];
  for (const step of result.steps) {
    for (const f of step.fields) {
      if (f.status === 'unexpected' && !f.key.startsWith('cable:')) {
        const howEntry = CHECK_FIELD_RESET_HOW[f.key];
        const resetDisplay = f.resetValue !== undefined ? formatResetValue(f.key, f.resetValue) : null;
        items.push({
          label: f.label,
          conceptKey: conceptForCheckKey(f.key),
          resetDisplay,
          how: howEntry ? howEntry.how : 'via the SOUND menu',
        });
      }
    }
  }
  const targetCables = cablesOf(result.targetObj);
  const actualCables = cablesOf(result.actualObj);
  for (const c of actualCables) {
    if (!c.source || !c.destination || cableIsDefault(c)) continue;
    const inTarget = targetCables.some(t => t.source === c.source && t.destination === c.destination);
    if (!inTarget) items.push({ label: `${humanize(c.source)} → ${destDisplayName(c.destination)} (extra patch cable)`, conceptKey: 'modmatrix', why: cableWhyText(c.source, c.destination, dvCable(c.amount)) });
  }
  return items;
}

function renderUnexpectedChanges(items) {
  const el = document.getElementById('unexpectedChanges');
  if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const showTips = document.getElementById('tipsToggle') && isShowTips();
  el.innerHTML = `<div class="unexpected-title">Unexpected changes (not part of this patch)</div>` +
    `<ul>${items.map(item => {
      // Session 3: prefer the per-cable `why` override (cableWhyText()) over
      // the flat PARAM_CONCEPTS[conceptKey] lookup, same precedence as
      // renderStepFootnotes() below.
      const whyText = item.why || (showTips && item.conceptKey && PARAM_CONCEPTS[item.conceptKey] && PARAM_CONCEPTS[item.conceptKey].why);
      const note = showTips && whyText ? `<div class="unexpected-note">Did you mean to change this? ${escapeHtml(whyText)}</div>` : '';
      // Always shown (not gated behind "Show tips" like the why-note above)
      // -- this is the actual fix, not an optional teaching aside. Reported
      // as too generic without it ("OSC1 cents ist zu generisch, der user
      // muss wissen auf welchen wert er zurückstellen muss und wie").
      const resetLine = item.resetDisplay !== undefined && item.resetDisplay !== null
        ? `<div class="unexpected-reset">Reset to ${val(escapeHtml(String(item.resetDisplay)))} — ${item.how}.</div>`
        : '';
      return `<li>${escapeHtml(item.label)}${resetLine}${note}</li>`;
    }).join('')}</ul>`;
}

function escapeHtml(s) { return svgEscape(s); }

// A step's "Show manual reference" / "Show tips" caption line(s), appended under its
// instruction text -- one <div class="step-ref"> per active toggle, styled
// like a small dim caption (see .step-ref in styles.css) rather than folded
// into .step-text, so it reads as metadata about the step, not part of it.
function renderStepFootnotes(step) {
  let html = '';
  // Session 3: a step's own computed `why` (per-cable text from
  // cableWhyText()) takes priority over the flat PARAM_CONCEPTS[conceptKey]
  // blurb when present; `tryThis` still only comes from PARAM_CONCEPTS,
  // since a per-cable "try this" isn't something cableWhyText() computes.
  const concept = step.conceptKey && PARAM_CONCEPTS[step.conceptKey];
  if (isShowTips() && (step.why || concept)) {
    const whyText = step.why || concept.why;
    html += `<div class="step-ref step-tip"><b>Why this matters:</b> ${escapeHtml(whyText)}</div>`;
    if (concept && concept.tryThis) html += `<div class="step-ref step-tip"><b>Try this:</b> ${escapeHtml(concept.tryThis)}</div>`;
  }
  if (isShowRefs() && step.manualRef) {
    const r = step.manualRef;
    const cls = 'step-ref step-source' + (r.community ? ' step-source-community' : '');
    html += r.url
      ? `<div class="${cls}">More infos: <a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.text)}</a></div>`
      : `<div class="${cls}">More infos: ${escapeHtml(r.text)}</div>`;
  }
  // Idea 2: a "Hear it" WebAudio demo button, shown whenever this step's
  // concept has one -- independent of the "Show tips" toggle, since it's an
  // interactive aid rather than more text to read.
  const demoKind = step.conceptKey && DEMO_FOR_CONCEPT[step.conceptKey];
  if (demoKind) {
    html += `<div class="step-ref step-demo"><button type="button" class="btn-link demo-open-btn" data-demo="${demoKind}">&#9654; Hear it</button></div>`;
  }
  return html;
}

function renderGuide(item, sections) {
  document.getElementById('guideEmpty').hidden = true;
  const content = document.getElementById('guideContent');
  content.hidden = false;
  document.getElementById('guidePack').textContent = item.pack;
  document.getElementById('guideTitle').textContent = item.name;

  const container = document.getElementById('guideSections');
  container.innerHTML = '';
  // Repopulated below, one entry per rendered "live" step -- refreshLiveSteps()
  // (called from the MIDI Follow CC subscription) walks just this small list
  // instead of re-running renderGuide() on every incoming CC, which can fire
  // many times a second while a knob is turned.
  renderedLiveSteps = [];
  // The "Reading the steps" (SHIFT+PARAM syntax) explanation used to live
  // here as its own box above every guide -- moved into the User Guide
  // (openUserGuide()) instead, reachable from the top bar, so it's there
  // when actually needed without permanently eating space in the guide a
  // returning user already knows how to read.

  sections.forEach((section) => {
    const block = document.createElement('div');
    block.className = 'section-block';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = section.title;
    block.appendChild(title);
    for (const step of section.steps) {
      // Live steps never consult the file-based check result, and vice
      // versa -- see isLiveStep()'s comment for why a step is never allowed
      // to blend the two.
      const live = deluge.connected && isLiveStep(step);
      const checkStatus = live ? liveStepStatus(step) : stepCheckStatus(step);
      const el = document.createElement('div');
      el.className = 'step' + (checkStatus ? ` check-${checkStatus}` : '') + (step.indent ? ' step-indent' : '');
      if (live) el.classList.toggle('step-live-waiting', checkStatus === null);
      // "live" (device connected, MIDI Follow covers every field of this
      // step) vs. "check pending..." (device connected, but this step needs
      // an explicit Check now -- and none has run yet this preset). Neither
      // shows at all without a connected Deluge, so the plain read-the-guide
      // experience is untouched.
      let badgeHtml = '';
      if (deluge.connected && step.checkFields && step.checkFields.length) {
        badgeHtml = live
          ? `<span class="step-badge step-badge-live">live</span>`
          : (!lastCheckFieldStatus ? `<span class="step-badge step-badge-pending">check pending&hellip;</span>` : '');
      }
      const body = document.createElement('div');
      body.className = 'step-body';
      body.innerHTML = `<div class="step-title">${step.title}${badgeHtml}</div><div class="step-text">${isBeginnerMode() ? step.beginner : step.expert}</div>${renderStepFootnotes(step)}`;
      // Color each individual instruction fragment (e.g. "SHIFT+ATTACK 31")
      // right where it's written, not in a separate list -- see ck() above
      // for how these markers get embedded into a step's HTML.
      if (live) {
        for (const spanEl of body.querySelectorAll('[data-check-path]')) {
          applyLiveSpanVisuals(spanEl);
        }
        renderedLiveSteps.push({ el, body, step });
      } else if (lastCheckFieldStatus) {
        for (const spanEl of body.querySelectorAll('[data-check-path]')) {
          const s = lastCheckFieldStatus.get(spanEl.dataset.checkPath);
          if (s) spanEl.classList.add(`check-${s.status}`);
        }
      }
      const demoBtn = body.querySelector('.demo-open-btn');
      if (demoBtn) demoBtn.addEventListener('click', () => openAudioDemo(demoBtn.dataset.demo));
      el.appendChild(body);
      block.appendChild(el);
    }
    container.appendChild(block);
  });
  updateCompletedText(item.id);
}

function updateCompletedText(id) {
  const el = document.getElementById('completedText');
  const btn = document.getElementById('resetCompletedBtn');
  const done = isCompleted(id);
  el.textContent = done ? '★ Built correctly before' : '';
  btn.hidden = !done;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.getElementById('pickFolderBtn').addEventListener('click', () => document.getElementById('folderInput').click());
document.getElementById('folderInput').addEventListener('change', e => ingestFiles(e.target.files));
document.getElementById('filesInput').addEventListener('change', e => ingestFiles(e.target.files, { autoSelectSingle: true }));
document.getElementById('searchBox').addEventListener('input', e => renderLibrary(e.target.value));
wireLibraryFilters();
document.getElementById('modeToggle').addEventListener('change', () => {
  if (currentPreset) selectPreset(currentPreset);
  updateCheckStatusClickability();
});
// "Show manual reference" / "Show tips": restore persisted state on load,
// then re-render the current guide (if any) whenever one is flipped --
// same one-shot re-render pattern the Beginner/Expert toggle already uses.
document.getElementById('refsToggle').checked = loadUiBool('showRefs', false);
document.getElementById('tipsToggle').checked = loadUiBool('showTips', true);
document.getElementById('refsToggle').addEventListener('change', e => {
  saveUiBool('showRefs', e.target.checked);
  if (currentPreset) selectPreset(currentPreset);
});
document.getElementById('tipsToggle').addEventListener('change', e => {
  saveUiBool('showTips', e.target.checked);
  if (currentPreset) selectPreset(currentPreset);
});
// Landscape-phone-only collapse toggle for the preset-list sidebar (see the
// `body.sidebar-collapsed` rules inside the `orientation: landscape` media
// query in styles.css) -- the toggle button itself is display:none outside
// that breakpoint, so this listener is harmless (never reachable) elsewhere.
// Deliberately not persisted to localStorage: it's a transient space trade-
// off for the current viewport, not a durable preference like the other
// toggles above, and defaulting back to expanded on reload means a user
// who rotates back to portrait (or reopens on desktop) never has to wonder
// where their preset list went.
document.getElementById('libraryCollapseToggle').addEventListener('click', function () {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  this.setAttribute('aria-expanded', String(!collapsed));
});
document.getElementById('resetCompletedBtn').addEventListener('click', () => {
  if (!currentPreset) return;
  if (!confirm('Clear the "built correctly before" star for this preset?')) return;
  clearCompleted(currentPreset.id);
  updateCompletedText(currentPreset.id);
  renderLibrary(document.getElementById('searchBox').value);
});
document.getElementById('glossaryBtn').addEventListener('click', openGlossary);
document.getElementById('userGuideBtn').addEventListener('click', openUserGuide);
document.getElementById('userGuideLinkCheck').addEventListener('click', openUserGuide);
document.getElementById('printBtn').addEventListener('click', printCheatSheet);
document.getElementById('tabBar').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b === btn);
  const panels = { steps: 'tabSteps', matrix: 'tabMatrix', signal: 'tabSignal', compare: 'tabCompare' };
  for (const [key, id] of Object.entries(panels)) {
    document.getElementById(id).classList.toggle('active', key === btn.dataset.tab);
  }
  if (btn.dataset.tab === 'compare' && currentPreset) renderCompareTab();
});

const svgTooltip = document.getElementById('svgTooltip');
// Attached to #guideContent -- the nearest common ancestor of both
// #signalPathContent (single-preset Signal Path tab) and #compareContent
// (Compare tab, which renders two more copies of the same diagram) -- so
// hover tooltips work on every signal-path SVG in the document, not just
// the original tab. `e.target.closest('[data-tooltip]')` already does the
// real per-box scoping, so this generalizes for free regardless of which
// container the pointer is actually over.
document.getElementById('guideContent').addEventListener('mousemove', e => {
  const target = e.target.closest('[data-tooltip]');
  if (!target) { svgTooltip.hidden = true; return; }
  svgTooltip.textContent = target.getAttribute('data-tooltip');
  svgTooltip.hidden = false;
  const margin = 14;
  let left = e.clientX + margin;
  let top = e.clientY + margin;
  svgTooltip.style.left = left + 'px';
  svgTooltip.style.top = top + 'px';
  const rect = svgTooltip.getBoundingClientRect();
  if (rect.right > window.innerWidth) svgTooltip.style.left = (e.clientX - rect.width - margin) + 'px';
  if (rect.bottom > window.innerHeight) svgTooltip.style.top = (e.clientY - rect.height - margin) + 'px';
});
document.getElementById('guideContent').addEventListener('mouseleave', () => { svgTooltip.hidden = true; });

// ---------------------------------------------------------------------------
// Live Deluge connection: load a preset straight off the device, and check
// an in-progress rebuild against the target patch. Fully optional -- none of
// the above (folder/file pickers, guide, mod matrix, signal path) touches
// this section or the modules it imports.
// ---------------------------------------------------------------------------
const deluge = new DelugeSysex();
const delugeCheck = new DelugeCheck(deluge);
let checkSettings = loadSettings();
let lastCheckResult = null;
// Live MIDI Follow feedback tracking -- see modules/deluge-midi-follow.js
// for the CC<->field mapping and per-field status logic; this instance just
// owns the connection-lifetime state (started on connect, stopped on
// disconnect) and the one onUpdate() subscription that keeps rendered live
// steps in sync (refreshLiveSteps(), defined next to renderGuide() above).
const midiFollow = new DelugeMidiFollowModule.MidiFollowTracker(deluge);
midiFollow.onUpdate(() => refreshLiveSteps());

const delugeConnectBtn = document.getElementById('delugeConnectBtn');
const delugeStatusEl = document.getElementById('delugeStatus');
function setDelugeStatus(text, connected) {
  delugeStatusEl.textContent = text;
  delugeStatusEl.classList.toggle('connected', !!connected);
  delugeConnectBtn.textContent = connected ? 'Disconnect Deluge' : 'Connect Deluge…';
}
// Refreshes everything that depends on connected-or-not rather than on any
// particular check/live result: the "some steps are live" hint under the
// check panel, and (if a preset is loaded) the guide itself, so live/check-
// pending badges appear or disappear immediately on connect/disconnect
// instead of only after the next preset selection.
function onDelugeConnectionChanged() {
  const hint = document.getElementById('midiFollowHint');
  if (hint) hint.hidden = !deluge.connected;
  if (currentPreset && currentPatch) renderGuide(currentPreset, buildGuide(currentPatch));
}
// Web MIDI's requestMIDIAccess() must be called directly from a click
// handler (a user-gesture requirement), so every entry point below that
// needs a connection (load-from-device, check-on-device) calls this itself
// rather than assuming the dedicated Connect button was used first.
async function ensureDelugeConnected() {
  if (deluge.connected) return;
  await deluge.requestAccess();
  // autoConnect() prefers whichever MIDI port actually answers a ping, but
  // connects to a name-matched port even if none of them do -- some
  // firmware/driver combinations never answer a bare PING yet still work
  // fine for real file commands (see the fallback in _ensureSession), so a
  // ping timeout alone isn't reliable enough to call the connection dead.
  if (!(await deluge.autoConnect())) {
    throw new Error('No MIDI device with "deluge" in its port name was found. Make sure it is plugged in and powered on.');
  }
  setDelugeStatus('connected', true);
  // Best-effort (never throws -- see MidiFollowTracker.start()): reads the
  // device's real SETTINGS/MIDIFollow.XML, falling back to the documented
  // default mapping if that file doesn't exist or can't be parsed.
  await midiFollow.start();
  onDelugeConnectionChanged();
}
delugeConnectBtn.addEventListener('click', async () => {
  if (deluge.connected) {
    deluge.disconnect();
    midiFollow.stop();
    setDelugeStatus('not connected', false);
    onDelugeConnectionChanged();
    return;
  }
  setDelugeStatus('connecting…', false);
  try {
    await ensureDelugeConnected();
  } catch (err) {
    setDelugeStatus('not connected', false);
    alert('Could not connect to Deluge: ' + err.message);
  }
});

// Generic modal overlay, shared by the device file picker and the check
// settings panel below.
function closeModal() {
  stopActiveDemo(); // idea 2: never leave a WebAudio demo playing after its modal is gone
  const overlay = document.getElementById('modalOverlay');
  overlay.hidden = true;
  overlay.innerHTML = '';
  overlay.onclick = null;
}
function openModal(buildFn) {
  const overlay = document.getElementById('modalOverlay');
  overlay.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal-box';
  overlay.appendChild(box);
  overlay.hidden = false;
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
  buildFn(box);
  return box;
}
// Turns the flat {path, name} list the Deluge returns into a nested tree
// keyed by folder name, so the picker below can act like a real folder
// browser (drill in / breadcrumb back out) instead of one long list.
function buildFileTree(files) {
  const root = { folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push(f);
  }
  return root;
}
function countFilesRecursive(node) {
  let n = node.files.length;
  for (const child of node.folders.values()) n += countFilesRecursive(child);
  return n;
}

// Experimental, opt-in device-side category filtering (see this session's
// report for the full reasoning): a full read of every candidate file over
// MIDI SysEx to categorize the whole /SYNTHS tree the way the local
// library does would be hundreds/thousands of open+read+close round trips
// -- far too slow to do eagerly. A short partial read (a couple KB) CAN
// reliably sniff engine + oscillator source (see sniffEngineMode()/
// sniffOscSource()'s own comments and readFilePartial() in
// deluge-sysex.js), but arpeggiator/cables/sidechain sit too far into the
// file to trust from a short read -- sniffCategories(text, {partial:true})
// already zeroes those out. So this stays deliberately narrow: opt-in
// (a button, never automatic), bounded to the folder currently being
// browsed (never the flattened whole-tree search results), and capped at
// DEVICE_CATEGORIZE_MAX_FILES per click.
const DEVICE_PARTIAL_READ_BYTES = 2048; // 2x READ_CHUNK_SIZE -- enough headroom for engine+osc attributes even on a file with a long multisample zone list before them.
const DEVICE_CATEGORIZE_MAX_FILES = 200; // a real folder-full is fine; the whole SD card is not.
// "Load N presets…" (below) deliberately has NO matching cap: it always
// loads every candidate the label just counted, in one click -- a 40-file
// cap here used to force repeated clicks for anything bigger than that,
// which is exactly the "mühsam" (tedious) real-world friction it was
// reported for. A full readFile() per file is heavier than Categorize's 2KB
// partial reads, but the per-file progress text ("Loaded X / N…") already
// keeps the UI honest while a big batch is still in flight.

// Doubles as the onPickerNeeded callback DelugeCheck.runCheck() expects
// (files => Promise<string|null>), since the shape matches exactly -- that
// caller (the "Check on device" flow) never passes a second argument, so
// deviceForCategorize stays undefined there and this whole feature is a
// no-op for it, exactly as before this was added.
function showFilePickerModal(files, { deviceForCategorize } = {}) {
  return new Promise(resolve => {
    const tree = buildFileTree(files);
    let pathParts = []; // folder names, root to current
    // path -> categories (from a partial read) | null (read failed, treat
    // as unknown -- never hidden). Session-scoped to this one modal open;
    // reopening the picker starts fresh since the SD card may have changed.
    const deviceCategories = new Map();
    const deviceFilters = { engine: 'all', oscSource: 'all' };
    function filtersAreActive() { return deviceFilters.engine !== 'all' || deviceFilters.oscSource !== 'all'; }
    // Files directly in `node` that match the current filter (or all of
    // them, if no filter is active) and aren't already sitting in the
    // library -- the exact set "Load this whole folder…"/"Load N
    // presets…" both counts and actually loads, kept in one place so the
    // button's live label (render()) and its click handler can never drift
    // apart from each other.
    function loadableFilesIn(node) {
      const scoped = filtersAreActive()
        ? node.files.filter(f => presetMatchesFilters(deviceCategories.get(f.path), deviceFilters))
        : node.files;
      return scoped.filter(f => !library.some(l => l.id === `deluge:${f.path}`));
    }

    openModal(box => {
      const h = document.createElement('h3');
      h.textContent = 'Choose a preset on the Deluge';
      box.appendChild(h);

      const cancel = document.createElement('button');
      cancel.className = 'btn-secondary';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { closeModal(); resolve(null); });

      if (files.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'No XML files found under /SYNTHS.';
        box.appendChild(p);
        box.appendChild(cancel);
        return;
      }

      // Device-side filter chips + "Categorize this folder…" opt-in button
      // -- only built at all when the caller passed deviceForCategorize
      // (only the "Load a preset from connected Deluge…" handler does;
      // the on-device check flow's picker never sees this UI).
      //
      // Categorize comes BEFORE the filter chips (it's the prerequisite
      // that makes the chips mean anything -- they start disabled, see
      // render()'s hasCategorized check, until at least one file in the
      // current folder actually has data). "Load this whole folder…" comes
      // AFTER the chips instead: it's not a prerequisite for anything, and
      // its own label/behavior actually depends on the chips' current
      // state (see below), so it reads better positioned right under them.
      let deviceFilterBox = null;
      let categorizeRow = null;
      let categorizeBtn = null;
      let categorizeStatus = null;
      let loadFolderRow = null;
      let loadFolderBtn = null;
      let loadFolderStatus = null;
      if (deviceForCategorize) {
        categorizeRow = document.createElement('div');
        categorizeRow.className = 'modal-categorize-row';
        categorizeBtn = document.createElement('button');
        categorizeBtn.type = 'button';
        categorizeBtn.className = 'btn-secondary modal-categorize-btn';
        categorizeBtn.textContent = 'Categorize this folder…';
        categorizeStatus = document.createElement('span');
        categorizeStatus.className = 'modal-categorize-status';
        categorizeRow.appendChild(categorizeBtn);
        categorizeRow.appendChild(categorizeStatus);
        box.appendChild(categorizeRow);

        deviceFilterBox = document.createElement('div');
        deviceFilterBox.className = 'modal-device-filters';
        deviceFilterBox.innerHTML = `
          <div class="library-filters">
            <div class="filter-group" role="group" aria-label="Filter by engine">
              <button type="button" class="filter-chip active" data-group="engine" data-value="all">All engines</button>
              <button type="button" class="filter-chip" data-group="engine" data-value="subtractive">Subtractive</button>
              <button type="button" class="filter-chip" data-group="engine" data-value="fm">FM</button>
              <button type="button" class="filter-chip" data-group="engine" data-value="ringmod">Ring Mod</button>
            </div>
            <div class="filter-group" role="group" aria-label="Filter by oscillator source">
              <button type="button" class="filter-chip active" data-group="oscSource" data-value="all">Any osc</button>
              <button type="button" class="filter-chip" data-group="oscSource" data-value="waveform">Waveform</button>
              <button type="button" class="filter-chip" data-group="oscSource" data-value="sample">Sample</button>
              <button type="button" class="filter-chip" data-group="oscSource" data-value="multisample">Multisample</button>
            </div>
          </div>
        `;
        box.appendChild(deviceFilterBox);

        deviceFilterBox.addEventListener('click', e => {
          const btn = e.target.closest('.filter-chip');
          if (!btn) return;
          const group = btn.dataset.group;
          for (const b of deviceFilterBox.querySelectorAll(`.filter-chip[data-group="${group}"]`)) {
            b.classList.toggle('active', b === btn);
          }
          deviceFilters[group] = btn.dataset.value;
          render();
        });
        categorizeBtn.addEventListener('click', async () => {
          const node = currentNode();
          const candidates = node.files.filter(f => !deviceCategories.has(f.path)).slice(0, DEVICE_CATEGORIZE_MAX_FILES);
          if (candidates.length === 0) { render(); return; }
          categorizeBtn.disabled = true;
          let done = 0;
          categorizeStatus.textContent = `Reading ${candidates.length} file${candidates.length === 1 ? '' : 's'}…`;
          for (const f of candidates) {
            try {
              const { buffer } = await deviceForCategorize.readFilePartial(f.path, DEVICE_PARTIAL_READ_BYTES);
              deviceCategories.set(f.path, sniffCategories(new TextDecoder().decode(buffer), { partial: true }));
            } catch (e) {
              deviceCategories.set(f.path, null); // couldn't read -- stays "unknown", never hidden by a filter
            }
            done++;
            categorizeStatus.textContent = `Read ${done} / ${candidates.length}…`;
            render();
          }
          const remaining = node.files.length - node.files.filter(f => deviceCategories.has(f.path)).length;
          categorizeStatus.textContent = remaining > 0
            ? `Categorized ${node.files.length - remaining} of ${node.files.length} files here (click again for the rest).`
            : `Categorized all ${node.files.length} files in this folder.`;
          categorizeBtn.disabled = false;
          render();
        });

        // Loading exactly one preset at a time from a connected Deluge left
        // Compare with nothing to compare against unless the user ALSO
        // loaded a local folder -- this reads every preset directly under
        // the folder currently being browsed (not recursive, same "scoped
        // to one folder" reasoning as Categorize above) and adds them all
        // to the library in one go, same as picking a local folder would.
        // Below the filter chips (not above, alongside Categorize): unlike
        // Categorize, it isn't a prerequisite for anything else in this
        // modal, and once a filter is actually active its own label/scope
        // changes to match the chips right above it (see render()), which
        // reads naturally as "this button follows what the chips say".
        loadFolderRow = document.createElement('div');
        loadFolderRow.className = 'modal-categorize-row';
        loadFolderBtn = document.createElement('button');
        loadFolderBtn.type = 'button';
        // Own class (not .modal-categorize-btn) despite identical styling --
        // keeps this and the real Categorize button distinguishable by
        // selector, not just by label text.
        loadFolderBtn.className = 'btn-secondary modal-categorize-btn modal-loadfolder-btn';
        loadFolderBtn.textContent = 'Load this whole folder…';
        loadFolderStatus = document.createElement('span');
        loadFolderStatus.className = 'modal-categorize-status modal-loadfolder-status';
        loadFolderRow.appendChild(loadFolderBtn);
        loadFolderRow.appendChild(loadFolderStatus);
        box.appendChild(loadFolderRow);

        loadFolderBtn.addEventListener('click', async () => {
          const node = currentNode();
          const filtered = filtersAreActive();
          const candidates = loadableFilesIn(node);
          if (candidates.length === 0) {
            loadFolderStatus.textContent = filtered ? 'Every filtered preset here is already loaded.' : 'Every preset here is already loaded.';
            return;
          }
          loadFolderBtn.disabled = true;
          let done = 0, failed = 0;
          loadFolderStatus.textContent = `Reading ${candidates.length} file${candidates.length === 1 ? '' : 's'}…`;
          for (const f of candidates) {
            try {
              const buffer = await deviceForCategorize.readFile(f.path);
              const text = new TextDecoder().decode(buffer);
              const name = f.path.split('/').pop().replace(/\.xml$/i, '');
              library.push({
                id: `deluge:${f.path}`, name, pack: 'From Deluge (live)',
                file: { text: async () => text }, rawText: text, categories: sniffCategories(text),
              });
            } catch (e) {
              failed++; // keep going -- one unreadable file shouldn't abort the whole batch
            }
            done++;
            loadFolderStatus.textContent = `Loaded ${done} / ${candidates.length}…`;
          }
          document.getElementById('libraryBody').hidden = false;
          sortLibrary();
          renderLibrary(document.getElementById('searchBox').value);
          loadFolderStatus.textContent = `Loaded ${candidates.length - failed}${filtered ? ' filtered' : ''} preset${candidates.length - failed === 1 ? '' : 's'}. `
            + (failed > 0 ? `${failed} failed to read.` : '');
          loadFolderBtn.disabled = false;
          render(); // refresh the button's own count/label now that these are in the library
        });
      }

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'modal-search';
      search.placeholder = 'Search presets by name…';
      box.appendChild(search);

      const breadcrumb = document.createElement('div');
      breadcrumb.className = 'modal-breadcrumb';
      box.appendChild(breadcrumb);

      const list = document.createElement('div');
      list.className = 'modal-list';
      box.appendChild(list);
      box.appendChild(cancel);

      function choose(path) { closeModal(); resolve(path); }
      function currentNode() {
        let node = tree;
        for (const part of pathParts) node = node.folders.get(part);
        return node;
      }

      function renderBreadcrumb() {
        breadcrumb.innerHTML = '';
        const rootBtn = document.createElement('button');
        rootBtn.className = 'modal-breadcrumb-item';
        rootBtn.textContent = 'SD card';
        rootBtn.addEventListener('click', () => { pathParts = []; render(); });
        breadcrumb.appendChild(rootBtn);
        const acc = [];
        for (const part of pathParts) {
          acc.push(part);
          const sep = document.createElement('span');
          sep.className = 'modal-breadcrumb-sep';
          sep.textContent = '/';
          breadcrumb.appendChild(sep);
          const btn = document.createElement('button');
          btn.className = 'modal-breadcrumb-item';
          btn.textContent = part;
          const target = acc.slice();
          btn.addEventListener('click', () => { pathParts = target; render(); });
          breadcrumb.appendChild(btn);
        }
      }

      function renderFolderView() {
        list.innerHTML = '';
        const node = currentNode();
        const folderNames = Array.from(node.folders.keys()).sort();
        for (const name of folderNames) {
          const count = countFilesRecursive(node.folders.get(name));
          const btn = document.createElement('button');
          btn.className = 'modal-list-item modal-list-folder';
          btn.innerHTML = `<span class="modal-folder-icon">\u{1F4C1}</span>` +
            `<span class="modal-item-name">${name}</span>` +
            `<span class="modal-item-count">${count}</span>`;
          btn.addEventListener('click', () => { pathParts = pathParts.concat(name); render(); });
          list.appendChild(btn);
        }
        let fileItems = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
        const deviceFiltersActive = deviceForCategorize && filtersAreActive();
        if (deviceFiltersActive) {
          fileItems = fileItems.filter(f => presetMatchesFilters(deviceCategories.get(f.path), deviceFilters));
        }
        for (const f of fileItems) {
          const btn = document.createElement('button');
          btn.className = 'modal-list-item';
          const cat = deviceCategories.get(f.path);
          // A small hint once a file's been categorized -- not shown at all
          // for files nothing's read yet, so there's no false confidence
          // about what an un-categorized "still matches" really means.
          const hint = cat ? `<span class="modal-item-category">${escapeHtml(cat.engine === 'subtractive' ? '' : cat.engine + ' · ')}${escapeHtml(cat.oscSource)}</span>` : '';
          btn.innerHTML = `<span class="modal-item-name">${escapeHtml(f.name)}</span>${hint}`;
          btn.addEventListener('click', () => choose(f.path));
          list.appendChild(btn);
        }
        if (folderNames.length === 0 && fileItems.length === 0) {
          const p = document.createElement('p');
          p.className = 'modal-empty';
          p.textContent = deviceFiltersActive && node.files.length > 0 ? 'No categorized files here match -- try "Categorize this folder…" first, or clear the filter.' : 'Empty folder.';
          list.appendChild(p);
        }
      }

      function renderSearchResults(query) {
        list.innerHTML = '';
        const q = query.toLowerCase();
        const matches = files
          .filter((f) => f.name.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (matches.length === 0) {
          const p = document.createElement('p');
          p.className = 'modal-empty';
          p.textContent = 'No presets match.';
          list.appendChild(p);
          return;
        }
        for (const f of matches) {
          const folder = f.path.slice(0, f.path.length - f.name.length - 1);
          const btn = document.createElement('button');
          btn.className = 'modal-list-item modal-list-search-item';
          btn.innerHTML = `<span class="modal-item-name">${f.name}</span>` +
            `<span class="modal-item-path">${folder}</span>`;
          btn.addEventListener('click', () => choose(f.path));
          list.appendChild(btn);
        }
      }

      function render() {
        const q = search.value.trim();
        // The device filter/categorize UI is bounded to "the folder
        // currently being browsed" -- it has no meaning once search
        // flattens across the whole tree, so hide it rather than let it
        // silently do nothing.
        if (deviceFilterBox) {
          categorizeRow.hidden = !!q;
          deviceFilterBox.hidden = !!q;
          loadFolderRow.hidden = !!q;
          if (!q) {
            // Chips stay disabled until at least one file in THIS folder
            // has actually been read -- before that, every file's category
            // is unknown, so every chip would look clickable but do
            // nothing, which reads as broken rather than "not yet".
            const hasCategorized = currentNode().files.some(f => deviceCategories.has(f.path));
            for (const chip of deviceFilterBox.querySelectorAll('.filter-chip')) {
              chip.disabled = !hasCategorized;
            }
            // Label always states exactly how many presets a click would
            // add right now (scoped to the active filter, if any, and
            // excluding ones already in the library) -- previously a flat
            // "Load this whole folder…"/"Load all filtered…" gave no idea
            // how big that click actually was, and a 40-file cap meant
            // sometimes it wasn't even "all" despite the label; there's no
            // cap now, so the count is also always the true total.
            const count = loadableFilesIn(currentNode()).length;
            loadFolderBtn.disabled = count === 0;
            loadFolderBtn.textContent = count === 0
              ? 'All presets here are loaded'
              : `Load ${count}${filtersAreActive() ? ' filtered' : ''} preset${count === 1 ? '' : 's'}…`;
          }
        }
        if (q) {
          breadcrumb.hidden = true;
          renderSearchResults(q);
        } else {
          breadcrumb.hidden = false;
          renderBreadcrumb();
          renderFolderView();
        }
      }

      search.addEventListener('input', render);
      render();
      search.focus();
    });
  });
}

document.getElementById('loadFromDelugeBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('loadStatus');
  try {
    statusEl.textContent = 'Connecting…';
    await ensureDelugeConnected();
    statusEl.textContent = 'Listing presets on Deluge…';
    const files = await delugeCheck.listCandidateFiles('/SYNTHS');
    // Only this caller opts into the (experimental, partial-read-based)
    // device-side category filter chips -- the "Check on device" flow
    // reuses this same modal via DelugeCheck.runCheck()'s picker callback
    // and never passes a second argument, so it's unaffected.
    const path = await showFilePickerModal(files, { deviceForCategorize: deluge });
    if (!path) { statusEl.textContent = ''; return; }
    statusEl.textContent = `Reading ${path}…`;
    const buffer = await deluge.readFile(path);
    const text = new TextDecoder().decode(buffer);
    const name = path.split('/').pop().replace(/\.xml$/i, '');
    // Content is already fully read (readFile() above got the whole file
    // over SysEx to load the guide) -- sniff library-filter categories from
    // it for free, same as a locally-loaded preset gets from ingestFiles().
    const item = {
      id: `deluge:${path}`, name, pack: 'From Deluge (live)',
      file: { text: async () => text }, rawText: text, categories: sniffCategories(text),
    };
    if (!library.some(l => l.id === item.id)) library.push(item);
    sortLibrary();
    document.getElementById('libraryBody').hidden = false;
    statusEl.textContent = `Loaded "${name}" from Deluge.`;
    await selectPreset(item);
  } catch (err) {
    statusEl.textContent = '';
    alert('Could not load preset from Deluge: ' + err.message);
  }
});

// "Check now" reads whatever progress file is currently sitting on the SD
// card -- easy to click before actually saving there, especially since
// nothing else in this flow forces a save first. Asked once per click
// unless permanently dismissed via "Don't ask again" (persisted the same
// way as the other UI_BOOL_KEYS toggles). Resolves true to proceed with the
// check, false if the user cancelled.
function confirmSavedToSdCard() {
  if (loadUiBool('skipSaveConfirm', false)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => { if (resolved) return; resolved = true; closeModal(); resolve(value); };
    openModal(box => {
      const h = document.createElement('h3');
      h.textContent = 'Saved to the SD card?';
      box.appendChild(h);
      const p = document.createElement('p');
      p.textContent = "Check now reads whatever progress file is currently on the Deluge's SD card. Make sure you saved your in-progress patch there first, or you'll just be re-checking the old version.";
      box.appendChild(p);
      const label = document.createElement('label');
      label.className = 'modal-checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" Don't ask again"));
      box.appendChild(label);
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => finish(false));
      const okBtn = document.createElement('button');
      okBtn.className = 'btn-primary';
      okBtn.textContent = 'Yes, check now';
      okBtn.addEventListener('click', () => {
        if (cb.checked) saveUiBool('skipSaveConfirm', true);
        finish(true);
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      box.appendChild(actions);
    });
    // Dismissing via the overlay backdrop counts as Cancel too, rather than
    // leaving this promise unresolved forever.
    document.getElementById('modalOverlay').onclick = (e) => {
      if (e.target === e.currentTarget) finish(false);
    };
  });
}

// One-off celebration the moment a preset FIRST reaches a perfect,
// every-field match -- reported directly ("popup a little congratulation
// popup on perfect match"). Purely a nicety; closing it (any way) does
// nothing else -- the star itself was already saved by markCompleted()
// before this is even shown.
function showCompletionCelebration() {
  openModal(box => {
    box.classList.add('modal-celebrate');
    const h = document.createElement('h3');
    h.textContent = '★ Perfect match!';
    box.appendChild(h);
    const p = document.createElement('p');
    p.textContent = `Every field on "${currentPreset.name}" now matches the target patch. It keeps its star in the library from here on, even after the device moves on to something else.`;
    box.appendChild(p);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Nice!';
    okBtn.addEventListener('click', closeModal);
    actions.appendChild(okBtn);
    box.appendChild(actions);
  });
}

// Click-to-expand troubleshooting list for the "X / Y fields match" status
// line -- reported directly ("macht es sinn beim click auf 77/79 ein
// popup anzuzeigen, was noch fehlt?"): a preset can have every VISIBLE
// step read green while a couple of check fields still don't match (no
// step ever shows those specific fields as part of its own text -- see
// e.g. the carrier1Feedback/toModulator1/retrigPhase gaps found this same
// session), so the raw "X / Y" count alone gives no way to find out WHICH
// two without hunting through every step by eye. Deliberately Beginner-
// mode only (per the same report: "nur im Beginnermode, nicht im
// Expert") -- Expert mode's whole premise is reading the terser,
// denser step text directly rather than leaning on an extra summary.
function showMissingFieldsModal(result) {
  const missingByStep = result.steps
    .map(s => ({ label: s.label, fields: s.fields.filter(f => !f.ok) }))
    .filter(s => s.fields.length);
  openModal(box => {
    const h = document.createElement('h3');
    h.textContent = 'Still to check';
    box.appendChild(h);
    if (!missingByStep.length) {
      const p = document.createElement('p');
      p.textContent = 'Every field matches.';
      box.appendChild(p);
    } else {
      for (const group of missingByStep) {
        const title = document.createElement('div');
        title.className = 'missing-fields-group-title';
        title.textContent = group.label;
        box.appendChild(title);
        for (const f of group.fields) {
          const howEntry = CHECK_FIELD_RESET_HOW[f.key];
          const row = document.createElement('div');
          row.className = 'missing-fields-row';
          row.innerHTML = `<span class="missing-field-label">${escapeHtml(f.label)}</span>` +
            `<span class="missing-field-status check-${f.status}">${f.status}</span>` +
            (howEntry ? `<span class="missing-field-how">${howEntry.how}</span>` : '');
          box.appendChild(row);
        }
      }
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.addEventListener('click', closeModal);
    actions.appendChild(close);
    box.appendChild(actions);
  });
}

// Toggles the click affordance on #deviceCheckStatus -- only clickable
// when there's an actual check result with something left unmatched, and
// only in Beginner mode (see showMissingFieldsModal()'s own comment).
function updateCheckStatusClickability() {
  const statusEl = document.getElementById('deviceCheckStatus');
  const hasGaps = !!(lastCheckResult && lastCheckResult.steps.some(s => s.fields.some(f => !f.ok)));
  statusEl.classList.toggle('clickable-status', isBeginnerMode() && hasGaps);
}
document.getElementById('deviceCheckStatus').addEventListener('click', () => {
  if (!document.getElementById('deviceCheckStatus').classList.contains('clickable-status')) return;
  showMissingFieldsModal(lastCheckResult);
});

document.getElementById('checkOnDeviceBtn').addEventListener('click', async () => {
  if (!currentPreset) { alert('Pick a preset first.'); return; }
  if (!(await confirmSavedToSdCard())) return;
  const statusEl = document.getElementById('deviceCheckStatus');
  try {
    statusEl.textContent = 'Connecting…';
    await ensureDelugeConnected();
    statusEl.textContent = 'Reading progress file from Deluge…';
    // Same reuse-don't-reread optimization as selectPreset(): this is the
    // TARGET preset's own file, already read once (and cached) when it was
    // loaded/selected -- not the device's progress file, which the
    // delugeCheck.runCheck() call below reads separately, for real, every
    // time (that one can't be cached -- it's the whole point of "Check on
    // device" that it re-reads the SD card each click).
    const targetXmlText = currentPreset.rawText !== undefined ? currentPreset.rawText : await currentPreset.file.text();
    const patch = parseDelugeXml(targetXmlText);
    currentPatch = patch;
    const steps = buildCheckSteps(patch);
    const result = await delugeCheck.runCheck(steps, targetXmlText, checkSettings, showFilePickerModal);
    lastCheckResult = result;
    // Index by key (not label -- labels aren't unique across steps) so
    // stepCheckStatus() can look up each guide step's checkFields directly.
    lastCheckFieldStatus = new Map(
      result.steps.flatMap(s => s.fields.map(f => [f.key, { ok: f.ok, status: f.status }])),
    );
    const totalFields = result.steps.reduce((n, s) => n + s.fields.length, 0);
    const okFields = result.steps.reduce((n, s) => n + s.fields.filter(f => f.ok).length, 0);
    statusEl.textContent = `Checked against ${result.path}: ${okFields} / ${totalFields} fields match. See the colored steps below.`;
    updateCheckStatusClickability();
    // Every single field matched -- this preset has now been built correctly
    // at least once, a durable fact worth keeping even after the device
    // moves on to something else. See completedKey()'s own comment. Only
    // celebrates the FIRST time this preset reaches it, not every re-check
    // of an already-starred preset.
    const perfectMatch = totalFields > 0 && okFields === totalFields;
    const justCompleted = perfectMatch && !isCompleted(currentPreset.id);
    if (perfectMatch) markCompleted(currentPreset.id);
    renderGuide(currentPreset, buildGuide(patch));
    renderUnexpectedChanges(findUnexpectedChanges(result));
    renderLibrary(document.getElementById('searchBox').value);
    if (justCompleted) showCompletionCelebration();
  } catch (err) {
    statusEl.textContent = '';
    alert('Check failed: ' + err.message);
  }
});

document.getElementById('checkSettingsBtn').addEventListener('click', () => {
  openModal(box => {
    const h = document.createElement('h3');
    h.textContent = 'Check settings';
    box.appendChild(h);
    const panel = document.createElement('div');
    box.appendChild(panel);
    const knownFieldKeys = lastCheckResult
      ? lastCheckResult.steps.flatMap(s => s.fields.map(f => ({ key: f.key, label: f.label })))
      : [];
    renderSettingsPanel(panel, {
      settings: checkSettings,
      knownFieldKeys,
      onChange: () => saveSettings(checkSettings),
    });
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.style.marginTop = '14px';
    close.addEventListener('click', closeModal);
    box.appendChild(close);
  });
});

// Diagnostic view for exactly the kind of "live feedback isn't showing up"
// question this got built to answer: instead of guessing at the connection
// (wrong port, MIDI Follow not enabled on the device, wrong CC numbers, ...),
// show every raw message MidiFollowTracker's monitored ports actually see.
// Reachable from the top bar (not gated behind a loaded preset) since the
// most useful moment to check it is often right after connecting, before
// picking a preset at all.
function formatMidiLogEntry(e) {
  const t = new Date(e.time);
  const time = t.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(t.getMilliseconds()).padStart(3, '0');
  let detail;
  if (e.label === 'CC') {
    if (e.fieldPaths && e.fieldPaths.length) {
      detail = `CC ${e.cc} = ${e.value} &rarr; <b>${e.fieldPaths.map(escapeHtml).join(', ')}</b> <span class="midi-monitor-tag">live</span>`;
    } else if (e.params && e.params.length) {
      detail = `CC ${e.cc} = ${e.value} &rarr; ${escapeHtml(e.params.join(', '))} <span class="midi-monitor-dim">(no guide step checks this field)</span>`;
    } else {
      detail = `CC ${e.cc} = ${e.value} <span class="midi-monitor-dim">(not in the current CC mapping)</span>`;
    }
  } else {
    detail = `${escapeHtml(e.label)} <span class="midi-monitor-dim">[${e.raw.map(b => b.toString(16).padStart(2, '0')).join(' ')}]</span>`;
  }
  return `<div class="midi-monitor-row"><span class="midi-monitor-time">${time}</span><span class="midi-monitor-ch">ch${e.channel}</span><span class="midi-monitor-detail">${detail}</span></div>`;
}

document.getElementById('midiMonitorBtn').addEventListener('click', () => {
  let unsubscribe = null;
  let pendingRender = false;
  const close = () => { if (unsubscribe) unsubscribe(); closeModal(); };
  openModal(box => {
    box.classList.add('midi-monitor-box');
    const h = document.createElement('h3');
    h.textContent = 'MIDI Monitor';
    box.appendChild(h);
    const info = document.createElement('div');
    box.appendChild(info);
    const toolbar = document.createElement('div');
    toolbar.className = 'midi-monitor-toolbar';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-link';
    clearBtn.textContent = 'Clear log';
    clearBtn.addEventListener('click', () => { midiFollow.clearLog(); renderLog(); });
    toolbar.appendChild(clearBtn);
    box.appendChild(toolbar);
    const logEl = document.createElement('div');
    logEl.className = 'midi-monitor-log';
    box.appendChild(logEl);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '14px';
    closeBtn.addEventListener('click', close);
    box.appendChild(closeBtn);

    function renderInfo() {
      if (!deluge.connected) {
        info.innerHTML = `<p>Not connected. Click <b>Connect Deluge&hellip;</b> first, then reopen this.</p>`;
        return;
      }
      const ports = midiFollow.monitoredPortNames;
      if (!ports.length) {
        info.innerHTML = `<p class="midi-monitor-warn">Connected, but no MIDI input with "deluge" in its name is open -- nothing can arrive here. Check the browser's MIDI permission and that the Deluge is still plugged in and powered on.</p>`;
        return;
      }
      const mappingSrc = midiFollow.usingDeviceMapping
        ? "the device's own SETTINGS/MIDIFollow.XML"
        : 'the documented default mapping (no MIDIFollow.XML found/readable on this device)';
      info.innerHTML = `<p>Listening on: ${ports.map(p => `<code>${escapeHtml(p)}</code>`).join(', ')}<br>
        CC mapping: ${mappingSrc}, ${midiFollow.mappedParamCount} parameters known.</p>`;
    }

    function renderLog() {
      const log = midiFollow.getLog();
      if (!log.length) {
        logEl.innerHTML = `<p class="empty-note">No messages received yet. On the Deluge: <b>SETTINGS &rarr; MIDI &rarr; MIDI-FOLLOW &rarr; FEEDBACK &rarr; CHANNEL</b> &mdash; make sure that's set to an actual channel, not OFF, then turn any knob. If nothing still shows up here, MIDI Follow's feedback may be coming out of a different USB-MIDI port than expected -- try reconnecting.</p>`;
        return;
      }
      // Newest first, capped display (MidiFollowTracker's own log already
      // caps storage at 300 -- this just keeps the DOM itself small too).
      logEl.innerHTML = log.slice(-150).reverse().map(formatMidiLogEntry).join('');
    }

    renderInfo();
    renderLog();
    unsubscribe = midiFollow.onRawMessage(() => {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => { pendingRender = false; renderInfo(); renderLog(); });
    });
  });
  document.getElementById('modalOverlay').onclick = (e) => { if (e.target === e.currentTarget) close(); };
});
