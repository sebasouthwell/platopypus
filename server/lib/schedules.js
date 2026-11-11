// Scheduled routines: small scripts in /Scheduled that the box runs on a cron-style schedule while it is on.
//
// You make them from More → Schedules. Agents can only propose one (`schedule add` in an agent shell): it waits,
// switched off, until you read the script and approve it, and an agent's routine always runs as the agent user.
// Each routine remembers the fingerprint of the script you approved or saved; if the file changes behind its back,
// it pauses ("changed") until you look again. Runs are logged in /Scheduled/.runs and in the audit log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { record } from './audit.js';
import * as alerts from './alerts.js';
import * as agentUser from './agentuser.js';

export const ROOT = path.join(config.root, 'Scheduled');
const RUNS = path.join(ROOT, '.runs'), WORK = path.join(ROOT, '.work');
const file = path.join(config.state, 'schedules.json');
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_SCRIPT = 64 * 1024, KEEP_RUNS = 20, MAX_PROPOSED = 10;
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: {} }; } };
const save = s => fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const scriptPath = id => path.join(ROOT, `${id}.sh`);
const readScript = id => { try { return fs.readFileSync(scriptPath(id), 'utf8'); } catch { return null; } };
function ensureRoot() { for (const d of [ROOT, RUNS, WORK]) fs.mkdirSync(d, { recursive: true, mode: 0o755 }); }

