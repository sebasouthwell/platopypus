// One-tap app catalog: "I want a Stirling PDF server" → pull, run on loopback, open a tunnel.
// Data folders live under ~/apps/<name> so they show up in the Files tab and survive container removal.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as dockerMgr from './docker.js';
import * as tunnels from './tunnels.js';
import { log } from './log.js';

export const catalog = [
    { key: 'stirling-pdf', title: 'Stirling PDF', blurb: 'Merge, split, convert, sign and OCR PDFs in the browser.', image: 'stirlingtools/stirling-pdf:latest', port: 8080, hostPort: 8081, volumes: [['configs', '/configs'], ['data', '/customFiles']], env: { DOCKER_ENABLE_SECURITY: 'false', SECURITY_ENABLELOGIN: 'false', LANGS: 'en_GB' } },
    { key: 'n8n', title: 'n8n', blurb: 'Workflow automation with a visual editor.', image: 'n8nio/n8n:latest', port: 5678, hostPort: 5678, volumes: [['data', '/home/node/.n8n']], env: { N8N_SECURE_COOKIE: 'false' } },
    { key: 'filebrowser', title: 'File Browser', blurb: 'Web file manager over the whole home folder.', image: 'filebrowser/filebrowser:latest', port: 80, hostPort: 8082, volumes: [['db', '/database'], ['config', '/config']], mounts: [['.', '/srv']], env: {} },
    { key: 'excalidraw', title: 'Excalidraw', blurb: 'Whiteboard and sketch diagrams.', image: 'excalidraw/excalidraw:latest', port: 80, hostPort: 8083, volumes: [], env: {} },
    { key: 'it-tools', title: 'IT Tools', blurb: 'Encoders, converters, generators, hashes, JWT and more.', image: 'corentinth/it-tools:latest', port: 80, hostPort: 8084, volumes: [], env: {} },
    { key: 'uptime-kuma', title: 'Uptime Kuma', blurb: 'Monitor sites and services with alerts.', image: 'louislam/uptime-kuma:1', port: 3001, hostPort: 3001, volumes: [['data', '/app/data']], env: {} },
    { key: 'jupyter', title: 'Jupyter Lab', blurb: 'Python notebooks with scipy stack.', image: 'jupyter/scipy-notebook:latest', port: 8888, hostPort: 8888, volumes: [['work', '/home/jovyan/work']], env: { JUPYTER_ENABLE_LAB: 'yes' }, command: ['start-notebook.py', '--NotebookApp.token=', '--NotebookApp.password='] },
    { key: 'postgres', title: 'Postgres 16', blurb: 'Database for a project. No tunnel; connect from the box.', image: 'postgres:16-alpine', port: 5432, hostPort: 5432, volumes: [['data', '/var/lib/postgresql/data']], env: { POSTGRES_PASSWORD: 'porthole', POSTGRES_USER: 'dev', POSTGRES_DB: 'dev' }, noTunnel: true },
    { key: 'redis', title: 'Redis', blurb: 'Cache / queue for a project. No tunnel.', image: 'redis:7-alpine', port: 6379, hostPort: 6379, volumes: [], env: {}, noTunnel: true },
];

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const pickPort = preferred => dockerMgr.freePortNear(preferred);

export async function list() {
    let running = [];
    try { running = await dockerMgr.containers(); } catch { /* docker down */ }
    let open = [];
    try { open = await tunnels.list(); } catch { /* ignore */ }
    return catalog.map(a => {
        const c = running.find(x => x.name === `app-${a.key}`);
        const hostPort = c?.ports?.[0]?.host ?? null;
        const t = hostPort ? open.find(x => x.port === hostPort) : null;
        return { key: a.key, title: a.title, blurb: a.blurb, image: a.image, noTunnel: !!a.noTunnel, running: c?.state === 'running', container: c?.name || null, hostPort, url: t?.url || null };
    });
}

export async function launch(key, { tunnel = true } = {}) {
    const a = catalog.find(x => x.key === key);
    if (!a) throw httpError(404, 'Unknown app.');
    const name = `app-${a.key}`;
    const existing = (await dockerMgr.containers()).find(x => x.name === name);
    let hostPort;
    if (existing) {
        hostPort = existing.ports[0]?.host ?? a.hostPort;
        if (existing.state !== 'running') await dockerMgr.action(name, 'start');
    } else {
        hostPort = await pickPort(a.hostPort);
        const base = path.join(config.home, 'apps', a.key);
        const args = { image: a.image, name, ports: [{ host: hostPort, container: a.port }], env: a.env, restart: 'unless-stopped', command: a.command || [] };
        // Build -v flags directly: persistent folders under ~/apps/<key>/ plus any home-folder mounts.
        const extra = [];
        for (const [sub, target] of a.volumes) {
            const dir = path.join(base, sub);
            fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            extra.push(`${dir}:${target}`);
        }
        for (const [sub, target] of a.mounts || []) extra.push(`${path.resolve(config.root, sub)}:${target}`);
        await dockerMgr.quickRunWithVolumes(args, extra);
    }
    log('apps', `launched ${a.key} on 127.0.0.1:${hostPort}`);
    let url = null;
    if (tunnel && !a.noTunnel) {
        const open = (await tunnels.list()).find(t => t.port === hostPort);
        if (open) url = open.url;
        else {
            // Give the container a moment to bind before cloudflared starts probing it.
            await new Promise(r => setTimeout(r, 1500));
            url = (await tunnels.create({ port: hostPort, name: a.title, host: config.dockerHost })).url;
        }
    }
    return { key: a.key, container: name, hostPort, url };
}
