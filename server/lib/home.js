// Aggregates for the Home and Services screens, so the phone makes one request per screen.
//
// A "project" is a folder under <root>/Projects (created on first use) or any folder a shell is running
// in. Services groups everything that has a port into: shared links (tunnels), dev servers (listening
// ports owned by ordinary processes), Docker containers/compose projects, and the one-tap app catalog.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as shells from './shells.js';
import * as tunnels from './tunnels.js';
import * as dockerMgr from './docker.js';
import * as apps from './apps.js';
import * as system from './system.js';
import * as servicesMgr from './services.js';
import * as projectFlags from './projects.js';
import * as live from './live.js';
import * as codeserver from './codeserver.js';
import * as profile from './profile.js';
import { folderIcon } from './files.js';
import fsSync from 'node:fs';

export const projectsDir = path.join(config.root, 'Projects');

async function ensureProjectsDir() {
    await fs.mkdir(projectsDir, { recursive: true });
}

function rel(abs) {
    return path.relative(config.root, abs).split(path.sep).join('/');
}

// What is running inside each folder: registered servers, .portholerun runs and live services, with their links.
// runningIn(abs, all) picks the ones whose folder is abs or below it.
export async function runningServers() {
    const [regs, tl] = await Promise.all([servicesMgr.list().catch(() => []), tunnels.list().catch(() => [])]);
    return regs.filter(r => r.alive && r.cwd).map(r => {
        const t = r.port ? tl.find(x => x.port === r.port && x.url) : null;
        return { slug: r.slug, name: r.live?.title || String(r.name || r.slug).replace(/^run-/, ''), kind: r.live ? 'live' : /^run-/.test(r.slug) ? 'run' : 'server', port: r.port || null, cwd: path.resolve(r.cwd), url: t?.url || null };
    });
}
export function runningIn(abs, all) {
    const root = path.resolve(abs);
    return all.filter(r => r.cwd === root || r.cwd.startsWith(root + path.sep)).map(({ cwd, ...r }) => r);
}

export async function home() {
    await ensureProjectsDir();
    const [shellList, tunnelList, dockerAvail, status] = await Promise.all([
        shells.list(), tunnels.list(), dockerMgr.available(), system.status(),
    ]);
    const containers = dockerAvail ? await dockerMgr.containers().catch(() => []) : [];
    const servers = await runningServers();

    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const projects = new Map();
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const abs = path.join(projectsDir, e.name);
        const st = await fs.stat(abs).catch(() => null);
        projects.set(abs, { name: e.name, path: rel(abs), modified: st?.mtimeMs || 0, shells: [], links: 0, repo: projectFlags.repoFlag(abs).flag });
    }
    // Folders with a running shell count as projects even outside ~/Projects.
    for (const s of shellList) {
        let key = s.cwd;
        // A shell deep inside a project belongs to that project.
        for (const abs of projects.keys()) if (s.cwd === abs || s.cwd.startsWith(abs + path.sep)) key = abs;
        if (!projects.has(key)) {
            projects.set(key, { name: key === config.root ? 'home' : path.basename(key), path: rel(key), modified: s.created, shells: [], links: 0, repo: projectFlags.repoFlag(key).flag });
        }
        const p = projects.get(key);
        p.shells.push({ name: s.name, kind: s.kind, attached: s.attached, created: s.created });
        p.modified = Math.max(p.modified, s.created);
    }
    for (const [abs, p] of projects) p.running = runningIn(abs, servers);
    const list = [...projects.values()].sort((a, b) => (b.running.length ? 1 : 0) - (a.running.length ? 1 : 0) || b.modified - a.modified);
    return {
        host: status.hostname,
        uptime: status.uptime,
        diskFree: status.disk?.free ?? null,
        counts: {
            shells: shellList.length,
            links: tunnelList.filter(t => t.url).length,
            containers: containers.filter(c => c.state === 'running').length,
        },
        claude: status.claude,
        projects: list,
    };
}

