/**
 * Eigene Videodateien per lokalem Pfad: pruefen, einmal hochladen, bei
 * Folgefragen wiederverwenden, gezielt loeschen.
 *
 * Anders als beim Instagram-Pfad bleibt die hochgeladene Datei nach der Frage
 * bei Google liegen. Ein 1,7-GB-Video fuer jede Kapitelfrage neu hochzuladen
 * waere untragbar. Die Files API haelt Dateien 48 Stunden, danach verfallen
 * sie von selbst.
 *
 * Wiederverwendung ohne lokale Zustandsdatei: der Anzeigename bei Google
 * enthaelt einen Hash aus Pfad, Groesse und Aenderungszeit. Damit findet auch
 * ein neu gestarteter Server die Datei wieder, und der Pfad selbst (mit
 * Benutzername) verlaesst den Rechner nicht.
 */

import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, resolve } from 'node:path';

import { holeClient, FehlerGemini } from './gemini.js';
import { ladeHoch, loescheDatei, warteAufAktiv } from './files.js';

/**
 * Von Gemini unterstuetzte Videoformate laut
 * https://ai.google.dev/gemini-api/docs/video-understanding (Stand 2026-09).
 * MKV steht dort nicht, deshalb fehlt es hier bewusst.
 */
export const LOKAL_MIME = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpg',
  mov: 'video/mov',
  avi: 'video/avi',
  flv: 'video/x-flv',
  webm: 'video/webm',
  wmv: 'video/wmv',
  '3gp': 'video/3gpp',
};

/**
 * Obergrenze pro Datei. Die Files-API-Doku nennt 2 GB pro Datei, die
 * Video-Doku 2 GB im kostenlosen und 20 GB im bezahlten Tarif. Default ist
 * deshalb die kleinere Zahl, in Dezimal-GB gerechnet, damit nichts knapp
 * darueber erst beim Upload scheitert. LOKAL_MAX_MB hebt sie bei Bedarf an.
 */
export const LOKAL_MAX_BYTES = 2_000_000_000;

/** Wartezeit auf ACTIVE. Ein langes Video braucht bei Google deutlich laenger als ein Reel. */
export const LOKAL_VERARBEITUNG_TIMEOUT_MS = 30 * 60 * 1000;

/** Eine Datei, die bald verfaellt, wird nicht mehr fuer eine Analyse benutzt. */
const MIN_RESTLAUFZEIT_MS = 60 * 60 * 1000;

const PRAEFIX = 'lokal-';

/** Laufende Uploads je Anzeigename. Ein zweiter Aufruf haengt sich an, statt neu hochzuladen. */
const laufend = new Map();

/**
 * Sieht die Eingabe wie ein lokaler Pfad aus? Laufwerksbuchstabe
 * ("C:\..." oder "C:/..."), UNC ("\\server\...") oder absoluter Pfad.
 * URLs wie "https://..." fallen nie darunter.
 */
export function istLokalerPfad(eingabe) {
  const pfad = ohneAnfuehrungszeichen(eingabe);
  return /^[A-Za-z]:[\\/]/.test(pfad) || isAbsolute(pfad);
}

/**
 * Prueft eine lokale Videodatei: existiert, ist eine Datei, bekannte Endung,
 * nicht leer, unter dem Groessenlimit.
 *
 * @param {string} eingabe
 * @returns {{url: string, id: string, datei: {pfad: string, groesse: number, mtimeMs: number, mimeTyp: string}}}
 */
