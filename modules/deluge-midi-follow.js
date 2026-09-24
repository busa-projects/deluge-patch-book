/**
 * deluge-midi-follow.js
 * ----------------------------------------------------------------------
 * Live parameter tracking via the Deluge's "MIDI Follow Mode" (Community
 * Firmware feature): once enabled on the device, the Deluge sends a full
 * MIDI CC feedback dump on every context/preset change and a live CC
 * message every time a mapped parameter changes -- on the device's knobs,
 * not just incoming MIDI. That lets a subset of the check-on-device fields
 * (see buildCheckSteps() in app.js) show green/yellow instantly instead of
 * needing an explicit "Check now" + SD-card round trip.
 *
 * Coverage is inherently partial -- MIDI Follow only maps ~80 continuous
 * parameters (see FIELD_TO_MIDIFOLLOW_PARAM below), never patch cables,
 * enums (oscillator type, filter mode, arp mode, ...), Unison, or the
 * Sidechain compressor's attack/release/syncLevel (only its Shape and Duck
 * Amount are mappable, and neither of those is a field buildCheckSteps()
 * currently tracks). app.js is responsible for the "never mix live and
 * check-file values in one guide step" rule -- this module only answers
 * "is this exact field path live-mappable" and "what's its current live
 * value", it doesn't know about guide steps at all.
 *
 * Two sources for the CC-number-per-parameter mapping, in preference order:
 * 1. The device's own SETTINGS/MIDIFollow.XML (read once per connection via
 *    the existing deluge.readFile() SysEx path) -- respects the user's own
 *    remapping/disabling of individual parameters, per the documented
 *    format: <paramName>ccNumber</paramName>, 255 meaning "unmapped"
 *    (delugecommunity.com/features/midi_follow_mode/).
 * 2. DEFAULT_CC_MAP, the documented out-of-the-box mapping (same source,
 *    "Appendix A"), used whenever the file can't be read (older firmware,
 *    MIDI Follow never touched on this device, a read/parse error) so the
 *    feature still works for the common default-settings case.
 * ----------------------------------------------------------------------
 */

