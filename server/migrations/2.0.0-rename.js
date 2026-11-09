// 1.x → 2.0: the rename on disk. config.js and install.sh already did the moves by the time this runs (the state
// folder before anything was read, the app folder during install); this step makes sure of every link and copy,
// so a box that skipped one path (Docker mode, an unusual install) ends up the same. Idempotent; nothing is deleted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sbin = name => ['/usr/sbin/', '/sbin/', '/usr/bin/'].map(d => d + name).find(f => fs.existsSync(f)) || name;

function linkOldToNew(oldPath, newPath, out, label) {
    try {
        const st = fs.lstatSync(oldPath);
        if (st.isSymbolicLink()) return;
        if (st.isDirectory() && !fs.existsSync(newPath)) { fs.renameSync(oldPath, newPath); fs.symlinkSync(newPath, oldPath); out.moved.push(label); return; }
    } catch (e) { if (e.code !== 'ENOENT') return; }
    if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) { try { fs.symlinkSync(newPath, oldPath); out.linked.push(label); } catch { /* best effort */ } }
}

export async function up({ state, log }) {
    const out = { moved: [], linked: [], envFile: false, chainRemoved: false };
    const home = os.homedir();
    linkOldToNew(path.join(home, '.porthole'), path.join(home, '.platopypus'), out, 'state');
    linkOldToNew('/opt/porthole', '/opt/platopypus', out, 'app');
    linkOldToNew('/opt/porthole-src', '/opt/platopypus-src', out, 'source');
    if (fs.existsSync('/etc/porthole.env') && !fs.existsSync('/etc/platopypus.env')) {
        try { const t = fs.readFileSync('/etc/porthole.env', 'utf8').replace(/^PORTHOLE_/gm, 'PLATO_'); fs.writeFileSync('/etc/platopypus.env', t, { mode: 0o600 }); out.envFile = true; } catch (e) { log(`env file: ${e.message}`); }
    }
    for (const bin of ['iptables', 'ip6tables']) {
        try { await run(sbin(bin), ['-w', '5', '-D', 'OUTPUT', '-j', 'PORTHOLE-EGRESS']); await run(sbin(bin), ['-w', '5', '-F', 'PORTHOLE-EGRESS']); await run(sbin(bin), ['-w', '5', '-X', 'PORTHOLE-EGRESS']); out.chainRemoved = true; } catch { /* not there */ }
    }
    if (out.moved.length || out.linked.length) log(`moved: ${out.moved.join(', ') || 'nothing'}; linked: ${out.linked.join(', ') || 'nothing'}`);
    return out;
}
