/**
 * Download von Instagram-Videos ueber yt-dlp.
 *
 * Gemini kann sich Instagram-Videos nicht selbst holen -- anders als YouTube,
 * wo die URI direkt uebergeben wird. Deshalb der Umweg ueber eine lokale
 * Datei.
 *
 * Bewusst ohne jedes Cookie-, Session- oder Login-Handling: nur oeffentlich
 * abrufbare Beitraege. Private Accounts und Stories sind kein Fehler, sondern
 * ausserhalb des Funktionsumfangs.
 *
 * Wichtig fuer das Verstaendnis des Ablaufs: yt-dlp liefert fuer Instagram
 * regelmaessig "NA" statt Dauer, Aufloesung und Dateigroesse. Deshalb wird
 * hier nichts anhand der Metadaten entschieden -- massgeblich ist allein, was
 * nach dem Download tatsaechlich auf der Platte liegt.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Obergrenze fuer die heruntergeladene Datei. Ein Reel liegt bei 5-30 MB. */
export const MAX_MB = 250;

/** Zeitrahmen fuer den Download. Instagram liefert sonst haengende Prozesse. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Endungen, die eindeutig kein Video sind -- so sehen Bild-Beitraege aus. */
const BILD_ENDUNGEN = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'avif']);

const VIDEO_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/mov',
  mkv: 'video/x-matroska',
  m4v: 'video/mp4',
};

/** Liefert den yt-dlp-Aufruf: YTDLP_PATH, sonst der Name aus dem PATH. */
export function ytdlpPfad() {
  return process.env.YTDLP_PATH?.trim() || 'yt-dlp';
}

/**
 * Laedt das Video eines Instagram-Beitrags in ein temporaeres Verzeichnis.
 *
 * @param {string} url
 * @param {object} [opt]
 * @param {number} [opt.maxMb]
 * @returns {Promise<{pfad: string, verzeichnis: string, groesseMb: number, mimeTyp: string}>}
 */
export async function ladeInstagramVideo(url, opt = {}) {
  const maxMb = opt.maxMb ?? maxMbAusUmgebung();
  const verzeichnis = await mkdtemp(join(tmpdir(), 'gemini-video-'));

  try {
    const pfad = await fuehreDownloadAus(url, verzeichnis, maxMb);
    const endung = pfad.split('.').pop()?.toLowerCase() ?? '';

    if (BILD_ENDUNGEN.has(endung)) {
      throw new FehlerDownload(
        `Der Beitrag unter ${url} enthaelt kein Video, sondern nur Bildmaterial ` +
          `(heruntergeladen wurde eine ${endung.toUpperCase()}-Datei). Dieser Server analysiert ` +
          'ausschliesslich Videos -- Reels und Video-Beitraege.',
        'kein_video',
      );
    }

    const { size } = await stat(pfad);
    if (size === 0) {
      throw new FehlerDownload(
        `yt-dlp hat zu ${url} eine leere Datei geliefert. Der Beitrag ist moeglicherweise nicht ` +
          'oeffentlich abrufbar.',
        'leer',
      );
    }

    const groesseMb = size / (1024 * 1024);
    if (groesseMb > maxMb) {
      throw new FehlerDownload(
        `Das heruntergeladene Video ist ${groesseMb.toFixed(1)} MB gross und ueberschreitet die ` +
          `Grenze von ${maxMb} MB. Sie laesst sich ueber MAX_VIDEO_MB anheben.`,
        'zu_gross',
      );
    }

    return { pfad, verzeichnis, groesseMb, mimeTyp: VIDEO_MIME[endung] ?? 'video/mp4' };
  } catch (fehler) {
    await entferneVerzeichnis(verzeichnis);
    throw fehler;
  }
}

/** Raeumt das temporaere Verzeichnis samt Inhalt weg. Wirft nie. */
export async function entferneVerzeichnis(verzeichnis) {
  if (!verzeichnis) return;
  try {
    await rm(verzeichnis, { recursive: true, force: true });
  } catch {
    // Aufraeumen darf den eigentlichen Fehler nie ueberdecken.
  }
}

/**
 * Fuehrt den Download aus.
 *
 * `-f best[ext=mp4]/best` waehlt bewusst ein bereits fertiges Format statt
 * getrennter Video- und Audiospuren: damit wird ffmpeg zum Zusammenfuegen
 * nicht gebraucht, was bei Reels ohnehin dem einzigen angebotenen Format
 * entspricht. Fehlt ffmpeg doch einmal, wird das sauber gemeldet.
 *
 * `--max-filesize` bricht bereits den Download ab, statt erst hinterher eine
 * zu grosse Datei zu verwerfen. `--no-playlist` haelt den Aufruf strikt beim
 * einzelnen Beitrag -- die Profil-Auflistung von yt-dlp gilt fuer Instagram
 * als defekt und wird hier nirgends gebraucht.
 */
