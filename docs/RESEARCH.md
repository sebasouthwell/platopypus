# Research: step 2 (design, nothing built yet)

Step 1 was Projects: an agent builds an app in `/Projects/<name>`. Step 2 is Research: an agent builds a paper in
`/Research/<Topic>`, reading real sources, citing them properly, and producing LaTeX you can read and export from the
phone. It uses the same agents, the same session picker (Project · Control · **Research**), the same permission
pattern (ask, show exactly what happens, wait) and the same audit log.

## The one idea that keeps it cheap

**The box does the heavy reading; the agent reads small, searchable text.** Every source is turned into plain text on
disk by tools that run outside the model (captions, Whisper, OCR, PDF text). The agent never receives a whole transcript
or a whole PDF: it gets a short summary and an id, then asks for excerpts (`read 11 --at 14:30 --for 2m`) or searches
(`find "conversion loss"`). Nothing it has already pulled is fetched or re-read again.

## What a topic is

```
/Research/Tidal-energy-storage/
  paper/            main.tex, sections/*.tex, refs.bib, figures/, build/main.pdf   (what you read and export)
  sources/<id>/     meta.json, text.md, (video) transcript.vtt, frames/ with ocr.json, (pdf) pages.json
  notes/            outline.md, claims.md (each claim -> source id + quote + timestamp/page)
  .platopypus/      research.json (state), permissions/ (pending asks), index/ (search index), cost.json
```

Every claim an agent writes in `notes/claims.md` carries its evidence; `research cite` turns a claim into a `\cite`
with the BibTeX entry and a page or timestamp, so references are real, not remembered.

## The hidden tools (CLIs on the box, like `vault` and `credshare`)

| Command | What it does | Tokens |
|---|---|---|
| `research add <url or file>` | Fetches a page, PDF or video, makes `sources/<id>/`, prints id + 5-line summary | none |
| `research transcript <id>` | Captions if they exist (free). Otherwise **asks you** to download the audio, then Whisper on the box | none |
| `research frames <id> --every 30s` | Takes frames, OCRs each (Tesseract), keeps the text; flags frames with charts or little text | none |
| `research see <id> <frame…>` | Hands chosen frames to the agent as images (only the flagged ones, only after OCR) | images only |
| `research find "<query>"` / `read <id> --at …` | Searches the index / returns an excerpt, with a cost shown | small |
| `research cite <claim>` | Writes the BibTeX entry and `\cite{}` for a claim, with page or timestamp | none |
| `research build` | `latexmk`; returns warnings, never the log | none |
| `research ask <what>` | Puts a card in your inbox and waits for Allow or Skip | none |

The agents' global instructions get a Research block (like the Project and Control ones): read the brief, use these
tools, never paste a whole source into the chat, cite everything through `research cite`.

## Permissions (what is never automatic)

Downloading a video or its audio; extracting frames from a video; sending frames to the model; and anything outside
the source's own site. Each is a card in the Needs-you inbox (see the mockup), logged in the audit log with the
address. Captions, page text and PDF text are fetched without asking, as a browser would.

## The GUI (see `web/design/research-mockup.html`)

- **List:** one card per topic, with the real first page as its cover; an amber inbox strip for anything waiting on you.
- **Topic, Paper tab:** the built PDF as swipeable pages; tappable citations (amber paper or article, blue video moment);
  Build, Export (PDF, LaTeX, BibTeX, zip).
- **Sources tab:** every source with its state (text ready, transcript from captions or Whisper, frames OCR'd,
  waiting for permission). A **reader** per source: the transcript with timestamps, the frame strip with OCR text, and
  counters for what the agent actually read, so you can see the savings.
- **Notes tab:** the outline and the claims, each with its evidence.
- **Agent tab:** the live terminal, as in Shells.
- **Where it lives:** a Research entry beside Files (bottom bar on phone; sidebar on desktop), and a "Research" choice
  next to Project and Control when you start an agent.

## Local first

Built and tried on this PC in the Docker test box before it goes anywhere near the live one. The image gains
`texlive` (the small set, with `latexmk` and `biber`), `ffmpeg`, `yt-dlp`, `tesseract-ocr` and `faster-whisper`. On the
live box (4 GB, 50 GB disk) the full TeX Live is too big and CPU Whisper is slow, so the plan is: LaTeX in a small
builder container, and Whisper either with the small model on the box or through your OpenAI key
(`vault run OPENAI_API_KEY`, a few cents per hour of audio) as a switch in the topic.

## Build order

1. **Skeleton:** `/Research`, the Research session type and brief, the topic list and an empty topic page; `research
   add` for web pages and PDFs (text only); `research build` and the Paper tab with export.
2. **Sources and tokens:** the index, `find` / `read`, `cite` with BibTeX, the cost counters, the Sources tab and reader.
3. **Video:** captions, then permission-gated download and Whisper; frames with OCR; the inbox and its alerts.
4. **Polish:** per-topic settings (Whisper local or API), citation styles, a share link for a finished PDF.

## Decisions for you

1. **Whisper on the live box:** small model on CPU (free, slow) or your OpenAI key (fast, pennies)?
2. **LaTeX on the live box:** builder container (clean, a few hundred MB pulled once) or the small TeX Live installed on the box?
3. **Where it sits on the phone:** replace nothing and add Research as a sixth entry in the bar, or fold Shells and Research under one tab?
4. **Local first:** the Docker test box on this PC, using the GPU for Whisper?

## Editor, uploads and source control (built, local test only)

- `/editor.html?topic=<slug>`: edit `main.tex`, sections and `refs.bib`; build; click a citation (in the text or in the
  preview) to open its source at the cited page or timestamp.
- Upload a PDF (button or drag and drop): stored as `sources/<id>/original.pdf` with its SHA-256; a DOI on the first two
  pages gives the publisher's BibTeX via doi.org; without one the agent sets the metadata from the first and last page
  (`research meta <id>`).
- Two git repositories per topic. `/Research/<Topic>` (sources, PDFs, notes) is local history and can never be flagged
  for publishing. `/Research/<Topic>/paper` (LaTeX and refs.bib) may be flagged private, never public. Both rules are
  enforced in `projects.setRepoFlag` and again in `projects.allowPush`.
