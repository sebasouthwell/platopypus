// RETIRED in 1.28.0: the icons are rendered from web/mascot.svg by scripts/render-mascot.mjs. Kept for reference.
// Generates the PWA icons (a brass porthole ring on deep sea) as PNGs with no dependencies.
// Usage: node scripts/make-icons.mjs   → writes web/icons/icon-{180,192,512}.png

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'web', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const SEA = [15, 26, 38], BRASS = [214, 173, 82], BRASS_DARK = [122, 95, 39], GLASS_IN = [46, 85, 122], GLASS_OUT = [14, 29, 44], FOAM = [242, 245, 247];

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const [r, g, b] = pixel(x + 0.5, y + 0.5);
            const o = y * (size * 3 + 1) + 1 + x * 3;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp01 = v => Math.max(0, Math.min(1, v));

function icon(size) {
    const c = size / 2;
    const R = size * 0.40;       // outer ring radius
    const ringW = size * 0.085;  // ring thickness
    const aa = 1.2;              // anti-alias width in px
    return png(size, (x, y) => {
        const dx = x - c, dy = y - c;
        const d = Math.hypot(dx, dy);
        // glass: radial gradient offset to upper-left
        const gx = x - c + size * 0.10, gy = y - c + size * 0.12;
        const gd = clamp01(Math.hypot(gx, gy) / (R * 1.1));
        let col = mix(GLASS_IN, GLASS_OUT, gd);
        // highlight streak
        const hx = dx * Math.cos(0.5) + dy * Math.sin(0.5), hy = -dx * Math.sin(0.5) + dy * Math.cos(0.5);
        const streak = clamp01(1 - Math.hypot(hx / (size * 0.17), (hy + size * 0.19) / (size * 0.045)));
        col = mix(col, FOAM, streak * 0.45);
        // ring with dark inner lip
        const inner = R - ringW;
        const ringT = clamp01((d - inner) / aa) * clamp01((R - d) / aa);
        const lip = clamp01(1 - Math.abs(d - inner) / (size * 0.012));
        let ring = mix(BRASS, BRASS_DARK, lip * 0.8);
        // bolts
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
            const bx = c + Math.cos(a) * (R - ringW / 2), by = c + Math.sin(a) * (R - ringW / 2);
            const bd = Math.hypot(x - bx, y - by);
            const bolt = clamp01((size * 0.022 - bd) / aa);
            ring = mix(ring, BRASS_DARK, bolt);
        }
        col = mix(col, ring, ringT);
        // outside ring → sea
        const outside = clamp01((d - R) / aa);
        col = mix(col, SEA, outside);
        return col;
    });
}

for (const s of [180, 192, 512]) {
    fs.writeFileSync(path.join(outDir, `icon-${s}.png`), icon(s));
    console.log(`wrote icon-${s}.png`);
}
