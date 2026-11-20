// Hand-offs: an agent working in one place proposes work for one of PlatOpypus's apps (a Research topic, a Conspiracy
// case, a Job Hunt search, a Security Lab engagement). The proposal waits in that app for the user; Approve & start
// creates the topic, case, search or engagement, copies in the files the agent attached, and starts the app's own
// unattended agent with the brief. When that agent finishes, a summary goes back to the project that asked
// (<project>/.platopypus/handoffs/<id>.md, read with `handoff status <id>`) and the user gets an alert.
//
// Agents can only propose and read their own project's hand-offs (the `handoff` kit tools, through the agent-tool
// route); approving and starting are user routes, never open to agent shells. A Security Lab hand-off brings targets
// as "to verify": nothing runs until the user verifies or declares each one in Lab, as for any engagement.
// State: <state>/handoffs.json; attached files in <state>/handoffs/<id>/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { record, projectOf } from './audit.js';
import * as kit from './kit/tools.js';
import * as alerts from './alerts.js';

const FILE = path.join(config.state, 'handoffs.json');
const DIR = path.join(config.state, 'handoffs');
const PROJECTS = path.join(config.root, 'Projects');
export const APPS = { research: 'Research', case: 'Conspiracy', jobs: 'Job Hunt', lab: 'Security Lab' };
const MAX_FILES = 8, MAX_BYTES = 20 * 1024 * 1024;
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; } }
function save(d) { const t = `${FILE}.tmp`; fs.writeFileSync(t, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(t, FILE); }
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const view = h => ({ ...h, files: (h.files || []).map(f => ({ name: f.name, size: f.size })) });

// The app integrations, set by server.js (it owns starting shells): { start(h, edits) → { ref, shell, status }, startLab(h) }.
let starter = null;
// Also picks up hand-offs whose agent was running when PlatOpypus last stopped (their shells outlive a restart).
export function setStarter(s) { starter = s; for (const h of load().items) if (h.status === 'running' && h.shell) watch(h.id, h.shell); }

export function list({ app = null, status = null } = {}) {
    const d = load(); const keep = Date.now() - 30 * 86400_000;
    return d.items.filter(h => (!app || h.app === app) && (!status || h.status === status) && (h.status === 'proposed' || h.status === 'scope' || h.status === 'running' || (h.decided || h.created) > keep)).sort((a, b) => b.created - a.created).map(view);
}
export function get(id) { const h = load().items.find(x => x.id === id); if (!h) throw httpError(404, 'No such hand-off.'); return h; }
function update(id, fn) { const d = load(); const h = d.items.find(x => x.id === id); if (!h) throw httpError(404, 'No such hand-off.'); fn(h); save(d); return h; }
// Where a shell works: its project folder (top level under /Projects) or its own folder.
function originOf(shell) { const p = projectOf(shell.cwd); return { project: p, root: p ? path.join(PROJECTS, p) : shell.cwd, cwd: shell.cwd, shell: shell.name || null, session: shell.session || 'project' }; }

export function propose(shell, b) {
    const app = String(b.app || '').toLowerCase(); if (!APPS[app]) throw httpError(400, `app: ${Object.keys(APPS).join(', ')}.`);
    const title = clip(b.title, 120); if (title.length < 3) throw httpError(400, 'Give it a title (3 to 120 characters).');
    const brief = clip(b.brief, 6000); if (brief.length < 10) throw httpError(400, 'Write a brief: what you want found or done, and what to come back with.');
    const from = originOf(shell); const id = `h${crypto.randomBytes(4).toString('hex')}`;
    // Files: inside the asking shell's project (or folder) only, copied now so later edits there do not change them.
    const files = []; let bytes = 0;
    for (const raw of (Array.isArray(b.files) ? b.files : b.files ? [b.files] : []).slice(0, MAX_FILES)) {
        const abs = path.resolve(shell.cwd, String(raw)); let real; try { real = fs.realpathSync(abs); } catch { throw httpError(400, `No such file: ${raw}`); }
        if (!(real === from.root || real.startsWith(from.root + path.sep))) throw httpError(403, `${raw} is outside this project.`);
        const st = fs.statSync(real); if (!st.isFile()) throw httpError(400, `${raw} is not a file.`);
        bytes += st.size; if (bytes > MAX_BYTES) throw httpError(413, 'Attached files are over 20 MB together.');
        fs.mkdirSync(path.join(DIR, id), { recursive: true, mode: 0o700 });
        const name = path.basename(real).replace(/[^\w.-]/g, '_'); fs.copyFileSync(real, path.join(DIR, id, name)); files.push({ name, size: st.size });
    }
    const targets = app === 'lab' ? (Array.isArray(b.targets) ? b.targets : String(b.targets || '').split(/[\s,]+/)).map(t => clip(t, 253).toLowerCase()).filter(Boolean).slice(0, 20) : [];
    if (app === 'lab' && !targets.length) throw httpError(400, 'A Security Lab hand-off needs targets (domains or addresses you are authorised to test).');
    const into = app === 'research' && b.topic ? clip(b.topic, 80) : null;
    const h = { id, app, title, brief, files, targets, into, why: clip(b.why, 400), from, status: 'proposed', created: Date.now() };
    const d = load(); if (d.items.filter(x => x.status === 'proposed' && x.from.root === from.root).length >= 10) throw httpError(429, 'This project already has 10 hand-offs waiting for the user.');
    d.items.push(h); d.items = d.items.slice(-300); save(d);
    log('handoff', `proposed ${id} for ${APPS[app]} from ${from.project || from.cwd}: ${title}`);
    record('activity', 'handoff-proposed', { actor: `shell "${from.shell || '?'}"`, cwd: from.cwd, what: `${APPS[app]}: ${title}` });
    try { alerts.notify('handoff', `An agent${from.project ? ` in ${from.project}` : ''} proposes work for ${APPS[app]}: ${title}. Approve or decline it there.`, { key: id, quietMs: 0 }); } catch { /* alerts off */ }
    return `Proposed ${id} for ${APPS[app]}. It waits for the user to approve it in ${APPS[app]}; check with handoff status ${id}.`;
}

// The user's decisions (user routes only).
export async function approve(id, edits = {}) {
    const h = get(id); if (h.status !== 'proposed') throw httpError(409, `Already ${h.status}.`);
    if (!starter) throw httpError(503, 'Not ready yet.');
    const e = { title: edits.title !== undefined ? clip(edits.title, 120) : h.title, brief: edits.brief !== undefined ? clip(edits.brief, 6000) : h.brief, targets: Array.isArray(edits.targets) ? edits.targets.map(t => clip(t, 253).toLowerCase()).filter(Boolean) : h.targets };
    if (e.title.length < 3 || e.brief.length < 10) throw httpError(400, 'Keep a title and a brief.');
    const r = await starter.start({ ...h, ...e }, filesDir(h));
    const out = update(id, x => { Object.assign(x, e, { status: r.status || 'running', decided: Date.now(), ref: r.ref, shell: r.shell || null }); });
    record('activity', 'handoff-approved', { actor: 'phone', what: `${APPS[h.app]}: ${e.title}`, cwd: h.from.cwd });
    log('handoff', `approved ${id} → ${APPS[h.app]} ${r.ref?.slug || r.ref?.id || ''}${r.shell ? ` (shell ${r.shell})` : ''}`);
    if (r.shell) watch(id, r.shell);
    return view(out);
}
export async function startLab(id, { ack = false } = {}) {
    const h = get(id); if (h.app !== 'lab' || h.status !== 'scope') throw httpError(409, 'Nothing waiting to start.');
    const r = await starter.startLab(h, { ack });
    const out = update(id, x => { x.status = 'running'; x.shell = r.shell; x.started = Date.now(); });
    record('activity', 'handoff-lab-started', { actor: 'phone', what: `${h.ref?.slug}: ${h.title}`, cwd: h.from.cwd }); watch(id, r.shell);
    return view(out);
}
export function decline(id, why = '') {
    const h = update(id, x => { if (x.status !== 'proposed') throw httpError(409, `Already ${x.status}.`); x.status = 'declined'; x.decided = Date.now(); x.declined = clip(why, 300); });
    writeBack(h, `# Hand-off ${h.id}: declined\n\nThe user declined "${h.title}" for ${APPS[h.app]}${h.declined ? `: ${h.declined}` : '.'}\n`);
    record('activity', 'handoff-declined', { actor: 'phone', what: `${APPS[h.app]}: ${h.title}`, cwd: h.from.cwd });
    fs.rmSync(path.join(DIR, h.id), { recursive: true, force: true }); return view(h);
}
export const filesDir = h => path.join(DIR, h.id);

// When the app's agent finishes: its result file (or the run's last output) goes back to the asking project.
function watch(id, shell) {
    const f = path.join(config.state, 'oneshot', `${shell}.json`); const t0 = Date.now();
    const t = setInterval(() => {
        if (!fs.existsSync(f) && Date.now() - t0 < 3 * 3600_000) return; clearInterval(t);
        let out = ''; try { out = JSON.parse(fs.readFileSync(f, 'utf8')).output || ''; } catch { /* no output */ }
        finish(id, out).catch(e => log('handoff', `finish ${id}: ${e.message}`));
    }, 10_000);
}
async function finish(id, output) {
    const h = get(id); if (h.status !== 'running') return;
    let result = ''; try { result = starter.result ? await starter.result(h) : ''; } catch { /* none */ }
    if (!result) result = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-60).join('\n');
    const link = h.ref?.url || '';
    writeBack(h, `# Hand-off ${h.id}: ${h.title}\n\nDone by ${APPS[h.app]}${h.ref?.slug ? ` (${h.ref.slug})` : ''} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.${link ? ` Open it in PlatOpypus: ${link}` : ''}\n\n## Brief\n\n${h.brief}\n\n## Result\n\n${result || '(the agent left no summary; open the app to see what it did)'}\n`);
    update(id, x => { x.status = 'done'; x.finished = Date.now(); x.result = result.slice(0, 4000); });
    try { alerts.notify('handoff', `${APPS[h.app]} finished "${h.title}"${h.from.project ? `; the result is back in ${h.from.project}` : ''}.`, { key: `${id}-done`, quietMs: 0 }); } catch { /* alerts off */ }
    log('handoff', `${id} done`);
}
function writeBack(h, text) {
    try {
        const d = path.join(h.from.root, '.platopypus', 'handoffs'); fs.mkdirSync(d, { recursive: true });
        const f = path.join(d, `${h.id}.md`); fs.writeFileSync(f, text, { mode: 0o660 });
        // Same group as the project, so the project's agents (agent user, porthole-dev) can read it.
        try { const st = fs.statSync(h.from.root); for (const x of [path.dirname(d), d, f]) fs.chownSync(x, st.uid, st.gid); fs.chmodSync(d, 0o2770); } catch { /* best effort */ }
    } catch (e) { log('handoff', `write back ${h.id}: ${e.message}`); }
}

