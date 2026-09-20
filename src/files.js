/**
 * Gemini Files API: hochladen, auf die Verarbeitung warten, wieder loeschen.
 *
 * Nur fuer den Instagram-Pfad noetig. YouTube-Videos holt sich Gemini selbst
 * ueber die URI, dort wird nichts hochgeladen.
 */

import { holeClient, FehlerGemini } from './gemini.js';

/** Wie lange auf den Zustand ACTIVE gewartet wird. */
export const VERARBEITUNG_TIMEOUT_MS = 5 * 60 * 1000;

/** Abstand zwischen zwei Zustandsabfragen. */
const ABFRAGE_ABSTAND_MS = 2000;

/**
 * Laedt eine lokale Videodatei hoch und wartet, bis Gemini sie verarbeitet hat.
 *
 * Das Warten ist nicht optional: direkt nach dem Upload steht die Datei auf
 * PROCESSING, und eine Analyse in diesem Zustand schlaegt fehl.
 *
 * @param {string} pfad
 * @param {string} mimeTyp
 * @param {string} [anzeigename]
 * @returns {Promise<{name: string, uri: string, mimeTyp: string}>}
 */
export async function ladeHoch(pfad, mimeTyp, anzeigename) {
  const client = holeClient();

  let datei;
  try {
    datei = await client.files.upload({
      file: pfad,
      config: { mimeType: mimeTyp, displayName: anzeigename },
    });
  } catch (fehler) {
    throw new FehlerGemini(
      'Der Upload des Videos zur Gemini Files API ist fehlgeschlagen: ' +
        `${kurz(fehler)}. Bei grossen Dateien oder wackeliger Verbindung lohnt ein zweiter Versuch.`,
      'upload_fehlgeschlagen',
      fehler,
    );
  }

  if (!datei?.name) {
    throw new FehlerGemini(
      'Die Files API hat den Upload bestaetigt, aber keinen Dateinamen zurueckgegeben.',
      'upload_unvollstaendig',
    );
  }

  const fertig = await warteAufAktiv(client, datei);

  if (!fertig.uri) {
    // Die Datei existiert bei Google, ist aber unbrauchbar -- weg damit.
    await loescheDatei(fertig.name);
    throw new FehlerGemini(
      'Die hochgeladene Datei hat keine URI erhalten und laesst sich nicht analysieren.',
      'upload_unvollstaendig',
    );
  }

  return { name: fertig.name, uri: fertig.uri, mimeTyp: fertig.mimeType || mimeTyp };
}

/** Fragt den Zustand ab, bis die Datei ACTIVE ist. */
async function warteAufAktiv(client, datei) {
  const bis = Date.now() + verarbeitungTimeout();
  let aktuell = datei;

  while (aktuell?.state === 'PROCESSING' || aktuell?.state === 'STATE_UNSPECIFIED') {
    if (Date.now() > bis) {
      await loescheDatei(aktuell.name);
      throw new FehlerGemini(
        `Gemini hat das Video nicht innerhalb von ${Math.round(verarbeitungTimeout() / 1000)} ` +
          'Sekunden verarbeitet. Bei langen Videos kann das vorkommen -- erneut versuchen oder ' +
          'ein kuerzeres Video waehlen.',
        'verarbeitung_timeout',
      );
    }

    await schlafe(ABFRAGE_ABSTAND_MS);

    try {
      aktuell = await client.files.get({ name: aktuell.name });
    } catch (fehler) {
      throw new FehlerGemini(
        `Der Verarbeitungszustand des Videos liess sich nicht abfragen: ${kurz(fehler)}`,
        'zustand_unbekannt',
        fehler,
      );
    }
  }

  if (aktuell?.state === 'FAILED') {
    const grund = aktuell?.error?.message ? ` Meldung: ${aktuell.error.message}` : '';
    await loescheDatei(aktuell.name);
    throw new FehlerGemini(
      `Gemini konnte das hochgeladene Video nicht verarbeiten.${grund} Moeglicherweise ist die ` +
        'Datei beschaedigt oder das Format wird nicht unterstuetzt.',
      'verarbeitung_fehlgeschlagen',
    );
  }

  return aktuell;
}

/**
 * Loescht eine hochgeladene Datei bei Google. Wirft nie.
 *
 * Aufraeumen darf den eigentlichen Fehler nicht ueberdecken, und eine
 * vergessene Datei verfaellt ohnehin nach 48 Stunden.
 *
 * @returns {Promise<boolean>} true, wenn geloescht wurde.
 */
export async function loescheDatei(name) {
  if (!name) return false;
  try {
    await holeClient().files.delete({ name });
    return true;
  } catch {
    return false;
  }
}

/** Nur fuer Tests: prueft, ob eine Datei bei Google noch existiert. */
export async function existiertDatei(name) {
  try {
    const d = await holeClient().files.get({ name });
    return Boolean(d?.name);
  } catch {
    return false;
  }
}

function verarbeitungTimeout() {
  const wert = Number(process.env.UPLOAD_TIMEOUT_MS?.trim());
  return Number.isFinite(wert) && wert > 0 ? wert : VERARBEITUNG_TIMEOUT_MS;
}

function schlafe(ms) {
  return new Promise((a) => setTimeout(a, ms));
}

function kurz(fehler) {
  const text = String(fehler?.message ?? fehler ?? 'unbekannter Fehler').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