window.DelugeMidiFollowModule = (function () {

// -----------------------------------------------------------------------
// Field path (buildCheckSteps()'s field.key/field.path in app.js) <->
// MidiFollow.XML parameter name. Only fields buildCheckSteps() actually
// emits are listed -- being *in* the real default CC table isn't enough by
// itself (see e.g. carrier1Feedback/hpfMorph/compressorThreshold below,
// left out because nothing in buildCheckSteps() checks them).
//
// osc{A,B}Pitch / modulator{1,2}Pitch are deliberately NOT mapped to our
// checked "transpose" fields, even though a real device's own
// SETTINGS/MIDIFollow.XML does list a CC for them (confirmed against an
// actual exported file, not just the docs) and the firmware source
// (gui/menu_item/transpose.h) shows the "Transpose" menu item is
// technically a PatchedParam under the hood. Real-hardware testing found
// no feedback arrives when using the SHIFT+TRANSPOSE grid shortcut this
// guide actually instructs, despite that. Working theory (not firmware-
// verified, just the most likely explanation of what was observed): "Pitch"
// here is a separate, continuous/patchable value meant for modulation
// (mod-knob/gold-knob/automation-style pitch bend), distinct from
// "Transpose", the coarse whole-semitone tuning the grid shortcut and our
// checked field both actually mean -- not simply the same parameter with
// feedback suppressed. Re-verified the rest of this table against both the
// documented default CC list and a real device's actual mapping file and
// found nothing else missing -- every other buildCheckSteps() field that's
// numeric, non-cable and appears in that table is already listed below.
// -----------------------------------------------------------------------
const FIELD_TO_MIDIFOLLOW_PARAM = {
  'defaultParams.oscAVolume': 'oscAVolume',
  'defaultParams.oscBVolume': 'oscBVolume',
  'defaultParams.oscAPulseWidth': 'oscAPhaseWidth',
  'defaultParams.oscBPulseWidth': 'oscBPhaseWidth',
  'defaultParams.noiseVolume': 'noiseVolume',
  'defaultParams.pan': 'pan',
  'defaultParams.envelope1.attack': 'env1Attack',
  'defaultParams.envelope1.decay': 'env1Decay',
  'defaultParams.envelope1.sustain': 'env1Sustain',
  'defaultParams.envelope1.release': 'env1Release',
  'defaultParams.envelope2.attack': 'env2Attack',
  'defaultParams.envelope2.decay': 'env2Decay',
  'defaultParams.envelope2.sustain': 'env2Sustain',
  'defaultParams.envelope2.release': 'env2Release',
  'defaultParams.lpfFrequency': 'lpfFrequency',
  'defaultParams.lpfResonance': 'lpfResonance',
  'defaultParams.hpfFrequency': 'hpfFrequency',
  'defaultParams.hpfResonance': 'hpfResonance',
  'defaultParams.lfo1Rate': 'lfo1Rate',
  'defaultParams.lfo2Rate': 'lfo2Rate',
  'defaultParams.modulator1Amount': 'modulator1Volume',
  'defaultParams.modulator2Amount': 'modulator2Volume',
  'defaultParams.modFXRate': 'modFXRate',
  'defaultParams.modFXDepth': 'modFXDepth',
  'defaultParams.delayRate': 'delayRate',
  'defaultParams.delayFeedback': 'delayFeedback',
  'defaultParams.reverbAmount': 'reverbAmount',
  'defaultParams.arpeggiatorRate': 'arpRate',
  'defaultParams.arpeggiatorGate': 'arpGate',
  'defaultParams.sampleRateReduction': 'sampleRateReduction',
  'defaultParams.bitCrush': 'bitcrushAmount',
  'defaultParams.waveFold': 'waveFold',
  'defaultParams.portamento': 'portamento',
  'defaultParams.equalizer.bass': 'bass',
  'defaultParams.equalizer.treble': 'treble',
};

// The Deluge-INIT-patch raw value for every field above (1:1 copy of the
// relevant attributes from deluge-check.js's own INIT_PATCH_XML) -- needed
// to tell "untouched" from "changed" for live values the same way
// deluge-check.js's fieldStatus() does for file-based ones. Duplicated
// rather than imported to keep this module independent of deluge-check.js
// (it doesn't export its parsed init object) -- these values are a fixed
// fact about the Deluge's init patch, not something that needs to stay in
// lockstep with any generated/derived state.
const LIVE_FIELD_INIT = {
  'defaultParams.oscAVolume': '0x7FFFFFFF',
  'defaultParams.oscBVolume': '0x80000000',
  'defaultParams.oscAPulseWidth': '0x00000000',
  'defaultParams.oscBPulseWidth': '0x00000000',
  'defaultParams.noiseVolume': '0x80000000',
  'defaultParams.pan': '0x00000000',
  'defaultParams.envelope1.attack': '0x80000000',
  'defaultParams.envelope1.decay': '0xE6666654',
  'defaultParams.envelope1.sustain': '0x7FFFFFFF',
  'defaultParams.envelope1.release': '0x80000000',
  'defaultParams.envelope2.attack': '0xE6666654',
  'defaultParams.envelope2.decay': '0xE6666654',
  'defaultParams.envelope2.sustain': '0xFFFFFFE9',
  'defaultParams.envelope2.release': '0xE6666654',
  'defaultParams.lpfFrequency': '0x7FFFFFFF',
  'defaultParams.lpfResonance': '0x80000000',
  'defaultParams.hpfFrequency': '0x80000000',
  'defaultParams.hpfResonance': '0x80000000',
  'defaultParams.lfo1Rate': '0x1999997E',
  'defaultParams.lfo2Rate': '0x00000000',
  'defaultParams.modulator1Amount': '0x80000000',
  'defaultParams.modulator2Amount': '0x80000000',
  'defaultParams.modFXRate': '0x00000000',
  'defaultParams.modFXDepth': '0x00000000',
  'defaultParams.delayRate': '0x00000000',
  'defaultParams.delayFeedback': '0x80000000',
  'defaultParams.reverbAmount': '0x80000000',
  'defaultParams.arpeggiatorRate': '0x00000000',
  'defaultParams.arpeggiatorGate': '0x00000000',
  'defaultParams.sampleRateReduction': '0x80000000',
  'defaultParams.bitCrush': '0x80000000',
  'defaultParams.waveFold': '0x80000000',
  'defaultParams.portamento': '0x80000000',
  'defaultParams.equalizer.bass': '0x00000000',
  'defaultParams.equalizer.treble': '0x00000000',
};

// Reverse lookup, built once: MidiFollow.XML paramName -> our field path(s).
// A plain object (not just inverting 1:1) since nothing rules out two of
// our fields sharing one paramName in principle, even though today it's
// always exactly one.
const PARAM_TO_FIELDS = {};
for (const [path, param] of Object.entries(FIELD_TO_MIDIFOLLOW_PARAM)) {
  (PARAM_TO_FIELDS[param] || (PARAM_TO_FIELDS[param] = [])).push(path);
}

function isLiveMappable(path) {
  return Object.prototype.hasOwnProperty.call(FIELD_TO_MIDIFOLLOW_PARAM, path);
}

// Documented out-of-the-box CC assignments (delugecommunity.com/features/
// midi_follow_mode/, "Appendix A - List of Deluge Parameters with Default
// Mapped CC's"), kept complete (not just the ~33 fields we use above) so a
// future field addition only needs a FIELD_TO_MIDIFOLLOW_PARAM entry, not a
// new CC lookup too. CC numbers verified against the actual table image;
// every tag NAME also cross-checked against the real firmware source
// (SynthstromAudible/DelugeFirmware, src/deluge/modulation/params/param.cpp
// paramNameForFileConst(..., forMidiFollowFile=true)) -- one fixed in the
// process: the docs page's table has a typo, "ratchedAmount", the firmware
// actually writes "ratchetAmount". Cross-checked a second time against a
// real device's own SETTINGS/MIDIFollow.XML (all 81 of its cc_mappings
// entries) -- matched on every CC number already listed here, and found
// two genuinely missing (swapProbability, glideProbability), added below.
const DEFAULT_CC_MAP = {
  reverseProbability: 36, spreadVelocity: 37, spreadOctave: 39, spreadGate: 40,
  rhythm: 42, sequenceLength: 43, chordPolyphony: 44, ratchetAmount: 45,
  noteProbability: 46, bassProbability: 47, chordProbability: 48, ratchetProbability: 49,
  arpGate: 50, arpRate: 51, swapProbability: 112, glideProbability: 113,
  compressorThreshold: 27,
  delayFeedback: 52, delayRate: 53,
  waveFold: 19, bitcrushAmount: 62, sampleRateReduction: 63,
  env1Release: 72, env1Attack: 73, env1Decay: 75, env1Sustain: 76,
  env2Attack: 77, env2Decay: 78, env2Sustain: 79, env2Release: 80,
  env3Attack: 102, env3Decay: 103, env3Sustain: 104, env3Release: 105,
  env4Attack: 106, env4Decay: 107, env4Sustain: 108, env4Release: 109,
  bassFreq: 84, trebleFreq: 85, bass: 86, treble: 87,
  modulator1Pitch: 14, modulator1Volume: 54, modulator1Feedback: 55,
  modulator2Pitch: 15, modulator2Volume: 56, modulator2Feedback: 57,
  hpfFrequency: 81, hpfResonance: 82, hpfMorph: 83,
  lfo1Rate: 58, lfo2Rate: 59, lfo3Rate: 110, lfo4Rate: 111,
  lpfMorph: 70, lpfResonance: 71, lpfFrequency: 74,
  pitch: 3, volumePostFX: 7, pan: 10,
  modFXRate: 16, modFXFeedback: 17, modFXOffset: 18, modFXDepth: 93,
  noiseVolume: 41,
  oscAPitch: 12, oscAVolume: 21, oscAPhaseWidth: 23, carrier1Feedback: 24, oscAWavetablePosition: 25,
  oscBPitch: 13, oscBVolume: 26, oscBPhaseWidth: 28, carrier2Feedback: 29, oscBWavetablePosition: 30,
  portamento: 5, reverbAmount: 91,
  compressorShape: 60, sidechainCompressorVolume: 61,
  stutterRate: 20,
};

// MIDI Follow's own CC<->raw conversion is NOT the same relationship as the
// menu's own 0-50 display scale (dv()/dvHalfPrecision() in app.js) -- a
// SEPARATE, coarser (128-step, not 51-step) one, confirmed against firmware
// source (modulation/params/param_set.cpp/param_collection.cpp):
//  - Every field EXCEPT pulse width: ParamCollection::knobPosToParamValue()
//    -- given an incoming CC (already shifted by kKnobPosOffset=64 back to
//    a -64..63 "knobPos"), raw = knobPos << 25.
//  - Pulse width only: PatchedParamSet::knobPosToParamValue() has its own
//    special case (only the positive half of the range is meaningful, same
//    reason dvHalfPrecision() exists) -- raw = (knobPos + 64) << 24, which
//    collapses to exactly `cc << 24` once knobPos = cc - 64 is substituted
//    in. Confirmed bit-exact against the same real-hardware data point used
//    to verify dvHalfPrecision(): PatchedParamSet::paramValueToKnobPos()'s
//    OWN forward formula, (paramValue >> 24) - 64, applied to the real
//    on-screen-41 raw (0x68F5C27C) plus kKnobPosOffset gives exactly
//    CC 104, the real confirmed value.
// An earlier version of this function used its own approximated, continuous
// (non-quantized) formulas instead of these exact ones -- close, but not
// bit-identical, and confirmed (via a full sweep of the generic formula
// against dv()) to read up to 1 menu step off from the real device on
// roughly 1 in 10 raw values, an inherent quantization gap the real
// firmware's own asymmetric forward/reverse formulas already have (not
// something this app introduced, and not eliminable without ignoring what
// the real device does) -- using the *exact* firmware formulas is as close
// as this app can get to matching what a real device does with a given CC.
const HALF_PRECISION_FIELD_PATHS = new Set(['defaultParams.oscAPulseWidth', 'defaultParams.oscBPulseWidth']);
function ccToRawHex(ccValue, fieldPath) {
  const clamped = Math.max(0, Math.min(127, ccValue));
  const knobPos = clamped - 64; // kKnobPosOffset, confirmed via the pulse-width real-hardware cross-check above
  let raw;
  if (HALF_PRECISION_FIELD_PATHS.has(fieldPath)) {
    raw = knobPos < 64 ? (knobPos + 64) << 24 : 0x7fffffff;
  } else {
    raw = knobPos < 64 ? knobPos << 25 : 0x7fffffff;
  }
  raw = raw >>> 0; // back to an unsigned 32-bit bit pattern for hex formatting
  return '0x' + raw.toString(16).toUpperCase().padStart(8, '0');
}

// ---------------------------------------------------------------------
// MIDIFollow.XML's real shape (confirmed against the community firmware
// source, src/deluge/io/midi/midi_follow.cpp -- MidiFollow::writeDefaultsToFile()
// / readDefaultMappingsFromFile(), not just the docs page's short example
// snippet, which only showed one bare tag and doesn't mention the wrapper):
//
//   <defaults>
//     <cc_mappings>
//       <lpfFrequency>74</lpfFrequency>
//       ...one flat <paramName>ccNumber</paramName> tag per MAPPED CC...
//     </cc_mappings>
//     <settings>...channels, kit root note, feedback, display param...</settings>
//   </defaults>
//
// The firmware only ever writes a tag for a CC that's actually assigned to
// a parameter (it loops CC 0-127 and writes one tag per hit) -- there is no
// literal "255" sentinel value inside this specific file, unlike the docs
// page's more general description of the format, so no need to special-
// case it; the 0-127 range check below is a plain sanity guard, not a
// "skip unmapped" rule. Looked up as `cc_mappings` wherever it is in the
// document (not tied to the exact root nesting depth) so a firmware version
// that wraps things slightly differently doesn't silently break this.
// ---------------------------------------------------------------------
function parseMidiFollowXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('MIDIFollow.XML could not be parsed.');
  const ccMappings = doc.getElementsByTagName('cc_mappings')[0];
  if (!ccMappings) throw new Error('MIDIFollow.XML has no <cc_mappings> section.');
  const ccByParam = {};
  for (const el of Array.from(ccMappings.children || [])) {
    const cc = parseInt((el.textContent || '').trim(), 10);
    if (Number.isFinite(cc) && cc >= 0 && cc <= 127) ccByParam[el.tagName] = cc;
  }
  return ccByParam;
}

function buildCcIndex(ccByParam) {
  const byCc = new Map();
  for (const [param, cc] of Object.entries(ccByParam)) {
    if (!byCc.has(cc)) byCc.set(cc, []);
    byCc.get(cc).push(param);
  }
  return byCc;
}

// ---------------------------------------------------------------------
const LOG_CAPACITY = 300;

// Status-byte high nibble -> a short label, for the raw message log only
// (has zero bearing on live-value tracking, which only ever cares about
// 0xB0 Control Change).
const STATUS_LABELS = {
  0x80: 'note off', 0x90: 'note on', 0xa0: 'poly aftertouch', 0xb0: 'CC',
  0xc0: 'program change', 0xd0: 'channel aftertouch', 0xe0: 'pitch bend',
};

// System real-time messages (clock/transport) are single status-only bytes
// sent continuously during playback -- MIDI Clock (0xF8) alone goes out 24x
// per quarter note -- and would otherwise flood the Monitor's fixed-size
// log (LOG_CAPACITY), pushing out anything actually useful (CC, notes...)
// within seconds. Reported directly: "ignore clock messages on monitor or
// transport". Never touched live-value tracking either way (only 0xB0 CC
// ever is) -- this only changes what the Monitor log records.
const IGNORED_REALTIME_STATUS = new Set([0xf8, 0xfa, 0xfb, 0xfc]); // clock, start, continue, stop

// Tracks live CC feedback for the fields FIELD_TO_MIDIFOLLOW_PARAM knows
// about. Doesn't touch the DOM or know about guide steps -- app.js
// subscribes via onUpdate() and re-colors whatever it's currently showing.
//
// Deliberately does NOT rely on DelugeSysex's single connected input/CC
// listener: the Deluge exposes several MIDI ports (deluge-sysex.js's own
// comment on autoConnect() -- "welcher davon dieses SysEx-Protokoll
// tatsächlich beantwortet, ist je nach OS/Treiber unterschiedlich"), and
// there is no guarantee the port that happens to answer SysEx is the same
// one MIDI Follow's plain-CC feedback comes out of. This attaches directly
// to every MIDI input with "deluge" in its name instead, independent of
// whichever single port deluge.connect()'d for file transfer.
class MidiFollowTracker {
  /** @param {import("./deluge-sysex.js").DelugeSysex} deluge */
  constructor(deluge) {
    this.deluge = deluge;
    this._ccByParam = DEFAULT_CC_MAP;
    this._ccIndex = buildCcIndex(DEFAULT_CC_MAP);
    this._usingDeviceMapping = false;
    this._liveValues = new Map(); // field path -> raw hex
    this._listeners = new Set();
    this._logListeners = new Set();
    this._log = [];
    this._attachedInputs = [];
    this._onRawMidiMessage = this._onRawMidiMessage.bind(this);
  }

  get usingDeviceMapping() { return this._usingDeviceMapping; }
  get monitoredPortNames() { return this._attachedInputs.map(i => i.name); }
  get mappedParamCount() { return Object.keys(this._ccByParam).length; }

  /**
   * Best-effort: try reading the device's real mapping, silently keep the
   * documented default on any failure (missing file = older firmware or
   * MIDI Follow never opened on this device; that's a normal, expected
   * case, not an error worth surfacing to the user). Safe to call again on
   * every reconnect -- cheap, and picks up mapping changes made on the
   * device since the last connection.
   */
  async start() {
    this._detachAll();
    try {
      const buffer = await this.deluge.readFile('/SETTINGS/MIDIFollow.XML');
      const xmlText = new TextDecoder().decode(buffer);
      const parsed = parseMidiFollowXml(xmlText);
      if (Object.keys(parsed).length) {
        this._ccByParam = parsed;
        this._ccIndex = buildCcIndex(parsed);
        this._usingDeviceMapping = true;
      }
    } catch {
      // Fall back to DEFAULT_CC_MAP (already in place from the constructor).
      this._ccByParam = DEFAULT_CC_MAP;
      this._ccIndex = buildCcIndex(DEFAULT_CC_MAP);
      this._usingDeviceMapping = false;
    }
    this._attachedInputs = this.deluge.listInputs()
      .filter(i => i.name && i.name.toLowerCase().includes('deluge'));
    for (const input of this._attachedInputs) {
      input.addEventListener('midimessage', this._onRawMidiMessage);
    }
  }

  stop() {
    this._detachAll();
    this._liveValues.clear();
  }

  _detachAll() {
    for (const input of this._attachedInputs) {
      input.removeEventListener('midimessage', this._onRawMidiMessage);
    }
    this._attachedInputs = [];
  }

  _onRawMidiMessage(event) {
    const data = event.data;
    if (!data || data.length < 1) return;
    const status = data[0];
    if (status === 0xf0) return; // SysEx -- deluge-sysex.js's own concern, not logged here
    if (IGNORED_REALTIME_STATUS.has(status)) return; // clock/transport -- see IGNORED_REALTIME_STATUS's own comment
    const kind = status & 0xf0;
    const channel = (status & 0x0f) + 1; // logged 1-based, matching how a MIDI channel is normally talked about
    const portName = event.target && event.target.name;
    let entry;
    if (kind === 0xb0 && data.length >= 3) {
      const cc = data[1], value = data[2];
      const params = this._ccIndex.get(cc) || [];
      const fieldPaths = params.flatMap(p => PARAM_TO_FIELDS[p] || []);
      entry = { cc, value, channel, portName, params, fieldPaths, label: 'CC' };
      if (fieldPaths.length) {
        // Computed per path, not once for the whole CC message -- pulse
        // width needs a different formula than every other mapped field
        // (see ccToRawHex()'s own comment).
        for (const path of fieldPaths) this._liveValues.set(path, ccToRawHex(value, path));
        this._listeners.forEach(fn => fn(fieldPaths));
      }
    } else {
      entry = { channel, portName, label: STATUS_LABELS[kind] || ('status 0x' + kind.toString(16)), raw: Array.from(data) };
    }
    entry.time = Date.now();
    this._log.push(entry);
    if (this._log.length > LOG_CAPACITY) this._log.shift();
    this._logListeners.forEach(fn => fn(entry));
  }

  hasLiveValue(path) { return this._liveValues.has(path); }
  getLiveValue(path) { return this._liveValues.get(path); }

  /** @param {(changedPaths: string[]) => void} fn */
  onUpdate(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  getLog() { return this._log; }
  clearLog() { this._log = []; }
  /** @param {(entry: object) => void} fn -- called once per NEW message (not replayed for the existing log). */
  onRawMessage(fn) { this._logListeners.add(fn); return () => this._logListeners.delete(fn); }
}

/**
 * Resolves a field's TARGET value, falling back to its init value when the
 * XML omits the attribute entirely. Same fix, and same reasoning, as
 * deluge-check.js's resolveFieldValues(): a preset's XML can omit an
 * attribute that happens to match the firmware's own built-in default, and
 * leaving it undefined meant a field could never read "ok" no matter what
 * was dialled in on the device (an empty string never equals any real
 * value). A missing target value means "the preset wants the default",
 * i.e. init.
 */
function resolveTargetRaw(path, targetObj) {
  const raw = window.DelugeCheckModule.getValueAtPath(targetObj, path);
  return raw === undefined ? LIVE_FIELD_INIT[path] : raw;
}

/**
 * Live counterpart of deluge-check.js's fieldStatus(), for exactly one
 * field. Returns null if no CC has arrived for this field yet (caller
 * should show a "waiting for a live value" pending state, not a color).
 *
 * @param {MidiFollowTracker} tracker
 * @param {string} path
 * @param {object} targetObj  DelugeCheckModule.parseDelugeXml() output for
 *        the preset this guide was built from (NOT app.js's own parser --
 *        see the comment on currentCheckTargetObj in app.js)
 * @param {object} settings   deluge-check-settings.js settings instance
 */

// Same "does the DISPLAYED number agree, even if the raw percentage-window
// tolerance alone wouldn't call it a match" reasoning as evaluateSteps()'s
// matchesWithDisplayFallback() in deluge-check.js (see dvValue()'s own
// comment there for the full explanation and the real-hardware proof) --
// every live-mappable field is a plain q31 dial with no custom rawRange
// EXCEPT pulse width, which needs dvHalfPrecisionValue() instead of the
// standard dvValue().
function liveMatches(a, b, toleranceAbs, path) {
  const DC = window.DelugeCheckModule;
  if (DC.valuesMatch(a, b, toleranceAbs)) return true;
  const displayFn = HALF_PRECISION_FIELD_PATHS.has(path) ? DC.dvHalfPrecisionValue : DC.dvValue;
  const da = displayFn(a);
  const db = displayFn(b);
  return da !== null && db !== null && da === db;
}

function liveFieldStatus(tracker, path, targetObj, settings) {
  const liveRaw = tracker.getLiveValue(path);
  if (liveRaw === undefined) return null;
  const initRaw = LIVE_FIELD_INIT[path];
  const targetRaw = resolveTargetRaw(path, targetObj);
  const toleranceAbs = settings.resolveToleranceAbsolute(path, {});
  const ok = liveMatches(targetRaw, liveRaw, toleranceAbs, path);
  const targetIsDefault = liveMatches(targetRaw, initRaw, toleranceAbs, path);
  const actualIsDefault = liveMatches(liveRaw, initRaw, toleranceAbs, path);
  if (targetIsDefault && !actualIsDefault) return 'unexpected';
  if (ok) return 'ok';
  if (!actualIsDefault) return 'changed';
  return 'untouched';
}

/**
 * Where the live value currently sits relative to target: +1 (live is
 * ABOVE target -- too high, shown as an up arrow), -1 (live is BELOW
 * target -- too low, shown as a down arrow), 0 (already matches), or null
 * (no live value yet, or either raw value isn't numeric -- e.g. an enum
 * field, which never reaches here anyway since only continuous fields are
 * ever live-mappable). This deliberately shows CURRENT POSITION, not a
 * "turn it this way" instruction -- a reversed first version of this
 * pointed the arrow in the correction direction instead, which read as
 * backwards/confusing once actually tried on hardware. Deliberately a
 * separate function from liveFieldStatus() rather than folded into its
 * return value: callers that only care about status (liveStepStatus()'s
 * rollup, the tests) stay untouched, and this is only ever consulted where
 * a direction hint is actually rendered (see applyLiveSpanVisuals() in
 * app.js).
 */
function liveFieldDirection(tracker, path, targetObj) {
  const liveRaw = tracker.getLiveValue(path);
  if (liveRaw === undefined) return null;
  const DC = window.DelugeCheckModule;
  const targetRaw = resolveTargetRaw(path, targetObj);
  const liveNum = DC.parseNumericValue(liveRaw);
  const targetNum = DC.parseNumericValue(targetRaw);
  if (Number.isNaN(liveNum) || Number.isNaN(targetNum)) return null;
  if (liveNum === targetNum) return 0;
  return liveNum > targetNum ? 1 : -1;
}

return {
  FIELD_TO_MIDIFOLLOW_PARAM, DEFAULT_CC_MAP,
  isLiveMappable, ccToRawHex, parseMidiFollowXml,
  MidiFollowTracker, liveFieldStatus, liveFieldDirection,
};
})();
