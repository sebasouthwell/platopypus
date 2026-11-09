// Logos for Docker images, shown on container rows. Official and verified Docker Hub images publish one; PlatOpypus
// fetches it once, keeps it under state/logos, and serves it from its own origin (the phone never contacts Docker Hub).
// Images from other registries, or without a logo, get none (remembered for a week so a list stays quick).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const dir = path.join(config.state, 'logos');
const MISS_TTL = 7 * 24 * 3600_000;
const MAX = 256 * 1024;
const inflight = new Map();

// nginx:1.27 → library/nginx; grafana/grafana@sha256:… → grafana/grafana; ghcr.io/x/y → null (not Docker Hub).
export function hubRepo(image) {
    let s = String(image || '').trim().toLowerCase();
    if (!s || s.length > 255) return null;
    s = s.split('@')[0];
    const parts = s.split('/');
    if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) {
        if (parts[0] !== 'docker.io' && parts[0] !== 'registry-1.docker.io') return null;
        parts.shift();
    }
    const last = parts.pop().split(':')[0];
    const repo = [...parts, last];
    if (repo.length === 1) repo.unshift('library');
    if (repo.length !== 2 || !repo.every(x => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(x))) return null;
    return repo.join('/');
}

function files(repo) {
    const h = crypto.createHash('sha256').update(repo).digest('hex').slice(0, 24);
    return { png: path.join(dir, `${h}.png`), miss: path.join(dir, `${h}.none`) };
}

async function fetchLogo(repo, f) {
    const url = `https://hub.docker.com/api/media/repos_logo/v1/${encodeURIComponent(repo)}?type=logo`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !/^image\/(png|jpeg|webp)/.test(type)) throw new Error('no logo');
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX) throw new Error('bad size');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(f.png + '.tmp', buf); fs.renameSync(f.png + '.tmp', f.png);
        return f.png;
    } catch {
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(f.miss, String(Date.now())); } catch { /* ignore */ }
        return null;
    }
}

// Path of the cached PNG, or null when the image has no logo.
export async function logoFor(image) {
    const repo = hubRepo(image);
    if (!repo) return null;
    const f = files(repo);
    if (fs.existsSync(f.png)) return f.png;
    try { if (Date.now() - fs.statSync(f.miss).mtimeMs < MISS_TTL) return null; } catch { /* not tried yet */ }
    if (!inflight.has(repo)) inflight.set(repo, fetchLogo(repo, f).finally(() => inflight.delete(repo)));
    return inflight.get(repo);
}