async function fuehreDownloadAus(url, verzeichnis, maxMb) {
  const ziel = join(verzeichnis, 'video.%(ext)s');
  const { code, stderr } = await rufeYtdlp(
    [
      '-f', 'best[ext=mp4]/best',
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--retries', '3',
      '--max-filesize', `${Math.round(maxMb)}M`,
      '-o', ziel,
      url,
    ],
    downloadTimeoutAusUmgebung(),
  );

  if (code !== 0) throw uebersetzeYtdlpFehler(stderr, url);

  const dateien = await readdir(verzeichnis);
  const video = dateien.find((d) => d.startsWith('video.'));

  if (!video) {
    // Greift auch, wenn --max-filesize den Download verhindert hat.
    if (String(stderr).toLowerCase().includes('larger than')) {
      throw new FehlerDownload(
        `Das Video unter ${url} ueberschreitet die Grenze von ${maxMb} MB und wurde nicht geladen. ` +
          'Sie laesst sich ueber MAX_VIDEO_MB anheben.',
        'zu_gross',
      );
    }
    throw new FehlerDownload(
      `yt-dlp meldete Erfolg, hat zu ${url} aber keine Datei abgelegt. Moeglicherweise enthaelt ` +
        'der Beitrag kein Video.',
      'kein_video',
    );
  }

  return join(verzeichnis, video);
}

/**
 * Startet yt-dlp und sammelt die Ausgabe ein.
 *
 * Unter Windows wird yt-dlp haeufig als .cmd-Shim installiert (scoop, npm).
 * Node startet eine Batchdatei seit Version 20 nicht mehr direkt, sondern
 * quittiert sie mit EINVAL. Der Umweg ueber cmd.exe loest das, und zwar
 * bewusst ohne `shell: true`: so escaped Node die Argumente weiterhin selbst,
 * statt die URL ungeprueft in eine Kommandozeile zu setzen.
 */
function rufeYtdlp(argumente, timeoutMs) {
  return new Promise((aufloesen, ablehnen) => {
    const befehl = ytdlpPfad();
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(befehl);

    let prozess;
    try {
      prozess = batch
        ? spawn('cmd.exe', ['/c', befehl, ...argumente], { windowsHide: true })
        : spawn(befehl, argumente, { windowsHide: true });
    } catch (fehler) {
      ablehnen(startFehler(fehler, befehl));
      return;
    }

    let stdout = '';
    let stderr = '';
    let abgebrochen = false;

    const uhr = setTimeout(() => {
      abgebrochen = true;
      prozess.kill('SIGKILL');
    }, timeoutMs);

    prozess.stdout.on('data', (d) => { stdout += d; });
    prozess.stderr.on('data', (d) => { stderr += d; });

    prozess.on('error', (fehler) => {
      clearTimeout(uhr);
      ablehnen(startFehler(fehler, befehl));
    });

    prozess.on('close', (code) => {
      clearTimeout(uhr);
      if (abgebrochen) {
        ablehnen(
          new FehlerDownload(
            `Der Download ueber yt-dlp hat laenger als ${Math.round(timeoutMs / 1000)} Sekunden ` +
              'gebraucht und wurde abgebrochen. Vermutlich drosselt oder blockt Instagram den ' +
              'Abruf gerade. Spaeter erneut versuchen oder mit "yt-dlp -U" aktualisieren.',
            'timeout',
          ),
        );
        return;
      }
      aufloesen({ code, stdout, stderr });
    });
  });
}

/** yt-dlp liess sich gar nicht erst starten. */
function startFehler(fehler, befehl) {
  if (fehler?.code === 'ENOENT') {
    return new FehlerDownload(
      `yt-dlp wurde nicht gefunden (gesucht als "${befehl}"). Instagram-Videos muessen ` +
        'heruntergeladen werden, dafuer wird yt-dlp gebraucht. Installation: "pipx install yt-dlp", ' +
        '"brew install yt-dlp", "winget install yt-dlp" oder von github.com/yt-dlp/yt-dlp. ' +
        'Liegt es ausserhalb des PATH, den vollstaendigen Pfad in YTDLP_PATH eintragen. ' +
        'Der YouTube-Pfad funktioniert ohne yt-dlp.',
      'ytdlp_fehlt',
    );
  }
  return new FehlerDownload(
    `yt-dlp liess sich nicht starten: ${String(fehler?.message ?? fehler)}`,
    'ytdlp_start',
  );
}

