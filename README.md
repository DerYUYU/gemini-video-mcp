# gemini-video-mcp

An MCP server that lets Claude — or any other MCP client — understand public
YouTube videos, both what is said and what is shown, through the Google Gemini
API. It exposes a single tool, `analyze_video`, over stdio.

## Why

Language models cannot watch YouTube videos. The usual workaround is to paste a
transcript by hand, which throws away everything that only appears on screen, or
to ask a second app and copy the answer back. This server removes that detour:
the client asks a question about a URL and gets an answer grounded in the audio
*and* the video track.

## What it does

- Full analysis with chapters and timestamps across the whole video
- Targeted analysis of a specific time range
- Audio and visuals evaluated together — on-screen text, code, diagrams and
  demos are part of the answer, no separate transcript needed
- Token usage reported on every call, so the cost of each request is visible

## The agentic finding

This is why the project exists rather than just calling `generateContent`.

Gemini can process YouTube videos two ways. The classic endpoint,
`models:generateContent`, pulls the video into the context window frame by
frame. The `POST /v1beta/interactions` endpoint in agentic mode lets the model
navigate the video itself.

Same 15-minute video, same question:

| | `models:generateContent` | `interactions` (agentic) |
|---|---|---|
| Tokens | **85,480** | **7,416** |
| Answer | incomplete | more complete coverage |

Roughly **91 % fewer tokens, with better coverage**. This server therefore uses
`interactions` throughout. The `processing` field that selects the mode does not
exist on `generateContent` at all — sending it there returns
`400 INVALID_ARGUMENT: Unknown name "processing"`.

Measurements taken with this server on a 15-minute video:

| Call | Mode | Tokens |
|---|---|---|
| Whole video, specific question | agentic | 8,203 |
| Range 10:30–12:30 | static, `low` | 11,293 |
| Range 10:30–12:30 | static, `high` | 35,922 |

Worth noting: `low` picked up the same on-screen-only GitHub repository name
that `high` did, for a third of the cost. High resolution is therefore a
deliberate choice (`detail: "hoch"`), never automatic.

## Requirements

- **Node 22 or newer** (developed and tested on 24.16)
- **Your own Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)

## Installation

```bash
git clone https://github.com/DerYUYU/gemini-video-mcp.git
cd gemini-video-mcp
npm install
```

Create a `.env` file next to `package.json` (see `.env.example`):

```ini
GEMINI_API_KEY=your-key-here
```

`.env` is gitignored and must never be committed.

### Register with your MCP client

For Claude Code:

```bash
claude mcp add gemini-video -- node /path/to/gemini-video-mcp/src/index.js
```

For clients that use a configuration file (Claude Desktop and others):

```json
{
  "mcpServers": {
    "gemini-video": {
      "command": "node",
      "args": ["/path/to/gemini-video-mcp/src/index.js"]
    }
  }
}
```

Replace `/path/to/gemini-video-mcp` with the absolute path to your clone. The
key can also be passed here instead of via `.env`:

```json
{
  "mcpServers": {
    "gemini-video": {
      "command": "node",
      "args": ["/path/to/gemini-video-mcp/src/index.js"],
      "env": { "GEMINI_API_KEY": "your-key-here" }
    }
  }
}
```

## Usage

The client calls the tool; you normally just ask in plain language. The
arguments below are what the tool receives.

**A simple question about a video**

```jsonc
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "prompt": "Which tools does the speaker recommend? Include timestamps."
}
```

**Analysing a specific range** — `auto` switches to the static mode here and
cuts exactly to the requested window:

```jsonc
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "start": "10:30",
  "end": "12:30",
  "prompt": "What is shown on screen during this part?"
}
```

**Higher visual detail** — roughly three times the tokens per video second, so
only worth it on a short range:

```jsonc
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "start": "14:00",
  "end": "14:40",
  "detail": "hoch",
  "prompt": "Read the code in the terminal line by line."
}
```

**Leaving out `prompt`** requests a full structured analysis: summary, chapters
with timestamps covering the entire video, key statements, what is shown
visually, and a closing assessment.

### Example output

Every answer starts with a header stating mode, resolution, range, model and
token usage. Abbreviated real output from a question about a speaker's Linux
setup:

```markdown
**Video:** https://www.youtube.com/watch?v=VIDEO_ID
**Modus:** agentic
**Tokenverbrauch:** 8.203 Tokens
**Modell:** gemini-3.8-flash

---

* **Distribution [ca. 10:45 – 10:57]:**
  Er nutzt das aktuelle **CachyOS**, eine auf **Arch Linux** basierende
  Distribution [...]

* **Fingerabdrucksensor [ca. 14:27 – 15:02]:** Der Sensor wird unter Linux zwar
  prinzipiell unterstützt, ist im Alltag jedoch extrem unzuverlässig [...]
```

