// Box status: load, memory, disk, Tailscale, Claude Code sign-in and Remote Control state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { hasSession } from './tmux.js';

const run = promisify(execFile);

async function tryRun(cmd, args, timeout = 4000) {
    try {
        const { stdout } = await run(cmd, args, { timeout });
        return stdout.trim();
    } catch {
        return null;
    }
}

export async function status() {
    const [disk, tailscale, claudeVersion, remoteControl, cloudflared, dockerOk] = await Promise.all([
        diskUsage(),
        tailscaleStatus(),
        tryRun('claude', ['--version']),
        hasSession('remote-control'),
        tryRun('cloudflared', ['--version']),
        tryRun('docker', ['info', '--format', '{{.ServerVersion}}']),
    ]);
    const credFile = path.join(config.home, '.claude', '.credentials.json');
    return {
        hostname: os.hostname(),
        uptime: os.uptime(),
        load: os.loadavg(),
        cpus: os.cpus().length,
        arch: os.arch(),
        mem: { total: os.totalmem(), free: os.freemem() },
        disk,
        tailscale,
        claude: {
            version: claudeVersion,
            signedIn: fs.existsSync(credFile),
            remoteControl,
        },
        cloudflared: cloudflared ? cloudflared.split('\n')[0] : null,
        docker: dockerOk,
        root: config.root,
        node: process.version,
    };
}

async function diskUsage() {
    const out = await tryRun('df', ['-kP', config.root]);
    if (!out) return null;
    const line = out.split('\n')[1];
    if (!line) return null;
    const [, total, used, avail] = line.trim().split(/\s+/);
    return { total: Number(total) * 1024, used: Number(used) * 1024, free: Number(avail) * 1024 };
}

async function tailscaleStatus() {
    const out = await tryRun('tailscale', ['status', '--json']);
    if (!out) return { installed: false };
    try {
        const j = JSON.parse(out);
        return {
            installed: true,
            online: j.Self?.Online ?? false,
            dnsName: (j.Self?.DNSName || '').replace(/\.$/, ''),
            ips: j.TailscaleIPs || [],
            backend: j.BackendState,
        };
    } catch {
        return { installed: true, online: false };
    }
}
