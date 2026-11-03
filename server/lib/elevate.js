// Root for one command, on request from an agent-user shell and approval on the phone (docs/AGENT-USER.md).
// Requests live in memory (a restart drops pending ones; the CLI then reports it). A shell can also hold a time-limited
// "pure elevation" grant, during which its requests run without asking.

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log.js';

const run = promisify(execFile);
const requests = new Map();          // id -> request
const grants = new Map();            // shell -> until (ms)
const PENDING_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const view = r => ({ id: r.id, shell: r.shell, cwd: r.cwd, cmd: r.cmd, reason: r.reason, created: r.created, status: r.status, decidedBy: r.decidedBy || null, code: r.code ?? null, output: r.status === 'done' ? r.output : undefined, auto: !!r.auto });

function sweep() {
    const now = Date.now();
    for (const r of requests.values()) {
        if (r.status === 'pending' && now - r.created > PENDING_MS) { r.status = 'expired'; log('elevate', `request ${r.id} from "${r.shell}" expired`); }
        if (now - r.created > 24 * 3600_000) requests.delete(r.id);
    }
    for (const [s, until] of grants) if (until < now) grants.delete(s);
}

async function execute(r) {
    r.status = 'running';
    log('elevate', `RUN as root for "${r.shell}" in ${r.cwd}: ${r.cmd}`);
    try {
        const out = await run('bash', ['-lc', r.cmd], { cwd: r.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
        r.code = 0; r.output = (out.stdout || '') + (out.stderr || '');
    } catch (e) {
        r.code = typeof e.code === 'number' ? e.code : 1;
        r.output = (e.stdout || '') + (e.stderr || '') + (e.killed ? '\n[stopped after 10 minutes]' : '');
    }
    r.output = String(r.output).slice(-200_000);
    r.status = 'done';
    log('elevate', `done for "${r.shell}" → exit ${r.code}`);
}

export function grantUntil(shell) { sweep(); return grants.get(shell) || null; }
export function grant(shell, minutes) {
    const m = Math.max(0, Math.min(Number(minutes) || 0, 8 * 60));
    if (!m) { grants.delete(shell); log('elevate', `revoked elevation for "${shell}"`); return null; }
    const until = Date.now() + m * 60_000; grants.set(shell, until);
    log('elevate', `GRANTED full elevation to "${shell}" for ${m} min`);
    return until;
}

export function request(shell, { cmd, cwd, reason }) {
    sweep();
    const c = String(cmd || '').trim();
    if (!c) throw httpError(400, 'No command.');
    if (c.length > 4000) throw httpError(413, 'Command too long.');
    const r = { id: crypto.randomBytes(6).toString('hex'), shell, cwd: cwd || '/', cmd: c, reason: String(reason || '').slice(0, 300), created: Date.now(), status: 'pending' };
    requests.set(r.id, r);
    log('elevate', `request ${r.id} from "${shell}" in ${r.cwd}: ${c}`);
    if ((grants.get(shell) || 0) > Date.now()) { r.auto = true; r.decidedBy = 'standing grant'; execute(r); }
    return view(r);
}

export function get(id, shell = null) {
    sweep();
    const r = requests.get(id);
    if (!r || (shell && r.shell !== shell)) throw httpError(404, 'No such request.');
    return view(r);
}

export function pending() { sweep(); return [...requests.values()].filter(r => r.status === 'pending').map(view); }

export function decide(id, { allow, minutes = 0 }) {
    sweep();
    const r = requests.get(id);
    if (!r) throw httpError(404, 'No such request.');
    if (r.status !== 'pending') throw httpError(409, `Already ${r.status}.`);
    if (!allow) { r.status = 'denied'; r.decidedBy = 'phone'; log('elevate', `DENIED ${r.id} for "${r.shell}"`); return view(r); }
    r.decidedBy = minutes ? `phone (+${minutes} min grant)` : 'phone';
    if (minutes) grant(r.shell, minutes);
    execute(r);
    return view(r);
}