// One entry per project folder with everything that belongs to it, worked out from where each thing runs:
// live services from their PORTHOLE.md, servers and .portholerun runs from their folder, containers from the folder
// Docker Compose started them in (or the folder a project editor mounts), stray ports from the shell that opened
// them. A link sits on whatever holds its port. Anything outside /Projects goes under "box".
async function projectsView({ liveList, servers, containers, devservers, links, shellList, cs }) {
    const folders = new Map();
    let entries = []; try { entries = fsSync.readdirSync(projectsDir, { withFileTypes: true }); } catch { /* none */ }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const abs = path.join(projectsDir, e.name);
        folders.set(abs, { name: e.name, path: rel(abs), abs, parts: [] });
    }
    const box = { parts: [] };
    const home = abs => { const r = abs ? profile.projectRoot(abs) : null; return r && folders.has(r) ? folders.get(r) : null; };
    const put = (abs, part) => (home(abs) || box).parts.push(part);
    const linkFor = port => port ? links.find(t => t.port === port) || null : null;
    const used = new Set();
    const withLink = part => { const t = linkFor(part.port); if (t) { used.add(t.port); part.link = { url: t.url || null, kind: t.kind || 'quick', expires: t.expires || null, connected: t.connected ?? null, port: t.port }; } return part; };

    for (const p of liveList) for (const v of p.services || []) {
        put(p.root, withLink({ type: 'live', id: `live:${p.project}:${v.key}`, project: p.project, key: v.key, title: v.title, port: v.port, running: !!v.running, url: v.host?.url || null, hostname: v.hostname || null, worker: !!v.worker }));
    }
    for (const r of servers) {
        put(r.cwd, withLink({ type: /^run-/.test(r.slug) ? 'run' : 'server', id: `srv:${r.slug}`, slug: r.slug, title: r.slug.replace(/^run-/, ''), port: r.port || null, running: !!r.alive, canStart: !!r.canStart, gone: !fsSync.existsSync(r.cwd) }));
    }
    const editors = new Map((cs?.projects || []).map(e => [e.name, e]));
    for (const c of containers) {
        const ed = editors.get(c.name);
        const folder = ed?.folder || c.workdir || null;
        const port = c.ports[0]?.host || null;
        const part = { type: ed ? 'editor' : 'container', id: `ctr:${c.name}`, name: c.name, title: ed ? 'VS Code' : c.title, image: c.image, compose: c.compose, port, ports: c.ports.map(x => x.host), running: c.state === 'running', status: c.status, app: c.app };
        // An editor keeps its own share (password-protected, timed); its link is never the project's Open.
        if (ed) { Object.assign(part, { shared: !!ed.shared, shareUrl: ed.url || null, expires: ed.expires || null, passwordHint: ed.passwordHint || null }); if (ed.shared) used.add(port); put(folder, part); }
        else put(folder, withLink(part));
    }
    for (const d of devservers) {
        const sh = d.shell ? shellList.find(x => x.name === d.shell) : null;
        put(sh?.cwd || null, withLink({ type: 'port', id: `port:${d.port}`, title: d.process, port: d.port, running: true, shell: d.shell || null }));
    }
    if (cs?.installed) { box.parts.unshift({ type: 'box-editor', id: 'box-editor', title: 'Box editor', port: cs.port, running: !!cs.running, shared: !!cs.shared, shareUrl: cs.shared ? cs.url : null, expires: cs.expires || null, passwordHint: cs.passwordHint || null, folder: cs.folder || null }); if (cs.shared) used.add(cs.port); }
    for (const t of links) if (!used.has(t.port)) box.parts.push({ type: 'link', id: `link:${t.port}`, title: t.name || t.target || `port ${t.port}`, port: t.port, running: true, link: { url: t.url || null, kind: t.kind || 'quick', expires: t.expires || null, connected: t.connected ?? null, port: t.port } });

    // Merge a compose project's containers into one part ("3 containers"), keeping the details for the panel.
    const out = [];
    for (const f of folders.values()) {
        if (!f.parts.length && !['.platorun', '.portholerun'].some(n => fsSync.existsSync(path.join(f.abs, n))) && !fsSync.existsSync(path.join(f.abs, 'PORTHOLE.md'))) continue;
        const running = f.parts.some(x => x.running);
        const app = f.parts.filter(x => x.type !== 'editor');
        const primary = app.find(x => x.running && x.url) || app.find(x => x.running && x.link?.url) || null;
        let icon = null; try { const st = fsSync.statSync(f.abs); const ic = await folderIcon(f.abs, st.mtimeMs); if (ic) icon = rel(path.join(f.abs, ic)); } catch { /* none */ }
        out.push({
            name: f.name, path: f.path, icon, running, parts: f.parts,
            open: primary ? (primary.url || primary.link.url) : null,
            canRun: ['.platorun', '.portholerun'].some(n => fsSync.existsSync(path.join(f.abs, n))),
            hasEditor: f.parts.some(x => x.type === 'editor'),
            summary: { running: f.parts.filter(x => x.running).length, total: f.parts.length },
        });
    }
    out.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || a.name.localeCompare(b.name));
    return { projects: out, box };
}