export function pruefeLokaleDatei(eingabe) {
  const pfad = resolve(ohneAnfuehrungszeichen(eingabe));

  let info;
  try {
    info = statSync(pfad);
  } catch (fehler) {
    throw new FehlerDatei(
      fehler?.code === 'ENOENT'
        ? `Die Datei "${pfad}" existiert nicht. Bitte den vollstaendigen Pfad pruefen.`
        : `Auf "${pfad}" laesst sich nicht zugreifen (${fehler?.code ?? 'unbekannter Fehler'}).`,
    );
  }
  if (!info.isFile()) {
    throw new FehlerDatei(`"${pfad}" ist keine Datei, sondern ein Ordner oder etwas anderes.`);
  }

  const endung = extname(pfad).slice(1).toLowerCase();
  const mimeTyp = LOKAL_MIME[endung];
  if (!mimeTyp) {
    throw new FehlerDatei(
      `Die Endung "${endung ? `.${endung}` : '(keine)'}" ist kein von Gemini unterstuetztes ` +
        `Videoformat. Erlaubt sind: ${Object.keys(LOKAL_MIME).map((e) => `.${e}`).join(', ')}.`,
    );
  }

  if (info.size === 0) throw new FehlerDatei(`"${pfad}" ist leer.`);

  const max = maxBytes();
  if (info.size > max) {
    throw new FehlerDatei(
      `Die Datei ist ${gb(info.size)} gross, die Gemini Files API nimmt hoechstens ${gb(max)} pro ` +
        'Datei an. Das Video vorher verkleinern (niedrigere Aufloesung oder Bitrate) oder in ' +
        'Teile schneiden.',
    );
  }

  const datei = { pfad, groesse: info.size, mtimeMs: info.mtimeMs, mimeTyp };
  return { url: pfad, id: anzeigename(datei), datei };
}

/**
 * Sorgt dafuer, dass die Datei ACTIVE bei Google liegt, und laedt nur hoch,
 * wenn keine passende, noch lange genug gueltige Kopie existiert.
 *
 * Wird der MCP-Aufruf abgebrochen, laeuft der Upload im Serverprozess weiter
 * und der naechste Aufruf haengt sich daran an. Stirbt der Prozess mitten im
 * Upload, wird der resumable Upload nie abgeschlossen, und bei Google entsteht
 * keine Datei.
 *
 * @param {{pfad: string, groesse: number, mtimeMs: number, mimeTyp: string}} datei
 * @param {(text: string) => void} [melde]
 * @returns {Promise<{name: string, uri: string, mimeTyp: string, ablauf: string|null, wiederverwendet: boolean}>}
 */
export function stelleBereit(datei, melde = () => {}) {
  const name = anzeigename(datei);
  const aktiv = laufend.get(name);
  if (aktiv) {
    melde('Upload dieser Datei laeuft bereits, warte darauf.');
    return aktiv;
  }

  const auftrag = (async () => {
    const vorhanden = await findeHochgeladene(datei.pfad);
    const passend = vorhanden
      .filter((f) => f.displayName === name && f.sizeBytes === String(datei.groesse) && brauchbar(f))
      .sort((a, b) => Date.parse(b.expirationTime ?? 0) - Date.parse(a.expirationTime ?? 0))[0];

    // Veraltete Versionen derselben Datei belegen nur Speicher im Projekt.
    for (const f of vorhanden) if (f !== passend) await loescheDatei(f.name);

    if (passend?.state === 'ACTIVE' && passend.uri) {
      melde('Bereits hochgeladene Datei gefunden, kein neuer Upload noetig.');
      return ergebnis(passend, datei, true);
    }

    if (passend) {
      melde('Datei liegt schon bei Google und wird noch verarbeitet, warte darauf.');
      const fertig = await warteAufAktiv(holeClient(), passend, verarbeitungTimeout());
      if (!fertig.uri) {
        await loescheDatei(fertig.name);
        throw new FehlerGemini('Die hochgeladene Datei hat keine URI erhalten.', 'upload_unvollstaendig');
      }
      return ergebnis(fertig, datei, true);
    }

    melde(`Lade ${gb(datei.groesse)} zur Gemini Files API hoch.`);
    const neu = await ladeHoch(datei.pfad, datei.mimeTyp, name, verarbeitungTimeout());
    const details = await holeClient().files.get({ name: neu.name }).catch(() => null);
    return ergebnis({ ...details, ...neu, mimeType: neu.mimeTyp }, datei, false);
  })().finally(() => laufend.delete(name));

  laufend.set(name, auftrag);
  return auftrag;
}

/**
 * Loescht alle hochgeladenen Kopien einer lokalen Datei, egal welche Version.
 * Die lokale Datei muss dafuer nicht mehr existieren.
 *
 * @returns {Promise<{geloescht: number, fehlgeschlagen: number, laeuftNoch: boolean}>}
 */
export async function loescheLokal(eingabe) {
  const pfad = resolve(ohneAnfuehrungszeichen(eingabe));
  const vorhanden = await findeHochgeladene(pfad);
  let geloescht = 0;
  for (const f of vorhanden) if (await loescheDatei(f.name)) geloescht += 1;
  const laeuftNoch = [...laufend.keys()].some((n) => n.startsWith(pfadPraefix(pfad)));
  return { geloescht, fehlgeschlagen: vorhanden.length - geloescht, laeuftNoch };
}

