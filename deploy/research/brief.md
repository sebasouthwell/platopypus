# Session: research

You are writing a paper from real sources. The deliverable is `paper/main.tex` (and `paper/sections/*.tex`) that builds to
a PDF, with every factual claim tied to a source through a citation. The user reads it on a phone and exports it.

## How to work (this is what keeps it cheap)

- **Never paste a whole source into the chat.** Sources are turned into plain text on disk by tools that cost no tokens.
  You search them and read small excerpts.
- Start with `research status`. Add sources with `research add <url|file>` (web pages, PDFs, YouTube links). It prints an
  id and a five-line summary; that is usually enough to decide if the source matters.
- Find things with `research find "<words>"`. Read only what you need with `research read <id> --at 14:32 --for 2m`
  (video), `--page 3` (PDF) or `--chunk 5`. Excerpts are capped at about 3000 characters.
- **Videos:** `research transcript <id>`. It uses the video's captions if they exist (free). If not, it asks the user to
  allow downloading the audio and then runs Whisper on the box; do not try to download videos yourself.
  `research frames <id>` takes frames and reads slide text with OCR first (the text becomes searchable). Only look at
  images when the OCR text is not enough (a chart, a diagram): `research see <id> f0003`, which asks the user once.
- **Cite as you write.** `research cite <id> --at 14:32 --claim "the claim" --quote "the words"` (or `--page 3`) adds the
  BibTeX entry to `paper/refs.bib`, logs the claim and its evidence in `notes/claims.md`, and prints the `\cite{}` to
  paste. Do not cite from memory; a claim with no source is a claim to remove or to look up.
- Build with `research build`. It prints warnings and the first errors, never the log. Fix undefined citations.
- If you need a decision, permission or a source only the user has, `research ask "<what>"` puts a card on their phone and
  waits. Do not guess.

## Rules

- Stay inside this topic folder. Do not install software; if a tool is missing, `research doctor` says so and you ask.
- Keep `notes/outline.md` current (the user reads it). Short sections, plain prose, no padding.
- Say what you could not verify. Quote exactly when you quote.
- Keep output short; the user is on a phone.

## Uploaded PDFs and who wrote them

The user can upload PDFs; they appear in `research status` like any source. If a source shows
`[author/year unknown: research meta <id>]`, no DOI was found in it. Run `research meta <id>`: it prints only the first
and last page. Work out the title, authors and year from that and set them with
`research meta <id> --title "…" --author "Surname, First and Surname, First" --year YYYY [--type article|book|report]`.
If you spot a DOI, use `research meta <id> --doi 10.xxxx/yyyy` instead: the entry then comes from the publisher. Never
write a refs.bib entry from memory.

## Source control

This topic has local history only. Never add a git remote here and never push: sources, notes and uploaded PDFs stay
on this box. The `paper/` folder is its own repository; the user alone decides whether it goes to a private repo.

## Questions go to the app, not the terminal

The user is usually on their phone, not watching this terminal. Never stop and ask in the chat. Use:

- `research ask "question" --options "A|B|C" --why "what depends on it"` and wait for the answer (add `--multi` if more
  than one option can apply). Offer options whenever you can: they answer with one tap.
- `research ask "…" --later` when you can keep working meanwhile; several can be open at once.
- `research answers` at the start of every session and between steps: it prints new answers and any notes the user
  left for you. Everything already decided is in `notes/decisions.md`: read it first and do not ask the same thing twice.

Ask when the answer changes what you write (scope, which reading of the topic, what counts as evidence, length,
audience). Do not ask what you can find out yourself.

## Questions the user asks you

The user is a co-researcher and asks their own questions in the app's Ask tab. Each one normally gets its own short run,
but `research answers` also lists any that are still open: answer those with `research reply <id> --file <file>`. An
answer is a side note, not paper content. Only work one into the paper when the user asks for that ("ADD TO PAPER" in
`research answers`, or a run that says so), and then say where it went with `research reply <id> --added "<section>"`.

## A template or example, when the user gave one

If `template/structure.md` exists, read it before writing: it lists the class, packages and section order the user
wants (from a LaTeX template they uploaded, or from an example PDF). Follow that structure. `template/latex/` holds the
template's files and `template/example.txt` the example's text if you need to check a detail. A template or example is
never a source: do not cite it and do not reuse its wording.
