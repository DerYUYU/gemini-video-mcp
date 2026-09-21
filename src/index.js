#!/usr/bin/env node
/**
 * MCP-Server zur Analyse oeffentlicher Videos von YouTube und Instagram sowie
 * eigener Videodateien per lokalem Pfad mit der Google Gemini API.
 * Transport: stdio.
 *
 * WICHTIG: stdout gehoert dem MCP-Protokoll. Jede Diagnoseausgabe muss nach
 * stderr, sonst zerschiesst sie den JSON-RPC-Stream.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { analyseVideo, formatiere, MODI, DETAILSTUFEN } from './analyze.js';
import { istLokalerPfad, pruefeLokaleDatei, stelleBereit, loescheLokal, zustandLokal } from './lokal.js';

const HIER = dirname(fileURLToPath(import.meta.url));
const WURZEL = join(HIER, '..');

ladeEnv();

const paket = JSON.parse(readFileSync(join(WURZEL, 'package.json'), 'utf8'));

const server = new McpServer(
  { name: 'gemini-video-mcp', version: paket.version },
  {
    instructions:
      'Analysiert oeffentliche Videos von YouTube und Instagram sowie eigene Videodateien per lokalem ' +
      'Pfad mit Google Gemini. Tonspur und Bild ' +
      'werden gemeinsam ausgewertet, ein separates Transkript ist nicht noetig. Fuer ganze Videos den ' +
      'Default-Modus "auto" (agentic) nutzen -- er ist um ein Vielfaches guenstiger als die statische ' +
      'Verarbeitung. Eigene Videodateien gehen per vollstaendigem lokalem Pfad (z. B. ' +
      'C:\\Videos\\vortrag.mp4). Sie werden einmal hochgeladen und bleiben 48 Stunden fuer ' +
      'Folgefragen liegen. Ablauf fuer lange Videos: erst manage_local_video mit action "upload", ' +
      'dann analyze_video ohne start/end fuer die Uebersicht mit Kapiteln, dann Kapitel fuer Kapitel ' +
      'mit start und end, zum Schluss manage_local_video mit action "delete".',
  },
);

server.registerTool(
  'analyze_video',
  {
    title: 'Video analysieren (YouTube, Instagram, lokale Datei)',
    description:
      'Analysiert ein oeffentliches Video von YouTube oder Instagram oder eine eigene Videodatei ' +
      'per lokalem Pfad mit Google Gemini und beantwortet eine Frage dazu. Ohne "prompt" liefert das Tool eine vollstaendige Analyse mit ' +
      'Kapiteln, Zeitstempeln und visuellen Details. Bild und Ton werden gemeinsam ausgewertet. Die ' +
      'Antwort weist immer den Tokenverbrauch aus. Bei YouTube und Instagram funktioniert es nur mit ' +
      'oeffentlichen Videos (keine privaten oder nicht gelisteten). Instagram-Beitraege ohne Video, etwa reine Bilder oder ' +
      'Bild-Karussells, lassen sich nicht analysieren. Lokale Dateien (mp4, mov, webm, avi, wmv, ' +
      'mpeg, mpg, flv, 3gp, hoechstens 2 GB) werden beim ersten Aufruf hochgeladen und bei ' +
      'Folgefragen zur unveraenderten Datei wiederverwendet statt erneut hochgeladen. Bei grossen ' +
      'Dateien vorher manage_local_video mit action "upload" aufrufen.',
    inputSchema: {
      url: z
        .string()
        .describe(
          'URL des oeffentlichen Videos. YouTube, z. B. https://www.youtube.com/watch?v=VIDEOID, ' +
            'oder Instagram als Reel oder Video-Beitrag, z. B. https://www.instagram.com/reel/KENNUNG/. ' +
            'Oder der vollstaendige Pfad einer eigenen Videodatei auf diesem Rechner, z. B. ' +
            'C:\\Users\\Name\\Videos\\vortrag.mp4. Andere Plattformen werden nicht unterstuetzt.',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Die konkrete Frage an das Video. Ohne Angabe wird eine vollstaendige strukturierte ' +
            'Analyse mit Kapiteln und Zeitstempeln angefordert.',
        ),
      mode: z
        .enum(MODI)
        .optional()
        .describe(
          '"agentic" (Default ueber auto): Gemini navigiert selbst durchs Video, ~90 % guenstiger und ' +
            'vollstaendiger bei langen Videos. "static": Frame-fuer-Frame, erlaubt exakte Zeit-Offsets ' +
            'und hohe Aufloesung, aber teuer. "auto": agentic, ausser bei engem Ausschnitt.',
        ),
      start: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Beginn des Ausschnitts: "12:30", "1:02:30", "750s" oder Millisekunden als Zahl.'),
      end: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Ende des Ausschnitts, gleiche Formate wie "start".'),
      detail: z
        .enum(DETAILSTUFEN)
        .optional()
        .describe(
          '"normal" (Default) oder "hoch". "hoch" erzwingt den statischen Modus mit hoher Aufloesung ' +
            '(~300 statt ~100 Tokens pro Videosekunde) -- sinnvoll fuer Bildschirmtexte, Code oder ' +
            'feine Bilddetails, nur zusammen mit einem kurzen Ausschnitt empfehlenswert.',
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args, extra) => {
    // Nur der lokale Weg meldet Fortschritt, YouTube und Instagram bleiben wie gehabt.
    const herz = herzschlag(istLokalerPfad(args.url ?? '') ? extra : null);
    try {
      const ergebnis = await analyseVideo(args, { melde: herz.melde });
      return { content: [{ type: 'text', text: formatiere(ergebnis) }] };
    } catch (fehler) {
      return {
        isError: true,
        content: [{ type: 'text', text: fehlertext(fehler) }],
      };
    } finally {
      herz.stop();
    }
  },
);

server.registerTool(
  'manage_local_video',
  {
    title: 'Lokale Videodatei hochladen, pruefen, loeschen',
    description:
      'Verwaltet die Kopie einer eigenen Videodatei bei der Gemini Files API. "upload" laedt die ' +
      'Datei hoch und wartet, bis Gemini sie verarbeitet hat. Das trennt den langen Upload grosser ' +
      'Dateien von der Analyse, danach antwortet analyze_video mit demselben Pfad ohne neuen ' +
      'Upload. Eine vorhandene Kopie der unveraenderten Datei wird nicht erneut hochgeladen. ' +
      '"status" zeigt, ob und bis wann eine Kopie bei Google liegt. "delete" loescht alle Kopien ' +
      'dieser Datei bei Google, die lokale Datei bleibt unberuehrt. Ohne Loeschen verfallen Kopien ' +
      'nach 48 Stunden.',
    inputSchema: {
      action: z.enum(['upload', 'status', 'delete']).describe('"upload", "status" oder "delete".'),
      path: z
        .string()
        .describe('Vollstaendiger lokaler Pfad der Videodatei, z. B. C:\\Users\\Name\\Videos\\vortrag.mp4.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ action, path }, extra) => {
    const herz = herzschlag(extra);
    try {
      return { content: [{ type: 'text', text: await verwalteLokal(action, path, herz.melde) }] };
    } catch (fehler) {
      return { isError: true, content: [{ type: 'text', text: fehlertext(fehler) }] };
    } finally {
      herz.stop();
    }
  },
);

async function verwalteLokal(action, path, melde) {
  if (action === 'upload') {
    const { url, datei } = pruefeLokaleDatei(path);
    const bereit = await stelleBereit(datei, melde);
    return [
      `${bereit.wiederverwendet ? 'Bereits hochgeladen, kein neuer Upload noetig' : 'Hochgeladen und verarbeitet'}: ${url}`,
      `Liegt bei Google bis: ${datum(bereit.ablauf)}`,
      'Jetzt analyze_video mit demselben Pfad aufrufen.',
    ].join('\n');
  }

  if (action === 'delete') {
    const { geloescht, fehlgeschlagen, laeuftNoch } = await loescheLokal(path);
    return [
      `${geloescht} Kopie(n) bei Google geloescht.`,
      fehlgeschlagen ? `${fehlgeschlagen} Kopie(n) liessen sich nicht loeschen, bitte erneut versuchen.` : null,
      laeuftNoch ? 'Ein Upload dieser Datei laeuft noch. Nach seinem Ende erneut loeschen.' : null,
    ].filter(Boolean).join('\n');
  }

  const { pfad, laeuftNoch, kopien } = await zustandLokal(path);
  const zeilen = kopien.map(
    (k) => `- ${k.zustand}, bis ${datum(k.ablauf)}${k.aktuell ? ', passt zur aktuellen Datei' : ', aeltere Version'}`,
  );
  return [
    `Datei: ${pfad}`,
    laeuftNoch ? 'Ein Upload dieser Datei laeuft gerade.' : null,
    kopien.length ? `Kopien bei Google:\n${zeilen.join('\n')}` : 'Keine Kopie bei Google.',
  ].filter(Boolean).join('\n');
}

function datum(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE') : 'unbekannt';
}

/**
 * Sendet Fortschrittsmeldungen, solange ein Aufruf laeuft, sofern der Client
 * ein progressToken mitschickt. Claude Code bricht stdio-Aufrufe ohne Antwort
 * und ohne Fortschritt nach 30 Minuten ab (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT),
 * und Upload plus Verarbeitung einer grossen Datei kann so lange dauern.
 */
