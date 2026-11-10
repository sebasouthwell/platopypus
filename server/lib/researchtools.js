// The Research tools (what bin/research calls, and what the tests exercise): turn a source into plain text on disk,
// then let an agent search it and read small excerpts, so it never has to ingest a whole transcript or PDF.
//
// A topic is a folder: /Research/<Topic>/
//   paper/            main.tex, sections/*.tex, refs.bib, build/   (what the user reads and exports)
//   sources/<id>/     meta.json, text.md, (video) transcript.json + frames/ + ocr.json, (pdf) pages.json
//   notes/            outline.md, claims.md
//   .platopypus/      research.json, research.md (brief), asks/, cost.json
//
// Everything here is deterministic file work. Anything that costs the user something (a download, frames, images to the
// model) goes through `ask`, which waits for an Allow on the phone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
export const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
export function readJson(f, fallback = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
export function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(data, null, 2)); fs.renameSync(t, f); }

// ---------- tools on this machine ----------
export async function which(bin) { try { const { stdout } = await run('sh', ['-c', `command -v ${bin}`]); return stdout.trim() || null; } catch { return null; } }
export async function doctor() {
    const need = { latexmk: 'build the paper', pdftoppm: 'show pages on the phone', pdftotext: 'read PDFs', ffmpeg: 'audio and frames', 'yt-dlp': 'captions and downloads', tesseract: 'read text in frames' };
    const out = {};
    for (const [b, why] of Object.entries(need)) out[b] = { path: await which(b), why };
    let fw = false; try { await run('python3', ['-c', 'import faster_whisper'], { timeout: 20000 }); fw = true; } catch { /* not installed */ }
    out['faster-whisper'] = { path: fw ? 'python3 module' : null, why: 'transcribe audio on this machine' };
    return out;
}

// ---------- ids, paths ----------
export const sourcesDir = topic => path.join(topic, 'sources');
export function nextId(topic) {
    let max = 0;
    try { for (const d of fs.readdirSync(sourcesDir(topic))) { const m = d.match(/^s(\d+)$/); if (m) max = Math.max(max, Number(m[1])); } } catch { /* none */ }
    return 's' + String(max + 1).padStart(2, '0');
}
export const validId = id => /^s\d{2,4}$/.test(String(id));
export function sourceMeta(topic, id) { const m = readJson(path.join(sourcesDir(topic), id, 'meta.json')); if (!m) throw httpError(404, `No source ${id}. See: research status`); return m; }
export function listSources(topic) {
    let ids = []; try { ids = fs.readdirSync(sourcesDir(topic)).filter(d => /^s\d+$/.test(d)).sort(); } catch { /* none */ }
    return ids.map(id => readJson(path.join(sourcesDir(topic), id, 'meta.json'))).filter(Boolean);
}
const fmtT = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
export const fmtTime = fmtT;
export function parseTime(str) {
    const s = String(str).trim(); if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/); if (m) return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
    const d = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/); if (d && (d[1] || d[2] || d[3])) return Number(d[1] || 0) * 3600 + Number(d[2] || 0) * 60 + Number(d[3] || 0);
    throw httpError(400, `Time like 14:32, 1:02:03, 90s or 2m, not "${str}".`);
}

// ---------- cost counters (what the agent actually pulled, shown in the app) ----------
export function costOf(topic) { return readJson(path.join(topic, '.platopypus', 'cost.json'), { ingestedChars: 0, readChars: 0, excerpts: 0, searches: 0, imagesSent: 0 }); }
export function bump(topic, delta) { const c = costOf(topic); for (const [k, v] of Object.entries(delta)) c[k] = (c[k] || 0) + v; writeJson(path.join(topic, '.platopypus', 'cost.json'), c); return c; }

