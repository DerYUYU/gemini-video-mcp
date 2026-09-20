# gemini-video-mcp

MCP-Server, der öffentliche YouTube-Videos über die Google-Gemini-API analysiert.
Bild- und Tonspur werden gemeinsam ausgewertet — ein separates Transkript ist nicht nötig.

Der Server spricht **stdio** und stellt genau ein Tool bereit: `analyze_video`.
Kein HTTP, kein Gateway, kein Token, kein systemd.

## Warum das wichtig ist: zwei Endpunkte, ein großer Unterschied

Gemini kann YouTube-Videos auf zwei Wegen verarbeiten. Dieser Server nutzt
konsequent den zweiten:

| | `models:generateContent` | `POST /v1beta/interactions` (agentic) |
|---|---|---|
| Vorgehen | Video Frame für Frame ins Kontextfenster | Das Modell navigiert selbst durchs Video |
| 15-Minuten-Video | **85.480 Tokens** | **7.416 Tokens** |
| Antwortqualität | unvollständig | vollständiger |

Das sind **rund 91 % weniger Tokens bei besserer Qualität**. Deshalb geht hier
alles über `interactions`. Das Feld `processing`, über das die Betriebsart
gewählt wird, existiert in `generateContent` ohnehin nicht — ein Versuch dort
quittiert die API mit `400 INVALID_ARGUMENT: Unknown name "processing"`.

Eigene Messungen dieses Servers am Video `b3WiM0o3bF8` (15 min):

| Aufruf | Modus | Tokens |
|---|---|---|
| Ganzes Video, gezielte Frage | agentic | 8.203 |
| Ausschnitt 10:30–12:30 | static, `low` | 11.293 |
| Ausschnitt 10:30–12:30 | static, `high` | 35.922 |

Bemerkenswert: `low` fand im Ausschnitt denselben nur im Bild sichtbaren
GitHub-Repository-Namen wie `high` — für ein Drittel der Kosten. Deshalb bleibt
die hohe Auflösung eine bewusste Entscheidung (`detail: "hoch"`) statt ein
Automatismus.

## Installation

Voraussetzung: **Node ≥ 22** (entwickelt und getestet mit 24.16).

```bash
npm install
```

## Konfiguration

Der API-Key kommt aus einer `.env` im Projektverzeichnis (Vorlage:
`.env.example`) oder aus der Umgebung der MCP-Konfiguration.

```ini
# Pflicht: Key aus Google AI Studio
GEMINI_API_KEY=dein-key

# Optional, Default gemini-3.8-flash
GEMINI_MODEL=gemini-3.8-flash

# Optional, Timeout in Millisekunden. Default 600000 (10 Minuten).
GEMINI_TIMEOUT_MS=600000
```

`.env` ist in `.gitignore` und gehört niemals ins Repository.

### Registrierung beim MCP-Client

```bash
claude mcp add gemini-video -- node /absoluter/pfad/zu/gemini-video-mcp/src/index.js
```

Oder direkt in der Client-Konfiguration:

```json
{
  "mcpServers": {
    "gemini-video": {
      "command": "node",
      "args": ["/absoluter/pfad/zu/gemini-video-mcp/src/index.js"]
    }
  }
}
```

Der Key kann alternativ hier als `"env": { "GEMINI_API_KEY": "..." }` gesetzt
werden, statt über `.env`.

## Tool: `analyze_video`

| Parameter | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `url` | string | ja | — | URL eines **öffentlichen** YouTube-Videos. Akzeptiert `watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`. |
| `prompt` | string | nein | Vollanalyse | Die Frage an das Video. Ohne Angabe wird eine strukturierte Komplettanalyse angefordert (siehe unten). |
| `mode` | `agentic` \| `static` \| `auto` | nein | `auto` | Betriebsart, siehe nächster Abschnitt. |
| `start` | string \| number | nein | — | Beginn eines Ausschnitts. `"12:30"`, `"1:02:30"`, `"750s"` oder Millisekunden als Zahl (`750000`). |
| `end` | string \| number | nein | — | Ende des Ausschnitts, gleiche Formate. |
| `detail` | `normal` \| `hoch` | nein | `normal` | `hoch` erzwingt `static` mit hoher Auflösung (~300 statt ~100 Tokens pro Videosekunde). |

Die Antwort nennt immer **Modus, Auflösung, Ausschnitt, Modell und den
verbrauchten Tokenwert**, damit die Kosten jedes Aufrufs sichtbar sind.

### Der Default-Prompt

