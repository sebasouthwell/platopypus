// "Limit reached": when the box is overloaded (1-minute load over the limit for two checks in a row), close every
// public quick link, then stop what is not a live service, worst first, until the load comes down: registered
// servers, .portholerun runs and containers, ranked by what they use (CPU and memory incl. swap) and, for a tie, by
// how recently they were started. Live services and shells are never touched here; the phone gets an alert and the
// audit log says what was stopped and why. Nothing is deleted: everything stopped can be started again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';
import * as usage from './usage.js';
import * as services from './services.js';
import * as dockerMgr from './docker.js';
import * as tunnels from './tunnels.js';
import * as alerts from './alerts.js';

const file = path.join(config.state, 'limit.json');
const DEFAULT_LOAD = Math.max(2, Number(process.env.PORTHOLE_LIMIT_LOAD) || 10);
const COOLDOWN_MS = 10 * 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function save(c) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

export function settings() {
    const c = load();
    return { on: c.on !== false, load: Number(c.load) || DEFAULT_LOAD, cpus: os.cpus().length, loadNow: Math.round(os.loadavg()[0] * 100) / 100, last: c.last || null, cooldownUntil: c.last && Date.now() - c.last.at < COOLDOWN_MS ? c.last.at + COOLDOWN_MS : null };
}
export function configure(body = {}) {
    const c = load();
    if ('on' in body) c.on = !!body.on;
    if ('load' in body) { const n = Number(body.load); if (!(n >= 2 && n <= 500)) { const e = new Error('Load limit: a number from 2 to 500.'); e.status = 400; throw e; } c.load = n; }
    save(c);
    return settings();
}

const score = c => (c.cpu || 0) + (c.mem || 0) / 8;   // 400 MB counts like 50 % of a core

// Everything that could be stopped, worst first.
export async function candidates() {
    usage.sample(true);
    const [servers, containers, ctrs] = await Promise.all([services.list().catch(() => []), dockerMgr.containers().catch(() => []), usage.containers(true)]);
    const out = [];
    for (const r of servers) {
        if (!r.alive || r.live) continue;
        const u = usage.tree(r.pid) || { mem: 0, cpu: 0 };
        out.push({ kind: r.slug.startsWith('run-') ? 'run' : 'server', name: r.slug, title: r.name, created: r.created || 0, mem: u.mem, cpu: u.cpu, stop: () => services.stop(r.slug) });
    }
    const liveSlugs = new Set(servers.filter(r => r.live).map(r => r.slug));
    // Never the container PlatOpypus itself runs in (docker mode: the hostname is the container id).
    const self = os.hostname();
    for (const c of containers) {
        if (c.state !== 'running' || liveSlugs.has(c.name) || c.name.startsWith('live-') || (c.id && self && c.id.startsWith(self))) continue;
        const u = ctrs.get(c.name) || { mem: 0, cpu: 0 };
        out.push({ kind: 'container', name: c.name, title: c.name, created: Date.parse(c.created) || 0, mem: u.mem, cpu: u.cpu, stop: () => dockerMgr.action(c.name, 'stop') });
    }
    return out.sort((a, b) => score(b) - score(a) || b.created - a.created);
}

let busy = false, hits = 0;
// dry: say what would go, stop nothing. force: act whatever the load is (the phone's "Do it now").
export async function act({ reason = 'load', dry = false, force = false } = {}) {
    if (busy) return { busy: true };
    busy = true;
    try {
        const s = settings();
        const links = (await tunnels.list().catch(() => [])).filter(t => t.kind !== 'zoned');
        const cands = await candidates();
        const plan = { at: Date.now(), reason, load: s.loadNow, links: links.map(t => ({ port: t.port, url: t.url || null })), stopped: [], left: [] };
        if (dry) { plan.left = cands.map(view); return plan; }
        for (const t of links) { try { await tunnels.close(t.port); } catch { /* gone */ } }
        for (let i = 0; i < cands.length; i++) {
            const c = cands[i];
            try { await c.stop(); plan.stopped.push(view(c)); log('limit', `stopped ${c.kind} ${c.name} (${c.mem} MB, ${c.cpu} %)`); }
            catch (e) { log('limit', `could not stop ${c.name}: ${e.message}`); continue; }
            if (i === cands.length - 1) break;
            await sleep(force ? 2000 : 30_000);
            if (!force && os.loadavg()[0] < s.load * 0.7) break;   // came down: leave the rest alone
        }
        plan.left = cands.filter(c => !plan.stopped.some(x => x.name === c.name)).map(view);
        const c = load(); c.last = { at: plan.at, reason, load: plan.load, stopped: plan.stopped.length, links: plan.links.length }; save(c);
        record('activity', 'limit-reached', { actor: force ? 'phone' : 'PlatOpypus', via: force ? 'Alerts page' : 'limit guard', what: `${reason}: closed ${plan.links.length} link${plan.links.length === 1 ? '' : 's'}, stopped ${plan.stopped.map(x => x.name).join(', ') || 'nothing'}` });
        alerts.notify('limit', `Limit reached (load ${plan.load} on ${s.cpus} vCPU)\n${plan.links.length ? `Closed ${plan.links.length} public link${plan.links.length === 1 ? '' : 's'}. ` : ''}${plan.stopped.length ? `Stopped: ${plan.stopped.map(x => `${x.title} (${x.mem} MB)`).join(', ')}.` : 'Nothing to stop: only live services and shells are running.'}\nLive services and shells were left alone.`);
        return plan;
    } finally { busy = false; }
}
const view = c => ({ kind: c.kind, name: c.name, title: c.title, mem: c.mem, cpu: c.cpu, created: c.created });

// Every 30 s: two checks over the limit in a row, outside the cooldown, and the guard acts.
export async function check() {
    const s = settings();
    if (!s.on) { hits = 0; return; }
    if (os.loadavg()[0] >= s.load) hits++; else hits = 0;
    if (hits < 2 || s.cooldownUntil) return;
    hits = 0;
    log('limit', `load ${s.loadNow} over ${s.load}: acting`);
    await act({ reason: `load ${s.loadNow} over ${s.load}` }).catch(e => log('limit', `failed: ${e.message}`));
}