/**
 * Zustand der hochgeladenen Kopien einer lokalen Datei.
 *
 * @returns {Promise<{pfad: string, laeuftNoch: boolean, kopien: Array<{name: string, zustand: string, ablauf: string|null, aktuell: boolean}>}>}
 */
export async function zustandLokal(eingabe) {
  const pfad = resolve(ohneAnfuehrungszeichen(eingabe));
  let aktuellerName = null;
  try {
    aktuellerName = pruefeLokaleDatei(pfad).id;
  } catch {
    // Lokale Datei fehlt oder ist ungueltig: Kopien bei Google trotzdem anzeigen.
  }
  const kopien = (await findeHochgeladene(pfad)).map((f) => ({
    name: f.name,
    zustand: f.state ?? 'unbekannt',
    ablauf: f.expirationTime ?? null,
    aktuell: f.displayName === aktuellerName,
  }));
  const laeuftNoch = [...laufend.keys()].some((n) => n.startsWith(pfadPraefix(pfad)));
  return { pfad, laeuftNoch, kopien };
}

/** Alle Dateien im Projekt, die zu diesem Pfad gehoeren. */
async function findeHochgeladene(pfad) {
  const praefix = pfadPraefix(pfad);
  const treffer = [];
  try {
    const seiten = await holeClient().files.list({ config: { pageSize: 100 } });
    for await (const f of seiten) if (f?.displayName?.startsWith(praefix)) treffer.push(f);
  } catch (fehler) {
    if (fehler instanceof FehlerGemini) throw fehler;
    throw new FehlerGemini(
      `Die Liste der hochgeladenen Dateien liess sich nicht abrufen: ${String(fehler?.message ?? fehler).split('\n')[0]}`,
      'liste_fehlgeschlagen',
      fehler,
    );
  }
  return treffer;
}

function brauchbar(f) {
  if (f.state === 'FAILED') return false;
  const ablauf = Date.parse(f.expirationTime ?? '');
  return Number.isFinite(ablauf) && ablauf - Date.now() > MIN_RESTLAUFZEIT_MS;
}

function ergebnis(f, datei, wiederverwendet) {
  return {
    name: f.name,
    uri: f.uri,
    mimeTyp: f.mimeType || datei.mimeTyp,
    ablauf: f.expirationTime ?? null,
    wiederverwendet,
  };
}

/** "lokal-<Pfad-Hash>-<Versions-Hash>". Windows-Pfade sind unabhaengig von Gross/Klein. */
function anzeigename(datei) {
  const version = hash(`${datei.groesse}:${Math.trunc(datei.mtimeMs)}`).slice(0, 12);
  return `${pfadPraefix(datei.pfad)}${version}`;
}

function pfadPraefix(pfad) {
  const norm = process.platform === 'win32' ? pfad.toLowerCase() : pfad;
  return `${PRAEFIX}${hash(norm).slice(0, 16)}-`;
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** "Als Pfad kopieren" im Explorer setzt Anfuehrungszeichen, die gehoeren nicht zum Pfad. */
function ohneAnfuehrungszeichen(eingabe) {
  return String(eingabe ?? '').trim().replace(/^"(.*)"$/, '$1');
}

function maxBytes() {
  const mb = Number(process.env.LOKAL_MAX_MB?.trim());
  return Number.isFinite(mb) && mb > 0 ? mb * 1_000_000 : LOKAL_MAX_BYTES;
}

function verarbeitungTimeout() {
  const wert = Number(process.env.LOKAL_UPLOAD_TIMEOUT_MS?.trim());
  return Number.isFinite(wert) && wert > 0 ? wert : LOKAL_VERARBEITUNG_TIMEOUT_MS;
}

function gb(bytes) {
  const [wert, einheit] = bytes < 1e9 ? [bytes / 1e6, 'MB'] : [bytes / 1e9, 'GB'];
  return `${wert.toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${einheit}`;
}

export class FehlerDatei extends Error {
  constructor(nachricht) {
    super(nachricht);
    this.name = 'FehlerDatei';
    this.istNutzerfehler = true;
  }
}
