// Runtime configuration. Everything comes from the environment with safe defaults.
// Security defaults: bind to loopback only, token auth always on, file root jailed to $HOME.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = os.homedir();

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
    // Where Porthole keeps its own state (token, shell metadata, tunnel logs, trash).
    state: path.resolve(process.env.PORTHOLE_STATE || path.join(home, '.porthole')),
    // Cookie `Secure` flag. Only turn off for plain-http local testing.
    insecureCookie: process.env.PORTHOLE_INSECURE_COOKIE === '1',
    // Extra allowed Origins for WebSocket/CSRF checks (comma separated). Same-host is always allowed.
    allowedOrigins: (process.env.PORTHOLE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // Where published container ports live. 127.0.0.1 on a real box; host.docker.internal when Porthole itself
    // runs in a container that talks to the host's Docker daemon (local testing).
    dockerHost: process.env.PORTHOLE_DOCKER_HOST || '127.0.0.1',
    // Quick tunnels die after this many minutes unless renewed.
    tunnelTtlMinutes: envInt('PORTHOLE_TUNNEL_TTL', 240),
    // Max upload size in MB.
    maxUploadMb: envInt('PORTHOLE_MAX_UPLOAD_MB', 512),
    // Login session lifetime in days (rolling).
    sessionDays: envInt('PORTHOLE_SESSION_DAYS', 7),
    // Dedicated tmux server so Porthole's sessions don't collide with the user's own tmux.
    tmuxSocket: 'porthole',
    // Shell used for plain sessions.
    shell: process.env.SHELL || '/bin/bash',
    home,
};

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
        console.log(`[porthole] generated login token, saved to ${file}`);
        return token;
    }
}

// tmux config for the dedicated server. Status bar off: on a phone every row counts.
export function tmuxConfPath() {
    const file = path.join(config.state, 'tmux.conf');
    const conf = [
        'set -g status off',
        'set -g mouse off',   // selection by default; per-shell toggle via the API
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
