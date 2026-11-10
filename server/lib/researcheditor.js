// The paper editor's side: edit the paper's files, read refs.bib as real entries tied to their sources,
// open a source's pages, and find where each "[n]" sits on the built pages so the preview can make it clickable.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as T from './researchtools.js';
import { topicPath } from './research.js';

const run = promisify(execFile);
const httpError = T.httpError;
const FILE_OK = /^(main\.tex|refs\.bib|sections\/[A-Za-z0-9._-]{1,60}\.tex)$/;

function editable(slug, rel) {
    const r = String(rel || '');
    if (!FILE_OK.test(r) || r.includes('..')) throw httpError(400, 'Only main.tex, refs.bib and sections/*.tex can be edited.');
    return path.join(topicPath(slug), 'paper', r);
}
export function files(slug) {
    const dir = path.join(topicPath(slug), 'paper'); const out = [{ path: 'main.tex', label: 'main.tex' }];
    try { for (const f of fs.readdirSync(path.join(dir, 'sections')).filter(f => f.endsWith('.tex')).sort()) out.push({ path: `sections/${f}`, label: f }); } catch { /* none */ }
    out.push({ path: 'refs.bib', label: 'refs.bib' });
    return out.map(f => ({ ...f, size: (() => { try { return fs.statSync(path.join(dir, f.path)).size; } catch { return 0; } })() }));
}
export function readFile(slug, rel) {
    const f = editable(slug, rel);
    return { path: rel, text: T.exists(f) ? fs.readFileSync(f, 'utf8') : '', mtime: T.exists(f) ? fs.statSync(f).mtimeMs : 0 };
}
export function writeFile(slug, rel, text, { baseMtime = 0 } = {}) {
    const f = editable(slug, rel); const s = String(text); if (s.length > 2_000_000) throw httpError(413, 'File is too large.');
    const fresh = !T.exists(f);
    // An agent may have changed the file since the editor opened it: say so rather than overwrite silently.
    if (!fresh && baseMtime && fs.statSync(f).mtimeMs > Number(baseMtime) + 1) throw httpError(409, 'An agent changed this file since you opened it. Reload it to see their edit.');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, { mode: 0o664 });
    if (fresh) { const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, 0o664); } catch { /* best effort */ } }
    record('activity', 'research-edit', { actor: 'phone', what: `${slug}/${rel}`, cwd: path.dirname(f) });
    return { ok: true, mtime: fs.statSync(f).mtimeMs };
}
export function newSection(slug, name) {
    const n = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.tex$/, '').slice(0, 50); if (!n) throw httpError(400, 'Give the section a name.');
    const rel = `sections/${n}.tex`; if (T.exists(editable(slug, rel))) throw httpError(409, 'That section exists.');
    writeFile(slug, rel, `\\section{${n.replace(/[-_]+/g, ' ')}}\n`);
    const main = editable(slug, 'main.tex'); let m = fs.readFileSync(main, 'utf8');
    if (!m.includes(`\\input{sections/${n}}`)) { m = m.replace(/(\\bibliographystyle)/, `\\input{sections/${n}}\n$1`); fs.writeFileSync(main, m); }
    return { path: rel };
}

