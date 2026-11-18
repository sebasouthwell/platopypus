// Workspaces for the LaTeX editor (web/editor.html): any folder with a paper/main.tex can be opened in it, not only a
// Research topic. An app registers a workspace (its folder, title, which editor features it has, and a hook after a
// save); /api/ws/<id>/… serves the editor's core: files, read, write, build, page images, spelling.
//
// LaTeX is code, so builds run as the agent user (bin/paper-build), in the workspace's paper folder, without shell escape.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as agentUser from '../agentuser.js';
import { record } from '../audit.js';

const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const REG = new Map();
// { id, title, dir: () => folder (holding paper/), caps: ['build','spell'], files: [extra editable paths], afterWrite(rel) }
export function register(ws) { REG.set(ws.id, ws); }
export function get(id) { const w = REG.get(id); if (!w) throw httpError(404, 'No such workspace.'); const dir = w.dir(); if (!dir || !fs.existsSync(path.join(dir, 'paper', 'main.tex'))) throw httpError(409, `${w.title} is not set up yet.`); return { ...w, root: dir, paper: path.join(dir, 'paper') }; }
const FILE_OK = /^(main\.tex|sections\/[A-Za-z0-9._-]{1,60}\.tex|[A-Za-z0-9._-]{1,60}\.(tex|cls|sty|bib))$/;
function editable(w, rel) { const r = String(rel || ''); if (!FILE_OK.test(r) || r.includes('..')) throw httpError(400, 'Only .tex, .cls, .sty and .bib files in the paper folder can be edited.'); return path.join(w.paper, r); }

export function info(id) { const w = get(id); const b = readJson(path.join(w.paper, 'build', 'build.json')); return { id, title: w.title, caps: w.caps || [], build: b, pagesAvailable: pageNames(w.paper).length }; }
export function files(id) {
    const w = get(id); const out = [];
    const add = rel => { try { out.push({ path: rel, label: rel.replace(/^sections\//, ''), size: fs.statSync(path.join(w.paper, rel)).size }); } catch { /* gone */ } };
    add('main.tex');
    try { for (const f of fs.readdirSync(path.join(w.paper, 'sections')).filter(f => f.endsWith('.tex')).sort()) add(`sections/${f}`); } catch { /* none */ }
    try { for (const f of fs.readdirSync(w.paper).filter(f => /\.(cls|sty|bib)$/.test(f) || (f.endsWith('.tex') && f !== 'main.tex')).sort()) add(f); } catch { /* none */ }
    return { files: out, bib: [], lang: 'en-GB', langs: { 'en-GB': 'English (UK)', 'en-US': 'English (US)' } };
}
export function readFile(id, rel) { const f = editable(get(id), rel); const ok = fs.existsSync(f); return { path: rel, text: ok ? fs.readFileSync(f, 'utf8') : '', mtime: ok ? fs.statSync(f).mtimeMs : 0 }; }
export function writeFile(id, rel, text, { baseMtime = 0 } = {}) {
    const w = get(id); const f = editable(w, rel); const s = String(text); if (s.length > 2_000_000) throw httpError(413, 'File is too large.');
    const fresh = !fs.existsSync(f);
    if (!fresh && baseMtime && fs.statSync(f).mtimeMs > Number(baseMtime) + 1) throw httpError(409, 'Something changed this file since you opened it. Reload it to see the change.');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s);
    const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, 0o664); } catch { /* best effort */ }
    if (w.afterWrite) { try { w.afterWrite(rel); } catch (e) { throw httpError(400, e.message); } }
    record('activity', 'workspace-edit', { actor: 'phone', what: `${w.title}: ${rel}`, cwd: path.dirname(f) });
    return { ok: true, mtime: fs.statSync(f).mtimeMs };
}
const building = new Set();
export async function build(id) {
    const w = get(id); if (building.has(id)) throw httpError(409, 'A build is already running.'); building.add(id);
    try { return await buildPaper(w.root); } finally { building.delete(id); }
}
// Build <dir>/paper/main.tex (as the agent user when PlatOpypus runs as root) and return build.json.
export async function buildPaper(dir) {
    const cli = path.resolve(here, '..', '..', '..', 'bin', 'paper-build'); const a = agentUser.info();
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f));
    try {
        if (a && process.getuid?.() === 0 && runuser) await run(runuser, ['-u', agentUser.USER, '--', 'env', 'PATH=/usr/local/bin:/usr/bin:/bin', `HOME=${a.home}`, 'node', cli, dir], { timeout: 240_000 });
        else await run('node', [cli, dir], { timeout: 240_000 });
    } catch { /* the result file says what happened */ }
    const r = readJson(path.join(dir, 'paper', 'build', 'build.json'));
    if (!r) throw httpError(500, 'The build did not run (is LaTeX installed? Add the Research app, or install latexmk).');
    return r;
}
const pageNames = paper => { try { return fs.readdirSync(path.join(paper, 'build', 'pages')).filter(f => f.endsWith('.png')).sort(); } catch { return []; } };
export function pageFile(id, n) { const w = get(id); const names = pageNames(w.paper); const i = Number(n) - 1; if (!Number.isInteger(i) || i < 0 || i >= names.length) throw httpError(404, 'No such page.'); return path.join(w.paper, 'build', 'pages', names[i]); }
export function pdfFile(id) { const f = path.join(get(id).paper, 'build', 'main.pdf'); if (!fs.existsSync(f)) throw httpError(404, 'Not built yet.'); return f; }
export async function spell(id, text, lang = 'en-GB') {
    get(id);
    const out = await new Promise((ok, bad) => {
        const c = spawn('aspell', ['--mode=tex', `--lang=${String(lang).replace('-', '_')}`, '--encoding=utf-8', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let o = ''; c.stdout.on('data', d => { o += d; }); c.on('error', () => bad(httpError(501, 'The spelling checker is not installed (add the Research app).'))); c.on('close', code => (code === 0 ? ok(o) : bad(httpError(501, 'No dictionary for that language on this box.'))));
        c.stdin.end(String(text).slice(0, 2_000_000));
    });
    const count = new Map(); for (const w of out.split('\n').map(s => s.trim()).filter(Boolean)) count.set(w, (count.get(w) || 0) + 1);
    return { lang, words: [...count].map(([word, n]) => ({ word, n })).sort((a, b) => b.n - a.n).slice(0, 400) };
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