Ohne eigenen `prompt` fordert der Server eine Analyse in fünf Teilen an:
Kurzfassung, Kapitel mit Zeitstempeln über das gesamte Video, wichtigste
Aussagen mit Zeitstempeln, ausdrücklich das **visuell Gezeigte** (Bildschirm-
inhalte, Code, Hardware, Einblendungen) und ein Fazit. Der Hinweis auf die
Bildspur steht bewusst drin: ohne ihn fällt das Modell häufig auf eine reine
Transkript-Zusammenfassung zurück.

### Die beiden Modi

**`agentic`** — das Modell sucht sich selbst die relevanten Stellen im Video.
Kennt keine harten Zeit-Offsets. Die erste Wahl für ganze Videos und für jede
inhaltliche Frage.

**`static`** — das Video wird Sekunde für Sekunde verarbeitet. Erlaubt exaktes
Zuschneiden über `start`/`end` sowie die hohe Auflösung, kostet aber ~100
(`low`) bis ~300 (`high`) Tokens pro Videosekunde. Ohne Ausschnitt wird das bei
langen Videos sehr teuer.

**`auto`** (Default) entscheidet so:

| Situation | Ergebnis |
|---|---|
| `detail: "hoch"` | `static`, Auflösung `high` |
| Ausschnitt ≤ 5 Minuten | `static`, Auflösung `low` |
| Ausschnitt > 5 Minuten | `agentic` (der Bereich steht im Prompt) |
| kein Ausschnitt | `agentic` |

Wird `mode` ausdrücklich gesetzt, gilt das — außer `detail: "hoch"` verlangt
zwingend `static`. Solche Übersteuerungen meldet die Antwort unter „Hinweise".

### Beispiele

```jsonc
// Komplette Analyse eines Videos, günstigster Weg
{ "url": "https://www.youtube.com/watch?v=VIDEOID" }

// Gezielte Frage
{ "url": "https://youtu.be/VIDEOID",
  "prompt": "Welche Werkzeuge empfiehlt der Sprecher? Mit Zeitstempeln." }

// Ausschnitt exakt zuschneiden -> auto wählt static/low
{ "url": "https://www.youtube.com/watch?v=VIDEOID",
  "start": "10:30", "end": "12:30",
  "prompt": "Was steht in diesem Abschnitt auf dem Bildschirm?" }

// Feine Bilddetails, teuer -> nur mit kurzem Ausschnitt sinnvoll
{ "url": "https://www.youtube.com/watch?v=VIDEOID",
  "start": "14:00", "end": "14:40", "detail": "hoch",
  "prompt": "Lies den Code im Terminal Zeile für Zeile vor." }
```

## Bekannte Grenzen

- **Nur öffentliche Videos.** Private, nicht gelistete, gelöschte oder regional
  gesperrte Videos schlagen fehl. Die API meldet das als `403 The caller does
  not have permission`, ohne das Video zu erwähnen; der Server prüft in diesem
  Fall den Key aktiv gegen und formuliert die Ursache entsprechend.
- **Free Tier: maximal 8 Stunden YouTube-Material pro Tag**, dazu Limits pro
  Minute. Beides quittiert die API mit HTTP 429.
- **Lange Videos brauchen Zeit.** Im agentic-Modus sind mehrere Minuten normal.
  Default-Timeout 10 Minuten, anpassbar über `GEMINI_TIMEOUT_MS`.
- **Keine Bild- oder PDF-Analyse.** Der Server macht ausschließlich Video.
- **`start`/`end` wirken nur im statischen Modus.** Im agentic-Modus wird der
  gewünschte Bereich in den Prompt geschrieben, aber nicht hart zugeschnitten.
- Zeitstempel stammen vom Modell und können um einige Sekunden abweichen.

## Fehlermeldungen

Der Server gibt nie einen rohen Stacktrace zurück, sondern eine erklärte
Ursache: fehlender Key, abgelehnter Key, nicht abrufbares Video, erschöpftes
Kontingent, Zeitüberschreitung, Netzwerkproblem, Serverfehler, ungültige
Eingabe. Der API-Key wird dabei grundsätzlich nicht ausgegeben — auch nicht
teilweise.

## Projektstruktur

| Datei | Aufgabe |
|---|---|
| `src/index.js` | MCP-Server, stdio-Transport, Tool-Registrierung |
| `src/analyze.js` | Eingabeprüfung, Moduswahl, Ergebnisformatierung |
| `src/gemini.js` | Wrapper um `@google/genai` → `interactions`, Fehlerübersetzung |
| `src/prompt.js` | Default-Prompt und Zeitrahmen-Zusatz |
| `src/time.js` | Zeitparsing, Normalisierung auf Sekunden |
| `src/youtube.js` | URL-Validierung |

`src/analyze.js` ist bewusst frei von MCP-Abhängigkeiten und lässt sich direkt
per Node-Skript testen.