/** Uebersetzt die stderr-Ausgabe von yt-dlp in Klartext. */
export function uebersetzeYtdlpFehler(stderr, url) {
  const roh = String(stderr ?? '').trim();
  const klein = roh.toLowerCase();

  if (
    klein.includes('login required') ||
    klein.includes('log in') ||
    klein.includes('private') ||
    klein.includes('requested content is not available') ||
    klein.includes('restricted video')
  ) {
    return new FehlerDownload(
      `Der Beitrag unter ${url} ist nicht oeffentlich abrufbar. Private Accounts, Stories und alles, ` +
        'was einen Login braucht, werden bewusst nicht unterstuetzt -- der Server haelt keinerlei ' +
        'Zugangsdaten vor.',
      'nicht_oeffentlich',
    );
  }

  if (
    klein.includes('not found') ||
    klein.includes('404') ||
    klein.includes('unavailable') ||
    klein.includes('removed') ||
    klein.includes('does not exist')
  ) {
    return new FehlerDownload(
      `Der Beitrag unter ${url} existiert nicht oder wurde geloescht.`,
      'nicht_gefunden',
    );
  }

  if (
    klein.includes('no video') ||
    klein.includes('there is no video') ||
    klein.includes('unsupported url')
  ) {
    return new FehlerDownload(
      `Unter ${url} findet yt-dlp kein Video. Reine Bild-Beitraege und Bild-Karussells lassen sich ` +
        'nicht analysieren.',
      'kein_video',
    );
  }

  if (klein.includes('larger than') || klein.includes('max-filesize')) {
    return new FehlerDownload(
      `Das Video unter ${url} ueberschreitet die eingestellte Groessengrenze und wurde nicht ` +
        'geladen. Sie laesst sich ueber MAX_VIDEO_MB anheben.',
      'zu_gross',
    );
  }

  if (klein.includes('ffmpeg') || klein.includes('ffprobe')) {
    return new FehlerDownload(
      'Fuer diesen Beitrag muesste yt-dlp getrennte Video- und Audiospuren zusammenfuegen, dafuer ' +
        'fehlt ffmpeg. Bei Reels ist das normalerweise nicht noetig. Entweder ffmpeg installieren ' +
        'oder einen anderen Beitrag waehlen.',
      'ffmpeg_fehlt',
    );
  }

  if (
    klein.includes('rate') ||
    klein.includes('429') ||
    klein.includes('too many requests') ||
    klein.includes('temporarily blocked')
  ) {
    return new FehlerDownload(
      `Instagram drosselt die Abrufe gerade und hat den Download von ${url} abgelehnt. ` +
        'Spaeter erneut versuchen.',
      'gedrosselt',
    );
  }

  return new FehlerDownload(
    `yt-dlp konnte ${url} nicht herunterladen. Das liegt haeufig an Instagram selbst: die Seite ` +
      'aendert ihre Abrufwege regelmaessig und arbeitet aktiv gegen Downloader, weshalb der ' +
      'Instagram-Support von yt-dlp zeitweise brechen kann. Ein Update mit "yt-dlp -U" behebt das ' +
      'oft. Meldung von yt-dlp: ' +
      (roh ? kuerze(roh) : '(keine Ausgabe)'),
    'download_fehlgeschlagen',
  );
}

function kuerze(text) {
  const zeilen = text.split('\n').filter((z) => z.trim()).slice(-3).join(' | ');
  return zeilen.length > 400 ? `${zeilen.slice(0, 400)}...` : zeilen;
}

function maxMbAusUmgebung() {
  const wert = Number(process.env.MAX_VIDEO_MB?.trim());
  return Number.isFinite(wert) && wert > 0 ? wert : MAX_MB;
}

function downloadTimeoutAusUmgebung() {
  const wert = Number(process.env.YTDLP_TIMEOUT_MS?.trim());
  return Number.isFinite(wert) && wert > 0 ? wert : DOWNLOAD_TIMEOUT_MS;
}

export class FehlerDownload extends Error {
  constructor(nachricht, code) {
    super(nachricht);
    this.name = 'FehlerDownload';
    this.code = code;
    this.istNutzerfehler = true;
  }
}
