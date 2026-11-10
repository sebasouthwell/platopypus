// Power status: "is an agent working right now?" and "is the box being kept on?". Together they answer one question,
// "may this box be powered off now?", the way a health check answers "is it up?". Anything that can power the box off
// asks it (GET /api/power, or `plato power` on the box): a cloud schedule, cron, a UPS script. Nothing here knows or
// cares who is asking.
//
// An agent counts as WORKING when it is mid-task, not when it is waiting for you. Three signals, any one is enough:
//   1. its terminal changed in the last 90 s (a thinking spinner, streaming output; a prompt waiting for input is static)
//   2. its session transcript was written in the last 2 minutes (Claude Code / Codex append to it every turn and tool call)
//   3. something under it is using CPU (a build, a test run, a package install) while the terminal looks quiet
// Live services, plain shells and servers never count: they run whether or not anyone is working.
//
// Keep-alive is a date you set in the app ("keep the box on until Sunday"): until then the power status says "do not
// power off", whatever the agents are doing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { listSessions, capture } from './tmux.js';
import * as shells from './shells.js';
import * as agentUser from './agentuser.js';
import * as usage from './usage.js';

const PANE_MS = 90_000, TRANSCRIPT_MS = 120_000, CPU_PCT = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keepFile = path.join(config.state, 'keepalive.json');

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- keep-alive ----------

export function keepAlive() {
    try {
        const k = JSON.parse(fs.readFileSync(keepFile, 'utf8'));
        if (k && k.until > Date.now()) return { until: k.until, reason: k.reason || '', set: k.set || null };
    } catch { /* none */ }
    return null;
}
export function setKeepAlive({ until, hours, reason = '' } = {}) {
    let ms = until !== undefined && until !== null ? (typeof until === 'number' ? until : Date.parse(until)) : (Number(hours) > 0 ? Date.now() + Number(hours) * 3600_000 : NaN);
    if (!Number.isFinite(ms)) throw httpError(400, 'Give a date (until) or a number of hours.');
    if (ms <= Date.now()) throw httpError(400, 'That time has already passed.');
    if (ms > Date.now() + 60 * 86400_000) throw httpError(400, 'At most 60 days; set it again later.');
    const rec = { until: ms, reason: String(reason || '').slice(0, 120), set: Date.now() };
    const tmp = keepFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 }); fs.renameSync(tmp, keepFile);
    return keepAlive();
}
export function clearKeepAlive() { try { fs.rmSync(keepFile, { force: true }); } catch { /* none */ } return null; }

// ---------- agent activity ----------

const panes = new Map();   // shell name → { hash, changedAt }

const AGENT_KINDS = new Set(['agent', 'remote-control']);
async function agentShells() {
    const live = await listSessions();
    return live.map(s => ({ name: s.name, meta: shells.shellMeta(s.name) })).filter(s => s.meta && AGENT_KINDS.has(s.meta.kind === 'claude' ? 'agent' : s.meta.kind));
}

// Look at every agent terminal; remember when each last changed.
export async function sample() {
    const now = Date.now();
    const seen = new Set();
    for (const s of await agentShells()) {
        seen.add(s.name);
        let text = ''; try { text = await capture(s.name, 30); } catch { continue; }
        const hash = crypto.createHash('sha1').update(text).digest('hex');
        const p = panes.get(s.name);
        if (!p) panes.set(s.name, { hash, changedAt: 0, firstSeen: now });   // not "changed now": it was just noticed
        else if (p.hash !== hash) { p.hash = hash; p.changedAt = now; }
    }
    for (const k of [...panes.keys()]) if (!seen.has(k)) panes.delete(k);
}
let timer = null;
export function start() { if (timer) return; sample().catch(() => {}); timer = setInterval(() => sample().catch(() => {}), 30_000); timer.unref?.(); }

// Transcript folders: Claude Code keeps one folder per working directory (the path with every non-alphanumeric as "-").
function transcriptRoots() {
    const homes = new Set([config.home]); const a = agentUser.info(); if (a?.home) homes.add(a.home);
    const roots = [];
    for (const h of homes) {
        roots.push(path.join(h, '.claude', 'projects'));
        try { for (const p of fs.readdirSync(path.join(h, '.agent-profiles', 'claude'))) roots.push(path.join(h, '.agent-profiles', 'claude', p, 'projects')); } catch { /* none */ }
    }
    return roots;
}
function newestIn(dir) {
    let best = 0;
    try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.jsonl')) continue; try { best = Math.max(best, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* gone */ } } } catch { /* none */ }
    return best;
}
function transcriptAgeMs(cwd) {
    const enc = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
    let newest = 0;
    for (const r of transcriptRoots()) newest = Math.max(newest, newestIn(path.join(r, enc)));
    return newest ? Date.now() - newest : Infinity;
}
function codexAgeMs() {   // Codex keeps dated rollout files, not per-folder ones: any recent write counts for codex shells
    let newest = 0; const homes = [config.home]; const a = agentUser.info(); if (a?.home) homes.push(a.home);
    const walk = (d, depth) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (e.isFile()) { try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* gone */ } } } } catch { /* none */ } };
    for (const h of homes) walk(path.join(h, '.codex', 'sessions'), 0);
    return newest ? Date.now() - newest : Infinity;
}

// settle: sample twice this many ms apart first (a single look cannot tell a static prompt from a quiet pause).
export async function status({ settle = 0 } = {}) {
    if (settle > 0) { await sample(); usage.sample(true); await sleep(settle); await sample(); }
    else usage.sample();
    const now = Date.now(), out = [];
    for (const s of await agentShells()) {
        const why = [];
        const p = panes.get(s.name);
        if (p && p.changedAt && now - p.changedAt < PANE_MS) why.push('terminal changing');
        const age = s.meta.agent === 'codex' ? codexAgeMs() : transcriptAgeMs(s.meta.cwd);
        if (age < TRANSCRIPT_MS) why.push('session log written just now');
        let t = null; try { t = usage.tree(await shells.panePid(s.name)); } catch { /* gone */ }
        if (t && t.cpu >= CPU_PCT) why.push(`using ${t.cpu}% CPU`);
        out.push({ name: s.name, agent: s.meta.agent || 'claude', cwd: s.meta.cwd, working: why.length > 0, why });
    }
    return { at: now, agents: out, working: out.filter(a => a.working).map(a => a.name), keepAlive: keepAlive() };
}

// The answer for whoever asks: stop = it may be powered off now.
export function decide(st) {
    if (st.keepAlive) return { stop: false, why: 'keep-alive', message: `Kept on until ${new Date(st.keepAlive.until).toUTCString()}${st.keepAlive.reason ? ` (${st.keepAlive.reason})` : ''}.` };
    if (st.working.length) return { stop: false, why: 'working', message: `${st.working.length === 1 ? 'An agent is' : st.working.length + ' agents are'} working (${st.working.join(', ')}); not stopping this round.` };
    return { stop: true, why: 'idle', message: 'No agent is working and the box is not kept on.' };
}

export { log };
