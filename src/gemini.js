/**
 * Duenner Wrapper um `@google/genai` -> POST /v1beta/interactions.
 *
 * Bewusst NICHT `models.generateContent`: fuer dasselbe 15-Minuten-Video
 * kostet generateContent ~85.000 Tokens bei unvollstaendiger Antwort, der
 * interactions-Endpoint im agentic-Modus ~7.400 bei besserer Qualitaet.
 * Das Feld `processing` existiert in generateContent ausserdem gar nicht.
 */

import { setTimeout as warte } from 'node:timers/promises';
import { GoogleGenAI } from '@google/genai';

export const DEFAULT_MODELL = 'gemini-3.8-flash';
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ausweichkette. Das Tageskontingent des Free Tier gilt pro Modell, nicht pro
 * Konto -- ein erschoepftes Modell bedeutet also nicht, dass gar nichts mehr
 * geht. Alle Eintraege beherrschen die agentische Videoverarbeitung.
 */
export const DEFAULT_KETTE = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
];

/** Nur diese Zustaende rechtfertigen einen Modellwechsel. */
const AUSWEICH_STATUS = new Set([429, 503]);

/**
 * Pausen vor der zweiten und dritten Runde durch die Kette, und vor dem einen
 * erneuten Versuch nach einem kurzen Verbindungsabbruch. Weitere Runden gibt
 * es nur nach einem 503: "Server ueberlastet" ist meist nach Minuten vorbei,
 * ein erschoepftes Tageskontingent (429) wird durch Warten nicht besser.
 */
export const PAUSEN_MS = { runden: [20 * 1000, 60 * 1000], netz: 2 * 1000 };

/** Ursachen von "fetch failed", die auf einen kurzen Abbruch deuten. */
const KURZE_NETZFEHLER = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

let clientCache = null;
let dispatcherCache;

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
 * @param {string} p.url        YouTube-URL oder URI einer hochgeladenen Datei.
 * @param {string} p.prompt     Die Frage an das Modell.
 * @param {'agentic'|object} p.processing  "agentic" oder {type:'static',...}.
 * @param {string} [p.resolution]  "low" | "medium" | "high" | "ultra_high".
 * @param {string} [p.mimeTyp]  Nur fuer hochgeladene Dateien noetig.
 * @param {string} [p.modell]
 * @param {number} [p.timeoutMs]
 * @param {{runden: number[], netz: number}} [p.pausen]  Nur fuer Tests kuerzer als PAUSEN_MS.
 * @returns {Promise<{text: string, tokens: number|null, status: string, modell: string, usage: object, uebersprungen: object[], runden: number}>}
 */
export async function frageVideo({
  url,
  prompt,
  processing,
  resolution,
  mimeTyp,
  modell,
  timeoutMs,
  pausen = PAUSEN_MS,
}) {
  const client = holeClient();
  const kette = modellKette(modell);

  const video = { type: 'video', uri: url, processing };
  if (resolution) video.resolution = resolution;
  // Nur der Instagram-Pfad setzt das. Ohne mimeTyp bleibt die Anfrage exakt
  // die, die der YouTube-Pfad schon immer geschickt hat.
  if (mimeTyp) video.mime_type = mimeTyp;

  const eingabe = [video, { type: 'text', text: prompt }];
  // Letzter Ausweich-Status je Modell. Ein 429 sperrt das Modell fuer die
  // weiteren Runden, ein 503 nicht.
  const letzterStatus = new Map();
  let letzterFehler = null;

  for (let runde = 1; ; runde += 1) {
    const offen = kette.filter((m) => letzterStatus.get(m) !== 429);

    for (const modellName of offen) {
      const { antwort, fehler, sekunden } = await frageModell(
        client,
        modellName,
        eingabe,
        timeoutMs,
        pausen.netz,
      );

      if (fehler) {
        const status = statusVon(fehler);
        // Nur Kontingent und Ueberlastung rechtfertigen einen Wechsel. Ein
        // kaputter Key oder ein privates Video wuerde bei jedem Modell genauso
        // scheitern -- weiterzuprobieren wuerde nur Kontingent verbrennen.
        if (!AUSWEICH_STATUS.has(status)) {
          throw uebersetzeFehler(fehler, url, await pruefeKey(client, fehler), sekunden);
        }
        letzterStatus.set(modellName, status);
        letzterFehler = fehler;
        continue;
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
        // Alles vor dem antwortenden Modell ist in dieser Runde gescheitert
        // oder seit einer frueheren Runde wegen 429 gesperrt.
        uebersprungen: kette
          .slice(0, kette.indexOf(modellName))
          .map((m) => ({ modell: m, status: letzterStatus.get(m) })),
        runden: runde,
      };
    }

    // Ein einzelnes Modell ohne 503 meldet sich wie eh und je mit dem
    // passenden Einzelfehler statt mit einer Kette aus einem Glied.
    if (kette.length === 1 && runde === 1 && statusVon(letzterFehler) !== 503) {
      throw uebersetzeFehler(letzterFehler, url);
    }

    const ueberlastet = offen.filter((m) => letzterStatus.get(m) === 503);
    if (!ueberlastet.length || runde > pausen.runden.length) {
      throw ketteErschoepft(letzterStatus, runde);
    }

    const pause = pausen.runden[runde - 1];
    process.stderr.write(
      `gemini-video-mcp: Runde ${runde} ohne Antwort, ueberlastet (HTTP 503): ${ueberlastet.join(', ')}. ` +
        `Naechste Runde in ${Math.round(pause / 1000)} s.\n`,
    );
    await warte(pause);
  }
}

