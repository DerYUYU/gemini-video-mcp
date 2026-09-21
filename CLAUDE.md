# gemini-video-mcp

MCP-Server, der Videos ueber die Google-Gemini-API auswertet. Drei Quellen:
oeffentliche YouTube-Videos, Instagram-Reels und Video-Beitraege sowie eigene
Videodateien per lokalem Pfad. Tools: `analyze_video` fuer alle drei Quellen,
`manage_local_video` fuer Upload, Status und Loeschen lokaler Dateien.
Transport stdio.

## Stack

- Node 22 oder neuer, ESM (`"type": "module"`). Kein Build, kein TypeScript.
- Dependencies: `@google/genai`, `@modelcontextprotocol/sdk`, `zod`. Mehr nicht.
- Keine Tests, kein Linter, kein Formatter. Start: `npm start`.
- Externes Programm nur fuer Instagram: `yt-dlp` (kein npm-Paket).

## Harte Regeln

1. **stdout gehoert dem MCP-Protokoll.** Jede Diagnoseausgabe geht nach stderr
   (`process.stderr.write`). Ein `console.log` zerschiesst den JSON-RPC-Stream.
2. **`.env` niemals lesen, ausgeben oder committen.** Dort liegt der echte
   `GEMINI_API_KEY`. Struktur und Defaults stehen in `.env.example`.
3. **Keine neue Dependency ohne Begruendung**, warum Standardbibliothek und die
   drei vorhandenen Pakete nicht reichen.
4. **Sprache im Code ist Deutsch in ASCII**, also `oe`, `ue`, `ae`, `ss`. Das
   gilt fuer Bezeichner, Kommentare, Fehlertexte und die Tool-Beschreibungen.
   README und LICENSE bleiben Englisch, weil das Repo oeffentlich ist.
5. **Eingaben an der Systemgrenze pruefen.** Dafuer gibt es die Fehlerklassen
   `FehlerEingabe`, `FehlerUrl`, `FehlerZeit`, `FehlerDownload`, `FehlerDatei`
   und `FehlerGemini`.

## Aufbau

| Datei | Rolle |
|---|---|
| `src/index.js` | MCP-Schicht: Tool-Registrierung, zod-Schema, stdio-Transport. Sonst nichts. |
| `src/analyze.js` | Fachlogik. Bewusst ohne MCP-Abhaengigkeit, damit sie per Node-Skript direkt aufrufbar bleibt. |
| `src/gemini.js` | Duenner Wrapper um den Gemini-Endpoint plus Uebersetzung der Fehlerursachen. |
| `src/quelle.js` | Quellenerkennung: YouTube, Instagram, lokaler Pfad, sonst Ablehnung. |
| `src/ytdlp.js` | Instagram-Download per yt-dlp. |
| `src/files.js` | Gemini Files API: hochladen, auf `ACTIVE` warten, loeschen. Gemeinsam fuer Instagram und lokale Dateien. |
| `src/lokal.js` | Lokale Dateien: pruefen, einmal hochladen, wiederverwenden, Status, loeschen. |
| `src/prompt.js`, `src/time.js`, `src/youtube.js` | Default-Prompt, Zeitparser, URL-Pruefung. |

Die Trennung ist der Grund, warum sich etwas testen laesst, obwohl es keine
Testsuite gibt. Fachlogik nicht in `index.js` ziehen.

## Drei Quellen, drei Wege

- **YouTube:** Gemini holt das Video selbst ueber die URL, nichts wird hochgeladen.
- **Instagram:** yt-dlp laedt herunter, Upload zur Files API, Analyse, danach
  wird die Kopie bei Google und die temporaere Datei im `finally` geloescht.
- **Lokal:** Upload zur Files API, die Kopie bleibt fuer Folgefragen liegen.
  Wiedererkennung ueber den Anzeigenamen `lokal-<Pfad-Hash>-<Versions-Hash>`
  (Pfad, Groesse, Aenderungszeit), also ohne lokale Zustandsdatei. Kopien mit
  weniger als einer Stunde Restlaufzeit werden neu hochgeladen, die Files API
  haelt Dateien 48 Stunden. Limit 2 GB pro Datei laut Files-API-Doku.

Aenderungen an einem Weg duerfen die anderen beiden nicht veraendern. Das
Loeschen nach jeder Frage gehoert nur zu Instagram.

## Gemini-Besonderheit

Der Server spricht durchgehend `POST /v1beta/interactions`, nicht
`models:generateContent`. Das Feld `processing`, das den Modus waehlt,
existiert auf `generateContent` gar nicht und quittiert dort mit
`400 INVALID_ARGUMENT`. Der agentic-Modus kostet fuer ein ganzes Video ein
Vielfaches weniger als die statische Verarbeitung, Messwerte stehen im README.
`mode: "auto"` schaltet erst unterhalb von 300 Sekunden Ausschnittslaenge auf
static um, `detail: "hoch"` ist immer eine bewusste Entscheidung.

## Projekt-Hooks

`.claude/hooks/guard.mjs`, verdrahtet in `.claude/settings.json`:

- **env-guard** (PreToolUse) blockt Zugriffe auf die Key-Datei, auch
  Bash-Befehle, in deren Text der Dateiname als Literal vorkommt. Wenn eine
  Commit-Message ihn nennt, hilft `git commit -F <datei>`.
- **syntax-check** (PostToolUse) laesst `node --check` ueber jede geaenderte
  `src/*.js` und blockt bei einem Syntaxfehler.

## Aenderungen pruefen

Es gibt keine Suite, also zaehlt der echte Aufruf: Server starten und
`analyze_video` gegen ein oeffentliches Video schicken. Jede Antwort weist den
Tokenverbrauch aus, Ausreisser dort sind das erste Warnsignal.

Fuer den lokalen Weg nur selbst erzeugte Testvideos ohne persoenliche Inhalte
hochladen, niemals private Videos des Nutzers ohne seine ausdrueckliche
Entscheidung. Nach dem Test mit `manage_local_video` und `action: "delete"`
aufraeumen.
