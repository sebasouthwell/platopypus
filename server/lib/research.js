// Research topics (/Research/<Topic>): create them, list them, build the paper, serve its pages and sources to the app,
// and hold the "asks": things an agent will not do without the user's Allow (downloads, frames, images to the model).
// The heavy file work and the agent's tools are in researchtools.js and bin/research; this file is the app's side.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as alerts from './alerts.js';
import * as T from './researchtools.js';

const run = promisify(execFile);
export const ROOT = path.join(config.root, 'Research');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const briefFile = path.resolve(here, '..', '..', 'deploy', 'research', 'brief.md');

const httpError = T.httpError;
export const slugify = title => String(title || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `topic-${Date.now().toString(36)}`;
export function topicPath(slug) {
    if (!SLUG.test(String(slug))) throw httpError(400, 'Bad topic name.');
    const p = path.join(ROOT, slug);
    if (!T.exists(path.join(p, '.platopypus', 'research.json'))) throw httpError(404, 'No such research topic.');
    return p;
}
// The topic a folder is inside, or null.
export function topicOf(dir) {
    const rel = path.relative(ROOT, path.resolve(String(dir || '')));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const slug = rel.split(path.sep)[0];
    return SLUG.test(slug) && T.exists(path.join(ROOT, slug, '.platopypus', 'research.json')) ? slug : null;
}

export async function create({ title, brief = '' }) {
    const t = String(title || '').trim(); if (t.length < 3 || t.length > 120) throw httpError(400, 'Give the topic a title (3 to 120 characters).');
    let slug = slugify(t); for (let i = 2; T.exists(path.join(ROOT, slug)); i++) slug = `${slugify(t).slice(0, 44)}-${i}`;
    const dir = path.join(ROOT, slug);
    for (const d of ['paper/sections', 'sources', 'notes', '.platopypus/asks']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper', 'main.tex'), T.TEMPLATE_TEX(t));
    fs.writeFileSync(path.join(dir, 'paper', 'sections', 'introduction.tex'), `\\section{Introduction}\n% Write here. Cite with: research cite <id> --claim "…"\n`);
    fs.writeFileSync(path.join(dir, 'paper', 'refs.bib'), '');
    fs.writeFileSync(path.join(dir, 'notes', 'outline.md'), `# ${t}\n\n${String(brief || '').trim() || '(what this research should find out)'}\n`);
    fs.writeFileSync(path.join(dir, 'notes', 'claims.md'), '# Claims and their evidence\n\n');
    let doc = ''; try { doc = fs.readFileSync(briefFile, 'utf8'); } catch { doc = '# Research session\n\nUse the `research` tools; never paste a whole source into the chat.\n'; }
    fs.writeFileSync(path.join(dir, '.platopypus', 'research.md'), doc);
    T.writeJson(path.join(dir, '.platopypus', 'research.json'), { title: t, created: Date.now(), brief: String(brief || '').slice(0, 2000) });
    try { await agentUser.prepareFolder(dir); } catch (e) { log('research', `${slug}: agent folder access not set (${e.message})`); }
    record('activity', 'research-new', { actor: 'phone', what: `${t} (/Research/${slug})`, cwd: dir });
    return summary(slug);
}

function summary(slug) {
    const dir = path.join(ROOT, slug); const meta = T.readJson(path.join(dir, '.platopypus', 'research.json'), {});
    const build = T.readJson(path.join(dir, 'paper', 'build', 'build.json'), null); const src = T.listSources(dir);
    const asks = asksIn(dir).filter(a => a.status === 'pending');
    const hasText = (() => { try { return fs.readdirSync(path.join(dir, 'paper', 'sections')).some(f => fs.statSync(path.join(dir, 'paper', 'sections', f)).size > 160); } catch { return false; } })();
    const status = build?.ok ? 'built' : hasText ? 'writing' : 'gathering';
    return { slug, title: meta.title || slug, brief: meta.brief || '', created: meta.created || 0, status, sources: src.length, pages: build?.pages || 0, builtAt: build?.at || null, pending: asks.length, updated: newest(dir) };
}
function newest(dir) { let m = 0; for (const d of ['paper', 'sources', 'notes']) { try { m = Math.max(m, fs.statSync(path.join(dir, d)).mtimeMs); } catch { /* none */ } } return m; }
export function list() {
    let names = []; try { names = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && SLUG.test(e.name)).map(e => e.name); } catch { /* none yet */ }
    return names.filter(n => T.exists(path.join(ROOT, n, '.platopypus', 'research.json'))).map(summary).sort((a, b) => b.updated - a.updated);
}
const pageNames = dir => { try { return fs.readdirSync(path.join(dir, 'paper', 'build', 'pages')).filter(f => f.endsWith('.png')).sort(); } catch { return []; } };
export function detail(slug) {
    const dir = topicPath(slug); const s = summary(slug);
    const cost = T.costOf(dir);
    return {
        ...s, build: T.readJson(path.join(dir, 'paper', 'build', 'build.json'), null), pagesAvailable: pageNames(dir).length,
        sources: T.listSources(dir).map(m => ({ id: m.id, kind: m.kind, title: m.title, author: m.author, year: m.year, url: m.url, chars: m.chars, state: m.state, note: m.note, duration: m.duration || null, pages: m.pages || null, key: T.bibKey(m) })),
        cost, saved: Math.max(0, cost.ingestedChars - cost.readChars), asks: asksIn(dir),
        notes: { outline: readCap(path.join(dir, 'notes', 'outline.md')), claims: readCap(path.join(dir, 'notes', 'claims.md')) },
        sections: (() => { try { return fs.readdirSync(path.join(dir, 'paper', 'sections')).filter(f => f.endsWith('.tex')); } catch { return []; } })(),
    };
}
const readCap = (f, n = 30000) => { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return ''; } };

