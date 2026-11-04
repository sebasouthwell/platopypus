// 1.14.x → 1.15.0: live services move from the shared porthole-svc account to one account per project.
// Idempotent. Keeps all data: no project file is changed except folder permission bits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sbin = name => ['/usr/sbin/', '/sbin/', '/usr/bin/'].map(d => d + name).find(f => fs.existsSync(f)) || name;

export async function up({ state, log }) {
    const out = { sharedRemoved: false, foldersClosed: 0, approvalsCleared: 0 };
    // 1. The shared account keeps existing (a running 1.14 service may still use it) but loses the project group.
    const groups = fs.existsSync('/etc/group') ? fs.readFileSync('/etc/group', 'utf8') : '';
    const dev = groups.split('\n').find(l => l.startsWith('porthole-dev:'));
    if (dev && dev.split(':')[3]?.split(',').includes('porthole-svc')) {
        await run(sbin('gpasswd'), ['-d', 'porthole-svc', 'porthole-dev']);
        out.sharedRemoved = true; log('removed porthole-svc from porthole-dev');
    }
    // 2. Service accounts may only enter the project their ACL names.
    const root = process.env.PORTHOLE_ROOT || '/';
    const projects = path.join(root, 'Projects');
    if (fs.existsSync(projects)) {
        for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = path.join(projects, e.name);
            const m = fs.statSync(p).mode;
            if (m & 0o007) { fs.chmodSync(p, m & 0o7770); out.foldersClosed++; }
        }
        if (out.foldersClosed) log(`closed ${out.foldersClosed} project folders to other accounts`);
    }
    // 3. Root approvals from 1.14 pinned only the commands; 1.15 pins the code too, so they could never match.
    const f = path.join(state, 'live-approvals.json');
    if (fs.existsSync(f)) {
        let a = {}; try { a = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* unreadable: treat as empty */ }
        out.approvalsCleared = Object.keys(a).length;
        fs.rmSync(f, { force: true });
        if (out.approvalsCleared) log(`cleared ${out.approvalsCleared} root approvals (asked again on the phone)`);
    }
    return out;
}
