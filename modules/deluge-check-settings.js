/**
 * deluge-check-settings.js
 * ----------------------------------------------------------------------
 * Verwaltet die Toleranz ("OK-Range") für den Patchbook-Check.
 *
 * Zwei Ebenen:
 * - defaultTolerancePercent: gilt für alle Felder, für die es keinen
 *   Override gibt. Als Prozentsatz von RAW_PARAM_RANGE (siehe
 *   deluge-check.js) statt absoluter Roheinheiten, damit ein einzelner
 *   Regler ("Wie streng?") für Normalnutzer reicht.
 * - overrides[fieldKey].tolerancePercent: Feld-spezifischer Override,
 *   nur im Expert-Modus sichtbar/editierbar (z.B. "bei Filter-Frequenz
 *   darf's großzügiger sein als bei Sustain").
 *
 * Persistenz: bewusst ANDERS als der Check-Datei-Pfad. Der Pfad wird nie
 * gespeichert (siehe deluge-check.js), aber Toleranz-Einstellungen sind
 * eine reine UI-Präferenz ohne Bezug zu einer bestimmten SD-Karten-Datei
 * — hier nutzen wir daher localStorage, damit man sie nicht jede Session
 * neu einstellen muss. Falls das nicht gewünscht ist, load/saveSettings
 * einfach durch In-Memory-Varianten ersetzen (siehe Anleitung).
 * ----------------------------------------------------------------------
 */

// Plain classic script, not an ES module -- see the matching comment in
// deluge-sysex.js (file:// + <script type="module"> don't mix).
window.DelugeCheckSettingsModule = (function () {

const STORAGE_KEY = "deluge-check-settings";

const DEFAULT_SETTINGS_DATA = {
  expertMode: false,
  defaultTolerancePercent: 2, // "wie streng" für alle nicht überschriebenen Felder
  overrides: {
    // fieldKey: { tolerancePercent: number }
  },
};

function clonePlain(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Lädt die gespeicherten Settings (oder Defaults, falls noch nichts da ist). */
function loadSettings() {
  let stored = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // Kaputtes/fehlendes localStorage ignorieren, einfach mit Defaults starten.
  }

  const data = {
    ...clonePlain(DEFAULT_SETTINGS_DATA),
    ...(stored || {}),
    overrides: { ...(stored && stored.overrides) },
  };

  return wrapSettings(data);
}

/** Speichert die aktuellen Settings. */
function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.data));
  } catch {
    // z.B. privater Modus ohne Storage-Zugriff — Check funktioniert trotzdem,
    // nur die Einstellung wird nicht über die Session hinaus gemerkt.
  }
}

/**
 * Wrappt die reinen Daten mit den Hilfsfunktionen, die deluge-check.js
 * erwartet (resolveToleranceAbsolute) sowie Settern für die UI.
 */
function wrapSettings(data) {
  return {
    data,

    get expertMode() {
      return data.expertMode;
    },
    setExpertMode(value) {
      data.expertMode = !!value;
    },

    get defaultTolerancePercent() {
      return data.defaultTolerancePercent;
    },
    setDefaultTolerancePercent(value) {
      data.defaultTolerancePercent = Math.max(0, Number(value) || 0);
    },

    getOverridePercent(fieldKey) {
      const o = data.overrides[fieldKey];
      return o ? o.tolerancePercent : null;
    },
    setOverridePercent(fieldKey, percent) {
      if (percent === null || percent === undefined || percent === "") {
        delete data.overrides[fieldKey];
      } else {
        data.overrides[fieldKey] = { tolerancePercent: Math.max(0, Number(percent) || 0) };
      }
    },

    /**
     * Liefert die für ein Feld effektiv geltende Toleranz in absoluten
     * Roheinheiten. Nicht-numerische Felder (Enums) ignorieren die
     * Toleranz ohnehin, da valuesMatch() dort auf String-Vergleich
     * zurückfällt.
     *
     * `field.rawRange` (optional, vom Step-Generator gesetzt) überschreibt
     * den Nenner für Felder, die NICHT als volle Q31-Fixpunktzahl codiert
     * sind (z.B. Unison-Voice-Count, Transpose in Halbtönen, Sync-Level) —
     * für die wäre ein Prozentsatz von 2^31 immer riesig gegenüber dem
     * tatsächlichen Wertebereich und die Toleranz würde jede Abweichung
     * durchwinken. Ohne rawRange gilt weiterhin der volle Q31-Bereich
     * (0x7fffffff), passend für Attack/Decay/Cutoff/Rate/etc.
     */
    resolveToleranceAbsolute(fieldKey, field) {
      const percent = data.overrides[fieldKey]?.tolerancePercent ?? data.defaultTolerancePercent;
      // RAW_PARAM_RANGE hier nicht importiert, um zirkuläre Imports zu
      // vermeiden — Wert bewusst dupliziert (0x7fffffff), siehe Anleitung
      // falls ihr die Skala anpasst, an BEIDEN Stellen ändern oder in ein
      // gemeinsames constants.js auslagern.
      const RAW_PARAM_RANGE = 0x7fffffff;
      const range = (field && Number.isFinite(field.rawRange)) ? field.rawRange : RAW_PARAM_RANGE;
      return (percent / 100) * range;
    },
  };
}

