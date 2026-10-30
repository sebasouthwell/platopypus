// Docker management through the docker CLI. Inputs are validated against strict patterns and
// passed as separate arguments (never a shell string). Docker access is root-equivalent on the
// box, so this sits behind the same login as everything else and every action is logged.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const run = promisify(execFile);

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

async function docker(args, timeout = 20_000) {
    try {
        const { stdout } = await run('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const msg = (err.stderr || err.message || '').trim();
        if (/Cannot connect to the Docker daemon|command not found|ENOENT/i.test(msg)) throw httpError(503, 'Docker is not running on the box.');
        throw httpError(500, msg.split('\n').pop().slice(0, 300) || 'docker failed');
    }
}

function parseJsonLines(out) {
    return out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function portFree(port) {
    return new Promise(resolve => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, '127.0.0.1');
    });
}

export async function freePortNear(preferred, taken = new Set()) {
    const start = preferred >= 1024 ? preferred : 8080;
    for (let p = start; p < start + 200; p++) if (!taken.has(p) && await portFree(p)) return p;
    throw httpError(409, 'No free port near ' + start);
}

// Pull an image and describe it so the phone can pre-fill a run form: description, exposed ports with a
// suggested free host port, default environment, declared volumes, command.
export async function inspectImage(image) {
    if (!IMAGE_RE.test(String(image || ''))) throw httpError(400, 'Image: e.g. nginx:alpine or ghcr.io/org/app:tag.');
    await docker(['pull', image], 600_000);
    const info = JSON.parse(await docker(['image', 'inspect', image]))[0];
    const cfg = info.Config || {};
    const labels = cfg.Labels || {};
    const taken = new Set((await containers().catch(() => [])).flatMap(c => c.ports.map(p => p.host)));
    const ports = [];
    for (const key of Object.keys(cfg.ExposedPorts || {})) {
        const [num, proto] = key.split('/');
        const container = Number(num);
        const host = await freePortNear(container, taken);
        taken.add(host);
        ports.push({ container, proto: proto || 'tcp', host });
    }
    const env = (cfg.Env || []).map(kv => { const i = kv.indexOf('='); return { key: kv.slice(0, i), value: kv.slice(i + 1) }; })
        .filter(e => !/^(PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|GPG_KEY|PYTHON_[A-Z_]+|NODE_VERSION|YARN_VERSION|JAVA_HOME|JAVA_VERSION|GOLANG_VERSION|GOPATH)$/.test(e.key));
    const name = (image.split('/').pop() || 'app').split(':')[0].split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '-');
    const volumes = Object.keys(cfg.Volumes || {}).map(target => ({ target, folder: `apps/${name}/${target.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'data'}` }));
    log('docker', `inspected ${image}`);
    return {
        image,
        name,
        description: labels['org.opencontainers.image.description'] || labels['description'] || '',
        title: labels['org.opencontainers.image.title'] || '',
        url: labels['org.opencontainers.image.url'] || labels['org.opencontainers.image.source'] || '',
        size: info.Size,
        created: info.Created,
        arch: `${info.Os}/${info.Architecture}`,
        ports, env, volumes,
        cmd: cfg.Cmd || [], entrypoint: cfg.Entrypoint || [], workdir: cfg.WorkingDir || '', user: cfg.User || '',
    };
}

export async function available() {
    try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000 }); return true; } catch { return false; }
}