/**
 * Ein Aufruf bei einem Modell, nach einem kurzen Verbindungsabbruch einmal
 * wiederholt. Wirft nicht, sondern liefert den Fehler samt Laufzeit zurueck,
 * damit die Meldung sagen kann, nach wie vielen Sekunden es abbrach.
 */
async function frageModell(client, modellName, eingabe, timeoutMs, netzPauseMs) {
  const dispatcher = dispatcherOhneFristen();

  for (let versuch = 1; ; versuch += 1) {
    const beginn = Date.now();
    try {
      const antwort = await client.interactions.create(
        { model: modellName, input: eingabe },
        {
          timeout_ms: timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // Die SDK-eigenen Wiederholungen muessen aus: sie probieren jedes
          // Modell mehrfach, bevor die Kette ueberhaupt weiterschaltet. Bei
          // einem erschoepften Tageskontingent ist das reine Zeit- und
          // Kontingentverschwendung -- das Ausweichen auf das naechste Modell
          // ist die richtige Antwort, nicht ein erneuter Versuch beim selben.
          retries: { strategy: 'none' },
          ...(dispatcher && { fetch_options: { dispatcher } }),
        },
      );
      return { antwort };
    } catch (fehler) {
      const sekunden = Math.round((Date.now() - beginn) / 1000);
      const code = ursachenCode(fehler);
      if (versuch > 1 || !KURZE_NETZFEHLER.has(code)) return { fehler, sekunden };
      process.stderr.write(
        `gemini-video-mcp: ${modellName} Verbindung nach ${sekunden} s abgebrochen (${code}), ` +
          `neuer Versuch in ${Math.round(netzPauseMs / 1000)} s.\n`,
      );
      await warte(netzPauseMs);
    }
  }
}

/**
 * Eigener undici-Agent fuer den Analyse-Aufruf, ohne headersTimeout und
 * bodyTimeout.
 *
 * Node schickt fetch ueber undici, dessen globaler Agent nach 300 Sekunden
 * ohne Antwortkopf abbricht. Ein nicht gestreamter interactions-Aufruf
 * liefert den Kopf erst mit dem fertigen Ergebnis, lange agentic-Analysen
 * scheiterten so nach fuenf Minuten mit "fetch failed" statt nach
 * DEFAULT_TIMEOUT_MS. Das SDK hebt diese Grenzen auf dem interactions-Weg
 * nicht an. Ohne die beiden Fristen bleibt timeout_ms die einzige.
 *
 * Node exportiert die Agent-Klasse nicht. Sie steckt aber im globalen
 * Dispatcher, den `new Request` beim ersten Mal anlegt -- so geht es ohne
 * neue Dependency. Klappt das nicht, bleibt es beim globalen Dispatcher.
 */
