/**
 * Duenner Wrapper um `@google/genai` -> POST /v1beta/interactions.
 *
 * Bewusst NICHT `models.generateContent`: fuer dasselbe 15-Minuten-Video
 * kostet generateContent ~85.000 Tokens bei unvollstaendiger Antwort, der
 * interactions-Endpoint im agentic-Modus ~7.400 bei besserer Qualitaet.
 * Das Feld `processing` existiert in generateContent ausserdem gar nicht.
 */

import { GoogleGenAI } from '@google/genai';

export const DEFAULT_MODELL = 'gemini-3.8-flash';
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

let clientCache = null;

/** Liefert den Gemini-Client. Wirft eine klare Meldung, wenn der Key fehlt. */
export function holeClient() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new FehlerGemini(
      'GEMINI_API_KEY ist nicht gesetzt. Trage den Key in die .env des Servers ein ' +
        '(Vorlage: .env.example) oder setze ihn als Umgebungsvariable in der MCP-Konfiguration.',
      'kein_key',
    );
  }
  if (!clientCache || clientCache.key !== key) {
    clientCache = { key, client: new GoogleGenAI({ apiKey: key }) };
  }
  return clientCache.client;
}

/** Nur fuer Tests: erzwingt einen neuen Client beim naechsten Aufruf. */
export function resetClient() {
  clientCache = null;
}

/**
 * Schickt ein Video plus Frage an den interactions-Endpoint.
 *
 * @param {object} p
 * @param {string} p.url        Normalisierte YouTube-URL.
 * @param {string} p.prompt     Die Frage an das Modell.
 * @param {'agentic'|object} p.processing  "agentic" oder {type:'static',...}.
 * @param {string} [p.resolution]  "low" | "medium" | "high" | "ultra_high".
 * @param {string} [p.modell]
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{text: string, tokens: number|null, status: string, modell: string, usage: object}>}
 */
