// A small S3 client (SigV4) for backups: put a file, get an object to a file, list a prefix, delete. No SDK: the
// server has no dependencies beyond ws/yaml, and backups need exactly these four calls. Virtual-hosted URLs,
// single PUT up to 5 GB (S3's limit for one request); larger archives are refused with a clear message.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const MAX_PUT = 5 * 1024 * 1024 * 1024;
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha = d => crypto.createHash('sha256').update(d).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function client({ accessKeyId, secretAccessKey, region, bucket, endpoint = null }) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(bucket || ''))) throw new Error('Bucket name is not valid.');
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(String(region || ''))) throw new Error('Region should look like eu-west-2.');
    const host = endpoint ? new URL(endpoint).host : `${bucket}.s3.${region}.amazonaws.com`;
    const base = endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}` : `https://${host}`;

    function sign(method, path, query, headers, payloadHash) {
        const now = new Date(); const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = amz.slice(0, 8);
        const h = { ...headers, host, 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash };
        const signedNames = Object.keys(h).map(k => k.toLowerCase()).sort();
        const canonHeaders = signedNames.map(k => `${k}:${String(h[Object.keys(h).find(x => x.toLowerCase() === k)]).trim()}\n`).join('');
        const canonQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
        const canon = [method, path.split('/').map(enc).join('/'), canonQuery, canonHeaders, signedNames.join(';'), payloadHash].join('\n');
        const scope = `${day}/${region}/s3/aws4_request`;
        const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
        const kSig = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request');
        h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${hmac(kSig, sts).toString('hex')}`;
        delete h.host;
        return { url: `${base}${path}${canonQuery ? '?' + canonQuery : ''}`, headers: h };
    }
    async function call(method, path, { query = {}, headers = {}, body = null, payloadHash = null, timeout = 60_000 } = {}) {
        const ph = payloadHash || (body ? sha(body) : sha(''));
        const { url, headers: h } = sign(method, path, query, headers, ph);
        const res = await fetch(url, { method, headers: h, body: body || undefined, signal: AbortSignal.timeout(timeout), duplex: body && typeof body.pipe === 'function' ? 'half' : undefined });
        if (!res.ok) { const t = await res.text().catch(() => ''); const m = t.match(/<Code>([^<]+)<\/Code>(?:.*?<Message>([^<]+)<\/Message>)?/s); throw new Error(`S3 ${method} ${res.status}: ${m ? `${m[1]}${m[2] ? ` (${m[2]})` : ''}` : t.slice(0, 200) || res.statusText}`); }
        return res;
    }

    return {
        bucket, region,
        // Put a local file. The payload hash is computed over the file first so the body can stream.
        async putFile(key, file, contentType = 'application/octet-stream') {
            const size = fs.statSync(file).size;
            if (size > MAX_PUT) throw new Error(`Archive is ${(size / 1073741824).toFixed(1)} GB; backups above 5 GB are not supported yet.`);
            const hash = await new Promise((ok, no) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no); });
            const body = fs.createReadStream(file);
            await call('PUT', `/${key}`, { headers: { 'content-type': contentType, 'content-length': String(size) }, body, payloadHash: hash, timeout: 6 * 3600_000 });
            return { key, size };
        },
        async getToFile(key, file) {
            const res = await call('GET', `/${key}`, { timeout: 6 * 3600_000 });
            await pipeline(res.body, fs.createWriteStream(file));
            return fs.statSync(file).size;
        },
        async list(prefix = '') {
            const out = []; let token = null;
            do {
                const q = { 'list-type': '2', prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) };
                const text = await (await call('GET', '/', { query: q })).text();
                for (const m of text.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
                    const c = m[1];
                    out.push({ key: c.match(/<Key>([^<]*)<\/Key>/)?.[1], size: Number(c.match(/<Size>(\d+)<\/Size>/)?.[1] || 0), at: Date.parse(c.match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] || 0) });
                }
                token = text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] || null;
            } while (token);
            return out.map(o => ({ ...o, key: o.key.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') }));
        },
        async remove(key) { await call('DELETE', `/${key}`); },
        // A cheap call that proves the credentials and bucket work.
        async check() { await call('GET', '/', { query: { 'list-type': '2', 'max-keys': '1' } }); return true; },
    };
}
