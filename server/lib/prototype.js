// The read-only prototype snapshot inside an upgraded project (<project>/.porthole/prototype). Root owns it and nobody
// can write it, so the agent rebuilding the project always has the original behaviour to compare against. Anything
// that rewrites a project's permissions (Make agent-ready, live-service grants) calls lockSnapshot afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sbin = n => ['/usr/bin', '/usr/sbin', '/bin', '/sbin'].map(d => path.join(d, n)).find(f => fs.existsSync(f)) || n;

export const SNAPSHOT = path.join('.porthole', 'prototype');
export const snapshotOf = root => path.join(root, SNAPSHOT);

export async function lockSnapshot(root) {
    const snap = snapshotOf(root);
    if (!fs.existsSync(snap)) return false;
    try { await run(sbin('setfacl'), ['-R', '-b', snap], { timeout: 120_000 }); } catch { /* no ACL support */ }
    await run('chown', ['-R', 'root:root', snap], { timeout: 120_000 });
    await run('chmod', ['-R', 'u=rwX,go=rX', snap], { timeout: 120_000 });
    return true;
}
