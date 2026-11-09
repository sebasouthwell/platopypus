// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with no dependencies. Used as the second factor on login.
// State lives in state/security.json. Recovery if the phone is lost: delete that file over SSM.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

const file = path.join(config.state, 'security.json');
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function save(obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(str) {
    const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | ALPHA.indexOf(ch); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

export function code(secretB32, time = Date.now(), step = 30) {
    const counter = Math.floor(time / 1000 / step);
    const msg = Buffer.alloc(8);
    msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    msg.writeUInt32BE(counter >>> 0, 4);
    const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
    const off = h[h.length - 1] & 0xf;
    const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(n % 1_000_000).padStart(6, '0');
}

function verifyAgainst(secret, input, lastUsedCounter) {
    const given = String(input || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(given)) return { ok: false };
    const now = Date.now();
    for (const skew of [0, -1, 1]) {
        const t = now + skew * 30_000;
        const counter = Math.floor(t / 30_000);
        if (lastUsedCounter != null && counter <= lastUsedCounter) continue; // no replay within the window
        const expected = code(secret, t);
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return { ok: true, counter };
    }
    return { ok: false };
}

export function enabled() {
    return !!load().totp?.enabled;
}

// Step 1: generate a secret and hold it as pending until a valid code proves the app has it.
export function setup(label = 'PlatOpypus') {
    const sec = load();
    const secret = base32Encode(crypto.randomBytes(20));
    sec.pending = { secret, created: Date.now() };
    save(sec);
    const issuer = 'PlatOpypus';
    const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    log('auth', 'TOTP setup started');
    return { secret, otpauth };
}

// Step 2: confirm with a code from the authenticator.
export function enable(input) {
    const sec = load();
    if (!sec.pending) throw Object.assign(new Error('Start setup first.'), { status: 400 });
    const r = verifyAgainst(sec.pending.secret, input, null);
    if (!r.ok) throw Object.assign(new Error('That code did not match. Check the time on your phone and try again.'), { status: 400 });
    sec.totp = { enabled: true, secret: sec.pending.secret, enabledAt: Date.now(), lastCounter: r.counter };
    delete sec.pending;
    save(sec);
    log('auth', 'TOTP ENABLED');
}

export function disable(input) {
    const sec = load();
    if (!sec.totp?.enabled) return;
    const r = verifyAgainst(sec.totp.secret, input, sec.totp.lastCounter);
    if (!r.ok) throw Object.assign(new Error('Enter a current code to turn two-step codes off.'), { status: 400 });
    delete sec.totp;
    save(sec);
    log('auth', 'TOTP DISABLED');
}

// Called by login when TOTP is enabled.
export function verify(input) {
    const sec = load();
    if (!sec.totp?.enabled) return true;
    const r = verifyAgainst(sec.totp.secret, input, sec.totp.lastCounter);
    if (!r.ok) return false;
    sec.totp.lastCounter = r.counter;
    save(sec);
    return true;
}
