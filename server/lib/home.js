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

export const projectsDir = path.join(config.root, 'Projects');

async function ensureProjectsDir() {
    await fs.mkdir(projectsDir, { recursive: true });
}

function rel(abs) {
    return path.relative(config.root, abs).split(path.sep).join('/');
}

export async function home() {
    await ensureProjectsDir();
    const [shellList, tunnelList, dockerAvail, status] = await Promise.all([
        shells.list(), tunnels.list(), dockerMgr.available(), system.status(),
    ]);
    const containers = dockerAvail ? await dockerMgr.containers().catch(() => []) : [];

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
    const list = [...projects.values()].sort((a, b) => b.modified - a.modified);
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
            ports: c.ports, compose: c.compose, app: app?.key || null, tunnel: t, noTunnel: app?.noTunnel || false,
        };
    });

    return {
        docker: dockerAvail,
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
    if (/\/opt\/porthole\//.test(c)) return 'Porthole';
    return p.process || 'system';
}

function guessShell(shellList, port) {
    // Best effort: the newest shell is the likeliest owner of a freshly started dev server.
    return shellList[0]?.name || null;
}