function herzschlag(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return { melde: () => {}, stop: () => {} };

  const beginn = Date.now();
  let schritt = 0;
  let letzte = 'laeuft';
  const sende = () => {
    schritt += 1;
    const minuten = Math.floor((Date.now() - beginn) / 60000);
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: schritt, message: `${letzte} (${minuten} min)` },
      })
      .catch(() => {});
  };
  const takt = setInterval(sende, 60 * 1000);
  return {
    melde: (text) => {
      letzte = text;
      sende();
    },
    stop: () => clearInterval(takt),
  };
}

/**
 * Liest .env aus dem Projektverzeichnis. Fehlt die Datei, ist das kein Fehler:
 * der Key kann auch aus der MCP-Konfiguration als Umgebungsvariable kommen.
 */
function ladeEnv() {
  try {
    process.loadEnvFile(join(WURZEL, '.env'));
  } catch {
    // bewusst ignoriert
  }
}

/** Baut eine verstaendliche Fehlermeldung -- niemals ein roher Stacktrace. */
function fehlertext(fehler) {
  if (fehler?.istNutzerfehler) return `Analyse fehlgeschlagen: ${fehler.message}`;
  const kurz = String(fehler?.message ?? fehler ?? 'unbekannter Fehler').split('\n')[0];
  return `Analyse fehlgeschlagen (unerwarteter Fehler): ${kurz}`;
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`gemini-video-mcp ${paket.version} bereit (stdio)\n`);