const building = new Set();
export async function build(slug) {
    const dir = topicPath(slug); if (building.has(slug)) throw httpError(409, 'A build is already running.');
    building.add(slug);
    try {
        const a = agentUser.info();
        // LaTeX is code: it runs as the agent user (no root, no logins), in the paper folder, without shell escape.
        if (a && process.getuid?.() === 0) {
            const r = await runAsAgent(dir);
            record('activity', 'research-build', { actor: 'phone', what: `${slug}: ${r.ok ? `${r.pages} pages, ${r.warnings} warnings` : 'failed'}`, cwd: dir });
            return r;
        }
        const r = await T.build(dir);
        record('activity', 'research-build', { actor: 'phone', what: `${slug}: ${r.ok ? `${r.pages} pages, ${r.warnings} warnings` : 'failed'}`, cwd: dir });
        return r;
    } finally { building.delete(slug); }
}
// Run the build as the agent user by calling the same code through the research CLI (which does the work as that user).
async function runAsAgent(dir) {
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => T.exists(f)) || 'runuser';
    const cli = path.resolve(here, '..', '..', 'bin', 'research');
    try { await run(runuser, ['-u', agentUser.USER, '--', 'env', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=' + agentUser.info().home, 'node', cli, 'build'], { cwd: dir, timeout: 240_000 }); } catch { /* build.json says what happened */ }
    const info = T.readJson(path.join(dir, 'paper', 'build', 'build.json'), null);
    if (!info) throw httpError(500, 'The build did not run (is LaTeX installed? see More → Research tools).');
    return info;
}

export function pdfFile(slug) { const f = path.join(topicPath(slug), 'paper', 'build', 'main.pdf'); if (!T.exists(f)) throw httpError(404, 'Not built yet.'); return f; }
export function pageFile(slug, n) {
    const dir = topicPath(slug); const names = pageNames(dir); const i = Number(n) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= names.length) throw httpError(404, 'No such page.');
    return path.join(dir, 'paper', 'build', 'pages', names[i]);
}
export function sourceView(slug, id, { from = 0, max = 12000 } = {}) {
    const dir = topicPath(slug); if (!T.validId(id)) throw httpError(400, 'Bad source id.');
    const meta = T.sourceMeta(dir, id); const sd = path.join(dir, 'sources', id);
    let text = ''; try { text = fs.readFileSync(path.join(sd, 'text.md'), 'utf8'); } catch { /* none */ }
    const tr = T.readJson(path.join(sd, 'transcript.json'), null);
    return { meta: { ...meta, key: T.bibKey(meta) }, text: text.slice(Number(from), Number(from) + max), chars: text.length, transcript: tr ? T.windows(tr, 20) : null, frames: T.readJson(path.join(sd, 'ocr.json'), null) };
}
export function frameFile(slug, id, name) {
    const dir = topicPath(slug); if (!T.validId(id) || !/^f\d{4}\.jpg$/.test(String(name))) throw httpError(400, 'Bad frame.');
    const f = path.join(dir, 'sources', id, 'frames', name); if (!T.exists(f)) throw httpError(404, 'No such frame.'); return f;
}
export function sourceOriginal(slug, id) { const dir = topicPath(slug); if (!T.validId(id)) throw httpError(400, 'Bad source id.'); const f = path.join(dir, 'sources', id, 'original.pdf'); if (!T.exists(f)) throw httpError(404, 'No original file.'); return f; }

// kind: pdf | bib | tex | zip. tex and zip are zip files built in a temp folder and removed after they are sent.
export async function exportFile(slug, kind) {
    const dir = topicPath(slug);
    if (kind === 'pdf') return { file: pdfFile(slug), name: `${slug}.pdf`, type: 'application/pdf' };
    if (kind === 'bib') { const f = path.join(dir, 'paper', 'refs.bib'); if (!T.exists(f)) throw httpError(404, 'No references yet.'); return { file: f, name: `${slug}.bib`, type: 'text/plain; charset=utf-8' }; }
    if (!['tex', 'zip'].includes(kind)) throw httpError(400, 'pdf, bib, tex or zip.');
    if (!(await T.which('zip'))) throw httpError(501, 'zip is not installed on this box.');
    const tmp = path.join(config.state, 'research-export'); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const out = path.join(tmp, `${slug}-${kind}-${crypto.randomBytes(4).toString('hex')}.zip`);
    if (kind === 'tex') await run('zip', ['-r', '-q', out, 'paper', '-x', 'paper/build/*'], { cwd: dir, timeout: 60_000 });
    else await run('zip', ['-r', '-q', out, '.', '-x', '.platopypus/*', 'sources/*/frames/*', 'sources/*/audio.*', 'sources/*/video.*', 'paper/build/pages/*'], { cwd: dir, timeout: 120_000 });
    record('activity', 'research-export', { actor: 'phone', what: `${slug} as ${kind}`, cwd: dir });
    return { file: out, name: `${slug}-${kind === 'tex' ? 'latex' : 'topic'}.zip`, type: 'application/zip', remove: true };
}

// ---------- asks ----------
const askDir = dir => path.join(dir, '.platopypus', 'asks');
function asksIn(dir) {
    try { return fs.readdirSync(askDir(dir)).filter(f => f.endsWith('.json')).map(f => T.readJson(path.join(askDir(dir), f))).filter(Boolean).sort((a, b) => b.created - a.created).slice(0, 40); } catch { return []; }
}
const ASK_TYPES = ['download-audio', 'frames', 'send-frames', 'question'];
export function createAsk(callerCwd, body) {
    const slug = topicOf(callerCwd); if (!slug) throw httpError(403, 'This shell is not inside a research topic (/Research/<Topic>).');
    const type = String(body.type || ''); if (!ASK_TYPES.includes(type)) throw httpError(400, `type: ${ASK_TYPES.join(', ')}.`);
    const dir = path.join(ROOT, slug);
    const a = { id: crypto.randomBytes(6).toString('hex'), topic: slug, type, title: String(body.title || '').slice(0, 300), detail: body.detail && typeof body.detail === 'object' ? JSON.parse(JSON.stringify(body.detail).slice(0, 4000)) : {}, status: 'pending', created: Date.now() };
    if (type === 'question') {
        // A question is answered in the app: tappable options when the agent offers them, and always room for your own words.
        const d = a.detail; a.detail = { why: String(d.why || '').slice(0, 400), options: (Array.isArray(d.options) ? d.options : []).map(o => String(o).trim().slice(0, 90)).filter(Boolean).slice(0, 8), multi: !!d.multi, later: !!d.later };
    }
    fs.mkdirSync(askDir(dir), { recursive: true }); T.writeJson(path.join(askDir(dir), a.id + '.json'), a);
    record('activity', 'research-ask', { actor: 'agent', what: `${a.title} (${slug})`, cwd: dir });
    alerts.notify('research', `Research: ${a.title}\n${slug}${a.detail.video ? ` · ${a.detail.video}` : ''}\nOpen the app to ${type === 'question' ? 'answer' : 'allow or skip'}.`, { key: a.id });
    return a;
}
export function getAsk(callerCwd, id) {
    const slug = topicOf(callerCwd); if (!slug || !/^[a-f0-9]{12}$/.test(id)) throw httpError(404, 'No such ask.');
    const a = T.readJson(path.join(askDir(path.join(ROOT, slug)), id + '.json')); if (!a) throw httpError(404, 'No such ask.'); return a;
}
export function pendingAsks() {
    return list().filter(t => t.pending).flatMap(t => asksIn(path.join(ROOT, t.slug)).filter(a => a.status === 'pending').map(a => ({ ...a, topicTitle: t.title })));
}
export function decide(slug, id, { allow, answer = '' }) {
    const dir = topicPath(slug); const f = path.join(askDir(dir), `${/^[a-f0-9]{12}$/.test(id) ? id : 'x'}.json`); const a = T.readJson(f);
    if (!a) throw httpError(404, 'No such ask.'); if (a.status !== 'pending') throw httpError(409, `Already ${a.status}.`);
    if (a.type === 'question' && allow && !String(answer).trim()) throw httpError(400, 'Pick an option or write an answer.');
    a.status = allow ? 'allowed' : 'denied'; a.decided = Date.now(); if (answer) a.answer = String(answer).trim().slice(0, 2000);
    T.writeJson(f, a);
    if (a.type === 'question') logDecision(dir, a.title, allow ? a.answer : '(skipped: use your judgement)');
    record('activity', allow ? 'research-allowed' : 'research-denied', { actor: 'phone', what: `${a.title}${a.detail?.url ? ` · ${a.detail.url}` : ''} (${slug})`, cwd: dir });
    return a;
}

// Every answer and note is also kept in notes/decisions.md, so a later session (or a different agent) starts from what
// you already decided instead of asking again.
function logDecision(dir, question, answer) {
    const f = path.join(dir, 'notes', 'decisions.md'); fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!T.exists(f)) fs.writeFileSync(f, '# Decisions\n\nWhat the user answered or asked for, newest last. Read this before asking anything.\n');
    fs.appendFileSync(f, `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')}  ${String(question).replace(/\s+/g, ' ')}\n${String(answer).trim()}\n`);
}
// Something you want the agent to know or do, written in the app at any time (no question needed).
export function addNote(slug, text) {
    const dir = topicPath(slug); const t = String(text || '').trim(); if (t.length < 2) throw httpError(400, 'Write the note first.');
    const a = { id: crypto.randomBytes(6).toString('hex'), topic: slug, type: 'note', title: 'Note from you', detail: {}, status: 'allowed', answer: t.slice(0, 2000), created: Date.now(), decided: Date.now() };
    fs.mkdirSync(askDir(dir), { recursive: true }); T.writeJson(path.join(askDir(dir), a.id + '.json'), a);
    logDecision(dir, 'Note from the user', a.answer);
    record('activity', 'research-note', { actor: 'phone', what: `${slug}: ${a.answer.slice(0, 80)}`, cwd: dir });
    return a;
}
