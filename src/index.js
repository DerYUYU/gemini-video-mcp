#!/usr/bin/env node
/**
 * MCP-Server zur Analyse oeffentlicher YouTube-Videos mit der Google Gemini API.
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

const HIER = dirname(fileURLToPath(import.meta.url));
const WURZEL = join(HIER, '..');

ladeEnv();

const paket = JSON.parse(readFileSync(join(WURZEL, 'package.json'), 'utf8'));

const server = new McpServer(
  { name: 'gemini-video-mcp', version: paket.version },
  {
    instructions:
      'Analysiert oeffentliche YouTube-Videos mit Google Gemini. Tonspur und Bild werden gemeinsam ' +
      'ausgewertet, ein separates Transkript ist nicht noetig. Fuer ganze Videos den Default-Modus ' +
      '"auto" (agentic) nutzen -- er ist um ein Vielfaches guenstiger als die statische Verarbeitung.',
  },
);

server.registerTool(
  'analyze_video',
  {
    title: 'YouTube-Video analysieren',
    description:
      'Analysiert ein oeffentliches YouTube-Video mit Google Gemini und beantwortet eine Frage dazu. ' +
      'Ohne "prompt" liefert das Tool eine vollstaendige Analyse mit Kapiteln, Zeitstempeln und ' +
      'visuellen Details. Bild und Ton werden gemeinsam ausgewertet. Die Antwort weist immer den ' +
      'Tokenverbrauch aus. Funktioniert nur mit oeffentlichen Videos (keine privaten oder nicht ' +
      'gelisteten).',
    inputSchema: {
      url: z
        .string()
        .describe('URL des oeffentlichen YouTube-Videos, z. B. https://www.youtube.com/watch?v=VIDEOID'),
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
  async (args) => {
    try {
      const ergebnis = await analyseVideo(args);
      return { content: [{ type: 'text', text: formatiere(ergebnis) }] };
    } catch (fehler) {
      return {
        isError: true,
        content: [{ type: 'text', text: fehlertext(fehler) }],
      };
    }
  },
);

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