// Agent tools: propose, and read this project's hand-offs.
kit.registerApp('handoff', {
    context(shell) { if (!shell?.cwd) throw httpError(403, 'Hand-offs are proposed from an agent shell.'); return { shell }; },
    tools: [
        { name: 'propose', description: 'Propose work for another PlatOpypus app; the user approves it there, then that app\'s agent does it and the result comes back to this project. app: research (a new topic, or a question into an existing one with topic), case (a Conspiracy investigation), jobs (a Job Hunt search: what job, where), lab (a Security Lab engagement; needs targets the user is authorised to test).', inputSchema: kit.obj({ app: kit.str('research | case | jobs | lab'), title: kit.str('Short title'), brief: kit.str('What to find out or do, what matters, and what to come back with'), files: kit.arr('Files from this project to hand over (paths)'), targets: kit.arr('lab only: domains or addresses to test'), topic: kit.str('research only: an existing topic to add this to (optional)'), why: kit.str('One line: why this helps the work here') }, ['app', 'title', 'brief']),
            run: (c, a) => propose(c.shell, a) },
        { name: 'status', description: 'Hand-offs from this project: waiting, running, done (with the result) or declined. Give an id for one in full.', inputSchema: kit.obj({ id: kit.str('Hand-off id (optional)') }),
            run: (c, a) => {
                const root = originOf(c.shell).root; const mine = load().items.filter(h => h.from.root === root);
                if (a.id) { const h = mine.find(x => x.id === a.id); if (!h) throw httpError(404, 'No such hand-off from this project.'); return `${h.id} [${h.status}] ${APPS[h.app]}: ${h.title}${h.ref?.slug ? ` (${h.ref.slug})` : ''}\n\n${h.result || (h.status === 'proposed' ? 'Waiting for the user to approve it.' : h.status === 'scope' ? 'Approved; waiting for the user to verify the targets in Security Lab.' : h.status === 'running' ? 'The app\'s agent is working on it.' : h.declined ? `Declined: ${h.declined}` : '')}${h.status === 'done' ? `\n\nFull text: .platopypus/handoffs/${h.id}.md` : ''}`; }
                return mine.slice(-20).reverse().map(h => `${h.id} [${h.status}] ${APPS[h.app]}: ${h.title}`).join('\n') || 'No hand-offs from this project yet.';
            } },
    ],
});
