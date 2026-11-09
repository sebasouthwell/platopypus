// Runtime configuration. Everything comes from the environment with safe defaults.
// Security defaults: bind to loopback only, token auth always on, file root jailed to $HOME.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const home = os.homedir();

// 2.0: settings are PLATO_*; PORTHOLE_* is the old spelling and keeps working. Both are made to agree here, once,
// so every read below (and in every other module and CLI) can use either name.
for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('PLATO_') && process.env['PORTHOLE_' + k.slice(6)] === undefined) process.env['PORTHOLE_' + k.slice(6)] = v;
    else if (k.startsWith('PORTHOLE_') && process.env['PLATO_' + k.slice(9)] === undefined) process.env['PLATO_' + k.slice(9)] = v;
}

// The state folder is ~/.platopypus. A box that still has ~/.porthole gets it moved (same disk: a rename) with a
// link left at the old path, before anything is read, so nothing is ever started with an empty state folder.
function stateDir() {
    const want = path.resolve(process.env.PORTHOLE_STATE || path.join(home, '.platopypus'));
    const old = path.join(home, '.porthole');
    if (process.env.PORTHOLE_STATE || want !== path.join(home, '.platopypus')) return want;
    try {
        const st = fs.lstatSync(old);
        if (st.isDirectory()) {
            if (!fs.existsSync(want)) {
                // A rename; on an overlay filesystem (containers) that is EXDEV, and mv copies instead.
                try { fs.renameSync(old, want); } catch (e) { if (e.code !== 'EXDEV') throw e; execFileSync('mv', ['-T', old, want], { stdio: 'ignore' }); }
                fs.symlinkSync(want, old); console.log(`[platopypus] state moved ${old} → ${want}; ${old} is now a link`);
            }
            else if (!fs.existsSync(path.join(want, 'token')) && fs.existsSync(path.join(old, 'token'))) return old;   // both exist and the old one is the live one: keep it
        }
    } catch (e) {
        if (e.code !== 'ENOENT') { console.log(`[platopypus] state: could not move ${old}: ${e.message}; using it where it is`); return old; }   // never start on an empty folder
    }
    try { if (!fs.existsSync(old)) fs.symlinkSync(want, old); } catch { /* not ours to make */ }
    return want;
}

// The tmux socket is `plato`. While the old `porthole` server still holds sessions, keep using it (nothing is
// started twice); "finish the rename" (More → Update card) moves everything over at a moment you pick.
function tmuxSocketName() {
    try { const out = execFileSync('tmux', ['-L', 'porthole', 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); if (out.trim()) return 'porthole'; } catch { /* no old server */ }
    return 'plato';
}

function envInt(name, fallback) {
    const v = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(v) ? v : fallback;
}

export const config = {
    port: envInt('PORTHOLE_PORT', 7331),
    // 127.0.0.1 by default. On the box, `tailscale serve` proxies HTTPS to this. Docker sets 0.0.0.0.
    bind: process.env.PORTHOLE_BIND || '127.0.0.1',
    // Directory the file browser and new shells are jailed to.
    root: path.resolve(process.env.PORTHOLE_ROOT || home),
    // Where PlatOpypus keeps its own state (token, shell metadata, tunnel logs, trash).
    state: stateDir(),
    // Cookie `Secure` flag. Only turn off for plain-http local testing.
    insecureCookie: process.env.PORTHOLE_INSECURE_COOKIE === '1',
    // Extra allowed Origins for WebSocket/CSRF checks (comma separated). Same-host is always allowed.
    allowedOrigins: (process.env.PORTHOLE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // Where published container ports live. 127.0.0.1 on a real box; host.docker.internal when PlatOpypus itself
    // runs in a container that talks to the host's Docker daemon (local testing).
    dockerHost: process.env.PORTHOLE_DOCKER_HOST || '127.0.0.1',
    // Quick tunnels die after this many minutes unless renewed.
    tunnelTtlMinutes: envInt('PORTHOLE_TUNNEL_TTL', 240),
    // Max upload size in MB.
    maxUploadMb: envInt('PORTHOLE_MAX_UPLOAD_MB', 512),
    // Login session lifetime in days (rolling).
    sessionDays: envInt('PORTHOLE_SESSION_DAYS', 7),
    // Dedicated tmux server so PlatOpypus's sessions don't collide with the user's own tmux.
    tmuxSocket: tmuxSocketName(),
    // Shell used for plain sessions.
    shell: process.env.SHELL || '/bin/bash',
    home,
};
config.renamePending = config.tmuxSocket === 'porthole';

fs.mkdirSync(config.state, { recursive: true, mode: 0o700 });
for (const sub of ['tunnels', 'trash', 'uploads']) {
    fs.mkdirSync(path.join(config.state, sub), { recursive: true, mode: 0o700 });
}

// Login token: from env, else persisted at state/token (0600). Generated once, printed to the log.
export function loadToken() {
    if (process.env.PORTHOLE_TOKEN) return process.env.PORTHOLE_TOKEN;
    const file = path.join(config.state, 'token');
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        const token = crypto.randomBytes(24).toString('base64url');
        fs.writeFileSync(file, token + '\n', { mode: 0o600 });
        console.log(`[platopypus] generated login token, saved to ${file}`);
        return token;
    }
}

// tmux config for the dedicated server. Status bar off: on a phone every row counts.
export function tmuxConfPath() {
    const file = path.join(config.state, 'tmux.conf');
    const conf = [
        'set -g status off',
        'set -g mouse off',   // selection by default; per-shell toggle via the API
        'set -g allow-passthrough on', // credshare announces cards with a wrapped OSC; tmux drops unknown OSCs otherwise
        'set -g history-limit 20000',
        'set -g default-terminal "tmux-256color"',
        'set -ga terminal-overrides ",xterm-256color:Tc"',
        'set -sg escape-time 10',
        'set -g focus-events on',
        'set -g destroy-unattached off',
        'set -g remain-on-exit off',
        'setw -g aggressive-resize on',
        '',
    ].join('\n');
    fs.writeFileSync(file, conf, { mode: 0o600 });
    return file;
}
