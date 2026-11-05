// Audit trail of escalations (root) and credential use, kept on the box so the phone can show who did what, from
// which project. journald still gets every line (log.js); this file is the structured, browsable copy.
//
// Never written here: secret values, command output. Only names of Vault values, commands as asked, exit codes.
// Agents cannot read it (/api/audit is not on the agent-user allowlist).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

// One file per day (UTC) under ~/.porthole/audit/, kept for PORTHOLE_AUDIT_DAYS (90). A size cap (200 MB) is a
// backstop only: when it is hit, activity lines go from the oldest days first; root and credential lines are the
// last thing ever dropped. Files from 1.20.0 (audit.jsonl, audit.1.jsonl) are still read until they age out.
const dir = path.join(config.state, 'audit');
const legacy = [path.join(config.state, 'audit.1.jsonl'), path.join(config.state, 'audit.jsonl')];
const KEEP_DAYS = Math.max(7, Math.min(Number(process.env.PORTHOLE_AUDIT_DAYS) || 90, 3650));
const CAP_BYTES = Math.max(10, Number(process.env.PORTHOLE_AUDIT_MB) || 200) * 1024 * 1024;
const REPEAT_MS = 2 * 60_000;   // the same event again within this window bumps a count instead of a new line
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
const fileFor = day => path.join(dir, `${day}.jsonl`);
const projectsDir = path.join(config.root, 'Projects');

// The project a folder belongs to: the first folder under <root>/Projects. Null for anything else.
export function projectOf(dir) {
    if (!dir) return null;
    const rel = path.relative(projectsDir, path.resolve(String(dir)));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep)[0] || null;
}

const clip = (v, n) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

// The last line this process wrote, so a burst of identical events becomes one line with a count.
let last = null;   // { key, file, start, end, line }
const repeatKey = l => JSON.stringify([l.type, l.action, l.project, l.actor, l.what, l.cmd, l.names, l.via, l.code, l.cwd]);
let pruned = '';

// type: 'elevate', 'credential' or 'activity'. action: what happened. Everything else is optional context.
export function record(type, action, ev = {}) {
    try {
        const line = {
            at: Date.now(), type, action,
            project: ev.project !== undefined ? clip(ev.project, 80) ?? null : projectOf(ev.cwd),
            actor: clip(ev.actor, 120), id: clip(ev.id, 40), cwd: clip(ev.cwd, 400), cmd: clip(ev.cmd, 4000),
            reason: clip(ev.reason, 300), decidedBy: clip(ev.decidedBy, 80), code: typeof ev.code === 'number' ? ev.code : undefined,
            minutes: typeof ev.minutes === 'number' ? ev.minutes : undefined, auto: ev.auto ? true : undefined,
            what: clip(ev.what, 200), names: Array.isArray(ev.names) && ev.names.length ? ev.names.slice(0, 60).map(n => String(n).slice(0, 80)) : undefined,
            via: clip(ev.via, 80),
        };
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const f = fileFor(dayOf(line.at));
        const key = repeatKey(line);
        // Same as the last line, recently, and nothing else written since: rewrite that line with count + 1.
        if (!line.id && last && last.key === key && last.file === f && line.at - last.line.at < REPEAT_MS * (last.line.count || 1)) {
            let size = -1; try { size = fs.statSync(f).size; } catch { /* gone */ }
            if (size === last.end) {
                const merged = { ...last.line, count: (last.line.count || 1) + 1, lastAt: line.at };
                fs.truncateSync(f, last.start);
                fs.appendFileSync(f, JSON.stringify(merged) + '\n', { mode: 0o600 });
                last = { ...last, line: merged, end: fs.statSync(f).size };
                return;
            }
        }
        let start = 0; try { start = fs.statSync(f).size; } catch { /* new day */ }
        fs.appendFileSync(f, JSON.stringify(line) + '\n', { mode: 0o600 });
        last = { key, file: f, start, end: fs.statSync(f).size, line };
        if (pruned !== dayOf(line.at)) { pruned = dayOf(line.at); prune(); }
    } catch { /* auditing must never break the action it records; journald has the line regardless */ }
}

// Drop days past the retention window; past the size cap, thin activity out of the oldest days first.
export function prune(now = Date.now()) {
    try {
        const cutoff = dayOf(now - KEEP_DAYS * 86400_000);
        let days = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
        for (const n of days) if (n.slice(0, 10) < cutoff) fs.rmSync(path.join(dir, n), { force: true });
        for (const f of legacy) { try { if (now - fs.statSync(f).mtimeMs > KEEP_DAYS * 86400_000) fs.rmSync(f, { force: true }); } catch { /* none */ } }
        days = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
        const size = () => days.reduce((t, n) => { try { return t + fs.statSync(path.join(dir, n)).size; } catch { return t; } }, 0);
        if (size() <= CAP_BYTES) return;
        for (const n of days.slice(0, -1)) {   // never thin today
            const fp = path.join(dir, n);
            const keep = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l && !/"type":"activity"/.test(l));
            fs.writeFileSync(fp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
            if (size() <= CAP_BYTES) return;
        }
        while (days.length > 1 && size() > CAP_BYTES) fs.rmSync(path.join(dir, days.shift()), { force: true });
    } catch { /* best effort */ }
}

