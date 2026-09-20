/**
 * Plattformerkennung. Entscheidet, ob eine URL ueber den nativen YouTube-Pfad
 * laeuft (Gemini holt sich das Video selbst) oder ueber den Instagram-Pfad
 * (herunterladen, hochladen, analysieren).
 *
 * Alles andere wird abgelehnt. TikTok ist bewusst nicht dabei, obwohl yt-dlp
 * es koennte.
 */

import { pruefeYoutubeUrl, FehlerUrl } from './youtube.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtu.be', 'www.youtu.be',
]);

const INSTAGRAM_HOSTS = new Set([
  'instagram.com', 'www.instagram.com', 'm.instagram.com', 'ddinstagram.com',
]);

/**
 * Beitragsarten, die ein Video enthalten koennen.
 *
 * Bewusst bis zum Ende verankert: der Pfad wandert als Argument an yt-dlp,
 * deshalb darf hier nichts durchrutschen, was ueber Beitragsart und Kennung
 * hinausgeht.
 */
const INSTAGRAM_PFADE =
  /^\/(?:([A-Za-z0-9._]{1,60})\/)?(reel|reels|p|tv|share)\/([A-Za-z0-9_-]{1,64})$/;

/**
 * Bestimmt Plattform und normalisierte URL.
 *
 * @param {string} eingabe
 * @returns {{plattform: 'youtube'|'instagram', url: string, id: string}}
 */
export function erkenneQuelle(eingabe) {
  if (typeof eingabe !== 'string' || eingabe.trim() === '') {
    throw new FehlerUrl('Es wurde keine URL uebergeben.');
  }
  const roh = eingabe.trim();

  let u;
  try {
    u = new URL(roh);
  } catch {
    throw new FehlerUrl(`"${roh}" ist keine gueltige URL.`);
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new FehlerUrl(`Nicht unterstuetztes Protokoll "${u.protocol}". Erwartet wird http(s).`);
  }

  const host = u.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    // Unveraenderter Bestandspfad.
    return { plattform: 'youtube', ...pruefeYoutubeUrl(roh) };
  }

  if (INSTAGRAM_HOSTS.has(host)) {
    return { plattform: 'instagram', ...pruefeInstagramUrl(u, roh) };
  }

  throw new FehlerUrl(
    `"${u.hostname}" wird nicht unterstuetzt. Dieser Server analysiert oeffentliche Videos von ` +
      'YouTube und Instagram (Reels und Video-Beitraege). Andere Plattformen, auch TikTok, ' +
      'sind bewusst nicht vorgesehen.',
  );
}

/**
 * Prueft eine Instagram-URL und gibt sie aufgeraeumt zurueck.
 *
 * Query-Parameter fliegen raus: Instagram haengt Tracking-Parameter an, die
 * yt-dlp nicht braucht. Der `share`-Pfad wird durchgereicht, damit yt-dlp die
 * Weiterleitung selbst aufloesen kann.
 */
export function pruefeInstagramUrl(u, roh) {
  const pfad = u.pathname.replace(/\/+$/, '');
  const treffer = pfad.match(INSTAGRAM_PFADE);

  if (!treffer) {
    throw new FehlerUrl(
      `Aus "${roh}" laesst sich kein Instagram-Beitrag lesen. Unterstuetzt werden Reels und ` +
        'Video-Beitraege, also Links der Form /reel/..., /reels/..., /p/... oder /tv/.... ' +
        'Profilseiten, Stories und Suchergebnisse sind nicht analysierbar.',
    );
  }

  const [, benutzer, art, id] = treffer;

  // Die URL wird aus den geprueften Bestandteilen neu zusammengesetzt, statt
  // den Pfad der Eingabe zu uebernehmen. Tracking-Parameter fallen damit weg.
  //
  // Ausnahme "share": diese Kennungen sind Weiterleitungen und nicht mit der
  // Beitragskennung identisch, deshalb bleibt die Form hier erhalten und
  // yt-dlp loest sie selbst auf.
  const url =
    art === 'share'
      ? `https://www.instagram.com/${benutzer ? `${benutzer}/` : ''}share/${id}/`
      : `https://www.instagram.com/${art}/${id}/`;

  return { url, id, art };
}

export { FehlerUrl };