// refs.bib as entries, each with the source it stands for (the `source` field, else an id at the end of the key).
export function bibEntries(slug) {
    const dir = topicPath(slug); const bibFile = path.join(dir, 'paper', 'refs.bib');
    const bib = T.exists(bibFile) ? fs.readFileSync(bibFile, 'utf8') : '';
    const sources = new Map(T.listSources(dir).map(m => [m.id, m])); const out = [];
    const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g; let m;
    while ((m = re.exec(bib))) {
        const fields = {};
        for (const f of m[3].matchAll(/(\w+)\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) fields[f[1].toLowerCase()] = f[2].replace(/\\url\{([^}]*)\}/g, '$1').replace(/\\([&%$#_])/g, '$1');
        const id = (fields.source && sources.has(fields.source) ? fields.source : (m[2].match(/(s\d{2,4})$/) || [])[1]) || null; const src = id && sources.get(id);
        out.push({
            key: m[2], type: m[1].toLowerCase(), title: fields.title || '', author: fields.author || '', year: fields.year || '', url: fields.url || fields.howpublished || '', line: bib.slice(0, m.index).split('\n').length,
            source: src ? { id: src.id, kind: src.kind, title: src.title, url: src.url || '', hasPdf: T.exists(path.join(dir, 'sources', src.id, 'original.pdf')), pages: src.pages || null, duration: src.duration || null } : null,
        });
    }
    return out;
}
export function citeSource(slug, id, opts = {}) {
    const dir = topicPath(slug); if (!T.validId(id)) throw httpError(400, 'Bad source id.');
    return T.cite(dir, id, { at: opts.at ?? null, page: opts.page ?? null, claim: opts.claim || '' });
}
export async function addSource(slug, url, note) {
    const dir = topicPath(slug); const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw httpError(400, 'Give a web or YouTube address.');
    return T.addSource(dir, u, { note: String(note || '').slice(0, 200) });
}
// A page of a source PDF as an image (made when first asked for, then kept).
export async function sourcePage(slug, id, n) {
    const dir = topicPath(slug); if (!T.validId(id)) throw httpError(400, 'Bad source id.');
    const pdf = path.join(dir, 'sources', id, 'original.pdf'); if (!T.exists(pdf)) throw httpError(404, 'No PDF for this source.');
    const p = Number(n); if (!Number.isInteger(p) || p < 1 || p > 2000) throw httpError(400, 'Bad page.');
    const out = path.join(dir, 'sources', id, 'pages'); fs.mkdirSync(out, { recursive: true }); const base = path.join(out, `p${p}`);
    if (!T.exists(base + '.png')) await run('pdftoppm', ['-r', '110', '-png', '-singlefile', '-f', String(p), '-l', String(p), pdf, base], { timeout: 60_000 }).catch(() => { throw httpError(501, 'pdftoppm is not installed.'); });
    if (!T.exists(base + '.png')) throw httpError(404, 'No such page.');
    return base + '.png';
}

// Where each "[n]" or "[n, 14:32]" sits on the built pages, so the preview can make them clickable.
const linkCache = new Map();
export async function links(slug) {
    const dir = topicPath(slug); const paper = path.join(dir, 'paper'); const pdf = path.join(paper, 'build', 'main.pdf');
    if (!T.exists(pdf)) return { pages: [], refs: {} };
    const mt = fs.statSync(pdf).mtimeMs; const hit = linkCache.get(slug); if (hit && hit.mt === mt) return hit.v;
    const refs = {};
    try { for (const m of fs.readFileSync(path.join(paper, 'build', 'main.aux'), 'utf8').matchAll(/\\bibcite\{([^}]+)\}\{([^}]+)\}/g)) refs[m[2]] = m[1]; } catch { /* no aux */ }
    let html = '';
    try { html = (await run('pdftotext', ['-bbox', pdf, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })).stdout; } catch { return { pages: [], refs }; }
    const pages = []; let n = 0;
    for (const pg of html.split('<page ').slice(1)) {
        n++; const w = Number(pg.match(/width="([\d.]+)"/)?.[1] || 1), h = Number(pg.match(/height="([\d.]+)"/)?.[1] || 1); const ls = [];
        const words = [...pg.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] }));
        for (let i = 0; i < words.length; i++) {
            if (!/^\[\d+(,|\][.,;:)]*)?$/.test(words[i].t)) continue;
            let j = i, want = true;
            for (; j < words.length && j < i + 8; j++) {
                const t = words[j].t; const num = t.match(/^\[?(\d+)(,|\][.,;:)]*)?$/);
                if (want && num && refs[num[1]]) { ls.push({ x: words[j].x0 / w, y: words[j].y0 / h, w: (words[j].x1 - words[j].x0) / w, h: (words[j].y1 - words[j].y0) / h, key: refs[num[1]] }); want = num[2] === ','; } else want = false;
                if (t.includes(']')) break;
            }
            i = j;
        }
        pages.push({ n, links: ls });
    }
    const v = { pages, refs }; linkCache.set(slug, { mt, v }); return v;
}

