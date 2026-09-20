/**
 * Zeitangaben-Parsing fuer Video-Ausschnitte.
 *
 * Akzeptiert vom Nutzer bewusst mehrere Schreibweisen. Die Gemini-API selbst
 * erwartet in `processing.start_offset` / `end_offset` ausschliesslich einen
 * String in Sekunden mit `s`-Suffix (z. B. "750s") -- rohe Millisekunden-Zahlen
 * quittiert sie mit 400 "Invalid input at 'input[0].processing'".
 * Deshalb wird hier alles auf Sekunden normalisiert.
 */

/** Maximal plausible Videolaenge in Sekunden (24 h) -- Schutz vor Tippfehlern. */
const MAX_SEKUNDEN = 24 * 60 * 60;

/**
 * Wandelt eine Zeitangabe in Sekunden um.
 *
 * Unterstuetzte Formate:
 *   - Zahl oder reiner Ziffern-String -> Millisekunden ("750000" = 12:30)
 *   - "mm:ss" oder "hh:mm:ss"         -> Zeitcode   ("12:30", "1:02:30")
 *   - "90s" / "1.5s"                  -> Sekunden
 *   - "12.5"  (Dezimalzahl als String)-> Sekunden
 *
 * @param {number|string|null|undefined} wert
 * @param {string} feldname Fuer die Fehlermeldung.
 * @returns {number|null} Sekunden, oder null wenn nichts angegeben war.
 */
export function parseZeit(wert, feldname) {
  if (wert === null || wert === undefined || wert === '') return null;

  let sekunden;

  if (typeof wert === 'number') {
    if (!Number.isFinite(wert)) throw new FehlerZeit(feldname, wert);
    sekunden = wert / 1000;
  } else if (typeof wert === 'string') {
    const text = wert.trim();
    if (/^\d+$/.test(text)) {
      sekunden = Number(text) / 1000;
    } else if (/^\d+(\.\d+)?\s*s$/i.test(text)) {
      sekunden = Number(text.replace(/\s*s$/i, ''));
    } else if (/^\d+(\.\d+)?$/.test(text)) {
      sekunden = Number(text);
    } else if (/^\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d+)?$/.test(text)) {
      const teile = text.split(':').map(Number);
      sekunden = teile.reduce((acc, t) => acc * 60 + t, 0);
    } else {
      throw new FehlerZeit(feldname, wert);
    }
  } else {
    throw new FehlerZeit(feldname, wert);
  }

  if (!Number.isFinite(sekunden) || sekunden < 0 || sekunden > MAX_SEKUNDEN) {
    throw new FehlerZeit(feldname, wert);
  }
  return Math.round(sekunden * 1000) / 1000;
}

/** Formatiert Sekunden fuer die Gemini-API: 750 -> "750s". */
export function alsOffset(sekunden) {
  return `${sekunden}s`;
}

/** Formatiert Sekunden menschenlesbar: 750 -> "12:30". */
export function alsZeitcode(sekunden) {
  const gesamt = Math.floor(sekunden);
  const h = Math.floor(gesamt / 3600);
  const m = Math.floor((gesamt % 3600) / 60);
  const s = gesamt % 60;
  const zz = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${zz(m)}:${zz(s)}` : `${m}:${zz(s)}`;
}

class FehlerZeit extends Error {
  constructor(feldname, wert) {
    super(
      `Ungueltige Zeitangabe fuer "${feldname}": ${JSON.stringify(wert)}. ` +
        'Erlaubt sind "12:30", "1:02:30", "750s" oder Millisekunden als Zahl (750000).',
    );
    this.name = 'FehlerZeit';
    this.istNutzerfehler = true;
  }
}