export async function services() {
    const [tunnelList, ports, dockerAvail, catalog] = await Promise.all([
        tunnels.list(), tunnels.listeningPorts(), dockerMgr.available(), apps.list().catch(() => []),
    ]);
    const containers = dockerAvail ? await dockerMgr.containers().catch(() => []) : [];
    const compose = dockerAvail ? await dockerMgr.composeProjects().catch(() => []) : [];
    const shellList = await shells.list();
    const allServers = await servicesMgr.list().catch(() => []);
    const servers = allServers.filter(s => !s.slug.startsWith('live-'));
    const liveList = await live.list().catch(e => [{ project: '?', errors: [e.message], warnings: [], services: [] }]);
    const serverPorts = new Set(allServers.map(s => s.port).filter(Boolean));

    const tunnelByPort = new Map(tunnelList.map(t => [t.port, t]));
    const containerPorts = new Set(containers.flatMap(c => c.ports.map(p => p.host)));
    const appByContainer = new Map(catalog.map(a => [`app-${a.key}`, a]));

    // Dev servers: listening ports that aren't a container's published port, a registered server, or the box's own
    // plumbing (those go under "system": visible, never shareable).
    const devservers = ports
        .filter(p => !containerPorts.has(p.port) && !serverPorts.has(p.port) && !p.system)
        .map(p => ({
            port: p.port,
            process: p.process || 'unknown',
            addr: p.addr,
            pid: p.pid,
            tunnel: tunnelByPort.get(p.port) || null,
            shell: guessShell(shellList, p),
        }));
    const systemPorts = ports.filter(p => p.system && !containerPorts.has(p.port)).map(p => ({ port: p.port, process: p.process || 'unknown', addr: p.addr, what: describeSystem(p) }));

    const links = tunnelList.map(t => {
        const c = containers.find(x => x.ports.some(pp => pp.host === t.port));
        const srv = servers.find(s => s.port === t.port);
        return { ...t, kind: t.kind || 'quick', targetKind: c ? 'container' : srv ? 'server' : 'devserver', target: c ? (appByContainer.get(c.name)?.title || c.name) : srv ? srv.name : (devservers.find(d => d.port === t.port)?.process || `port ${t.port}`) };
    });

    const containerRows = containers.map(c => {
        const app = appByContainer.get(c.name);
        const hostPorts = c.ports.map(p => p.host);
        const t = hostPorts.map(p => tunnelByPort.get(p)).find(Boolean) || null;
        return {
            name: c.name, title: app?.title || c.name, image: c.image, state: c.state, status: c.status,
            ports: c.ports, compose: c.compose, workdir: c.workdir || null, app: app?.key || null, tunnel: t, noTunnel: app?.noTunnel || false,
        };
    });

    const cs = await codeserver.status().catch(() => null);
    const { projects: projectCards, box } = await projectsView({ liveList, servers, containers: containerRows, devservers, links, shellList, cs });
    return {
        docker: dockerAvail,
        projects: projectCards,
        box,
        links,
        live: liveList,
        servers,
        system: systemPorts,
        devservers,
        containers: containerRows,
        compose,
        apps: catalog,
    };
}

function describeSystem(p) {
    const c = p.cmd || '';
    if (/claude/.test(c)) return 'Claude Code';
    if (/codex/.test(c)) return 'Codex CLI';
    if (/agy|antigravity|gemini/.test(c)) return 'Antigravity CLI';
    if (/code-server/.test(c) || p.process === 'code-server') return 'code-server';
    if (/\/opt\/porthole\//.test(c)) return 'PlatOpypus';
    return p.process || 'system';
}

function guessShell(shellList, port) {
    // Best effort: the newest shell is the likeliest owner of a freshly started dev server.
    return shellList[0]?.name || null;
}
