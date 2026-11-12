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
const DEFAULTS = { lab: true, case: true, research: true, project: false, control: false };
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
    const zero = isZeroTrust(session); const can = k => (zero ? ZERO_TRUST : CAN_ANSWER).includes(k);
    return { allowed, session, zeroTrust: zero, agents: list.map(a => ({ key: a.key, title: a.title, installed: a.installed, signedIn: !!a.signedIn, canAnswer: can(a.key), ready: a.installed && !!a.signedIn && can(a.key) })) };
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
// Security Lab asks on zero-trust terms: the asked agent sees only the question it is given (no folder, no files, no
// instructions or connectors from this box, nothing saying what the work is unless the asker writes it), runs once,
// and gets no tools unless the asker grants web search. Only agents that can be confined like that may be asked.
const ZERO_TRUST = ['claude', 'cline'];
export const isZeroTrust = session => session === 'lab' || session === 'case';
export async function ask({ from, fromAgent, session, cwd, to, question, web = false }) {
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
    const zero = isZeroTrust(session);
    if (zero && !ZERO_TRUST.includes(target)) throw httpError(403, `${av.title} cannot be confined to zero trust (its sign-in comes with your setup's instructions and tools), so in Security Lab ask ${ZERO_TRUST.join(' or ')}.`);
    if (web && !(zero && target === 'claude')) throw httpError(400, web && zero ? 'Only Claude can be given web search here.' : '--web is for Security Lab questions; outside it the asked agent works as usual.');
    recent.push(now); running.set(from, (running.get(from) || 0) + 1);
    record('activity', 'agent-consult', { actor: `shell "${from}"`, what: `${fromAgent} asked ${target}${zero ? ` (zero trust${web ? ', web search' : ', no tools'})` : ''}: ${q.slice(0, 200)}`, cwd });
    try {
        if (zero) { const answer = await zeroTrust({ target, question: q, web, title: av.title }); return { from: fromAgent, to: target, zeroTrust: true, web: !!web, answer }; }
        if (target === 'cline') clineLib.prepare(a.home, { uid: a.uid, gid: a.gid });
        const prompt = `${fromAgent === 'shell' ? 'Someone' : `Another AI agent (${agents.catalog[fromAgent]?.title || fromAgent})`} working in this folder is asking for your view. Answer it directly and concisely. You may read files here to answer, but do not change anything.\n\nQuestion:\n${q}`;
        const [bin, args, extra = {}] = argv(target, prompt);
        const answer = await runAs(a, { bin, args, extra, home: a.home, workdir: cwd, title: av.title });
        return { from: fromAgent, to: target, zeroTrust: false, web: false, answer };
    } finally { running.set(from, Math.max(0, (running.get(from) || 1) - 1)); }
}
// Run one agent command as the agent user and return its cleaned output (5 minutes at most).
function runAs(a, { bin, args, extra = {}, home, workdir, title }) {
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser';
    const env = ['PATH=' + `${a.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, `HOME=${home}`, 'TERM=dumb', 'NO_COLOR=1', ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
    return new Promise((ok, bad) => {
        const c = spawn(runuser, ['-u', a.user, '--', 'env', '-i', ...env, bin, ...args], { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '', e = ''; c.stdout.on('data', d => { o += d; if (o.length > 400000) o = o.slice(-200000); }); c.stderr.on('data', d => { e += d; if (e.length > 100000) e = e.slice(-50000); });
        const t = setTimeout(() => { try { c.kill('SIGTERM'); } catch { /* gone */ } bad(httpError(504, `${title} did not answer within 5 minutes.`)); }, 300_000);
        c.on('close', code => { clearTimeout(t); if (code === 0 && o.trim()) ok(o.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim().slice(-20000)); else bad(httpError(502, `${title} could not answer${code ? ` (exit ${code})` : ''}: ${(e || o).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)); });
        c.on('error', err => { clearTimeout(t); bad(httpError(500, err.message)); });
    });
}
// Zero trust: a fresh empty folder, the question word for word, and only the capability it was given (web search or
// nothing), once. Security Lab consults and Conspiracy probes both use it. `system` replaces Claude's one-line system
// prompt; Cline keeps its own (it needs it to answer at all), so the instruction goes in front of the question.
export async function zeroTrust({ target, question, web = false, title = target, system = null }) {
    if (!ZERO_TRUST.includes(target)) throw httpError(403, `Only ${ZERO_TRUST.join(' or ')} can be asked on zero-trust terms.`);
    if (web && target !== 'claude') throw httpError(400, 'Only Claude can be given web search here.');
    const a = agentUser.info(); if (!a || process.getuid?.() !== 0) throw httpError(412, 'Asking other agents needs the agent user.');
    const scratch = fs.mkdtempSync(path.join(a.home, '.consult-')); fs.chownSync(scratch, a.uid, a.gid); fs.chmodSync(scratch, 0o700);
    try {
        // web: the two web tools exist AND are pre-approved (print mode refuses anything not approved); nothing else exists.
        if (target === 'claude') return await runAs(a, { bin: 'claude', args: ['-p', question, '--tools', web ? 'WebSearch,WebFetch' : '', ...(web ? ['--allowedTools', 'WebSearch', 'WebFetch'] : []), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--system-prompt', system || 'Answer the question you are given directly.'], home: a.home, workdir: scratch, title });
        clineLib.prepare(scratch, { uid: a.uid, gid: a.gid });   // its own home: no instruction files, only the Ollama connection
        return await runAs(a, { bin: 'cline', args: ['--auto-approve', 'false', '--thinking', 'none', system ? `${system}\n\n${question}` : question], extra: { CLINE_DIR: path.join(scratch, '.cline') }, home: scratch, workdir: scratch, title });
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
