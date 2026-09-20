/** Validierung von YouTube-URLs. Gemini akzeptiert nur oeffentliche Videos. */

const ERLAUBTE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtu.be', 'www.youtu.be',
]);

/**
 * Prueft die URL und gibt eine normalisierte watch-URL plus Video-ID zurueck.
 * @param {string} eingabe
 * @returns {{url: string, id: string}}
 */
export function pruefeYoutubeUrl(eingabe) {
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
  if (!ERLAUBTE_HOSTS.has(u.hostname.toLowerCase())) {
    throw new FehlerUrl(
      `"${u.hostname}" ist kein YouTube-Host. Dieser Server analysiert ausschliesslich oeffentliche YouTube-Videos.`,
    );
  }

  const id = videoId(u);
  if (!id) {
    throw new FehlerUrl(
      `Aus "${roh}" laesst sich keine Video-ID lesen. Erwartet wird z. B. https://www.youtube.com/watch?v=VIDEOID`,
    );
  }

  return { url: `https://www.youtube.com/watch?v=${id}`, id };
}

function videoId(u) {
  const gueltig = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null);

  if (u.hostname.toLowerCase().endsWith('youtu.be')) {
    return gueltig(u.pathname.slice(1).split('/')[0]);
  }
  const pfad = u.pathname.replace(/\/+$/, '');
  if (pfad === '/watch') return gueltig(u.searchParams.get('v'));

  const treffer = pfad.match(/^\/(shorts|live|embed|v)\/([^/]+)/);
  if (treffer) return gueltig(treffer[2]);

  return null;
}

export class FehlerUrl extends Error {
  constructor(nachricht) {
    super(nachricht);
    this.name = 'FehlerUrl';
    this.istNutzerfehler = true;
  }
}
