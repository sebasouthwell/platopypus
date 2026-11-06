// Memory and CPU per shell, server and container, for the stat bubbles in the UI. Read from /proc (resident +
// swapped, summed over each session's process tree) and from `docker stats` for containers. Cached for a few
// seconds so a busy phone cannot make the box busier.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const TICKS = 100;                 // CLK_TCK on Linux
const MIN_GAP = 3000;

let snap = { at: 0, procs: new Map() };   // pid → { ppid, ticks, mem (KB) }
let prevTicks = new Map(), prevAt = 0;
let cpuPct = new Map();                    // pid → % of one core since the previous sample

function readProcs() {
    const procs = new Map();
    let names = [];
    try { names = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { return procs; }
    for (const n of names) {
        try {
            const stat = fs.readFileSync(`/proc/${n}/stat`, 'latin1');
            const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // fields from state onwards
            const ppid = Number(after[1]), ticks = Number(after[11]) + Number(after[12]);
            let mem = 0;
            for (const l of fs.readFileSync(`/proc/${n}/status`, 'latin1').split('\n')) { if (l.startsWith('VmRSS:') || l.startsWith('VmSwap:')) mem += parseInt(l.slice(7), 10) || 0; }
            procs.set(Number(n), { ppid, ticks, mem });
        } catch { /* exited */ }
    }
    return procs;
}

// Take a fresh sample at most every MIN_GAP; CPU% needs two samples, so the first call reports 0.
export function sample(force = false) {
    const now = Date.now();
    if (!force && now - snap.at < MIN_GAP) return snap;
    const procs = readProcs();
    const next = new Map();
    const dt = (now - prevAt) / 1000;
    for (const [pid, p] of procs) {
        const was = prevTicks.get(pid);
        next.set(pid, was !== undefined && dt > 0 ? Math.max(0, (p.ticks - was) / TICKS / dt * 100) : 0);
    }
    cpuPct = next;
    prevTicks = new Map([...procs].map(([pid, p]) => [pid, p.ticks])); prevAt = now;
    snap = { at: now, procs };
    return snap;
}

// Resident+swapped memory (MB) and CPU (% of one core) of a process and everything under it.
export function tree(pid) {
    if (!pid || !snap.procs.has(pid)) return null;
    const kids = new Map();
    for (const [p, v] of snap.procs) { if (!kids.has(v.ppid)) kids.set(v.ppid, []); kids.get(v.ppid).push(p); }
    let mem = 0, cpu = 0, n = 0;
    const stack = [pid], seen = new Set();
    while (stack.length) {
        const p = stack.pop(); if (seen.has(p)) continue; seen.add(p);
        const v = snap.procs.get(p); if (!v) continue;
        mem += v.mem; cpu += cpuPct.get(p) || 0; n++;
        for (const k of kids.get(p) || []) stack.push(k);
    }
    return { mem: Math.round(mem / 1024), cpu: Math.round(cpu), procs: n };
}

// Containers: name → { mem, cpu }, from docker stats (cached like the rest).
let ctr = { at: 0, map: new Map() };
export async function containers(force = false) {
    const now = Date.now();
    if (!force && now - ctr.at < MIN_GAP) return ctr.map;
    const map = new Map();
    try {
        const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 8000 });
        for (const l of stdout.split('\n')) {
            if (!l.trim()) continue;
            let j; try { j = JSON.parse(l); } catch { continue; }
            map.set(j.Name, { mem: toMB(String(j.MemUsage || '').split('/')[0]), cpu: Math.round(parseFloat(j.CPUPerc) || 0) });
        }
    } catch { /* no docker, or none running */ }
    ctr = { at: now, map };
    return map;
}
function toMB(s) {
    const m = String(s).trim().match(/^([\d.]+)\s*([KMG]i?B?)/i); if (!m) return 0;
    const n = parseFloat(m[1]), u = m[2].toUpperCase()[0];
    return Math.round(u === 'G' ? n * 1024 : u === 'K' ? n / 1024 : n);
}

export function box() {
    let swapTotal = 0, swapFree = 0, avail = 0;
    try { for (const l of fs.readFileSync('/proc/meminfo', 'latin1').split('\n')) { const v = parseInt(l.split(/\s+/)[1], 10) || 0; if (l.startsWith('SwapTotal:')) swapTotal = v; else if (l.startsWith('SwapFree:')) swapFree = v; else if (l.startsWith('MemAvailable:')) avail = v; } } catch { /* not linux */ }
    const total = os.totalmem();
    return { memTotal: Math.round(total / 1048576), memUsed: Math.round((total - (avail ? avail * 1024 : os.freemem())) / 1048576), swapTotal: Math.round(swapTotal / 1024), swapUsed: Math.round((swapTotal - swapFree) / 1024), load: os.loadavg().map(x => Math.round(x * 100) / 100), cpus: os.cpus().length };
}
