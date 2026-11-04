// .portholerun: a small file in a project folder that says how to run it, so a tap in Files starts the server with
// its link, without asking an agent. The phone shows exactly what will run (the plan) and the file's hash; running
// requires that same hash, so the file cannot change between "this is what will happen" and "do it".
//
//   run: npm start                 # required: the command that serves (or works)
//   name: dollar-button            # optional; defaults to the folder name
//   port: 3000                     # optional: what it listens on (a link needs one)
//   before: npm ci                 # optional: runs first, in the same session (install, build, migrate)
//   cwd: web                       # optional: a folder inside this one
//   env: { NODE_ENV: production }  # optional: plain settings, never secrets
//   needs: [STRIPE_KEY]            # optional: Vault names it gets (project scope, then general)
//   share: quick                   # quick (trycloudflare, 4 h) | domain (needs hostname) | none. Default: quick with a port
//   hostname: app.example.com      # with share: domain
//   open: /?k=abc                  # optional: path the Open button adds to the link
//   run_as: service                # service (the project's own account, default) | agent | root
//
// It runs as a registered server (Services → Servers): stop, restart and logs work as usual, and stopping it closes
// a quick link. Porthole adds .portholerun to the project's .gitignore: it is about this box, not the code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { config } from './config.js';
import * as servicesMgr from './services.js';
import * as tunnels from './tunnels.js';
import * as zoned from './zoned.js';
import * as profile from './profile.js';
import * as agentUser from './agentuser.js';
import * as svcUser from './svcuser.js';
import { prepareAccount } from './live.js';
import { envFor } from './vault.js';
import { log } from './log.js';
import { ensureIgnored as ensureDefaultIgnores } from './gitignore.js';

export const FILE = '.portholerun';
const MAX = 8 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const slugName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'app';

function read(file) {
    const abs = path.resolve(file);
    if (path.basename(abs) !== FILE) throw httpError(400, `Not a ${FILE} file.`);
    const root = profile.projectRoot(path.dirname(abs));
    if (!root) throw httpError(403, `${FILE} runs only inside a project under /Projects.`);
    let st; try { st = fs.statSync(abs); } catch { throw httpError(404, `${FILE} not found.`); }
    if (!st.isFile() || st.size > MAX) throw httpError(400, `${FILE} must be a small text file (under 8 KB).`);
    const text = fs.readFileSync(abs, 'utf8');
    return { abs, dir: path.dirname(abs), root, text, hash: crypto.createHash('sha256').update(abs + '\0' + text).digest('hex') };
}

function validate(spec, dir) {
    const errors = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { errors: ['The file must be YAML key: value lines (run: is required).'] };
    if (typeof spec.run !== 'string' || !spec.run.trim()) errors.push('run: the command to start it is required.');
    if (spec.before !== undefined && typeof spec.before !== 'string') errors.push('before: one command (use && to chain).');
    if (spec.port !== undefined && !(Number.isInteger(Number(spec.port)) && Number(spec.port) > 0 && Number(spec.port) < 65536)) errors.push('port: 1-65535.');
    if (Number(spec.port) === config.port) errors.push("port: that is Porthole's own port.");
    if (spec.name !== undefined && !NAME_RE.test(slugName(spec.name))) errors.push('name: letters, digits and dashes.');
    if (spec.cwd !== undefined && (path.isAbsolute(String(spec.cwd)) || String(spec.cwd).split(/[\\/]/).includes('..'))) errors.push('cwd: a folder inside this one.');
    const share = spec.share === undefined ? (spec.port ? 'quick' : 'none') : String(spec.share);
    if (!['quick', 'domain', 'none'].includes(share)) errors.push('share: quick, domain or none.');
    if ((share === 'quick' || share === 'domain') && !spec.port) errors.push('share: a link needs a port.');
    if (share === 'domain' && !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(String(spec.hostname || '').toLowerCase())) errors.push('hostname: share: domain needs a full name like app.example.com.');
    const runAs = spec.run_as === undefined ? 'service' : String(spec.run_as);
    if (!['service', 'agent', 'root'].includes(runAs)) errors.push('run_as: service, agent or root.');
    const env = spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env) ? spec.env : {};
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_RE.test(k)) errors.push(`env.${k}: names are UPPER_CASE.`);
        if (/pass|secret|token|key/i.test(k) && !String(v).startsWith('$')) errors.push(`env.${k}: looks like a secret; put it in the Vault and list it under needs.`);
    }
    const needs = Array.isArray(spec.needs) ? spec.needs.map(String) : [];
    for (const n of needs) if (!ENV_RE.test(n)) errors.push(`needs: ${n} is not a Vault env name.`);
    if (spec.open !== undefined && !/^\/[^\s]*$/.test(String(spec.open))) errors.push('open: a path starting with /.');
    const cwd = path.resolve(dir, spec.cwd ? String(spec.cwd) : '.');
    if (!cwd.startsWith(dir)) errors.push('cwd: a folder inside this one.');
    return { errors, share, runAs, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), needs, cwd };
}