// ---------------------------------------------------------------------
// Minimale, framework-lose Settings-UI
// ---------------------------------------------------------------------

/**
 * Rendert einen einfachen Settings-Bereich in `container` (ein DOM-Element).
 * Ruft onChange() nach jeder Änderung auf (zum erneuten Speichern/Re-Check).
 *
 * `knownFieldKeys` (optional): Liste von { key, label } aus den zuletzt
 * ausgewerteten Steps — wird genutzt, um im Expert-Modus pro Feld ein
 * Override-Eingabefeld anzuzeigen. Ohne diese Liste wird nur der globale
 * Regler angezeigt (Overrides lassen sich dann nur programmatisch setzen).
 *
 * Das ist bewusst schlicht gehalten (kein CSS-Framework, keine Icons) —
 * gedacht als Ausgangspunkt, den ihr an euer bestehendes UI-Styling
 * anpasst, nicht als fertiges Design.
 */
function renderSettingsPanel(container, { settings, knownFieldKeys = [], onChange }) {
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "deluge-check-settings";

  // Expert-Mode Toggle
  const expertLabel = document.createElement("label");
  const expertCheckbox = document.createElement("input");
  expertCheckbox.type = "checkbox";
  expertCheckbox.checked = settings.expertMode;
  expertCheckbox.addEventListener("change", () => {
    settings.setExpertMode(expertCheckbox.checked);
    onChange();
    render(); // Overrides ein-/ausblenden
  });
  expertLabel.appendChild(expertCheckbox);
  expertLabel.appendChild(document.createTextNode(" Expert mode (set tolerance per parameter)"));
  wrapper.appendChild(expertLabel);

  // Globale Toleranz
  const globalRow = document.createElement("div");
  globalRow.className = "deluge-check-settings__row";
  const globalLabel = document.createElement("label");
  globalLabel.textContent = "OK range (default tolerance in %): ";
  const globalInput = document.createElement("input");
  globalInput.type = "number";
  globalInput.min = "0";
  globalInput.max = "100";
  globalInput.step = "0.5";
  globalInput.value = settings.defaultTolerancePercent;
  globalInput.addEventListener("change", () => {
    settings.setDefaultTolerancePercent(globalInput.value);
    onChange();
  });
  globalLabel.appendChild(globalInput);
  globalRow.appendChild(globalLabel);
  wrapper.appendChild(globalRow);

  // Pro-Feld-Overrides (nur im Expert-Modus)
  const overridesContainer = document.createElement("div");
  overridesContainer.className = "deluge-check-settings__overrides";
  wrapper.appendChild(overridesContainer);

  function renderOverrides() {
    overridesContainer.innerHTML = "";
    if (!settings.expertMode) return;
    if (knownFieldKeys.length === 0) {
      const hint = document.createElement("p");
      hint.textContent = "Run a check first to override individual parameters here.";
      overridesContainer.appendChild(hint);
      return;
    }

    const heading = document.createElement("p");
    heading.textContent = "Per-parameter override (leave blank = default tolerance):";
    overridesContainer.appendChild(heading);

    for (const { key, label } of knownFieldKeys) {
      const row = document.createElement("div");
      row.className = "deluge-check-settings__row";

      const fieldLabel = document.createElement("label");
      fieldLabel.textContent = `${label}: `;

      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "0.5";
      input.placeholder = String(settings.defaultTolerancePercent);
      const current = settings.getOverridePercent(key);
      if (current !== null) input.value = current;

      input.addEventListener("change", () => {
        settings.setOverridePercent(key, input.value === "" ? null : input.value);
        onChange();
      });

      fieldLabel.appendChild(input);
      row.appendChild(fieldLabel);
      overridesContainer.appendChild(row);
    }
  }

  function render() {
    renderOverrides();
  }

  render();
  container.appendChild(wrapper);
}

return { DEFAULT_SETTINGS_DATA, loadSettings, saveSettings, renderSettingsPanel };
})();

// ---------------------------------------------------------------------
// Beispiel-Verdrahtung (auskommentiert, zur Orientierung)
// ---------------------------------------------------------------------
//
// import { loadSettings, saveSettings, renderSettingsPanel } from "./deluge-check-settings.js";
//
// const settings = loadSettings();
//
// settingsNavButton.addEventListener("click", () => {
//   renderSettingsPanel(settingsContainer, {
//     settings,
//     knownFieldKeys: lastCheckResult
//       ? lastCheckResult.steps.flatMap((s) => s.fields.map((f) => ({ key: f.key, label: f.label })))
//       : [],
//     onChange: () => saveSettings(settings),
//   });
// });
