#!/usr/bin/env node
/**
 * Zwei Guards fuer Claude Code, ausgewaehlt ueber das erste Argument.
 *
 *   env-guard     blockt jeden Zugriff auf .env (enthaelt den echten API-Key)
 *   syntax-check  laesst `node --check` ueber eine gerade geaenderte src/*.js
 *
 * Das Hook-Ereignis kommt als JSON ueber stdin. Node 22 ist ohnehin
 * Voraussetzung fuer den Server, deshalb keine zusaetzliche Abhaengigkeit.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const modus = process.argv[2];

let roh = '';
process.stdin.setEncoding('utf8');
for await (const stueck of process.stdin) roh += stueck;

let ereignis;
try {
  ereignis = JSON.parse(roh || '{}');
} catch {
  process.exit(0);
}

const werkzeug = ereignis.tool_name ?? '';
const eingabe = ereignis.tool_input ?? {};
const pfad = String(eingabe.file_path ?? '').replace(/\\/g, '/');

/** .env und .env.local treffen zu, .env.example ausdruecklich nicht. */
const ZEIGT_AUF_ENV = /(^|\/)\.env(?!\.example)(\.|$)/;

if (modus === 'env-guard') {
  const ueberDatei = ZEIGT_AUF_ENV.test(pfad);
  const ueberShell = werkzeug === 'Bash' && /\.env(?!\.example)(?![\w-])/.test(String(eingabe.command ?? ''));

  if (ueberDatei || ueberShell) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            '.env enthaelt den echten GEMINI_API_KEY und wird weder gelesen noch geschrieben noch ausgegeben. Fuer Struktur und Defaults .env.example verwenden.',
        },
      }),
    );
  }
  process.exit(0);
}

if (modus === 'syntax-check') {
  if (!/\/src\/[^/]+\.js$/.test(pfad)) process.exit(0);

  // Nicht aufloesbarer Pfad ist kein Syntaxfehler. Sonst meldet node einen
  // MODULE_NOT_FOUND und der Hook blockt eine voellig gesunde Datei.
  if (!existsSync(pfad)) process.exit(0);

  try {
    execFileSync(process.execPath, ['--check', pfad], { stdio: 'pipe' });
  } catch (fehler) {
    const meldung = fehler.stderr?.toString().trim() || fehler.message;
    process.stderr.write(`node --check meldet einen Syntaxfehler in ${pfad}:\n${meldung}\n`);
    process.exit(2);
  }
}

process.exit(0);
