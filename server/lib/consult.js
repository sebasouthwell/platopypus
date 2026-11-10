// Agents asking other agents: from an agent shell, `consult <agent> "question"` runs the other agent once, in the same
// folder, read-only, and hands its answer back. Whether a session may do this depends on its type (More → AI agents):
// Security Lab and Research on by default, project work and control sessions off until you switch them on.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as agents from './agents.js';
import * as clineLib from './cline.js';

const file = path.join(config.state, 'consult.json');
const DEFAULTS = { lab: true, research: true, project: false, control: false };
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
export function settings() { let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ } return { ...DEFAULTS, ...s }; }
export function configure(body = {}) {
    const s = settings(); for (const k of Object.keys(DEFAULTS)) if (typeof body[k] === 'boolean') s[k] = body[k];
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    record('activity', 'consult-settings', { actor: 'phone', what: Object.entries(s).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ') });
    return s;
}
// Who can be asked: installed, signed in (or set up), and able to answer once without a terminal.
const CAN_ANSWER = ['claude', 'codex', 'antigravity', 'cline'];
export async function available(session = null) {
    const list = await agents.status(); const allowed = session ? !!settings()[session] : false;
    return { allowed, session, agents: list.map(a => ({ key: a.key, title: a.title, installed: a.installed, signedIn: !!a.signedIn, canAnswer: CAN_ANSWER.includes(a.key), ready: a.installed && !!a.signedIn && CAN_ANSWER.includes(a.key) })) };
}
const running = new Map();   // asking shell → count
const recent = [];           // times, for the hourly cap
// Read-only one-shot command lines: the asked agent may read the folder, not change it.
function argv(agent, prompt) {
    if (agent === 'claude') return ['claude', ['-p', prompt]];                                  // print mode: tools that need approval are refused
    if (agent === 'codex') return ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]];
    if (agent === 'cline') return ['cline', ['--auto-approve', 'false', prompt]];              // no terminal: anything needing approval is refused
    // Antigravity (Gemini): print mode in plan mode (no edits), inside a pseudo-terminal, because its print mode can drop
    // its output when writing to a pipe. The prompt goes in through the environment, so nothing needs quoting.
    if (agent === 'antigravity') return ['script', ['-qec', 'agy -p "$CONSULT_PROMPT" --mode plan --print-timeout 280s', '/dev/null'], { CONSULT_PROMPT: prompt }];
    throw httpError(400, 'That agent cannot be asked.');
}
export async function ask({ from, fromAgent, session, cwd, to, question }) {
    fromAgent = fromAgent || 'shell';   // a plain agent-user shell, not an agent
    if (!settings()[session]) throw httpError(403, `Asking other agents is off for ${session || 'this kind of'} sessions. The user can switch it on in More → AI agents.`);
    const target = String(to || '').toLowerCase(); const q = String(question || '').trim();
    if (!CAN_ANSWER.includes(target)) throw httpError(400, `Ask one of: ${CAN_ANSWER.join(', ')}.`);
    if (target === fromAgent) throw httpError(400, 'Ask a different agent than yourself.');
    if (q.length < 5 || q.length > 12000) throw httpError(400, 'Ask a question (5 to 12 000 characters).');
    const av = (await available(session)).agents.find(a => a.key === target);
    if (!av?.installed) throw httpError(409, `${av?.title || target} is not installed on this box.`);
    if (!av.signedIn) throw httpError(409, `${av.title} is not signed in${target === 'cline' ? ' (no Ollama server is set)' : ''}, so it cannot be asked.`);
    if ((running.get(from) || 0) >= 1) throw httpError(429, 'One question at a time from a shell.');
    const now = Date.now(); while (recent.length && now - recent[0] > 3600_000) recent.shift(); if (recent.length >= 30) throw httpError(429, 'Thirty questions in the last hour already. Try again later.');
    const a = agentUser.info(); if (!a || process.getuid?.() !== 0) throw httpError(412, 'Asking other agents needs the agent user.');
    if (!agentUser.allowedFolder(cwd)) throw httpError(403, 'This folder is not one agents work in.');
    if (target === 'cline') clineLib.prepare(a.home, { uid: a.uid, gid: a.gid });
    const prompt = `${fromAgent === 'shell' ? 'Someone' : `Another AI agent (${agents.catalog[fromAgent]?.title || fromAgent})`} working in this folder is asking for your view. Answer it directly and concisely. You may read files here to answer, but do not change anything.\n\nQuestion:\n${q}`;
    const [bin, args, extra = {}] = argv(target, prompt);
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser';
    const env = ['PATH=' + `${a.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, `HOME=${a.home}`, 'TERM=dumb', 'NO_COLOR=1', ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
    recent.push(now); running.set(from, (running.get(from) || 0) + 1);
    record('activity', 'agent-consult', { actor: `shell "${from}"`, what: `${fromAgent} asked ${target}: ${q.slice(0, 200)}`, cwd });
    try {
        const out = await new Promise((ok, bad) => {
            const c = spawn(runuser, ['-u', a.user, '--', 'env', '-i', ...env, bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
            let o = '', e = ''; c.stdout.on('data', d => { o += d; if (o.length > 400000) o = o.slice(-200000); }); c.stderr.on('data', d => { e += d; if (e.length > 100000) e = e.slice(-50000); });
            const t = setTimeout(() => { try { c.kill('SIGTERM'); } catch { /* gone */ } bad(httpError(504, `${av.title} did not answer within 5 minutes.`)); }, 300_000);
            c.on('close', code => { clearTimeout(t); if (code === 0 && o.trim()) ok(o); else bad(httpError(502, `${av.title} could not answer${code ? ` (exit ${code})` : ''}: ${(e || o).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)); });
            c.on('error', err => { clearTimeout(t); bad(httpError(500, err.message)); });
        });
        const answer = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
        return { from: fromAgent, to: target, answer: answer.slice(-20000) };
    } finally { running.set(from, Math.max(0, (running.get(from) || 1) - 1)); }
}
