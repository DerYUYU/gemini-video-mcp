/**
 * Fachlogik des Tools `analyze_video`: Eingaben pruefen, Modus waehlen,
 * Gemini fragen, Ergebnis formatieren. Bewusst ohne MCP-Abhaengigkeit,
 * damit sie sich direkt per Node-Skript testen laesst.
 */

import { erkenneQuelle } from './quelle.js';
import { parseZeit, alsOffset, alsZeitcode } from './time.js';
import { DEFAULT_PROMPT, mitZeitrahmen } from './prompt.js';
import { frageVideo, DEFAULT_TIMEOUT_MS, FehlerGemini } from './gemini.js';
import { ladeInstagramVideo, entferneVerzeichnis } from './ytdlp.js';
import { ladeHoch, loescheDatei } from './files.js';

/**
 * Bis zu dieser Ausschnittslaenge (Sekunden) schaltet "auto" von agentic auf
 * static um. Darueber lohnt der agentic-Modus deutlich: er kostet fuer ein
 * ganzes 15-Minuten-Video ~7.400 Tokens, waehrend static bei 300 Tokens pro
 * Videosekunde (high) schon nach einer Minute darueber liegt.
 */
const AUSSCHNITT_STATIC_MAX_S = 300;

export const MODI = ['agentic', 'static', 'auto'];
export const DETAILSTUFEN = ['normal', 'hoch'];

/**
 * Analysiert ein YouTube-Video.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {string} [args.prompt]
 * @param {'agentic'|'static'|'auto'} [args.mode]
 * @param {string|number} [args.start]
 * @param {string|number} [args.end]
 * @param {'normal'|'hoch'} [args.detail]
 * @returns {Promise<{text: string, tokens: number|null, meta: object}>}
 */
export async function analyseVideo(args = {}) {
  const { url, plattform } = erkenneQuelle(args.url);

  const mode = args.mode ?? 'auto';
  if (!MODI.includes(mode)) {
    throw new FehlerEingabe(`Unbekannter mode "${mode}". Erlaubt: ${MODI.join(', ')}.`);
  }
  const detail = args.detail ?? 'normal';
  if (!DETAILSTUFEN.includes(detail)) {
    throw new FehlerEingabe(`Unbekanntes detail "${detail}". Erlaubt: ${DETAILSTUFEN.join(', ')}.`);
  }
  if (args.prompt !== undefined && typeof args.prompt !== 'string') {
    throw new FehlerEingabe('"prompt" muss Text sein.');
  }

  const start = parseZeit(args.start, 'start');
  const end = parseZeit(args.end, 'end');
  if (start !== null && end !== null && end <= start) {
    throw new FehlerEingabe(
      `"end" (${alsZeitcode(end)}) muss nach "start" (${alsZeitcode(start)}) liegen.`,
    );
  }

  const plan = waehleModus({ mode, detail, start, end });

  const basis = args.prompt?.trim() || DEFAULT_PROMPT;
  const prompt = mitZeitrahmen(
    basis,
    start !== null ? alsZeitcode(start) : null,
    end !== null ? alsZeitcode(end) : null,
    plan.offsetsAktiv,
  );

  const ergebnis =
    plattform === 'instagram'
      ? await frageInstagram({ url, prompt, plan })
      : await frageVideo({
          url,
          prompt,
          processing: plan.processing,
          resolution: plan.resolution,
          timeoutMs: timeoutAusUmgebung(),
        });

  return {
    text: ergebnis.text,
    tokens: ergebnis.tokens,
    meta: {
      url,
      plattform,
      modus: plan.modus,
      begruendung: plan.begruendung,
      aufloesung: plan.resolution ?? null,
      ausschnitt:
        start === null && end === null
          ? null
          : `${start !== null ? alsZeitcode(start) : 'Anfang'} - ${end !== null ? alsZeitcode(end) : 'Ende'}`,
      hinweise: plan.hinweise,
      modell: ergebnis.modell,
      status: ergebnis.status,
      eigenerPrompt: Boolean(args.prompt?.trim()),
    },
  };
}

/**
 * Instagram-Pfad: herunterladen, hochladen, analysieren, aufraeumen.
 *
 * Das Aufraeumen steht im finally-Block, damit weder die temporaere Datei noch
 * die Kopie bei Google liegen bleibt -- auch dann nicht, wenn die Analyse
 * mitten im Lauf scheitert.
 *
 * Der Download laeuft vor der eigentlichen Anfrage und zaehlt deshalb nicht
 * gegen GEMINI_TIMEOUT_MS: dieses Timeout gilt erst fuer den Analyse-Aufruf.
 * Download und Verarbeitung haben ihre eigenen Zeitrahmen.
 */
async function frageInstagram({ url, prompt, plan }) {
  let download = null;
  let hochgeladen = null;

  try {
    download = await ladeInstagramVideo(url);
    hochgeladen = await ladeHoch(download.pfad, download.mimeTyp, `instagram-${Date.now()}`);

    return await frageVideo({
      url: hochgeladen.uri,
      mimeTyp: hochgeladen.mimeTyp,
      prompt,
      processing: plan.processing,
      resolution: plan.resolution,
      timeoutMs: timeoutAusUmgebung(),
    });
  } finally {
    if (hochgeladen?.name) await loescheDatei(hochgeladen.name);
    if (download?.verzeichnis) await entferneVerzeichnis(download.verzeichnis);
  }
}

