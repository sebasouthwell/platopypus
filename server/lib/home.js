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
        projects.set(abs, { name: e.name, path: rel(abs), modified: st?.mtimeMs || 0, shells: [], links: 0 });
    }
    // Folders with a running shell count as projects even outside ~/Projects.
    for (const s of shellList) {
        let key = s.cwd;
        // A shell deep inside a project belongs to that project.
        for (const abs of projects.keys()) if (s.cwd === abs || s.cwd.startsWith(abs + path.sep)) key = abs;
        if (!projects.has(key)) {
            projects.set(key, { name: key === config.root ? 'home' : path.basename(key), path: rel(key), modified: s.created, shells: [], links: 0 });
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

    const tunnelByPort = new Map(tunnelList.map(t => [t.port, t]));
    const containerPorts = new Set(containers.flatMap(c => c.ports.map(p => p.host)));
    const appByContainer = new Map(catalog.map(a => [`app-${a.key}`, a]));

    // Dev servers: listening ports that aren't a container's published port and aren't Porthole.
    const devservers = ports
        .filter(p => !containerPorts.has(p.port) && !/^(docker-proxy|cloudflared|tailscaled|sshd|systemd-resolve|nginx)$/.test(p.process || ''))
        .map(p => ({
            port: p.port,
            process: p.process || 'unknown',
            addr: p.addr,
            tunnel: tunnelByPort.get(p.port) || null,
            shell: guessShell(shellList, p),
        }));

    const links = tunnelList.map(t => {
        const c = containers.find(x => x.ports.some(pp => pp.host === t.port));
        return { ...t, kind: c ? 'container' : 'devserver', target: c ? (appByContainer.get(c.name)?.title || c.name) : (devservers.find(d => d.port === t.port)?.process || `port ${t.port}`) };
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
        devservers,
        containers: containerRows,
        compose,
        apps: catalog,
    };
}

function guessShell(shellList, port) {
    // Best effort: the newest shell is the likeliest owner of a freshly started dev server.
    return shellList[0]?.name || null;
}