// What the phone shows before running: every command, as whom, where, what is shared, which Vault names.
export async function plan(file) {
    const f = read(file);
    let spec, errors = [];
    try { spec = parseYaml(f.text); } catch (e) { errors = [`YAML: ${e.message.split('\n')[0]}`]; }
    const v = errors.length ? { errors } : validate(spec, f.dir);
    const project = path.basename(f.root);
    const name = slugName(spec?.name || path.basename(f.dir));
    const slug = `run-${name}`;
    const vault = v.needs?.length ? await envFor(f.dir, { project: 'exact' }).catch(() => ({})) : {};
    const reg = (await servicesMgr.list().catch(() => [])).find(r => r.slug === slug);
    const running = !!reg?.alive;
    const link = spec?.port ? (await tunnels.list().catch(() => [])).find(t => t.port === Number(spec.port)) || null : null;
    let gitignored = false; try { gitignored = fs.readFileSync(path.join(f.root, '.gitignore'), 'utf8').split('\n').some(l => l.trim() === FILE || l.trim() === `/${FILE}` || l.trim() === `**/${FILE}`); } catch { /* none */ }
    const account = v.runAs === 'service' ? svcUser.userFor(project) : v.runAs === 'agent' ? agentUser.USER : 'root';
    return {
        file: f.abs, folder: path.relative(config.root, f.dir).split(path.sep).join('/'), project, name, slug, hash: f.hash, errors: v.errors,
        commands: spec && !v.errors.length ? [...(spec.before ? [{ step: 'before', cmd: String(spec.before) }] : []), { step: 'run', cmd: String(spec.run) }] : [],
        cwd: v.cwd ? path.relative(config.root, v.cwd).split(path.sep).join('/') : null,
        port: spec?.port ? Number(spec.port) : null, share: v.share || 'none', hostname: spec?.hostname ? String(spec.hostname).toLowerCase() : null, open: spec?.open ? String(spec.open) : null,
        runAs: v.runAs || 'service', account, env: Object.keys(v.env || {}), needs: (v.needs || []).map(n => ({ name: n, present: n in vault })),
        running, link: link ? { url: link.url, kind: link.kind || 'quick', expires: link.expires || null } : null, gitignored,
    };
}

