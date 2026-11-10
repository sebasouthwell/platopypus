// Research tools test (run inside the test box): node /opt/test/research.mjs
// Pure logic always runs; anything needing LaTeX, ffmpeg, OCR, poppler or yt-dlp runs only where they are installed
// (research setup installs them; CI's image does not carry them and prints SKIP).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const T = await import('/opt/platopypus/server/lib/researchtools.js');
const R = await import('/opt/platopypus/server/lib/research.js');
let failures = 0, checks = 0;
const check = (name, ok, extra = '') => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failures++; };
const skip = why => console.log(`SKIP  ${why}`);
const sh = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const have = async b => !!(await T.which(b));

// ---- a topic made the way the app makes it ----
const created = await R.create({ title: 'Test tidal storage', brief: 'Smoke test topic' });
const slug = created.slug, dir = path.join(R.ROOT, slug);
check('a topic is a folder with a paper, sources, notes and a brief', ['paper/main.tex', 'paper/refs.bib', 'sources', 'notes/outline.md', '.platopypus/research.md', '.platopypus/research.json'].every(f => fs.existsSync(path.join(dir, f))), slug);
check('the topic shows in the list as gathering with no sources', R.list().some(t => t.slug === slug && t.status === 'gathering' && t.sources === 0));
check('a topic title needs some length', await R.create({ title: 'x' }).then(() => false, e => e.status === 400));
check('a bad slug is refused', (() => { try { R.topicPath('../etc'); return false; } catch (e) { return e.status === 400; } })());
check('a folder inside the topic maps back to it', R.topicOf(path.join(dir, 'paper', 'sections')) === slug && R.topicOf('/Projects/x') === null);

// ---- captions ----
const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
So we ran it

00:00:03.000 --> 00:00:05.000
So we ran it for a full season

00:00:05.000 --> 00:00:07.500
for a full season on the pilot site.

00:00:14.000 --> 00:00:18.000 align:start
<c>The dominant loss is not the turbine,</c>