// ---------- language and spelling ----------
// The topic has one language. The browser underlines with it as you type; "Check spelling" runs aspell in TeX mode on
// the box, which skips commands, citation keys and maths, so only real words are reported.
export const LANGS = { 'en-GB': 'English (UK)', 'en-US': 'English (US)', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano', pt: 'Português', nl: 'Nederlands' };
const settingsFile = slug => path.join(topicPath(slug), '.platopypus', 'research.json');
const wordsFile = slug => path.join(topicPath(slug), '.platopypus', 'words.txt');
export function language(slug) { const l = T.readJson(settingsFile(slug), {}).lang; return LANGS[l] ? l : 'en-GB'; }
export function setLanguage(slug, lang) {
    if (!LANGS[lang]) throw httpError(400, 'Unknown language.');
    const f = settingsFile(slug); const s = T.readJson(f, {}); s.lang = lang; T.writeJson(f, s); return { lang };
}
const ownWords = slug => { try { return fs.readFileSync(wordsFile(slug), 'utf8').split('\n').map(w => w.trim()).filter(Boolean); } catch { return []; } };
export function learnWord(slug, word) {
    const w = String(word || '').trim(); if (!/^[\p{L}\p{M}'’-]{1,60}$/u.test(w)) throw httpError(400, 'Not a word.');
    const all = new Set(ownWords(slug)); all.add(w); fs.writeFileSync(wordsFile(slug), [...all].sort().join('\n') + '\n'); return { words: all.size };
}
export async function spell(slug, text) {
    const lang = language(slug); if (!(await T.which('aspell'))) throw httpError(501, 'The spelling checker is not installed on this box (run: research setup).');
    const out = await new Promise((ok, bad) => {
        const c = spawn('aspell', ['--mode=tex', `--lang=${lang.replace('-', '_')}`, '--encoding=utf-8', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let o = '', e = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
        c.on('error', bad); c.on('close', code => (code === 0 ? ok(o) : bad(httpError(/No word lists|dictionar/i.test(e) ? 501 : 500, /No word lists|dictionar/i.test(e) ? `No ${LANGS[lang]} dictionary on this box (install aspell-${lang.slice(0, 2)}).` : e.trim().slice(0, 200) || 'aspell failed.'))));
        c.stdin.end(String(text).slice(0, 2_000_000));
    });
    const skip = new Set(ownWords(slug).map(w => w.toLowerCase())); const count = new Map();
    for (const w of out.split('\n').map(s => s.trim()).filter(Boolean)) { if (!skip.has(w.toLowerCase())) count.set(w, (count.get(w) || 0) + 1); }
    return { lang, words: [...count].map(([word, n]) => ({ word, n })).sort((a, b) => b.n - a.n || a.word.localeCompare(b.word)).slice(0, 400) };
}

// The words on a page of a source PDF and where each line sits (as fractions of the page), so the app can lay real,
// selectable text over the page image. Made when first asked for, then kept beside the image.
export async function sourceLines(slug, id, n) {
    const dir = topicPath(slug); if (!T.validId(id)) throw httpError(400, 'Bad source id.');
    const pdf = path.join(dir, 'sources', id, 'original.pdf'); if (!T.exists(pdf)) throw httpError(404, 'No PDF for this source.');
    const p = Number(n); if (!Number.isInteger(p) || p < 1 || p > 2000) throw httpError(400, 'Bad page.');
    const out = path.join(dir, 'sources', id, 'pages'); fs.mkdirSync(out, { recursive: true }); const cache = path.join(out, `p${p}.lines.json`);
    const hit = T.readJson(cache, null); if (hit) return hit;
    let html = ''; try { html = (await run('pdftotext', ['-bbox-layout', '-f', String(p), '-l', String(p), pdf, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })).stdout; } catch { throw httpError(501, 'pdftotext is not installed.'); }
    const w = Number(html.match(/<page width="([\d.]+)"/)?.[1] || 0), h = Number(html.match(/<page width="[\d.]+" height="([\d.]+)"/)?.[1] || 0);
    const un = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
    const lines = [];
    if (w && h) for (const m of html.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
        const text = [...m[5].matchAll(/<word[^>]*>([^<]*)<\/word>/g)].map(x => un(x[1])).join(' '); if (!text.trim()) continue;
        lines.push({ x: +m[1] / w, y: +m[2] / h, w: (+m[3] - +m[1]) / w, h: (+m[4] - +m[2]) / h, s: text });
    }
    const res = { page: p, lines: lines.slice(0, 4000) }; T.writeJson(cache, res); return res;
}