// ---------- reading web pages ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } } return ENT[e.toLowerCase()] ?? m; });
export function htmlToText(html) {
    const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
    const meta = n => decode(html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, 'i'))?.[1] || '');
    let body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<body[\s\S]*<\/body>/i)?.[0] || html;
    body = body.replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Math.min(Number(n), 4))} ${t.replace(/<[^>]+>/g, '')}\n\n`)
        .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|section|tr|blockquote|ul|ol|table)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    const text = decode(body).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title: title || meta('og:title'), author: meta('author') || meta('article:author'), site: meta('og:site_name'), published: meta('article:published_time') || meta('date') || '', text };
}

// ---------- captions (WebVTT) ----------
// Auto-generated captions repeat each phrase as it scrolls; keep each piece of text once, in order.
export function parseVtt(vtt) {
    const cues = []; const blocks = String(vtt).replace(/\r/g, '').split(/\n\n+/);
    for (const b of blocks) {
        const lines = b.split('\n'); const i = lines.findIndex(l => l.includes('-->')); if (i < 0) continue;
        const m = lines[i].match(/(\d+:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d+:)?(\d{2}):(\d{2})[.,](\d{3})/); if (!m) continue;
        const start = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
        const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (text) cues.push({ t: start, text: decode(text) });
    }
    const out = []; let prev = '';
    for (const c of cues) {
        if (c.text === prev) continue;
        const clean = prev && c.text.startsWith(prev) ? c.text.slice(prev.length).trim() : c.text;   // scrolling captions grow line by line
        prev = c.text; if (clean) out.push({ t: c.t, text: clean });
    }
    return out;
}
// Group cues into readable lines of about `win` seconds.
export function windows(cues, win = 20) {
    const out = []; let cur = null;
    for (const c of cues) {
        if (!cur || c.t - cur.t >= win) { cur = { t: c.t, text: c.text }; out.push(cur); } else cur.text += ' ' + c.text;
    }
    return out;
}
export const transcriptMarkdown = lines => lines.map(l => `[${fmtT(l.t)}] ${l.text}`).join('\n') + '\n';

// ---------- adding sources ----------
function youtubeId(u) { try { const x = new URL(u); if (/(^|\.)youtu\.be$/.test(x.hostname)) return x.pathname.slice(1, 12); if (/(^|\.)youtube\.com$/.test(x.hostname)) return x.searchParams.get('v') || x.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1] || null; } catch { /* not a url */ } return null; }
const clip = (s, n) => String(s || '').slice(0, n);

async function fetchText(url, { max = 6 * 1024 * 1024, accept = 'text/html,*/*' } = {}) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatOpypus-Research/1.0)', Accept: accept }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw httpError(502, `${url} answered ${res.status}.`);
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw httpError(413, `That is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${(max / 1048576).toFixed(0)} MB.`);
    return { type, buf, url: res.url };
}

export async function addSource(topic, input, { note = '' } = {}) {
    const id = nextId(topic); const dir = path.join(sourcesDir(topic), id); fs.mkdirSync(dir, { recursive: true });
    const meta = { id, kind: 'web', title: '', url: null, author: '', site: '', year: '', added: Date.now(), chars: 0, state: {}, note: clip(note, 300) };
    let text = '';
    const yt = /^https?:/i.test(input) ? youtubeId(input) : null;
    if (yt) {
        meta.kind = 'video'; meta.url = `https://www.youtube.com/watch?v=${yt}`; meta.videoId = yt; meta.site = 'YouTube';
        let info = null;
        if (await which('yt-dlp')) { try { const { stdout } = await run('yt-dlp', ['--skip-download', '--dump-single-json', '--no-warnings', meta.url], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }); info = JSON.parse(stdout); } catch { /* fall back to the page */ } }
        if (info) { meta.title = info.title || ''; meta.author = info.uploader || info.channel || ''; meta.year = String(info.upload_date || '').slice(0, 4); meta.duration = info.duration || null; meta.state.captions = !!(Object.keys(info.subtitles || {}).length || Object.keys(info.automatic_captions || {}).length); }
        else { try { const r = await fetchText(meta.url); const h = htmlToText(r.buf.toString('utf8')); meta.title = h.title.replace(/ - YouTube$/, ''); meta.author = h.author; } catch { /* offline */ } }
        text = `# ${meta.title || 'Video'}\n\n(Video, not transcribed yet: run research transcript ${id})\n`;
    } else if (/^https?:/i.test(input)) {
        const r = await fetchText(input, { accept: 'text/html,application/pdf,*/*' });
        meta.url = r.url;
        if (/pdf/i.test(r.type) || /\.pdf($|\?)/i.test(r.url)) { fs.writeFileSync(path.join(dir, 'original.pdf'), r.buf); Object.assign(meta, { kind: 'pdf' }); text = await pdfText(topic, id, dir, meta); }
        else { const h = htmlToText(r.buf.toString('utf8')); meta.title = h.title; meta.author = h.author; meta.site = h.site || new URL(r.url).hostname; meta.year = String(h.published).slice(0, 4); text = `# ${h.title}\n\n${h.text}\n`; }
    } else {
        const f = path.resolve(input); if (!exists(f)) throw httpError(404, `No such file: ${input}`);
        const ext = (path.extname(f).slice(1) || '').toLowerCase(); const stem = path.basename(f, path.extname(f));
        if (ext === 'pdf') { fs.copyFileSync(f, path.join(dir, 'original.pdf')); meta.kind = 'pdf'; meta.title = stem; text = await pdfText(topic, id, dir, meta); }
        else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            // A picture (a scanned page, a slide, a chart): kept as it is, its words read with OCR so they can be searched.
            fs.copyFileSync(f, path.join(dir, `original.${ext}`)); meta.kind = 'image'; meta.title = stem; meta.file = `original.${ext}`;
            let ocr = ''; if (await which('tesseract')) { try { ocr = (await run('tesseract', [f, '-', '--psm', '3'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { /* unreadable */ } }
            text = `# ${stem}\n\n${ocr.trim() ? ocr.trim() : '(an image with no readable text)'}\n`;
        } else if (ext === 'docx') {
            // A Word document: its text is in word/document.xml, one <w:p> per paragraph.
            fs.copyFileSync(f, path.join(dir, 'original.docx')); meta.kind = 'document'; meta.title = stem; meta.file = 'original.docx';
            let xml = ''; try { xml = (await run('unzip', ['-p', f, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout; } catch { throw httpError(400, 'That Word file could not be read.'); }
            const body = xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n');
            text = `# ${stem}\n\n${body.trim()}\n`;
        } else if (['html', 'htm'].includes(ext)) { const h = htmlToText(fs.readFileSync(f, 'utf8')); meta.kind = 'file'; meta.title = h.title || stem; meta.author = h.author || ''; text = `# ${meta.title}\n\n${h.text}\n`; fs.copyFileSync(f, path.join(dir, `original.${ext}`)); meta.file = `original.${ext}`; }
        else { meta.kind = 'file'; meta.title = stem; text = fs.readFileSync(f, 'utf8'); if (ext) { fs.copyFileSync(f, path.join(dir, `original.${ext}`)); meta.file = `original.${ext}`; } }
    }
    meta.from = Object.fromEntries(['title', 'author', 'year'].filter(k => meta[k]).map(k => [k, meta.kind === 'pdf' ? 'pdf' : meta.kind === 'video' ? 'video' : 'page']));
    meta.title = meta.title || input; meta.chars = text.length; meta.state.text = text.trim().length > 40 ? 'ready' : 'empty';
    fs.writeFileSync(path.join(dir, 'text.md'), text);
    writeJson(path.join(dir, 'meta.json'), meta);
    bump(topic, { ingestedChars: text.length });
    return { meta, summary: summaryOf(meta, text) };
}
export function summaryOf(meta, text) {
    const first = text.replace(/^#.*\n+/, '').replace(/<<page \d+>>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360);
    return `${meta.id}  ${meta.kind}  "${meta.title}"${meta.author ? ` by ${meta.author}` : ''}${meta.year ? ` (${meta.year})` : ''}  ${meta.chars} chars\n${first}${first.length >= 360 ? '…' : ''}`;
}
async function pdfText(topic, id, dir, meta) {
    if (!(await which('pdftotext'))) throw httpError(501, 'pdftotext is not installed (run: research setup).');
    const { stdout } = await run('pdftotext', ['-layout', path.join(dir, 'original.pdf'), '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    const pages = stdout.split('\f').map(s => s.trim()).filter((s, i, a) => s || i < a.length - 1);
    writeJson(path.join(dir, 'pages.json'), pages.map((t, i) => ({ page: i + 1, chars: t.length })));
    try { const { stdout: info } = await run('pdfinfo', [path.join(dir, 'original.pdf')]); meta.title = meta.title || info.match(/^Title:[ \t]*(.+)$/m)?.[1]?.trim() || ''; meta.author = meta.author || info.match(/^Author:[ \t]*(.+)$/m)?.[1]?.trim() || ''; meta.year = meta.year || info.match(/^CreationDate:.*?(\d{4})/m)?.[1] || ''; } catch { /* no pdfinfo */ }
    meta.pages = pages.length;
    return `# ${meta.title || 'PDF'}\n\n` + pages.map((t, i) => `<<page ${i + 1}>>\n${t}`).join('\n\n') + '\n';
}

// ---------- searching and reading ----------
function chunksOf(topic, meta) {
    const dir = path.join(sourcesDir(topic), meta.id); const out = [];
    const tr = readJson(path.join(dir, 'transcript.json'));
    if (tr) { for (const w of windows(tr, 45)) out.push({ id: meta.id, loc: fmtT(w.t), at: w.t, text: w.text }); return out; }
    let text = ''; try { text = fs.readFileSync(path.join(dir, 'text.md'), 'utf8'); } catch { return out; }
    let page = 1, n = 0;
    for (const raw of text.split(/\n\n+/)) {
        const pm = raw.match(/^<<page (\d+)>>\n?/); if (pm) page = Number(pm[1]);
        const body = raw.replace(/^<<page \d+>>\n?/, '').trim(); if (!body) continue;
        const parts = []; let cur = '';
        for (const sentence of body.split(/(?<=[.!?])\s+/)) { if ((cur + ' ' + sentence).length > 800 && cur) { parts.push(cur); cur = sentence; } else cur = (cur ? cur + ' ' : '') + sentence; }
        if (cur) parts.push(cur);
        for (const p of parts) out.push({ id: meta.id, loc: meta.kind === 'pdf' ? `p.${page}` : `¶${++n}`, page, text: p });
    }
    return out;
}
const tokens = s => String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
export function find(topic, query, { source = null, limit = 8, maxChars = 1800 } = {}) {
    const q = [...new Set(tokens(query))]; if (!q.length) throw httpError(400, 'Search for some words.');
    const metas = listSources(topic).filter(m => !source || m.id === source);
    const all = metas.flatMap(m => chunksOf(topic, m));
    const df = new Map(); for (const c of all) { c.tok = tokens(c.text); for (const t of new Set(c.tok)) df.set(t, (df.get(t) || 0) + 1); }
    const N = all.length || 1, avg = all.reduce((a, c) => a + c.tok.length, 0) / N || 1;
    for (const c of all) {
        const tf = new Map(); for (const t of c.tok) tf.set(t, (tf.get(t) || 0) + 1);
        c.score = q.reduce((s, t) => { const f = tf.get(t) || 0; if (!f) return s; const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5)); return s + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.tok.length / avg)); }, 0);
    }
    const hits = all.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    let used = 0; const out = [];
    for (const h of hits) { const snip = snippet(h.text, q); if (used + snip.length > maxChars) break; used += snip.length; out.push({ id: h.id, loc: h.loc, at: h.at ?? null, snippet: snip }); }
    bump(topic, { searches: 1, readChars: used });
    return out;
}
function snippet(text, q) {
    const low = text.toLowerCase(); let at = -1; for (const t of q) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, at - 90), end = Math.min(text.length, start + 360);
    return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
export function readExcerpt(topic, id, { at = null, span = '90s', page = null, chunk = null, from = 0, max = 3000 } = {}) {
    const meta = sourceMeta(topic, id); const dir = path.join(sourcesDir(topic), id);
    let body = '', where = '';
    const tr = readJson(path.join(dir, 'transcript.json'));
    if (at !== null && tr) {
        const t0 = parseTime(at), t1 = t0 + parseTime(span);
        body = tr.filter(c => c.t >= t0 - 2 && c.t <= t1).map(c => `[${fmtT(c.t)}] ${c.text}`).join('\n'); where = `${fmtT(t0)}–${fmtT(t1)}`;
    } else if (page !== null) {
        const text = fs.readFileSync(path.join(dir, 'text.md'), 'utf8'); const m = text.match(new RegExp(`<<page ${Number(page)}>>\\n([\\s\\S]*?)(?=\\n\\n<<page |$)`));
        if (!m) throw httpError(404, `No page ${page} in ${id}.`); body = m[1]; where = `page ${page}`;
    } else if (chunk !== null) {
        const cs = chunksOf(topic, meta); const c = cs[Number(chunk) - 1]; if (!c) throw httpError(404, `${id} has ${cs.length} chunks.`); body = c.text; where = `chunk ${chunk} of ${cs.length}`;
    } else {
        const text = fs.readFileSync(path.join(dir, 'text.md'), 'utf8'); body = text.slice(Number(from), Number(from) + max); where = `characters ${from}–${Number(from) + body.length} of ${text.length}`;
    }
    if (body.length > max) body = body.slice(0, max) + '\n[cut: ask for a smaller range]';
    bump(topic, { excerpts: 1, readChars: body.length });
    return { id, title: meta.title, where, text: body };
}

// ---------- the reference record ----------
// Each source's meta.json is the one place its reference details live, with where each detail came from. refs.bib is
// made from those records: every cited source has an entry, written from its record. Editing a linked entry in refs.bib
// writes the change back into the record (as yours), so the two never drift apart. Entries without a source are yours
// alone and are left exactly as written.
export const RECORD_FIELDS = ['title', 'author', 'year', 'journal', 'booktitle', 'volume', 'number', 'pages', 'publisher', 'doi', 'url'];
// A record's page range is kept as pageRange: `pages` on a source is how many pages its PDF has.
export const recKey = k => (k === 'pages' ? 'pageRange' : k);
export const recGet = (m, k) => m[recKey(k)];
const saveMeta = (topic, meta) => writeJson(path.join(sourcesDir(topic), meta.id, 'meta.json'), meta);
const plainField = s => String(s || '').replace(/\\url\{([^}]*)\}/g, '$1').replace(/[{}]/g, '').replace(/\\([&%$#_])/g, '$1').replace(/\s+/g, ' ').trim();
const texEsc = s => String(s || '').replace(/(?<!\\)([&%$#_])/g, '\\$1').replace(/\s+/g, ' ').trim();
export function bibFields(entry) {
    const f = {}; const body = entry.slice(entry.indexOf(',') + 1);
    for (const m of body.matchAll(/(\w+)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)"|(\d+))/g)) f[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\s+/g, ' ').trim();
    return f;
}
// Where each detail of a record came from (older records did not say: work it out from how the source was added).
export function provenance(meta) {
    const base = meta.metaFrom === 'doi' ? 'doi' : meta.kind === 'pdf' ? 'pdf' : meta.kind === 'video' ? 'video' : 'page';
    const out = {}; for (const k of RECORD_FIELDS) if (recGet(meta, k)) out[k] = meta.from?.[k] || (meta.metaFrom === 'agent' && ['title', 'author', 'year'].includes(k) ? 'agent' : base);
    return out;
}
// Set details on a record. Details you set are never overwritten by the DOI lookup or the agent.
export function setFields(meta, fields, from) {
    meta.from = meta.from || {}; let changed = false;
    for (const k of RECORD_FIELDS) {
        if (fields[k] === undefined) continue; const v = k === 'year' ? String(fields[k]).replace(/\D/g, '').slice(0, 4) : clip(plainField(fields[k]), 400);
        if (from !== 'you' && meta.from[k] === 'you') continue;
        if (v === (recGet(meta, k) || '')) continue;
        if (v) { meta[recKey(k)] = v; meta.from[k] = from; } else { delete meta[recKey(k)]; delete meta.from[k]; }
        changed = true;
    }
    if (fields.type !== undefined) { const t = String(fields.type).replace(/\W/g, '').toLowerCase(); if (t !== (meta.bibType || '') && (from === 'you' || meta.from.type !== 'you')) { if (t) meta.bibType = t; else delete meta.bibType; meta.from.type = from; changed = true; } }
    return changed;
}
export function bibKey(meta) {
    if (meta.citeKey) return meta.citeKey;          // fixed once the source is cited, so \cite keys never change under you
    const who = (meta.author || meta.site || meta.title || 'source').split(/[,;&]| and /)[0].trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'source';
    return `${who}${meta.year || 'nd'}${meta.id}`;
}
export function entryType(m) { return m.bibType || (m.journal ? 'article' : m.booktitle ? 'inproceedings' : 'misc'); }
export function renderEntry(m) {
    const type = entryType(m); const f = []; const put = (k, v) => { if (v) f.push(`  ${k} = {${v}}`); };
    put('title', texEsc(m.title)); put('author', texEsc(m.author)); put('year', m.year);
    for (const k of ['journal', 'booktitle', 'volume', 'number', 'pages', 'publisher']) put(k, texEsc(recGet(m, k)));
    put('doi', m.doi);
    if (m.url) { const u = m.url.replace(/[{}]/g, ''); if (type === 'misc') put('howpublished', `\\url{${u}}`); else put('url', u); }
    if (type === 'misc' || m.kind === 'video' || m.kind === 'web') put('note', `${m.kind === 'video' ? 'Video. ' : ''}Accessed ${new Date(m.added || Date.now()).toISOString().slice(0, 10)}`);
    put('source', m.id);
    return `@${type}{${bibKey(m)},\n${f.join(',\n')}\n}`;
}
function bibParts(text, sources) {
    const parts = []; let last = 0;
    for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,[\s\S]*?\n\}/g)) {
        parts.push({ text: text.slice(last, m.index) });
        const linked = (m[0].match(/\bsource\s*=\s*\{(s\d{2,4})\}/) || [])[1] || ((m[2].match(/(s\d{2,4})$/) || [])[1]);
        parts.push({ entry: m[0], type: m[1].toLowerCase(), key: m[2], id: linked && sources.has(linked) ? linked : null });
        last = m.index + m[0].length;
    }
    parts.push({ text: text.slice(last) }); return parts;
}
// Write refs.bib from the records: every cited source, in place, from its record; other entries untouched.
export function syncBib(topic) {
    const file = path.join(topic, 'paper', 'refs.bib'); const cur = exists(file) ? fs.readFileSync(file, 'utf8') : '';
    const sources = new Map(listSources(topic).map(m => [m.id, m]));
    for (const m of sources.values()) if (m.bibtex) { const f = bibFields(m.bibtex); const type = (m.bibtex.match(/^@(\w+)/) || [])[1]?.toLowerCase(); setFields(m, { ...Object.fromEntries(RECORD_FIELDS.filter(k => f[k]).map(k => [k, f[k]])), ...(type ? { type } : {}) }, 'doi'); delete m.bibtex; saveMeta(topic, m); }
    const parts = bibParts(cur, sources);
    // Records from before 2.3: take the key the entry already has, and copy into the record any detail that was only in
    // refs.bib (an agent or you may have added a journal or pages there), so writing refs.bib from the record loses nothing.
    for (const p of parts) if (p.id) {
        const m = sources.get(p.id); let changed = false;
        if (!m.citeKey || !m.inBib) { m.citeKey = m.citeKey || p.key; m.inBib = true; changed = true; }
        if (!m.bibAbsorbed) {
            const f = bibFields(p.entry); if (f.howpublished && !f.url) f.url = f.howpublished;
            const fill = Object.fromEntries(RECORD_FIELDS.filter(k => f[k] && !recGet(m, k)).map(k => [k, f[k]]));
            if (!m.bibType && p.type !== entryType(m)) fill.type = p.type;
            setFields(m, fill, 'bib'); m.bibAbsorbed = true; changed = true;
        }
        if (changed) saveMeta(topic, m);
    }
    const seen = new Set();
    let out = parts.map(p => (p.entry ? (p.id && !seen.has(p.id) ? (seen.add(p.id), renderEntry(sources.get(p.id))) : p.id ? '' : p.entry) : p.text)).join('');
    for (const m of sources.values()) if (m.inBib && !seen.has(m.id)) out += `\n\n${renderEntry(m)}`;
    out = out.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').trimEnd() + (out.trim() ? '\n' : '');
    if (out !== cur) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, out); }
    return { changed: out !== cur };
}
// You edited refs.bib: carry changes to linked entries back into their records, then write refs.bib from them again.
export function bibToRecords(topic) {
    const file = path.join(topic, 'paper', 'refs.bib'); const cur = exists(file) ? fs.readFileSync(file, 'utf8') : '';
    const sources = new Map(listSources(topic).map(m => [m.id, m])); const present = new Set();
    for (const p of bibParts(cur, sources)) {
        if (!p.entry || !p.id) continue; const m = sources.get(p.id); present.add(p.id);
        const f = bibFields(p.entry); if (f.howpublished && !f.url) f.url = f.howpublished;
        const fields = {}; for (const k of RECORD_FIELDS) fields[k] = f[k] !== undefined ? f[k] : '';
        if (p.type !== entryType(m)) fields.type = p.type;
        let changed = setFields(m, fields, 'you');
        if (p.key !== bibKey(m)) { m.citeKey = p.key; changed = true; }
        if (!m.inBib) { m.inBib = true; changed = true; }
        if (changed) saveMeta(topic, m);
    }
    for (const m of sources.values()) if (m.inBib && !present.has(m.id)) { m.inBib = false; saveMeta(topic, m); }   // you took it out of refs.bib
    return syncBib(topic);
}

// ---------- who wrote it: a DOI when there is one, otherwise the agent reads the first and last page ----------
const DOI = /\b(10\.\d{4,9}\/[^\s"<>{}|\\^`]+[^\s"<>{}|\\^`.,;:)\]])/;
export function findDoi(text) {
    // The DOI of the paper itself is on its first pages; later ones belong to its reference list.
    const head = String(text).split(/<<page 3>>/)[0].slice(0, 12000);
    return head.match(DOI)?.[1] || null;
}
// Fetch the publisher's own BibTeX for a DOI (doi.org content negotiation; only the DOI leaves the box) into the record.
export async function resolveDoi(topic, id, doi = null) {
    const meta = sourceMeta(topic, id); const dir = path.join(sourcesDir(topic), id);
    const d = doi || meta.doi || findDoi(exists(path.join(dir, 'text.md')) ? fs.readFileSync(path.join(dir, 'text.md'), 'utf8') : '');
    if (!d) return { ok: false, reason: 'no DOI found' };
    let bib = '';
    try { bib = (await fetchText(`https://doi.org/${encodeURI(d)}`, { accept: 'application/x-bibtex', max: 200 * 1024 })).buf.toString('utf8').trim(); } catch (e) { return { ok: false, doi: d, reason: e.message }; }
    if (!/^@\w+\s*\{/.test(bib)) return { ok: false, doi: d, reason: 'doi.org did not return BibTeX' };
    const f = bibFields(bib); const type = (bib.match(/^@(\w+)/) || [])[1]?.toLowerCase();
    setFields(meta, { ...Object.fromEntries(RECORD_FIELDS.filter(k => f[k]).map(k => [k, f[k]])), doi: d, ...(type ? { type } : {}) }, 'doi');
    meta.metaFrom = 'doi'; delete meta.needsMeta; delete meta.bibtex; saveMeta(topic, meta); syncBib(topic);
    return { ok: true, doi: d, title: meta.title, author: meta.author, year: meta.year };
}
// What the agent reads to work out the metadata when there is no DOI: the first and last page, nothing more.
export function metaPages(topic, id, max = 2500) {
    const meta = sourceMeta(topic, id); const text = fs.readFileSync(path.join(sourcesDir(topic), id, 'text.md'), 'utf8');
    const pages = text.split(/<<page \d+>>\n?/).slice(1); const first = (pages[0] || text).slice(0, max); const last = pages.length > 1 ? pages.at(-1).slice(0, max) : '';
    bump(topic, { excerpts: 1, readChars: first.length + last.length });
    return { id, current: { title: meta.title, author: meta.author, year: meta.year, doi: meta.doi || '' }, first, last, pages: pages.length };
}
export function setMeta(topic, id, { title, author, year, doi, type, journal, volume, pages, publisher } = {}) {
    const meta = sourceMeta(topic, id);
    setFields(meta, Object.fromEntries(Object.entries({ title, author, year, doi, journal, volume, pages, publisher }).filter(([, v]) => v)), 'agent');
    if (type) setFields(meta, { type }, 'agent');
    if (meta.metaFrom !== 'doi') meta.metaFrom = 'agent'; delete meta.needsMeta; saveMeta(topic, meta); syncBib(topic);
    return { id, key: bibKey(meta), renamedFrom: null, title: meta.title, author: meta.author, year: meta.year };
}
// Details you set yourself (the editor's record form).
export function setRecord(topic, id, fields) { const meta = sourceMeta(topic, id); setFields(meta, fields, 'you'); delete meta.needsMeta; saveMeta(topic, meta); syncBib(topic); return meta; }

// ---------- references ----------
export function cite(topic, id, { at = null, page = null, quote = '', claim = '' } = {}) {
    const meta = sourceMeta(topic, id);
    if (!meta.citeKey) meta.citeKey = bibKey(meta); meta.inBib = true; meta.bibAbsorbed = true; saveMeta(topic, meta); syncBib(topic);
    const key = meta.citeKey;
    const where = at !== null ? fmtT(parseTime(at)) : page !== null ? `p. ${page}` : '';
    const notes = path.join(topic, 'notes', 'claims.md'); fs.mkdirSync(path.dirname(notes), { recursive: true });
    if (claim) fs.appendFileSync(notes, `- ${claim} — [${id}${where ? ' ' + (at !== null ? '@' : '') + where : ''}]${quote ? ` "${String(quote).replace(/\s+/g, ' ').slice(0, 240)}"` : ''}\n`);
    return { key, latex: `\\cite${where ? `[${where}]` : ''}{${key}}` };
}

// ---------- the server (asks, and nothing else) ----------
function serverBase() { return `http://127.0.0.1:${process.env.PLATO_PORT || process.env.PORTHOLE_PORT || '7331'}`; }
async function serverCall(p, method = 'GET', body) {
    const headers = { 'Content-Type': 'application/json', 'X-Plato': '1' };
    const token = process.env.PLATO_TOKEN || process.env.PORTHOLE_TOKEN || '';
    if (!token) throw httpError(412, 'This shell has no PlatOpypus token (start it from the app as an agent shell).');
    const login = await fetch(`${serverBase()}/api/login/token`, { method: 'POST', headers, body: JSON.stringify({ token }), signal: AbortSignal.timeout(8000) });
    if (!login.ok) throw httpError(401, 'PlatOpypus did not accept this shell\'s token.');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const r = await fetch(serverBase() + p, { method, headers: { ...headers, cookie }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw httpError(r.status, d.error || `HTTP ${r.status}`); return d;
}
export const ask = body => serverCall('/api/agent/research/ask', 'POST', { ...body, pid: process.pid });
export const askStatus = id => serverCall(`/api/agent/research/ask/${id}`);
export async function waitAsk(id, { seconds = 600, onTick = null } = {}) {
    const end = Date.now() + seconds * 1000;
    for (;;) { const a = await askStatus(id); if (a.status !== 'pending') return a; if (Date.now() > end) return a; if (onTick) onTick(a); await sleep(4000); }
}
async function permission(topic, spec, { seconds }) {
    const a = await ask(spec);
    if (a.status === 'pending') { process.stderr.write(`Waiting for you to allow this on the phone: ${spec.title}  (ask ${a.id})\n`); }
    const done = a.status === 'pending' ? await waitAsk(a.id, { seconds }) : a;
    if (done.status === 'denied') throw httpError(403, 'You said no to that, so it was not done.');
    if (done.status === 'pending') throw httpError(408, `Still waiting for permission (ask ${a.id}); run the same command again later, or: research wait ${a.id}`);
    return done;
}

// ---------- video: captions first, then (with permission) audio and Whisper ----------
export async function transcript(topic, id, { engine = process.env.RESEARCH_WHISPER || 'local', model = process.env.RESEARCH_WHISPER_MODEL || 'small', lang = 'en', seconds = 600, keepAudio = false, vttFile = null } = {}) {
    const meta = sourceMeta(topic, id); const dir = path.join(sourcesDir(topic), id);
    if (meta.kind !== 'video') throw httpError(400, `${id} is not a video.`);
    let cues = null, how = null;
    if (vttFile) { cues = parseVtt(fs.readFileSync(vttFile, 'utf8')); how = 'captions'; }
    else {
        if (!(await which('yt-dlp'))) throw httpError(501, 'yt-dlp is not installed (run: research setup).');
        const tmp = path.join(dir, 'captions'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
        try { await run('yt-dlp', ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', `${lang}.*,${lang}`, '--sub-format', 'vtt', '--no-warnings', '-o', path.join(tmp, 'c.%(ext)s'), meta.url], { timeout: 120_000 }); } catch { /* no captions: fall through */ }
        const f = (fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).filter(x => x.endsWith('.vtt')).sort((a, b) => (a.includes('.orig') ? 1 : 0) - (b.includes('.orig') ? 1 : 0))[0];
        if (f) { cues = parseVtt(fs.readFileSync(path.join(tmp, f), 'utf8')); how = 'captions'; }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!cues || !cues.length) {
        const a = await permission(topic, { type: 'download-audio', title: 'Download a video to transcribe it?', detail: { source: id, video: meta.title, url: meta.url, duration: meta.duration || null, engine, model }, topic: path.basename(topic) }, { seconds });
        void a;
        const mp3 = path.join(dir, 'audio.mp3');
        await run('yt-dlp', ['-x', '--audio-format', 'mp3', '--audio-quality', '5', '--no-warnings', '-o', path.join(dir, 'audio.%(ext)s'), meta.url], { timeout: 30 * 60_000, maxBuffer: 20 * 1024 * 1024 });
        cues = await transcribeAudio(mp3, { engine, model, lang }); how = `whisper-${engine}`;
        if (!keepAudio) fs.rmSync(mp3, { force: true });
    }
    const lines = windows(cues, 20);
    writeJson(path.join(dir, 'transcript.json'), cues);
    const text = `# ${meta.title}\n\n${transcriptMarkdown(lines)}`;
    fs.writeFileSync(path.join(dir, 'text.md'), text);
    meta.chars = text.length; meta.state.text = 'ready'; meta.state.transcript = how; writeJson(path.join(dir, 'meta.json'), meta);
    bump(topic, { ingestedChars: text.length });
    return { id, how, cues: cues.length, minutes: Math.round((cues.at(-1)?.t || 0) / 60), chars: text.length };
}
async function transcribeAudio(file, { engine, model, lang }) {
    if (engine === 'openai') {
        const key = process.env.OPENAI_API_KEY; if (!key) throw httpError(412, 'Set OPENAI_API_KEY (run this with: vault run OPENAI_API_KEY -- research transcript …) or use --engine local.');
        const buf = fs.readFileSync(file); if (buf.length > 24 * 1024 * 1024) throw httpError(413, 'The audio is over the API limit of 25 MB; use --engine local.');
        const fd = new FormData(); fd.append('file', new Blob([buf]), 'audio.mp3'); fd.append('model', 'whisper-1'); fd.append('response_format', 'verbose_json'); fd.append('language', lang);
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(15 * 60_000) });
        const d = await r.json(); if (!r.ok) throw httpError(502, d.error?.message || `OpenAI answered ${r.status}`);
        return (d.segments || []).map(s => ({ t: s.start, text: String(s.text).trim() }));
    }
    const py = `import sys, json\nfrom faster_whisper import WhisperModel\nm = WhisperModel(sys.argv[2], device="auto", compute_type="auto")\nsegs, _ = m.transcribe(sys.argv[1], language=sys.argv[3], vad_filter=True)\nfor s in segs: print(json.dumps({"t": round(s.start, 2), "text": s.text.strip()}), flush=True)\n`;
    return await new Promise((ok, no) => {
        const p = spawn('python3', ['-c', py, file, model, lang], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
        p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
        p.on('error', e => no(httpError(501, `Cannot run python3: ${e.message}`)));
        p.on('exit', c => c === 0 ? ok(out.split('\n').filter(Boolean).map(l => JSON.parse(l))) : no(httpError(501, /No module named/.test(err) ? 'faster-whisper is not installed (run: research setup).' : `Whisper failed: ${err.slice(-300)}`)));
    });
}

// ---------- video: frames, OCR first ----------
export async function frames(topic, id, { every = 30, seconds = 600, videoFile = null } = {}) {
    const meta = sourceMeta(topic, id); const dir = path.join(sourcesDir(topic), id);
    for (const b of ['ffmpeg', 'tesseract']) if (!(await which(b))) throw httpError(501, `${b} is not installed (run: research setup).`);
    let video = videoFile;
    if (!video) {
        if (meta.kind !== 'video') throw httpError(400, `${id} is not a video.`);
        await permission(topic, { type: 'frames', title: 'Take frames from the video and read them?', detail: { source: id, video: meta.title, url: meta.url, every, duration: meta.duration || null }, topic: path.basename(topic) }, { seconds });
        video = path.join(dir, 'video.mp4');
        await run('yt-dlp', ['-f', 'worst[ext=mp4]/worst', '--no-warnings', '-o', video, meta.url], { timeout: 30 * 60_000, maxBuffer: 20 * 1024 * 1024 });
    }
    const fdir = path.join(dir, 'frames'); fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir, { recursive: true });
    await run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=1/${every},scale=960:-2`, '-q:v', '4', path.join(fdir, 'f%04d.jpg')], { timeout: 30 * 60_000 });
    const files = fs.readdirSync(fdir).filter(f => f.endsWith('.jpg')).sort(); const ocr = [];
    for (const [i, f] of files.entries()) {
        let text = ''; try { const { stdout } = await run('tesseract', [path.join(fdir, f), '-', '--psm', '6', '-l', 'eng'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); text = stdout.replace(/\s+/g, ' ').trim(); } catch { /* unreadable frame */ }
        ocr.push({ frame: f, t: i * every, text, chars: text.length, visual: text.length < 40 });   // little or no text: probably a chart, photo or diagram
    }
    writeJson(path.join(dir, 'ocr.json'), ocr);
    meta.state.frames = { count: ocr.length, every, visual: ocr.filter(o => o.visual).length }; writeJson(path.join(dir, 'meta.json'), meta);
    if (!videoFile) fs.rmSync(video, { force: true });
    // The OCR text joins the searchable text, so slide content is findable without any model seeing an image.
    const extra = ocr.filter(o => o.text).map(o => `[${fmtT(o.t)}] (on screen) ${o.text}`).join('\n');
    if (extra) { const tf = path.join(dir, 'text.md'); const cur = fs.readFileSync(tf, 'utf8').replace(/\n## On screen[\s\S]*$/, ''); fs.writeFileSync(tf, `${cur}\n## On screen\n${extra}\n`); }
    return { id, frames: ocr.length, withText: ocr.filter(o => !o.visual).length, visual: ocr.filter(o => o.visual).map(o => o.frame) };
}
export async function see(topic, id, names, { seconds = 600 } = {}) {
    const meta = sourceMeta(topic, id); const fdir = path.join(sourcesDir(topic), id, 'frames'); const ocr = readJson(path.join(sourcesDir(topic), id, 'ocr.json'), []);
    if (!names.length) throw httpError(400, 'Name the frames: research see s11 f0003 f0004');
    const want = names.map(n => (n.endsWith('.jpg') ? n : `${n}.jpg`)).filter(n => exists(path.join(fdir, n)));
    if (!want.length) throw httpError(404, 'None of those frames exist. See: research frames');
    await permission(topic, { type: 'send-frames', title: 'Show these frames to the agent?', detail: { source: id, video: meta.title, count: want.length }, topic: path.basename(topic) }, { seconds });
    bump(topic, { imagesSent: want.length });
    return want.map(n => ({ file: path.join(fdir, n), at: fmtT(ocr.find(o => o.frame === n)?.t || 0), ocr: (ocr.find(o => o.frame === n)?.text || '').slice(0, 300) }));
}

// ---------- building ----------
export async function build(topic) {
    if (!(await which('latexmk'))) throw httpError(501, 'latexmk is not installed (run: research setup).');
    const paper = path.join(topic, 'paper'); const t0 = Date.now();
    let ok = true, out = '';
    try { const r = await run('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-outdir=build', 'main.tex'], { cwd: paper, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }); out = r.stdout + r.stderr; }
    catch (e) { ok = false; out = (e.stdout || '') + (e.stderr || ''); }
    const log = (() => { try { return fs.readFileSync(path.join(paper, 'build', 'main.log'), 'utf8'); } catch { return out; } })();
    const errors = [...log.matchAll(/^! (.+)$/gm)].map(m => m[1]).slice(0, 5);
    const warnings = (log.match(/(LaTeX|Package \w+) Warning/g) || []).length; const undefinedCites = [...new Set([...log.matchAll(/Citation `([^']+)' .*undefined/g)].map(m => m[1]))];
    const pdf = path.join(paper, 'build', 'main.pdf'); const info = { at: Date.now(), ok: ok && exists(pdf), ms: Date.now() - t0, warnings, errors, undefinedCites, pages: 0 };
    if (info.ok) { try { const { stdout } = await run('pdfinfo', [pdf]); info.pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1] || 0); } catch { /* no pdfinfo */ } await renderPages(paper, pdf).catch(() => {}); }
    writeJson(path.join(paper, 'build', 'build.json'), info);
    return info;
}
export async function renderPages(paper, pdf) {
    if (!(await which('pdftoppm'))) return 0;
    const dir = path.join(paper, 'build', 'pages'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    await run('pdftoppm', ['-r', '100', '-png', pdf, path.join(dir, 'p')], { timeout: 120_000 });
    return fs.readdirSync(dir).length;
}

export const TEMPLATE_TEX = title => `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{microtype}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage[hidelinks]{hyperref}
\\title{${String(title).replace(/([&%$#_{}])/g, '\\\\$1')}}
\\author{}
\\date{\\today}
\\begin{document}
\\maketitle
\\begin{abstract}
\\noindent Written by an agent from the sources in this topic.
\\end{abstract}
\\input{sections/introduction}
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;

// A reference with no file (from an imported .bib): a source made of its record alone.
export function addRecordSource(topic, { key, type, fields }) {
    const id = nextId(topic); const dir = path.join(sourcesDir(topic), id); fs.mkdirSync(dir, { recursive: true });
    const meta = { id, kind: 'reference', title: '', url: null, author: '', year: '', added: Date.now(), chars: 0, state: { text: 'empty' }, note: 'imported from a .bib file', from: {} };
    setFields(meta, Object.fromEntries(RECORD_FIELDS.filter(k => fields[k]).map(k => [k, fields[k]])), 'you');
    if (fields.howpublished && !meta.url) setFields(meta, { url: fields.howpublished }, 'you');
    if (type) setFields(meta, { type }, 'you');
    if (key && /^[\w:.-]{1,80}$/.test(key)) meta.citeKey = key;
    const text = `# ${meta.title || key || id}\n\n${[meta.author, meta.year, meta.journal].filter(Boolean).join('. ')}\n${fields.abstract ? `\n${plainField(fields.abstract)}\n` : ''}`;
    fs.writeFileSync(path.join(dir, 'text.md'), text); meta.chars = text.length; saveMeta(topic, meta);
    return meta;
}