export async function frageVideo({ url, prompt, processing, resolution, modell, timeoutMs }) {
  const client = holeClient();
  const modellName = modell || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODELL;

  const video = { type: 'video', uri: url, processing };
  if (resolution) video.resolution = resolution;

  let antwort;
  try {
    antwort = await client.interactions.create(
      { model: modellName, input: [video, { type: 'text', text: prompt }] },
      { timeout_ms: timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (fehler) {
    throw uebersetzeFehler(fehler, url, await pruefeKey(client, fehler));
  }

  const text = leseAntworttext(antwort);
  if (!text) {
    throw new FehlerGemini(
      `Die API hat geantwortet (Status "${antwort?.status ?? 'unbekannt'}"), aber keinen auswertbaren ` +
        'Text geliefert. Versuche es mit einer konkreteren Frage oder einem kuerzeren Ausschnitt.',
      'leere_antwort',
    );
  }

  return {
    text,
    tokens: typeof antwort?.usage?.total_tokens === 'number' ? antwort.usage.total_tokens : null,
    status: antwort?.status ?? 'unbekannt',
    modell: antwort?.model ?? modellName,
    usage: antwort?.usage ?? {},
  };
}

/**
 * Liest den Antworttext aus `steps`. Der Aufbau ist eine Schrittliste
 * (processing_call, processing_result, thought, model_output, ...), deren
 * Reihenfolge und Anzahl variieren -- deshalb wird gefiltert statt indiziert.
 */
export function leseAntworttext(antwort) {
  const steps = Array.isArray(antwort?.steps) ? antwort.steps : [];

  const ausSteps = textAusSteps(steps.filter((s) => s?.type === 'model_output'));
  if (ausSteps) return ausSteps;

  // Fallback 1: Convenience-Feld des SDK.
  if (typeof antwort?.output_text === 'string' && antwort.output_text.trim()) {
    return antwort.output_text.trim();
  }

  // Fallback 2: irgendein Text-Content in den Steps, ausser Gedankenspuren.
  return textAusSteps(steps.filter((s) => s?.type !== 'thought'));
}

function textAusSteps(steps) {
  return steps
    .flatMap((s) => (Array.isArray(s?.content) ? s.content : []))
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * Klaert bei mehrdeutigen Fehlern, ob der Key ueberhaupt gueltig ist.
 *
 * Noetig, weil die API die beiden haeufigsten Ursachen genau verkehrt herum
 * signalisiert: ein nicht abrufbares Video liefert 403 "The caller does not
 * have permission" (ohne jeden Hinweis aufs Video), ein ungueltiger Key
 * dagegen 400 mit leerem Meldungstext. Ein `models.list` mit demselben Key
 * kostet ~0,1 s und keine Tokens und trennt die Faelle eindeutig.
 *
 * @returns {Promise<boolean|null>} true/false, oder null wenn nicht geprueft.
 */
async function pruefeKey(client, fehler) {
  const status = fehler?.status ?? fehler?.statusCode ?? fehler?.response?.status ?? null;
  if (status !== 400 && status !== 403 && status !== 401) return null;
  try {
    await client.models.list({ config: { pageSize: 1 } });
    return true;
  } catch (pruefFehler) {
    const text = String(pruefFehler?.message ?? '').toLowerCase();
    if (text.includes('api key not valid') || text.includes('api_key_invalid')) return false;
    return null; // Netzwerk o. ae. -- keine Aussage moeglich
  }
}

/**
 * Uebersetzt SDK-/HTTP-Fehler in verstaendliche deutsche Meldungen.
 *
 * @param {unknown} fehler
 * @param {string} url
 * @param {boolean|null} [keyGueltig] Ergebnis von pruefeKey, falls vorhanden.
 */
export function uebersetzeFehler(fehler, url, keyGueltig = null) {
  const status = fehler?.status ?? fehler?.statusCode ?? fehler?.response?.status ?? null;
  const roh = String(fehler?.message ?? fehler ?? '');
  const klein = roh.toLowerCase();

  if (
    fehler?.name === 'AbortError' ||
    klein.includes('timeout') ||
    klein.includes('timed out') ||
    klein.includes('aborted')
  ) {
    return new FehlerGemini(
      'Zeitueberschreitung bei der Analyse. Lange Videos brauchen im agentic-Modus mehrere Minuten. ' +
        'Grenze die Analyse mit "start"/"end" auf einen Ausschnitt ein oder erhoehe GEMINI_TIMEOUT_MS.',
      'timeout',
      fehler,
    );
  }

  // Das aktive Pruefergebnis schlaegt jede Textheuristik.
  if (keyGueltig === false) return keyFehler(fehler);

  const gehtUmsVideo =
    klein.includes('video') ||
    klein.includes('youtube') ||
    klein.includes('uri') ||
    klein.includes('private') ||
    klein.includes('unlisted') ||
    klein.includes('not accessible') ||
    klein.includes('unavailable') ||
    klein.includes('not found') ||
    klein.includes('could not be fetched') ||
    klein.includes('failed to fetch');

  // 403 heisst hier praktisch immer "Video nicht abrufbar": ein ungueltiger
  // Key liefert 400, und genau das hat keyGueltig oben bereits ausgeschlossen.
  if (gehtUmsVideo || status === 404 || (status === 403 && keyGueltig === true)) {
    return videoFehler(url, roh, fehler, keyGueltig);
  }

  if (
    status === 401 ||
    status === 403 ||
    klein.includes('api_key_invalid') ||
    klein.includes('api key not valid') ||
    klein.includes('permission denied')
  ) {
    return keyFehler(fehler);
  }

  if (
    status === 429 ||
    klein.includes('resource_exhausted') ||
    klein.includes('quota') ||
    klein.includes('rate limit')
  ) {
    return new FehlerGemini(
      'Kontingent erschoepft (HTTP 429). Im Free Tier sind maximal 8 Stunden YouTube-Material pro Tag ' +
        'erlaubt, dazu kommen Limits pro Minute. Warte ab oder nutze einen kuerzeren Ausschnitt.',
      'kontingent',
      fehler,
    );
  }

  if (
    klein.includes('private') ||
    klein.includes('unlisted') ||
    klein.includes('not accessible') ||
    klein.includes('unavailable') ||
    klein.includes('not found') ||
    klein.includes('could not be fetched') ||
    klein.includes('failed to fetch')
  ) {
    return videoFehler(url, roh, fehler);
  }

  if (status === 400 || klein.includes('invalid_argument') || klein.includes('invalid input')) {
    return new FehlerGemini(
      'Die API hat die Anfrage abgelehnt (HTTP 400). Haeufigste Ursachen: nicht oeffentliches Video, ' +
        'ungueltiger Zeitausschnitt oder ein fuer diesen Key nicht freigeschaltetes Modell. ' +
        `Originalmeldung der API: ${kurz(roh)}`,
      'ungueltige_anfrage',
      fehler,
    );
  }

  if (status && status >= 500) {
    return new FehlerGemini(
      `Die Gemini-API meldet einen Serverfehler (HTTP ${status}). Das ist in der Regel voruebergehend, ` +
        'bitte spaeter erneut versuchen.',
      'serverfehler',
      fehler,
    );
  }

  if (
    klein.includes('fetch failed') ||
    klein.includes('enotfound') ||
    klein.includes('econnrefused') ||
    klein.includes('getaddrinfo')
  ) {
    return new FehlerGemini(
      'Keine Verbindung zur Gemini-API moeglich. Pruefe Netzwerkverbindung bzw. Proxy.',
      'netzwerk',
      fehler,
    );
  }

  return new FehlerGemini(
    `Die Analyse ist fehlgeschlagen${status ? ` (HTTP ${status})` : ''}: ${kurz(roh)}`,
    'unbekannt',
    fehler,
  );
}

function videoFehler(url, roh, fehler, keyGueltig) {
  const bestaetigt =
    keyGueltig === true ? ' Der API-Key selbst wurde geprueft und ist gueltig.' : '';
  return new FehlerGemini(
    `Das Video unter ${url} konnte nicht geladen werden. Gemini verarbeitet nur oeffentliche ` +
      'YouTube-Videos -- private, nicht gelistete, geloeschte oder regional gesperrte Videos ' +
      `schlagen fehl.${bestaetigt} Originalmeldung der API: ${kurz(roh)}`,
    'video_nicht_abrufbar',
    fehler,
  );
}

function keyFehler(fehler) {
  return new FehlerGemini(
    'Der Gemini-API-Key wurde abgelehnt (ungueltig, abgelaufen oder ohne Zugriff auf dieses Modell). ' +
      'Pruefe GEMINI_API_KEY im AI Studio. Der Key wird hier bewusst nicht ausgegeben.',
    'key_abgelehnt',
    fehler,
  );
}

function kurz(text) {
  const eine = text.replace(/\s+/g, ' ').trim();
  return eine.length > 400 ? `${eine.slice(0, 400)}...` : eine;
}

export class FehlerGemini extends Error {
  constructor(nachricht, code, ursache) {
    super(nachricht);
    this.name = 'FehlerGemini';
    this.code = code;
    this.istNutzerfehler = true;
    if (ursache) this.cause = ursache;
  }
}