function dispatcherOhneFristen() {
  if (dispatcherCache !== undefined) return dispatcherCache;
  dispatcherCache = null;
  try {
    void new Request('http://localhost/');
    const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')]?.constructor;
    if (typeof Agent === 'function') dispatcherCache = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  } catch {
    // Etwa ein fremder ProxyAgent, der ohne Pflichtangaben nicht startet.
  }
  return dispatcherCache;
}

/**
 * Baut die Modellkette: Startmodell zuerst, dann die Ausweichmodelle.
 *
 * Ein ausdruecklich gesetztes GEMINI_MODEL bleibt immer der erste Eintrag und
 * behaelt damit seine bisherige Bedeutung. Doppelte Eintraege fliegen raus,
 * damit kein Modell zweimal probiert wird.
 */
export function modellKette(modell) {
  const start = modell || process.env.GEMINI_MODEL?.trim() || DEFAULT_KETTE[0] || DEFAULT_MODELL;

  const roh = process.env.GEMINI_MODEL_FALLBACKS?.trim();
  const ausweich = roh
    ? roh.split(',').map((m) => m.trim()).filter(Boolean)
    : DEFAULT_KETTE;

  return [...new Set([start, ...ausweich])];
}

function statusVon(fehler) {
  return fehler?.status ?? fehler?.statusCode ?? fehler?.response?.status ?? null;
}

/** Sucht in der cause-Kette den ersten Fehlercode, etwa ECONNRESET oder UND_ERR_SOCKET. */
function ursachenCode(fehler) {
  for (let f = fehler, tiefe = 0; f && tiefe < 6; f = f.cause, tiefe += 1) {
    if (typeof f.code === 'string') return f.code;
  }
  return null;
}

/**
 * Trennt Ueberlastung (503, voruebergehend) von erschoepftem Kontingent (429).
 * Massgeblich ist der letzte Status je Modell.
 */
function ketteErschoepft(letzterStatus, runden) {
  const mit = (status) =>
    [...letzterStatus].filter(([, s]) => s === status).map(([m]) => `${m} (HTTP ${status})`);
  const ueberlastet = mit(503);
  const erschoepft = mit(429);

  const teile = [];
  if (ueberlastet.length) {
    teile.push(
      `Server ueberlastet: ${ueberlastet.join(', ')}. Das ist voruebergehend und kein Kontingentproblem. ` +
        `Nach ${runden} ${runden === 1 ? 'Runde' : 'Runden'} durch die Modellkette aufgegeben -- in ` +
        'einigen Minuten erneut versuchen.',
    );
  }
  if (erschoepft.length) {
    teile.push(
      `Tageskontingent erschoepft: ${erschoepft.join(', ')}. Das Tageskontingent des Free Tier gilt pro ` +
        'Modell und wird taeglich zurueckgesetzt -- morgen geht es also wieder. Zusaetzliche Modelle ' +
        'lassen sich ueber GEMINI_MODEL_FALLBACKS eintragen, alternativ hilft ein hoeheres Kontingent ' +
        '(ai.dev/rate-limit).',
    );
  }
  return new FehlerGemini(`Kein Modell der Kette hat geantwortet. ${teile.join(' ')}`, 'kette_erschoepft');
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
 * @param {number|null} [sekunden]   Laufzeit des gescheiterten Aufrufs, falls gemessen.
 */
export function uebersetzeFehler(fehler, url, keyGueltig = null, sekunden = null) {
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
      'Kontingent erschoepft (HTTP 429). Im Free Tier gilt das Tageslimit pro Modell -- fuer ' +
        'gemini-3.8-flash sind es 20 Anfragen pro Tag. Es wird taeglich zurueckgesetzt. Ueber ' +
        'GEMINI_MODEL_FALLBACKS lassen sich weitere Modelle eintragen, auf die automatisch ' +
        'ausgewichen wird.',
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
    const ursache = ursachenCode(fehler) ?? 'unbekannt';
    const dauer = sekunden === null ? '' : `, Abbruch nach ${sekunden} s`;
    return new FehlerGemini(
      `Die Verbindung zur Gemini-API ist gescheitert (Ursache ${ursache}${dauer}). ` +
        'Pruefe Netzwerkverbindung bzw. Proxy.',
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