export async function containers() {
    const rows = parseJsonLines(await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']));
    return rows.map(c => ({
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: parsePorts(c.Ports),
        created: c.CreatedAt,
        compose: labelOf(c.Labels, 'com.docker.compose.project'),
    })).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
}

function labelOf(labels, key) {
    if (!labels) return null;
    const m = labels.split(',').find(kv => kv.startsWith(key + '='));
    return m ? m.slice(key.length + 1) : null;
}

// "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5000/tcp" → [{host:8080, container:80, proto:'tcp'}]
function parsePorts(str) {
    const out = [];
    const seen = new Set();
    for (const part of String(str || '').split(',')) {
        const m = part.trim().match(/(?:[\d.]+|\[?[0-9a-f:]+\]?):(\d+)->(\d+)\/(\w+)/);
        if (!m) continue;
        const k = `${m[1]}:${m[2]}/${m[3]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ host: Number(m[1]), container: Number(m[2]), proto: m[3] });
    }
    return out;
}

export async function action(name, verb) {
    if (!ID_RE.test(name)) throw httpError(400, 'Bad container name.');
    if (!['start', 'stop', 'restart', 'remove'].includes(verb)) throw httpError(400, 'Unknown action.');
    if (verb === 'remove') await docker(['rm', '-f', name], 60_000);
    else await docker([verb, name], 60_000);
    log('docker', `${verb} ${name}`);
}

export async function logs(name, tail = 200) {
    if (!ID_RE.test(name)) throw httpError(400, 'Bad container name.');
    const n = Math.min(2000, Math.max(10, parseInt(tail, 10) || 200));
    try {
        const { stdout, stderr } = await run('docker', ['logs', '--tail', String(n), '--timestamps', name], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
        return (stdout + stderr).split('\n').sort().join('\n');
    } catch (err) {
        throw httpError(500, (err.stderr || err.message).trim().slice(0, 300));
    }
}

// Quick run: image + name + port maps + env + optional volume of a folder inside the files root.
export async function quickRun(opts, resolveInRoot) {
    const extra = [];
    const list = Array.isArray(opts.volumes) ? opts.volumes : opts.volume ? [opts.volume] : [];
    for (const v of list) {
        if (!v || !v.folder) continue;
        const abs = resolveInRoot(v.folder);
        const target = String(v.target || '/data');
        if (!target.startsWith('/') || /[:\s]/.test(target)) throw httpError(400, 'Volume target must be an absolute container path.');
        fs.mkdirSync(abs, { recursive: true });
        extra.push(`${abs}:${target}`);
    }
    return quickRunWithVolumes(opts, extra);
}

// extraVolumes: already-validated "hostAbs:containerAbs" strings (used by the app catalog).
export async function quickRunWithVolumes({ image, name, ports = [], env = {}, restart = 'unless-stopped', command = [] }, extraVolumes = [], extraFlags = []) {
    if (!IMAGE_RE.test(String(image || ''))) throw httpError(400, 'Image: e.g. nginx:alpine or ghcr.io/org/app:tag.');
    if (!NAME_RE.test(String(name || ''))) throw httpError(400, 'Container name: letters, numbers, dash, underscore or dot.');
    const args = ['run', '-d', '--name', name];
    if (['no', 'unless-stopped', 'always', 'on-failure'].includes(restart)) args.push('--restart', restart);
    for (const p of ports) {
        const host = Number(p.host), cont = Number(p.container);
        if (!Number.isInteger(host) || !Number.isInteger(cont) || host < 1 || host > 65535 || cont < 1 || cont > 65535) throw httpError(400, 'Ports must be 1–65535.');
        // Bind to loopback: reach it via a Porthole tunnel, not the public interface.
        args.push('-p', `127.0.0.1:${host}:${cont}`);
    }
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_RE.test(k)) throw httpError(400, `Bad environment name "${k}".`);
        args.push('-e', `${k}=${String(v)}`);
    }
    for (const v of extraVolumes) args.push('-v', v);
    for (const f of extraFlags) { if (!/^[-A-Za-z0-9:_.=/]+$/.test(String(f))) throw httpError(400, 'Bad docker flag.'); args.push(String(f)); }
    args.push(image);
    if (Array.isArray(command)) for (const c of command) args.push(String(c));
    const id = (await docker(args, 180_000)).trim();
    log('docker', `run ${name} (${image}) ports=${ports.map(p => `${p.host}:${p.container}`).join(',') || '-'}`);
    return { id, name };
}

export async function composeProjects() {
    try {
        const rows = JSON.parse(await docker(['compose', 'ls', '-a', '--format', 'json']));
        return rows.map(r => ({ name: r.Name, status: r.Status, configFiles: r.ConfigFiles }));
    } catch {
        return [];
    }
}

export async function composeAction(project, verb) {
    if (!NAME_RE.test(project)) throw httpError(400, 'Bad project name.');
    if (!['up', 'down', 'restart', 'pull'].includes(verb)) throw httpError(400, 'Unknown action.');
    const projects = await composeProjects();
    const p = projects.find(x => x.name === project);
    if (!p) throw httpError(404, 'No such compose project.');
    const file = String(p.configFiles || '').split(',')[0];
    if (!file) throw httpError(400, 'Compose file unknown for this project.');
    const args = ['compose', '-p', project, '-f', file];
    if (verb === 'up') args.push('up', '-d');
    else args.push(verb);
    await docker(args, 300_000);
    log('docker', `compose ${verb} ${project}`);
}

export async function images() {
    return parseJsonLines(await docker(['images', '--format', '{{json .}}'])).map(i => ({ repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince }));
}