// ---------- cron ----------
// Five fields (minute hour day-of-month month day-of-week), box time. *, lists, ranges, steps, day and month names,
// and @hourly / @daily / @weekly / @monthly / @yearly.
const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = [null, null, null, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']];
export function parseCron(expr) {
    const raw = String(expr || '').trim().toLowerCase(); const text = MACROS[raw] || raw;
    const parts = text.split(/\s+/); if (parts.length !== 5) throw httpError(400, 'A schedule has five parts: minute hour day month weekday (for example 0 3 * * * for 03:00 every day).');
    const sets = parts.map((p, i) => {
        const [lo, hi] = RANGES[i]; const out = new Set();
        const num = v => { const n = NAMES[i]?.indexOf(v); const x = n >= 0 ? n + (i === 3 ? 1 : 0) : Number(v); if (!/^\d+$/.test(String(x)) || x < lo || x > hi) throw httpError(400, `"${v}" is not valid in the ${['minute', 'hour', 'day', 'month', 'weekday'][i]} part.`); return x; };
        for (const piece of p.split(',')) {
            const m = piece.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/); if (!m) throw httpError(400, `"${piece}" is not valid in the ${['minute', 'hour', 'day', 'month', 'weekday'][i]} part.`);
            const step = m[2] ? Number(m[2]) : 1; if (step < 1) throw httpError(400, 'A step must be 1 or more.');
            let a = lo, b = hi; if (m[1] !== '*') { const [x, y] = m[1].split('-'); a = num(x); b = y !== undefined ? num(y) : (m[2] ? hi : a); }
            if (a > b) throw httpError(400, `"${piece}" runs backwards.`);
            for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
        }
        return out;
    });
    return { sets, domAny: parts[2] === '*', dowAny: parts[4] === '*', text };
}
function matches(c, d) {
    const [mi, h, dom, mon, dow] = c.sets;
    if (!mi.has(d.getMinutes()) || !h.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false;
    const a = dom.has(d.getDate()), b = dow.has(d.getDay());
    return c.domAny && c.dowAny ? true : c.domAny ? b : c.dowAny ? a : (a || b);   // classic cron: both set means either
}
export function nextRun(expr, from = Date.now()) {
    let c; try { c = parseCron(expr); } catch { return null; }
    const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
    const end = from + 1470 * 86400_000;   // four years and a bit: 29 February comes round
    while (d.getTime() < end) {
        if (!c.sets[3].has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
        if (!matches({ ...c, sets: [new Set([d.getMinutes()]), new Set([d.getHours()]), c.sets[2], c.sets[3], c.sets[4]] }, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }   // the day itself
        if (!c.sets[1].has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
        if (!c.sets[0].has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
        return d.getTime();
    }
    return null;
}

// ---------- the list ----------
function view(id, it) {
    const text = readScript(id); const cur = text === null ? null : sha(text);
    const state = text === null ? 'missing' : it.status === 'proposed' ? 'proposed' : cur !== it.hash ? 'changed' : it.enabled ? 'on' : 'off';
    return { id, name: it.name, cron: it.cron, runAs: it.runAs, timeoutMin: it.timeoutMin, enabled: !!it.enabled, state, by: it.by, why: it.why || '', created: it.created, approved: it.approved || null,
        next: state === 'on' ? nextRun(it.cron) : null, last: it.last || null, running: running.has(id), file: scriptPath(id), hash: cur };
}
export function list() {
    const s = load();
    return { folder: ROOT, now: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        items: Object.entries(s.items).map(([id, it]) => view(id, it)).sort((a, b) => (a.state === 'proposed' ? -1 : 0) - (b.state === 'proposed' ? -1 : 0) || a.name.localeCompare(b.name)) };
}
export function get(id) {
    const s = load(); const it = s.items[id]; if (!it) throw httpError(404, 'No such routine.');
    return { ...view(id, it), script: readScript(id) ?? '', runs: runsOf(id) };
}
function runsOf(id) {
    try { return fs.readdirSync(path.join(RUNS, id)).filter(f => f.endsWith('.json')).sort().reverse().slice(0, KEEP_RUNS).map(f => { try { return JSON.parse(fs.readFileSync(path.join(RUNS, id, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
export function runLog(id, run) {
    if (!SLUG.test(id) || !/^\d{8}T\d{6}Z?$/.test(run)) throw httpError(400, 'Bad run.');
    try { const t = fs.readFileSync(path.join(RUNS, id, `${run}.log`), 'utf8'); return { id, run, text: t.length > 200_000 ? '…\n' + t.slice(-200_000) : t }; } catch { throw httpError(404, 'That run has no log.'); }
}
function slugFor(name, items) {
    const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'routine';
    let id = base; for (let i = 2; items[id]; i++) id = `${base}-${i}`; return id;
}
function checkScript(script) {
    const t = String(script ?? ''); if (!t.trim()) throw httpError(400, 'The routine needs a script.'); if (Buffer.byteLength(t) > MAX_SCRIPT) throw httpError(400, 'Keep the script under 64 KB.');
    if (t.includes('\0')) throw httpError(400, 'The script must be text.'); return t.endsWith('\n') ? t : t + '\n';
}
function writeScript(id, text) { ensureRoot(); const f = scriptPath(id); const tmp = f + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o644 }); fs.renameSync(tmp, f); }
const cleanName = n => { const v = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 60); if (!v) throw httpError(400, 'Give the routine a name.'); return v; };
const cleanTimeout = t => { const n = Math.round(Number(t ?? 30)); if (!(n >= 1 && n <= 240)) throw httpError(400, 'The time limit is 1 to 240 minutes.'); return n; };

// Made on the phone: on straight away.
export function create({ name, cron, script, runAs = 'agent', timeoutMin = 30, enabled = true } = {}) {
    const s = load(); const n = cleanName(name); parseCron(cron); const text = checkScript(script);
    if (!['agent', 'root'].includes(runAs)) throw httpError(400, 'Run as the agent user or root.');
    if (runAs === 'agent' && !agentUser.info()) throw httpError(412, 'The agent user does not exist on this box yet; run it as root or set up the agent user.');
    const id = slugFor(n, s.items); writeScript(id, text);
    s.items[id] = { name: n, cron: String(cron).trim(), runAs, timeoutMin: cleanTimeout(timeoutMin), enabled: !!enabled, status: 'active', hash: sha(text), by: 'phone', created: Date.now(), approved: Date.now() };
    save(s); record('activity', 'schedule-created', { actor: 'phone', what: `${n} (${String(cron).trim()}, as ${runAs})` });
    return get(id);
}
// Proposed by an agent: off until the user approves it, and only ever as the agent user.
export function propose({ name, cron, script, why = '', from }) {
    const s = load(); const n = cleanName(name); parseCron(cron); const text = checkScript(script);
    if (Object.values(s.items).filter(i => i.status === 'proposed').length >= MAX_PROPOSED) throw httpError(429, `${MAX_PROPOSED} routines are already waiting for the user's approval.`);
    const id = slugFor(n, s.items); writeScript(id, text);
    s.items[id] = { name: n, cron: String(cron).trim(), runAs: 'agent', timeoutMin: 30, enabled: false, status: 'proposed', hash: sha(text), by: `shell "${from}"`, why: String(why || '').slice(0, 500), created: Date.now() };
    save(s); record('activity', 'schedule-proposed', { actor: `shell "${from}"`, what: `${n} (${String(cron).trim()})${why ? `: ${String(why).slice(0, 200)}` : ''}` });
    alerts.notify('schedule', `An agent (shell "${from}") proposed a scheduled routine: ${n} (${String(cron).trim()}). It stays off until you read and approve it in More → Schedules.`);
    return { id, name: n, cron: String(cron).trim(), state: 'proposed', file: scriptPath(id), message: 'Proposed. It stays off until the user reads the script and approves it in More → Schedules.' };
}
export function update(id, body = {}) {
    const s = load(); const it = s.items[id]; if (!it) throw httpError(404, 'No such routine.');
    const what = [];
    if (body.name !== undefined) { it.name = cleanName(body.name); what.push('name'); }
    if (body.cron !== undefined) { parseCron(body.cron); it.cron = String(body.cron).trim(); what.push(`schedule ${it.cron}`); }
    if (body.timeoutMin !== undefined) { it.timeoutMin = cleanTimeout(body.timeoutMin); what.push(`limit ${it.timeoutMin} min`); }
    if (body.runAs !== undefined) { if (!['agent', 'root'].includes(body.runAs)) throw httpError(400, 'Run as the agent user or root.'); it.runAs = body.runAs; what.push(`as ${it.runAs}`); }
    if (body.script !== undefined) { const t = checkScript(body.script); writeScript(id, t); it.hash = sha(t); what.push('script'); }
    if (body.enabled !== undefined) {
        if (body.enabled && it.status === 'proposed') throw httpError(409, 'Approve it first.');
        if (body.enabled) { const t = readScript(id); if (t === null) throw httpError(409, 'The script file is missing.'); if (sha(t) !== it.hash) throw httpError(409, 'The script changed since it was saved or approved. Open it, check it, and save it again.'); }
        it.enabled = !!body.enabled; what.push(it.enabled ? 'on' : 'off');
    }
    save(s); record('activity', 'schedule-changed', { actor: 'phone', what: `${it.name}: ${what.join(', ') || 'nothing'}` });
    return get(id);
}
// Approve exactly the script the user was shown (its fingerprint), not whatever the file holds by then.
export function approve(id, { hash, runAs } = {}) {
    const s = load(); const it = s.items[id]; if (!it) throw httpError(404, 'No such routine.');
    const t = readScript(id); if (t === null) throw httpError(409, 'The script file is missing.');
    if (!hash || sha(t) !== hash) throw httpError(409, 'The script changed while you were reading it. Open it again.');
    if (runAs !== undefined) { if (!['agent', 'root'].includes(runAs)) throw httpError(400, 'Run as the agent user or root.'); it.runAs = runAs; }
    it.hash = hash; it.status = 'active'; it.enabled = true; it.approved = Date.now();
    save(s); record('activity', 'schedule-approved', { actor: 'phone', what: `${it.name} (${it.cron}, as ${it.runAs}; by ${it.by})` });
    return get(id);
}
export function remove(id) {
    const s = load(); const it = s.items[id]; if (!it) throw httpError(404, 'No such routine.');
    delete s.items[id]; save(s);
    for (const p of [scriptPath(id), path.join(RUNS, id), path.join(WORK, id)]) fs.rmSync(p, { recursive: true, force: true });
    record('activity', 'schedule-removed', { actor: 'phone', what: it.name });
    return { removed: id };
}

// ---------- running ----------
const running = new Map();   // id → child
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export async function run(id, { why = 'schedule' } = {}) {
    const s = load(); const it = s.items[id]; if (!it) throw httpError(404, 'No such routine.');
    if (it.status === 'proposed') throw httpError(409, 'Approve it first.');
    if (running.has(id)) throw httpError(409, 'It is still running from last time.');
    const text = readScript(id); if (text === null) throw httpError(409, 'The script file is missing.');
    if (sha(text) !== it.hash) {
        if (why === 'schedule') alerts.notify('schedule', `Scheduled routine "${it.name}" did not run: its script changed since it was approved. Check it in More → Schedules.`, { key: `sched-changed-${id}`, quietMs: 24 * 3600_000 });
        throw httpError(409, 'The script changed since it was saved or approved, so it will not run until you check it.');
    }
    ensureRoot();
    const runDir = path.join(RUNS, id), work = path.join(WORK, id); fs.mkdirSync(runDir, { recursive: true }); fs.chmodSync(runDir, 0o711); fs.mkdirSync(work, { recursive: true, mode: 0o750 });   // 711: the agent user can open its script copy by name, not list or read the logs
    const a = it.runAs === 'agent' ? agentUser.info() : null;
    if (it.runAs === 'agent' && !a) throw httpError(412, 'The agent user does not exist on this box.');
    if (a) { try { fs.chownSync(work, a.uid, a.gid); } catch { /* best effort */ } }
    // Run the approved text itself (a copy only this run reads), so the file cannot be swapped mid-check.
    const copy = path.join(runDir, '.script.sh'); fs.writeFileSync(copy, text); fs.chmodSync(copy, 0o644);
    const started = new Date(); const name = stamp(started); const logf = path.join(runDir, `${name}.log`);
    const out = fs.openSync(logf, 'w', 0o640);
    const home = a ? a.home : config.home;
    const env = { PATH: `${a ? a.home + '/.local/bin:' : ''}/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`, HOME: home, LANG: 'C.UTF-8', PLATO_ROUTINE: id, PLATO_ROUTINE_DIR: work, TERM: 'dumb' };
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser';
    const [bin, args] = a ? [runuser, ['-u', a.user, '--', 'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'bash', copy]] : ['bash', [copy]];
    let child; try { child = spawn(bin, args, { cwd: work, env: a ? {} : env, stdio: ['ignore', out, out], detached: true }); } catch (e) { fs.closeSync(out); throw httpError(500, e.message); }
    running.set(id, child);
    record('activity', 'schedule-run', { actor: why === 'schedule' ? 'schedule' : 'phone', what: `${it.name} started (as ${it.runAs})` });
    const limitMs = (it.timeoutMin || 30) * 60_000; let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000); }, limitMs);
    return await new Promise(ok => {
        const done = (code, err) => {
            clearTimeout(t); running.delete(id); try { fs.closeSync(out); } catch { /* closed */ }
            const ms = Date.now() - started.getTime(); const exit = err ? -1 : code;
            if (err) fs.appendFileSync(logf, `\n[platopypus] could not start: ${err.message}\n`);
            if (timedOut) fs.appendFileSync(logf, `\n[platopypus] stopped after the ${it.timeoutMin}-minute limit\n`);
            const res = { run: name, at: started.getTime(), ms, exit, timedOut, why };
            fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(res));
            // Keep the newest runs only.
            try { const old = fs.readdirSync(runDir).filter(f => f.endsWith('.json')).sort().reverse().slice(KEEP_RUNS); for (const f of old) { fs.rmSync(path.join(runDir, f), { force: true }); fs.rmSync(path.join(runDir, f.replace(/\.json$/, '.log')), { force: true }); } } catch { /* fine */ }
            const s2 = load(); if (s2.items[id]) { s2.items[id].last = res; save(s2); }
            record('activity', 'schedule-finished', { actor: why === 'schedule' ? 'schedule' : 'phone', what: `${it.name}: ${timedOut ? 'stopped at the time limit' : exit === 0 ? 'ok' : `exit ${exit}`} in ${Math.round(ms / 1000)} s` });
            if (exit !== 0 || timedOut) alerts.notify('schedule', `Scheduled routine "${it.name}" ${timedOut ? `was stopped after ${it.timeoutMin} minutes` : `failed (exit ${exit})`}. Its log is in More → Schedules.`, { key: `sched-fail-${id}`, quietMs: 3 * 3600_000 });
            ok(res);
        };
        child.on('error', e => done(-1, e)); child.on('close', code => done(code ?? -1));
    });
}
// Called every few seconds; starts each routine once in the minute it is due.
let lastMinute = null;
export function tick(now = new Date()) {
    const key = Math.floor(now.getTime() / 60_000); if (key === lastMinute) return; lastMinute = key;
    const s = load();
    for (const [id, it] of Object.entries(s.items)) {
        if (it.status !== 'active' || !it.enabled || running.has(id)) continue;
        let c; try { c = parseCron(it.cron); } catch { continue; }
        if (matches(c, now)) run(id).catch(() => { /* recorded or alerted */ });
    }
}