/**
 * Entscheidet zwischen agentic und static.
 *
 * "auto" bevorzugt agentic, weil es bei langen Videos rund 90 % Tokens spart
 * und vollstaendiger antwortet. Static kommt nur zum Zug, wenn ein enger
 * Ausschnitt analysiert wird oder detail: "hoch" es verlangt.
 */
export function waehleModus({ mode, detail, start, end }) {
  const hatAusschnitt = start !== null || end !== null;
  const laenge = start !== null && end !== null ? end - start : null;
  const hinweise = [];

  let modus;
  let begruendung;

  if (detail === 'hoch') {
    modus = 'static';
    begruendung = 'detail: "hoch" erzwingt den statischen Modus mit hoher Aufloesung.';
    if (mode === 'agentic') {
      hinweise.push(
        'mode: "agentic" wurde von detail: "hoch" ueberstimmt -- hohe Aufloesung gibt es nur statisch.',
      );
    }
  } else if (mode === 'static') {
    modus = 'static';
    begruendung = 'mode: "static" wurde ausdruecklich angefordert.';
  } else if (mode === 'agentic') {
    modus = 'agentic';
    begruendung = 'mode: "agentic" wurde ausdruecklich angefordert.';
  } else if (hatAusschnitt && (laenge === null || laenge <= AUSSCHNITT_STATIC_MAX_S)) {
    modus = 'static';
    begruendung =
      'auto: enger Zeitausschnitt -- static schneidet exakt zu und ist bei kurzen Abschnitten guenstiger.';
  } else {
    modus = 'agentic';
    begruendung = hatAusschnitt
      ? `auto: der Ausschnitt ist laenger als ${AUSSCHNITT_STATIC_MAX_S / 60} Minuten -- agentic ist hier deutlich guenstiger.`
      : 'auto: agentic -- spart bei ganzen Videos rund 90 % Tokens gegenueber static.';
  }

  if (modus === 'agentic') {
    if (hatAusschnitt) {
      hinweise.push(
        'Der agentic-Modus kennt keine harten Zeit-Offsets. Der gewuenschte Bereich steht im Prompt; ' +
          'fuer exaktes Zuschneiden mode: "static" setzen.',
      );
    }
    return { modus, begruendung, processing: 'agentic', resolution: undefined, offsetsAktiv: false, hinweise };
  }

  const processing = { type: 'static' };
  if (start !== null) processing.start_offset = alsOffset(start);
  if (end !== null) processing.end_offset = alsOffset(end);

  // Hohe Aufloesung bleibt eine bewusste Entscheidung des Aufrufers. Gemessen
  // am selben 2-Minuten-Ausschnitt: low 11.293 Tokens, high 35.922 Tokens --
  // bei identischem Ergebnis, inklusive eines nur im Bild sichtbaren
  // Repository-Namens. Der Dreifachpreis lohnt sich also nicht automatisch.
  let resolution;
  if (detail === 'hoch') {
    resolution = 'high';
  } else {
    resolution = 'low';
    hinweise.push(
      'Niedrige Aufloesung (~100 Tokens pro Videosekunde). Sie liest auch Bildschirmtexte meist ' +
        'zuverlaessig. Erst wenn feine Details fehlen, detail: "hoch" setzen (~300 Tokens pro Videosekunde).',
    );
  }

  if (!hatAusschnitt) {
    hinweise.push(
      'Static ohne Ausschnitt verarbeitet das komplette Video Sekunde fuer Sekunde und wird bei langen ' +
        'Videos sehr teuer. Mit "start"/"end" eingrenzen oder mode: "agentic" nutzen.',
    );
  }

  return { modus, begruendung, processing, resolution, offsetsAktiv: true, hinweise };
}

function timeoutAusUmgebung() {
  const roh = process.env.GEMINI_TIMEOUT_MS?.trim();
  if (!roh) return DEFAULT_TIMEOUT_MS;
  const wert = Number(roh);
  return Number.isFinite(wert) && wert > 0 ? wert : DEFAULT_TIMEOUT_MS;
}

/** Formatiert das Ergebnis als Text fuer die MCP-Antwort. */
export function formatiere({ text, tokens, meta }) {
  const kopf = [
    `**Video:** ${meta.url}`,
    `**Modus:** ${meta.modus}${meta.aufloesung ? ` (Aufloesung ${meta.aufloesung})` : ''}`,
    meta.ausschnitt ? `**Ausschnitt:** ${meta.ausschnitt}` : null,
    `**Tokenverbrauch:** ${tokens === null ? 'nicht gemeldet' : `${tokens.toLocaleString('de-DE')} Tokens`}`,
    `**Modell:** ${meta.modell}`,
  ].filter(Boolean);

  const fuss = meta.hinweise.length ? `\n\n---\n\nHinweise:\n${meta.hinweise.map((h) => `- ${h}`).join('\n')}` : '';

  return `${kopf.join('\n')}\n\n---\n\n${text}${fuss}`;
}

export class FehlerEingabe extends Error {
  constructor(nachricht) {
    super(nachricht);
    this.name = 'FehlerEingabe';
    this.istNutzerfehler = true;
  }
}

export { FehlerGemini };