// Events from the last `days` days, oldest first.
function readAll(days = 30) {
    const out = [];
    const since = Date.now() - days * 86400_000;
    const files = [...legacy];
    try { files.push(...fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= dayOf(since)).sort().map(n => path.join(dir, n))); } catch { /* none yet */ }
    for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const l of text.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (e.at >= since) out.push(e); } catch { /* torn line */ } }
    }
    return out.sort((a, b) => a.at - b.at);
}
export const retention = () => ({ days: KEEP_DAYS, capMb: Math.round(CAP_BYTES / 1048576) });

// Root requests are several events (asked, allowed, done); the page shows one entry per request.
function foldElevations(events) {
    const byId = new Map(), out = [];
    for (const e of events) {
        if (e.type !== 'elevate' || !e.id || !['request', 'allowed', 'denied', 'expired', 'done'].includes(e.action)) { out.push(e); continue; }
        let r = byId.get(e.id);
        if (!r) { r = { ...e, type: 'elevate', action: 'request', status: 'pending', events: [] }; byId.set(e.id, r); out.push(r); }
        r.events.push({ at: e.at, action: e.action, code: e.code, decidedBy: e.decidedBy });
        if (e.action === 'request') Object.assign(r, { at: e.at, cmd: e.cmd, cwd: e.cwd, reason: e.reason, actor: e.actor, project: e.project, auto: e.auto, decidedBy: e.decidedBy ?? r.decidedBy });
        if (e.action === 'allowed') { r.status = 'running'; r.decidedBy = e.decidedBy || r.decidedBy; }
        if (e.action === 'denied' || e.action === 'expired') r.status = e.action;
        if (e.action === 'done') { r.status = 'done'; r.code = e.code; r.finished = e.at; }
        if (e.auto) { r.auto = true; r.status = r.status === 'pending' ? 'running' : r.status; }
    }
    return out;
}

export function query({ type = null, project = null, limit = 300, days = 30 } = {}) {
    const span = Math.max(1, Math.min(Number(days) || 30, KEEP_DAYS));
    const all = foldElevations(readAll(span));
    // Per-project summary across everything kept, so the page can show counts before filtering.
    const sum = new Map();
    for (const e of all) {
        const k = e.project || '';
        const s = sum.get(k) || { project: e.project || null, elevate: 0, rootRuns: 0, credential: 0, activity: 0, names: new Set(), last: 0 };
        const c = e.count || 1;
        if (e.type === 'elevate') { s.elevate++; if (e.action === 'request' && (e.status === 'done' || e.status === 'running')) s.rootRuns++; }
        if (e.type === 'activity') s.activity += c;
        if (e.type === 'credential') { s.credential += c; (e.names || []).forEach(n => s.names.add(n)); }
        s.last = Math.max(s.last, e.at); sum.set(k, s);
    }
    const projects = [...sum.values()].map(s => ({ ...s, names: [...s.names].sort() })).sort((a, b) => b.last - a.last);
    let events = all;
    if (type) events = events.filter(e => e.type === type);
    if (project !== null) events = events.filter(e => (e.project || '') === project);
    const n = Math.max(1, Math.min(Number(limit) || 300, 2000));
    return { events: events.slice(-n).reverse(), total: events.length, projects, days: span, retention: retention() };
}

// Commits in each project's git history (agents commit with git directly, so Porthole never sees the call).
// Marked as an agent's when the author or a Co-Authored-By trailer names one. Cached briefly: git log per repo.
const execFileP = promisify(execFile);
const AGENT_RE = /\b(claude|codex|gemini|copilot|antigravity|agent)\b|noreply@anthropic\.com/i;
let commitCache = { at: 0, key: '', list: [] };
export async function commits({ project = null, days = 14 } = {}) {
    const d = Math.max(1, Math.min(Number(days) || 14, 90));
    const key = `${d}`;
    if (Date.now() - commitCache.at > 30_000 || commitCache.key !== key) {
        let dirs = [];
        try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(projectsDir, e.name, '.git'))).map(e => e.name); } catch { dirs = []; }
        const SEP = '\x1f', END = '\x1e';
        const per = await Promise.all(dirs.slice(0, 80).map(async name => {
            try {
                const { stdout } = await execFileP('git', ['-c', 'safe.directory=*', '-C', path.join(projectsDir, name), 'log', '--all', `--since=${d}.days`, '-n', '200', `--format=%H${SEP}%an${SEP}%ae${SEP}%at${SEP}%s${SEP}%b${END}`], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
                return stdout.split(END).map(x => x.trim()).filter(Boolean).map(x => {
                    const [hash, an, ae, at, subject, body = ''] = x.split(SEP);
                    const co = (body.match(/^Co-Authored-By:\s*(.+)$/gim) || []).map(l => l.replace(/^Co-Authored-By:\s*/i, '').trim());
                    const agent = AGENT_RE.test(`${an} ${ae}`) ? an : (co.find(c => AGENT_RE.test(c)) || '').replace(/\s*<.*$/, '') || null;
                    return { type: 'activity', action: 'commit', project: name, at: Number(at) * 1000, hash: hash.slice(0, 12), author: an, agent, what: subject.slice(0, 200) };
                });
            } catch { return []; }
        }));
        commitCache = { at: Date.now(), key, list: per.flat().sort((a, b) => b.at - a.at) };
    }
    return project === null ? commitCache.list.slice(0, 400) : commitCache.list.filter(c => c.project === project).slice(0, 400);
}
