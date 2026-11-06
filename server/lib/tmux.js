// Thin wrapper around the dedicated tmux server (`tmux -L porthole`). Every shell and every
// tunnel is a tmux session, so they outlive the web server and can also be attached from an SSH app.

import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, tmuxConfPath } from './config.js';

const run = promisify(execFile);
const conf = tmuxConfPath();

export const tmuxBase = ['-L', config.tmuxSocket, '-f', conf];

export async function tmux(...args) {
    try {
        const { stdout } = await run('tmux', [...tmuxBase, ...args], { maxBuffer: 4 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        // "no server running" / "no sessions" are normal when idle.
        if (/no server running|no sessions|can't find session|error connecting to .*No such file/i.test(err.stderr || err.message)) return '';
        throw new Error((err.stderr || err.message).trim());
    }
}

export async function listSessions() {
    const out = await tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}');
    return out.split('\n').filter(Boolean).map(line => {
        const [name, created, attached, windows] = line.split('\t');
        return { name, created: Number(created) * 1000, attached: Number(attached) > 0, windows: Number(windows) };
    });
}

export async function hasSession(name) {
    try {
        await run('tmux', [...tmuxBase, 'has-session', '-t', `=${name}`]);
        return true;
    } catch {
        return false;
    }
}

// The tmux server (and so every shell, server, live service and tunnel under it) runs in its own systemd scope at
// normal priority, outside Porthole's service cgroup: Porthole keeps its Nice/CPUWeight/MemoryLow to itself, the
// OOM killer prefers the shells, and the scope outlives a Porthole restart. The scope is created by whichever
// new-session call starts the server; later clients just talk to it. Without systemd (Docker mode) this is plain tmux.
const haveSystemd = () => fs.existsSync('/run/systemd/system') && ['/usr/bin/systemd-run', '/bin/systemd-run'].some(f => fs.existsSync(f));
function launcher() {
    const out = [];
    const prio = (() => { try { return os.getPriority(); } catch { return 0; } })();
    const pre = haveSystemd() ? ['systemd-run', '--quiet', '--scope', '--collect', `--unit=porthole-shells-${Date.now().toString(36)}`, '-p', 'CPUWeight=100', '-p', 'IOWeight=100', '-p', 'OOMScoreAdjust=500', '--'] : [];
    if (prio < 0) out.push('nice', '-n', String(-prio));   // children at normal priority, not Porthole's raised one
    return [...pre, ...out];
}

// Create a detached session. `command` is optional; without it the user's shell starts.
export async function newSession(name, cwd, command, env = {}) {
    const args = ['new-session', '-d', '-s', name, '-c', cwd, '-x', '100', '-y', '40'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    if (command) args.push(command);
    const pre = launcher();
    if (pre.length) {
        try { await run(pre[0], [...pre.slice(1), 'tmux', ...tmuxBase, ...args], { maxBuffer: 4 * 1024 * 1024 }); return; }
        catch (err) { if (!/systemd-run|Failed to|scope/i.test(err.stderr || err.message)) throw new Error((err.stderr || err.message).trim()); /* no systemd after all: plain tmux below */ }
    }
    await tmux(...args);
    // tmux swallows OSC sequences it does not know (credshare's card announcement); allow DCS-wrapped passthrough.
    try { await tmux('set-option', '-g', 'allow-passthrough', 'on'); } catch { /* older tmux: the WS push below still works */ }
}

export async function killSession(name) {
    await tmux('kill-session', '-t', `=${name}`);
}

export async function capture(name, lines = 4) {
    const out = await tmux("capture-pane", "-p", "-t", `${name}:`, "-S", `-${lines + 20}`);
    const rows = out.replace(/\s+$/g, '').split('\n').filter(l => l.trim().length);
    return rows.slice(-lines);
}

export async function sendKeys(name, text) {
    await tmux("send-keys", "-t", `${name}:`, "-l", text);
}

// Session names must be safe for tmux and for URLs.
export function validName(name) {
    return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name) && !name.includes('.') && !name.includes(':');
}