function ensureIgnored(root) {
    const gi = path.join(root, '.gitignore');
    let text = ''; try { text = fs.readFileSync(gi, 'utf8'); } catch { /* new */ }
    if (text.split('\n').some(l => [FILE, `/${FILE}`, `**/${FILE}`].includes(l.trim()))) return false;
    if (!fs.existsSync(path.join(root, '.git')) && !text) return false;   // not a repo: nothing to keep it out of
    fs.writeFileSync(gi, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Porthole: how this box runs the project (not part of the code)\n**/${FILE}\n`);
    return true;
}

// Start (or restart) it exactly as planned. hash must be the one the user saw.
export async function run(file, hash, { restart = false } = {}) {
    const p = await plan(file);
    if (p.errors.length) throw httpError(400, p.errors.join(' '));
    if (hash !== p.hash) throw httpError(409, `${FILE} changed since you looked at it. Open it again to see what it will run.`);
    const spec = parseYaml(read(file).text);
    const v = validate(spec, path.dirname(p.file));
    const missing = p.needs.filter(n => !n.present).map(n => n.name);
    if (missing.length) throw httpError(412, `Add ${missing.join(', ')} to the Vault (project or general) first.`);
    if (p.running) { if (!restart) throw httpError(409, `${p.name} is already running.`); await servicesMgr.stop(p.slug, { keepTunnel: true }); }
    const root = profile.projectRoot(path.dirname(p.file));
    const vault = await envFor(path.dirname(p.file), { project: 'exact' });
    const env = { ...Object.fromEntries(v.needs.map(n => [n, vault[n]])), ...v.env, PORTHOLE_PROJECT: p.project };
    const cmd = spec.before ? `${spec.before} && ${spec.run}` : String(spec.run);
    let account = null;
    if (v.runAs === 'service') account = await prepareAccount({ root, name: path.basename(root) });
    if (v.runAs === 'agent') { if (!agentUser.available()) throw httpError(412, 'The agent user does not exist on this box.'); await agentUser.prepareFolder(root).catch(() => {}); }
    const reg = await servicesMgr.runServer({ name: p.slug, port: p.port, cwd: v.cwd, cmd: ['bash', '-lc', cmd], project: p.project, env, runAs: v.runAs === 'service' ? 'service' : null, account, owner: v.runAs === 'agent' ? 'portholerun' : null });
    let ignored = false; try { ignored = ensureIgnored(root); ensureDefaultIgnores(root); } catch { /* read-only */ }
    // The link: an existing one for the port stays; otherwise a quick link or the domain.
    let link = null;
    if (p.port && p.share !== 'none') {
        try {
            const have = (await tunnels.list()).find(t => t.port === p.port);
            if (have) link = have;
            else if (p.share === 'quick') link = await tunnels.create({ port: p.port, name: p.name });
            else link = await zoned.create({ port: p.port, hostname: p.hostname, name: p.name });
        } catch (e) { log('portholerun', `${p.name}: link failed: ${e.message}`); link = { error: e.message }; }
    }
    remember(p.slug, p.file, p.hash);
    log('portholerun', `${restart ? 're' : ''}started ${p.folder}/${FILE} as ${account || v.runAs}${p.port ? ` on :${p.port}` : ''}${link?.url ? ` → ${link.url}` : ''}`);
    return { ...p, started: true, server: { slug: reg.slug, pid: reg.pid || null }, link: link?.url ? { url: link.url + (p.open || ''), kind: link.kind || p.share } : link?.error ? { error: link.error } : null, addedToGitignore: ignored };
}

// What each run was started from, so a plain restart (Services, svc restart) can repeat it with its settings and
// Vault values. state/portholerun.json: { "<slug>": { file, hash, at } }.
const recordFile = path.join(config.state, 'portholerun.json');
function records() { try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return {}; } }
function remember(slug, file, hash) { const r = records(); r[slug] = { file, hash, at: Date.now() }; try { fs.writeFileSync(recordFile, JSON.stringify(r, null, 2), { mode: 0o600 }); } catch { /* read-only state */ } }
export const isRunSlug = slug => /^run-/.test(String(slug || '')) && !!records()[slug];
// Start or restart a .portholerun server by slug. Refuses when the file changed since it was last run: the person
// has to see the new plan first (Files → .portholerun).
export async function startSlug(slug, { restart = false } = {}) {
    const rec = records()[slug];
    if (!rec) throw httpError(404, 'No .portholerun is known for that server.');
    const p = await plan(rec.file);
    if (p.hash !== rec.hash) throw httpError(409, `${FILE} in ${p.folder} changed since it was last run. Open it in Files to see the new plan, then run it.`);
    return run(rec.file, rec.hash, { restart: restart || p.running });
}

export async function stop(file) {
    const p = await plan(file);
    if (!p.running) throw httpError(409, 'Not running.');
    await servicesMgr.stop(p.slug);
    log('portholerun', `stopped ${p.folder}/${FILE}`);
    return { stopped: true };
}