00:00:18.000 --> 00:00:22.000
it is the conversion step. That alone is about twenty two percent.
`;
const cues = T.parseVtt(VTT);
check('captions: rolling repeats are collapsed to each phrase once', cues.map(c => c.text).join(' ').match(/So we ran it/g).length === 1, JSON.stringify(cues.map(c => c.text)));
check('captions: tags are stripped and times are kept', cues.some(c => c.t === 14 && c.text === 'The dominant loss is not the turbine,'));
check('time words parse (14:32, 1:02:03, 90s, 2m)', T.parseTime('14:32') === 872 && T.parseTime('1:02:03') === 3723 && T.parseTime('90s') === 90 && T.parseTime('2m') === 120);

// ---- web pages (a local server stands in for the internet) ----
const PAGE = `<html><head><title>Pumped storage &amp; the grid</title><meta name="author" content="Ada Lovelace"><meta property="og:site_name" content="Grid Journal"><meta property="article:published_time" content="2024-05-01"></head><body><nav>menu</nav><article><h1>Pumped storage</h1><p>Round-trip efficiency of pumped hydro is typically seventy to eighty percent, with the conversion step costing the most.</p><p>The best reservoir sites are already taken in most coastal regions.</p><script>alert(1)</script></article><footer>copyright</footer></body></html>`;
const srv = http.createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
await new Promise(ok => srv.listen(8997, '127.0.0.1', ok));
const added = await T.addSource(dir, 'http://127.0.0.1:8997/page.html', { note: 'background' });
srv.close();
check('a web page becomes text without scripts or menus, with its title, author and year', added.meta.id === 's01' && added.meta.title === 'Pumped storage & the grid' && added.meta.author === 'Ada Lovelace' && added.meta.year === '2024' && !fs.readFileSync(path.join(dir, 'sources', 's01', 'text.md'), 'utf8').match(/alert|menu|copyright/), JSON.stringify(added.meta).slice(0, 200));
check('adding a source prints a short summary, not the text', added.summary.length < 700 && /^s01\s+web/.test(added.summary), added.summary.slice(0, 120));

// ---- a video source with captions, from a file (no network) ----
const vid = path.join(dir, 'sources', 's02'); fs.mkdirSync(vid, { recursive: true });
T.writeJson(path.join(vid, 'meta.json'), { id: 's02', kind: 'video', title: 'Why the conversion step costs 22%', author: 'Grid Futures Lab', year: '2025', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', added: Date.now(), chars: 0, state: {} });
fs.writeFileSync(path.join(vid, 'text.md'), '# video\n');
const vf = path.join(dir, 'c.vtt'); fs.writeFileSync(vf, VTT);
const tr = await T.transcript(dir, 's02', { vttFile: vf });
const vtext = fs.readFileSync(path.join(vid, 'text.md'), 'utf8');
check('a transcript from captions makes searchable timestamped text', tr.how === 'captions' && /\[00:01\] So we ran it for a full season/.test(vtext) && /dominant loss/.test(vtext), JSON.stringify(tr));

// ---- search and reading cost tokens only for what is read ----
const hits = T.find(dir, 'conversion step efficiency');
check('find ranks the sources and gives short snippets with where they are', hits.length >= 2 && hits.every(h => h.snippet.length < 500) && hits.some(h => h.id === 's02' && h.loc.includes(':')) && hits.some(h => h.id === 's01'), JSON.stringify(hits.map(h => [h.id, h.loc])));
check('find can be limited to one source', T.find(dir, 'conversion', { source: 's01' }).every(h => h.id === 's01'));
const ex = T.readExcerpt(dir, 's02', { at: '0:10', span: '15s' });
check('a video excerpt is the lines in that window', /dominant loss/.test(ex.text) && !/So we ran it/.test(ex.text), ex.where);
check('an excerpt is capped', T.readExcerpt(dir, 's01', { max: 100 }).text.length <= 140);
const cost = T.costOf(dir);
check('the counters say what was ingested, searched and read', cost.ingestedChars > 200 && cost.excerpts >= 2 && cost.searches >= 2 && cost.readChars > 0, JSON.stringify(cost));
check('a missing source is a clear 404', (() => { try { T.readExcerpt(dir, 's77', {}); return false; } catch (e) { return e.status === 404; } })());

// ---- references ----
const c = T.cite(dir, 's02', { at: '14:32', quote: 'The dominant loss is not the turbine', claim: 'The conversion step dominates losses' });
const bib = fs.readFileSync(path.join(dir, 'paper', 'refs.bib'), 'utf8');
check('cite writes a BibTeX entry and returns the \\cite to paste, with the timestamp', c.key === 'lab2025s02' && c.latex === '\\cite[14:32]{lab2025s02}' && /@misc\{lab2025s02,/.test(bib) && /Grid Futures Lab/.test(bib), c.latex);
T.cite(dir, 's02', { at: '15:00' });
check('citing again does not duplicate the entry', (fs.readFileSync(path.join(dir, 'paper', 'refs.bib'), 'utf8').match(/@misc\{lab2025s02,/g) || []).length === 1);
check('the claim and its evidence are logged', /The conversion step dominates losses — \[s02 @14:32\] "The dominant loss/.test(fs.readFileSync(path.join(dir, 'notes', 'claims.md'), 'utf8')));

// ---- asks: what the agent may not do alone ----
const a = R.createAsk(path.join(dir, 'paper'), { type: 'download-audio', title: 'Download a video to transcribe it?', detail: { video: 'x', url: 'https://youtu.be/AAAAAAAAAAA' } });
check('an ask is pending until the user decides, and shows in the pending list', a.status === 'pending' && R.pendingAsks().some(x => x.id === a.id && x.topic === slug));
check('an ask outside a research topic is refused', (() => { try { R.createAsk('/Projects/x', { type: 'question', title: 'q' }); return false; } catch (e) { return e.status === 403; } })());
check('only known ask types are accepted', (() => { try { R.createAsk(dir, { type: 'rm-rf', title: 'q' }); return false; } catch (e) { return e.status === 400; } })());
const d = R.decide(slug, a.id, { allow: true });
check('allowing records the decision once', d.status === 'allowed' && (() => { try { R.decide(slug, a.id, { allow: false }); return false; } catch (e) { return e.status === 409; } })());
check('the agent can read the decision back', R.getAsk(dir, a.id).status === 'allowed');

// ---- the paper (needs LaTeX) ----
if (await have('latexmk')) {
    T.cite(dir, 's01', { claim: 'Round-trip efficiency is 70 to 80 percent' });
    fs.writeFileSync(path.join(dir, 'paper', 'sections', 'introduction.tex'), `\\section{Introduction}\nPumped hydro returns about seventy to eighty percent of the energy \\cite{lovelace2024s01}, and the conversion step is the dominant loss \\cite[14:32]{lab2025s02}. A missing one \\cite{nobody}.\n`);
    const b = await R.build(slug);
    check('the paper builds, and undefined citations are reported by key', b.ok === true && b.pages >= 1 && b.undefinedCites.includes('nobody'), JSON.stringify({ ok: b.ok, pages: b.pages, undefinedCites: b.undefinedCites, errors: b.errors }));
    if (await have('pdftoppm')) check('pages are rendered as images for the phone', R.detail(slug).pagesAvailable >= 1 && fs.statSync(R.pageFile(slug, 1)).size > 3000);
    else skip('page images (pdftoppm)');
    fs.writeFileSync(path.join(dir, 'paper', 'sections', 'introduction.tex'), '\\section{Broken}\n\\undefinedcommand\n');
    const bad = await R.build(slug);
    check('a broken paper reports its first error and does not pretend it built', bad.ok === false && bad.errors.length >= 1, JSON.stringify(bad.errors));
    fs.writeFileSync(path.join(dir, 'paper', 'sections', 'introduction.tex'), `\\section{Introduction}\nPumped hydro \\cite{lovelace2024s01}.\n`);
    await R.build(slug);
    const ex1 = await R.exportFile(slug, 'tex'); const zl = sh(`unzip -l ${ex1.file} | grep -c "main.tex"`); fs.rmSync(ex1.file, { force: true });
    check('export as LaTeX gives a zip with the source and no build output', zl === '1');
    check('export as PDF and BibTeX point at the real files', (await R.exportFile(slug, 'pdf')).file.endsWith('main.pdf') && (await R.exportFile(slug, 'bib')).file.endsWith('refs.bib'));
    // a PDF source, from the paper itself
    if (await have('pdftotext')) {
        const pdfSrc = await T.addSource(dir, path.join(dir, 'paper', 'build', 'main.pdf'));
        check('a PDF source is read page by page and its pages can be asked for', pdfSrc.meta.kind === 'pdf' && pdfSrc.meta.pages >= 1 && /Pumped hydro/.test(T.readExcerpt(dir, pdfSrc.meta.id, { page: 1 }).text), pdfSrc.summary.slice(0, 80));
        // frames: a video made from the PDF's first page, read with OCR before any model would see it
        if (await have('ffmpeg') && await have('tesseract') && await have('pdftoppm')) {
            sh(`cd /tmp && rm -rf fr && mkdir fr && pdftoppm -r 80 -png -f 1 -l 1 ${dir}/paper/build/main.pdf fr/p && ffmpeg -v error -loop 1 -i fr/p-1.png -t 65 -pix_fmt yuv420p -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' fr/v.mp4`);
            const f = await T.frames(dir, 's02', { every: 30, videoFile: '/tmp/fr/v.mp4' });
            check('frames are taken every N seconds and read with OCR first', f.frames === 2 && f.withText >= 1, JSON.stringify(f));
            check('the OCR text becomes searchable without any model seeing an image', T.find(dir, 'pumped hydro seventy', { source: 's02' }).some(h => /on screen/.test(h.snippet)) || /on screen/.test(fs.readFileSync(path.join(dir, 'sources', 's02', 'text.md'), 'utf8')));
        } else skip('frames and OCR (ffmpeg, tesseract)');
    } else skip('PDF sources (pdftotext)');
} else skip('building the paper (latexmk not installed: research setup)');

R.decide; // (kept referenced for linters)
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${checks} research checks failed` : `\nall ${checks} research checks passed`);
process.exit(failures ? 1 : 0);