See [Response language](#response-language) for why this example is in German.

## Tool reference: `analyze_video`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | — | URL of a **public** YouTube video. Accepts `watch?v=`, `youtu.be/`, `/shorts/`, `/live/` and `/embed/` forms. |
| `prompt` | string | no | full analysis | The question to ask. Omitted, a complete structured analysis with chapters and timestamps is requested. |
| `mode` | `agentic` \| `static` \| `auto` | no | `auto` | Processing mode, see below. |
| `start` | string \| number | no | — | Start of a range: `"12:30"`, `"1:02:30"`, `"750s"`, or milliseconds as a number (`750000`). |
| `end` | string \| number | no | — | End of the range, same formats. |
| `detail` | `normal` \| `hoch` | no | `normal` | `hoch` ("high") forces the static mode at high resolution, roughly 300 instead of 100 tokens per video second. |

### Modes

**`agentic`** — the model navigates the video itself and picks the relevant
passages. It has no hard time offsets. The right choice for whole videos and for
any question about content.

**`static`** — the video is processed second by second. This allows exact
trimming via `start`/`end` and the high resolution setting, but costs roughly
100 (`low`) to 300 (`high`) tokens per video second. Without a range it gets
expensive fast on long videos.

**`auto`** (default) decides as follows:

| Situation | Result |
|---|---|
| `detail: "hoch"` | `static`, resolution `high` |
| Range of 5 minutes or less | `static`, resolution `low` |
| Range longer than 5 minutes | `agentic`, with the range stated in the prompt |
| No range | `agentic` |

An explicit `mode` is honoured, except that `detail: "hoch"` always requires
`static`. Any such override is reported in the answer under "Hinweise" (notes).

## Limits and cost

- **Public videos only.** Private, unlisted, deleted or region-blocked videos
  fail.
- **Free tier: 20 requests per day** for `gemini-3.8-flash`. This is the limit
  you will actually hit — not the frequently cited 8 hours of YouTube footage
  per day. Both are reported as HTTP 429.
- **Token cost in static mode** is about 100 tokens per video second at `low`
  and about 300 at `high`. Agentic mode does not scale this way; the
  measurements above are representative.
- **An API key bills separately** from any Google AI subscription. A paid
  Gemini app plan does not cover API usage.
- **Long videos take time.** Several minutes is normal in agentic mode. The
  default timeout is 10 minutes, adjustable via `GEMINI_TIMEOUT_MS`.
- **`start`/`end` only take effect in static mode.** In agentic mode the
  requested range is written into the prompt but not hard-trimmed.
- Timestamps come from the model and can be off by a few seconds.
- Video only. No image or PDF tooling.

## Response language

The model answers in the language of the question you ask. The default prompt
and the tool's own output labels and notes ship in German, so a call without an
explicit `prompt` returns a German analysis — as in the example above. Pass your
own `prompt` in English to get an English answer.

## Three deviations from Google's documentation

All three were verified against the live API and cost real debugging time. If
you are building against this API yourself, they are worth knowing.

**1. Time offsets are second-strings, not millisecond numbers.**
`processing.start_offset` and `end_offset` accept only strings with an `s`
suffix, such as `"630s"`. Passing raw milliseconds returns
`400 Invalid input at 'input[0].processing'`. This server accepts `"12:30"`,
`"750s"` and milliseconds from the caller and converts internally.

**2. The field is `resolution`, not `media_resolution`.**
`media_resolution` is the `generateContent` name. On the `interactions`
endpoint the setting sits directly on the video input as `resolution`.

**3. The two most common errors are signalled the wrong way round.**
An unreachable video returns `403 The caller does not have permission` — with no
mention of the video at all. An invalid API key returns `400` with an *empty*
message body. Classifying these by their text alone reports a private video as a
key problem. This server resolves the ambiguity by issuing a `models.list` call
with the same key, which takes about 0.1 s, costs no tokens, and only runs on
the error path.

## Project layout

| File | Purpose |
|---|---|
| `src/index.js` | MCP server, stdio transport, tool registration |
| `src/analyze.js` | Input validation, mode selection, result formatting |
| `src/gemini.js` | Wrapper around `@google/genai` → `interactions`, error translation |
| `src/prompt.js` | Default prompt and time-range addendum |
| `src/time.js` | Time parsing, normalisation to seconds |
| `src/youtube.js` | URL validation |

`src/analyze.js` has no MCP dependencies and can be exercised directly from a
Node script.

## Configuration reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Key from Google AI Studio |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | Model to use |
| `GEMINI_TIMEOUT_MS` | no | `600000` | Request timeout in milliseconds |

## License

MIT — see [LICENSE](LICENSE).
