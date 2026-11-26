// Papers: find scholarly papers and fetch the real paper (the PDF, or the full text when there is no PDF) into a
// Research topic as a source, with its record (title, authors, year, venue, DOI) filled in from the catalogue.
//
//   search(topic, query)   arXiv, OpenAlex, Semantic Scholar and Europe PMC at once, merged and ranked; results are
//                          numbered r1, r2… and kept in .platopypus/papers/search.json so `get r3` fetches one
//   get(topic, input)      an r-number, arXiv id, DOI, PMCID, a paper link (arXiv, doi.org, OpenReview, ACL Anthology,
//                          bioRxiv, Europe PMC, Semantic Scholar, any .pdf) or a title: finds every open copy and tries
//                          them in turn until one is really a PDF; falls back to full text (Europe PMC, arXiv HTML), then
//                          to the abstract, saying so. A paper already in the topic is not fetched again.
//   related(topic, input)  the papers a source cites (or, with citedBy, the papers that cite it), numbered like a search
//   requests(topic)        every get, what came of it and where the copy came from (.platopypus/papers/requests.json)
//
// Only the query, the paper's ids or its title leave the box. Nothing needs an account; optional keys in the Vault
// (general scope, see KEYS) add more: CORE and IEEE searches, Unpaywall, publisher downloads you are entitled to, and
// higher rate limits. Key values are never written to the topic. Each service is asked politely: arXiv at most once
// every 3 seconds, Semantic Scholar once a second.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as T from './researchtools.js';

// ---------- optional keys: from the environment, else the Vault (general scope; names only are logged there) ----------
export const KEYS = {
    SEMANTIC_SCHOLAR_API_KEY: { what: 'Semantic Scholar', adds: 'a dedicated rate limit (without it searches share a public one and often get 429)', get: 'free: semanticscholar.org/product/api' },
    OPENALEX_API_KEY: { what: 'OpenAlex', adds: 'a higher daily limit', get: 'free: openalex.org (account settings)' },
    CORE_API_KEY: { what: 'CORE', adds: 'searches and downloads full texts held by university and institutional repositories (author copies of paywalled papers)', get: 'free: core.ac.uk/services/api' },
    UNPAYWALL_EMAIL: { what: 'Unpaywall', adds: 'the legal open copy of a DOI (an email address, not a key: it is sent with each lookup)', get: 'no sign-up: any address you are happy to send' },
    SPRINGER_API_KEY: { what: 'Springer Nature', adds: 'open-access full text (JATS) when the PDF will not download', get: 'free: dev.springernature.com' },
    ELSEVIER_API_KEY: { what: 'Elsevier (ScienceDirect)', adds: 'full-text PDFs of articles you are entitled to (open access, or through an institution with ELSEVIER_INSTTOKEN)', get: 'dev.elsevier.com; the institution token comes from your library' },
    ELSEVIER_INSTTOKEN: { what: 'Elsevier institution token', adds: 'your institution\'s subscriptions, from off campus', get: 'ask your library (Elsevier issues it to institutions)' },
    WILEY_TDM_TOKEN: { what: 'Wiley', adds: 'text-and-data-mining downloads of Wiley articles you are entitled to', get: 'onlinelibrary.wiley.com, Text and Data Mining (needs a Wiley login)' },
    IEEE_API_KEY: { what: 'IEEE Xplore', adds: 'searches IEEE papers (full text still needs a subscription)', get: 'developer.ieee.org' },
};
const execP = promisify(execFile);
let keyCache = null;
export async function keys() {
    if (keyCache) return keyCache;
    const out = {}; for (const n of Object.keys(KEYS)) if (process.env[n]) out[n] = process.env[n];
    const missing = Object.keys(KEYS).filter(n => !out[n]);
    if (missing.length && process.env.RESEARCH_NO_VAULT !== '1') {
        try {
            const { stdout } = await execP('vault', ['ls'], { timeout: 8000 });
            for (const n of missing.filter(x => new RegExp(`^${x}\\s`, 'm').test(stdout))) { try { const v = (await execP('vault', ['get', n], { timeout: 8000 })).stdout.trim(); if (v) out[n] = v; } catch { /* project-scoped or refused */ } }
        } catch { /* no vault here */ }
    }
    keyCache = out; return out;
}
export async function keyStatus() { const k = await keys(); return Object.entries(KEYS).map(([name, v]) => ({ name, set: !!k[name], ...v })); }

const UA = 'Mozilla/5.0 (compatible; PlatOpypus-Research/1.0; paper search)';
const MAX_PDF = 60 * 1024 * 1024;
const GAP = { 'export.arxiv.org': 3100, 'arxiv.org': 1000, 'api.semanticscholar.org': 1100, 'api.openalex.org': 150, 'www.ebi.ac.uk': 300 };
const last = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function polite(url) {
    const host = new URL(url).hostname; const gap = GAP[host] ?? 0; const wait = (last.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait); last.set(host, Date.now());
}
async function http(url, { accept = 'application/json', timeout = 25_000, max = 4 * 1024 * 1024, tries = 2, headers = {} } = {}) {
    for (let i = 0; ; i++) {
        await polite(url);
        let res;
        try { res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: accept, ...headers }, signal: AbortSignal.timeout(timeout) }); } catch (e) { if (i + 1 < tries) { await sleep(1500); continue; } throw T.httpError(502, `${new URL(url).hostname}: ${e.cause?.code || e.name || e.message}`); }
        if ((res.status === 429 || res.status >= 500) && i + 1 < tries) { await sleep(Number(res.headers.get('retry-after')) * 1000 || 3000); continue; }
        if (!res.ok) throw T.httpError(res.status === 404 ? 404 : 502, `${new URL(url).hostname} answered ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > max) throw T.httpError(413, 'too large');
        return { buf, type: res.headers.get('content-type') || '', url: res.url };
    }
}
const json = async (url, o) => JSON.parse((await http(url, o)).buf.toString('utf8'));
const oax = async url => { const k = (await keys()).OPENALEX_API_KEY; return k ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(k)}` : url; };
const s2h = async () => { const k = (await keys()).SEMANTIC_SCHOLAR_API_KEY; return k ? { 'x-api-key': k } : {}; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const decode = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const normTitle = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const normDoi = d => (d ? String(d).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').trim().toLowerCase() : '');
const bareArxiv = a => (a ? String(a).replace(/^arxiv:/i, '').replace(/v\d+$/, '') : '');

// ---------- what was asked for ----------
const ARXIV_NEW = /^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_OLD = /^(?:arxiv:)?([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;
export function identify(input) {
    const s = String(input || '').trim(); let m;
    if (/^r\d{1,3}$/i.test(s)) return { ref: s.toLowerCase() };
    if ((m = s.match(ARXIV_NEW) || s.match(ARXIV_OLD))) return { arxiv: m[1] };
    if (/^PMC\d+$/i.test(s)) return { pmcid: s.toUpperCase() };
    if (/^(doi:)?10\.\d{4,9}\/\S+$/i.test(s)) { const d = normDoi(s); const ax = d.match(/^10\.48550\/arxiv\.(.+)$/i); return ax ? { arxiv: ax[1] } : { doi: d }; }
    if (/^https?:\/\//i.test(s)) {
        let u; try { u = new URL(s); } catch { return { title: s }; }
        const h = u.hostname.replace(/^www\./, ''); const p = decodeURIComponent(u.pathname);
        if (/(^|\.)arxiv\.org$/.test(h) && (m = p.match(/^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/))) { const id = m[1].replace(/v\d+$/, ''); if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return { arxiv: id }; }
        if (/^(dx\.)?doi\.org$/.test(h)) return identify(p.slice(1));
        if (/(^|\.)(bio|med)rxiv\.org$/.test(h) && (m = p.match(/\/content\/(10\.1101\/[^v]+?)(v\d+)?(\.full(\.pdf)?)?\/?$/))) return { doi: m[1].toLowerCase(), url: s };
        if (h === 'openreview.net' && u.searchParams.get('id')) return { url: s, pdf: `https://openreview.net/pdf?id=${encodeURIComponent(u.searchParams.get('id'))}` };
        if (h === 'aclanthology.org' && (m = p.match(/^\/([\w.-]+?)(?:\.pdf)?\/?$/))) return { url: `https://aclanthology.org/${m[1]}/`, pdf: `https://aclanthology.org/${m[1]}.pdf`, doi: null };
        if ((m = s.match(/PMC\d+/i)) && /europepmc\.org|ncbi\.nlm\.nih\.gov/.test(h)) return { pmcid: m[0].toUpperCase() };
        if (h.endsWith('semanticscholar.org') && (m = p.match(/([0-9a-f]{40})/))) return { s2: m[1] };
        if ((m = s.match(/\b(10\.\d{4,9}\/[^\s?#]+)/))) return { doi: normDoi(m[1].replace(/\/(full|pdf|abstract|epdf)$/i, '')), url: s, ...(/\.pdf($|\?)/i.test(p) ? { pdf: s } : {}) };
        if (/\.pdf($|\?)/i.test(p)) return { url: s, pdf: s };
        return { url: s };
    }
    return { title: s };
}
// A link or id that `research add` should treat as a paper (so an arXiv abstract page brings the paper, not the page).
export function isPaper(input) { const k = identify(input); return !!(k.arxiv || k.doi || k.pmcid || k.s2 || k.pdf && k.url && !/\.pdf($|\?)/i.test(k.url)); }

// ---------- the catalogues ----------
const authorsLine = (a, n = 3) => (a.length ? a.slice(0, n).join(', ') + (a.length > n ? ' et al.' : '') : '');
function rec(x) { return { title: '', authors: [], year: '', venue: '', doi: '', arxiv: '', pmcid: '', openalex: '', s2: '', cites: null, abstract: '', landing: '', pdfs: [], from: [], ...x }; }
function addPdf(r, url, from) { if (url && /^https?:/.test(url) && !r.pdfs.some(p => p.url === url)) r.pdfs.push({ url, from }); }
function arxivPdfs(r) { if (r.arxiv) { addPdf(r, `https://arxiv.org/pdf/${r.arxiv}`, 'arXiv'); addPdf(r, `https://export.arxiv.org/pdf/${r.arxiv}`, 'arXiv mirror'); } }

function parseArxiv(xml) {
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
        const g = t => decode((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
        const id = (g('id').match(/abs\/(.+)$/) || [])[1]?.replace(/v\d+$/, '') || '';
        const r = rec({ title: g('title'), authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(x => decode(x[1])), year: g('published').slice(0, 4), venue: 'arXiv', journalRef: g('arxiv:journal_ref'), doi: normDoi(g('arxiv:doi')), arxiv: id, abstract: g('summary'), landing: id ? `https://arxiv.org/abs/${id}` : '', from: ['arXiv'] });
        arxivPdfs(r); return r;
    }).filter(r => r.arxiv && r.title && !/^Error$/i.test(r.title));
}
const STOP = new Set('a an and are as at be by for from how in into is it of on or that the this to was what when which with why does do can'.split(' '));
async function arxivSearch(q, n, { year } = {}) {
    const words = (q.match(/"[^"]+"|[\p{L}\p{N}-]+/gu) || []).filter(w => !STOP.has(w.toLowerCase())).slice(0, 8);
    if (!words.length) return [];
    let sq = words.map(w => `all:${w}`).join(' AND ');
    if (year) sq += ` AND submittedDate:[${year}01010000 TO ${new Date().getFullYear() + 1}01010000]`;
    const xml = (await http(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(sq)}&start=0&max_results=${n}&sortBy=relevance`, { accept: 'application/atom+xml' })).buf.toString('utf8');
    return parseArxiv(xml);
}
async function arxivById(ids) { const xml = (await http(`https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`, { accept: 'application/atom+xml' })).buf.toString('utf8'); return parseArxiv(xml); }

function fromOpenAlex(w) {
    const abs = w.abstract_inverted_index ? Object.entries(w.abstract_inverted_index).flatMap(([word, at]) => at.map(i => [i, word])).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ') : '';
    const locs = [w.best_oa_location, w.primary_location, ...(w.locations || [])].filter(Boolean);
    const arxivLoc = locs.map(l => l.landing_page_url || l.pdf_url || '').map(u => (u.match(/arxiv\.org\/(?:abs|pdf)\/([^\sv?#]+(?:\/\d{7})?)/) || [])[1]).find(Boolean);
    const pmcid = w.ids?.pmcid ? `PMC${(String(w.ids.pmcid).match(/(\d+)\/?$/) || [])[1] || ''}`.replace(/^PMC$/, '') : '';
    const r = rec({ title: decode(w.title || w.display_name), authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean), year: String(w.publication_year || ''), venue: w.primary_location?.source?.display_name || '', doi: normDoi(w.doi), arxiv: arxivLoc ? bareArxiv(arxivLoc.replace(/\.pdf$/, '')) : '', pmcid: pmcid || '', openalex: String(w.id || '').split('/').pop(), cites: w.cited_by_count ?? null, abstract: abs, landing: w.doi || w.primary_location?.landing_page_url || '', from: ['OpenAlex'], oa: !!w.open_access?.is_oa });
    if (/^10\.48550\/arxiv\./.test(r.doi)) { r.arxiv = r.arxiv || r.doi.split('arxiv.')[1]; }
    for (const l of locs) addPdf(r, l.pdf_url, l.source?.display_name || 'open copy');
    arxivPdfs(r); if (r.pmcid) addPdf(r, `https://europepmc.org/articles/${r.pmcid}?pdf=render`, 'Europe PMC');
    return r;
}
const OA_FIELDS = 'id,doi,title,display_name,publication_year,authorships,primary_location,best_oa_location,locations,open_access,cited_by_count,ids,abstract_inverted_index';
async function openalexSearch(q, n, { year, oa } = {}) {
    const f = [year ? `from_publication_date:${year}-01-01` : '', oa ? 'is_oa:true' : ''].filter(Boolean).join(',');
    const j = await json(await oax(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}${f ? `&filter=${f}` : ''}&select=${OA_FIELDS}`));
    return (j.results || []).map(fromOpenAlex);
}
async function openalexOne(key) { try { return fromOpenAlex(await json(await oax(`https://api.openalex.org/works/${key}?select=${OA_FIELDS}`))); } catch { return null; } }

const S2_FIELDS = 'title,year,authors,venue,externalIds,citationCount,openAccessPdf,abstract';
function fromS2(p) {
    const x = p.externalIds || {}; const r = rec({ title: decode(p.title), authors: (p.authors || []).map(a => a.name), year: String(p.year || ''), venue: p.venue || '', doi: normDoi(x.DOI), arxiv: x.ArXiv || '', pmcid: x.PubMedCentral ? `PMC${String(x.PubMedCentral).replace(/^PMC/i, '')}` : '', s2: p.paperId || '', cites: p.citationCount ?? null, abstract: p.abstract || '', landing: p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : '', from: ['Semantic Scholar'] });
    addPdf(r, p.openAccessPdf?.url, 'Semantic Scholar'); arxivPdfs(r); if (r.pmcid) addPdf(r, `https://europepmc.org/articles/${r.pmcid}?pdf=render`, 'Europe PMC');
    return r;
}
async function s2Search(q, n, { year, oa } = {}) {
    const j = await json(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${n}&fields=${S2_FIELDS}${year ? `&year=${year}-` : ''}${oa ? '&openAccessPdf' : ''}`, { headers: await s2h() });
    return (j.data || []).map(fromS2);
}
async function s2One(key) { try { return fromS2(await json(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(key)}?fields=${S2_FIELDS}`, { headers: await s2h() })); } catch { return null; } }

// CORE (with a key): full texts from institutional repositories, often the author's own copy of a paywalled paper.
function fromCore(w) {
    const r = rec({ title: decode(w.title), authors: (w.authors || []).map(a => a.name).filter(Boolean), year: String(w.yearPublished || ''), venue: w.journals?.[0]?.title || w.publisher || '', doi: normDoi(w.doi), arxiv: w.arxivId || '', cites: w.citationCount ?? null, abstract: w.abstract || '', landing: (w.links || []).find(l => l.type === 'display')?.url || (w.id ? `https://core.ac.uk/works/${w.id}` : ''), from: ['CORE'] });
    addPdf(r, w.downloadUrl, 'CORE'); for (const l of w.links || []) if (l.type === 'download') addPdf(r, l.url, 'CORE'); arxivPdfs(r);
    return r;
}
async function coreQuery(q, n) { const k = (await keys()).CORE_API_KEY; if (!k) return null; const j = await json(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(q)}&limit=${n}`, { headers: { Authorization: `Bearer ${k}` }, timeout: 40_000 }); return (j.results || []).map(fromCore); }
const coreSearch = (q, n, { year } = {}) => coreQuery(year ? `(${q}) AND yearPublished>=${year}` : q, n);
// IEEE Xplore (with a key): search only; its full text needs a subscription, so open copies come from the others.
async function ieeeSearch(q, n, { year } = {}) {
    const k = (await keys()).IEEE_API_KEY; if (!k) return null;
    const j = await json(`https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=${encodeURIComponent(q)}&max_records=${n}${year ? `&start_year=${year}` : ''}&apikey=${encodeURIComponent(k)}`);
    return (j.articles || []).map(a => rec({ title: decode(a.title), authors: (a.authors?.authors || []).map(x => x.full_name).filter(Boolean), year: String(a.publication_year || ''), venue: a.publication_title || '', doi: normDoi(a.doi), cites: a.citing_paper_count ?? null, abstract: a.abstract || '', landing: a.html_url || (a.doi ? `https://doi.org/${a.doi}` : ''), from: ['IEEE Xplore'] }));
}

function fromEpmc(x) {
    const r = rec({ title: decode(x.title), authors: String(x.authorString || '').split(/,\s*/).filter(Boolean).map(a => a.replace(/\.$/, '')), year: String(x.pubYear || ''), venue: x.journalInfo?.journal?.title || x.journalTitle || x.bookOrReportDetails?.publisher || '', doi: normDoi(x.doi), pmcid: x.pmcid || '', cites: x.citedByCount ?? null, abstract: decode(x.abstractText), landing: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.doi ? `https://doi.org/${x.doi}` : '', from: ['Europe PMC'] });
    for (const u of x.fullTextUrlList?.fullTextUrl || []) if (u.documentStyle === 'pdf' && u.availabilityCode === 'OA') addPdf(r, u.url, 'Europe PMC');
    if (r.pmcid) addPdf(r, `https://europepmc.org/articles/${r.pmcid}?pdf=render`, 'Europe PMC');
    return r;
}
async function epmcSearch(q, n, { year, oa } = {}) {
    let query = q; if (year) query += ` AND PUB_YEAR:[${year} TO ${new Date().getFullYear() + 1}]`; if (oa) query += ' AND OPEN_ACCESS:y';
    const j = await json(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${n}&resultType=core`);
    return (j.resultList?.result || []).map(fromEpmc);
}

// Several records of one paper (from different catalogues) become one, keeping every open copy found.
function keyOf(r) { return r.doi && !/^10\.48550\//.test(r.doi) ? `doi:${r.doi}` : r.arxiv ? `arxiv:${bareArxiv(r.arxiv)}` : r.doi ? `doi:${r.doi}` : `t:${normTitle(r.title).slice(0, 90)}`; }
function merge(a, b) {
    for (const k of ['title', 'year', 'venue', 'doi', 'arxiv', 'pmcid', 'openalex', 's2', 'landing']) if (!a[k] && b[k]) a[k] = b[k];
    if (!a.venue || a.venue === 'arXiv') a.venue = b.venue && b.venue !== 'arXiv' ? b.venue : a.venue;
    if (b.authors.length > a.authors.length) a.authors = b.authors;
    if ((b.abstract || '').length > (a.abstract || '').length) a.abstract = b.abstract;
    a.cites = Math.max(a.cites ?? -1, b.cites ?? -1); if (a.cites < 0) a.cites = null;
    for (const p of b.pdfs) addPdf(a, p.url, p.from); arxivPdfs(a);
    a.from = [...new Set([...a.from, ...b.from])]; a.oa = a.oa || b.oa; return a;
}
function mergeAll(lists) {
    const by = new Map(); const titles = new Map();
    lists.forEach(list => list.forEach((r, rank) => {
        const nt = normTitle(r.title).slice(0, 90); let k = keyOf(r);
        if (!by.has(k) && titles.has(nt) && nt.length > 20) k = titles.get(nt);
        const score = 1 / (rank + 2);
        if (by.has(k)) { const cur = by.get(k); merge(cur, r); cur.score += score; } else { by.set(k, { ...r, score }); }
        // a later record with a DOI can join one first seen by arXiv id
        const cur = by.get(k); for (const kk of [cur.doi && `doi:${cur.doi}`, cur.arxiv && `arxiv:${bareArxiv(cur.arxiv)}`].filter(Boolean)) if (kk !== k && by.has(kk) && by.get(kk) !== cur) { merge(cur, by.get(kk)); cur.score += by.get(kk).score; by.delete(kk); }
        if (nt.length > 20) titles.set(nt, k);
    }));
    return [...by.values()].map(r => ({ ...r, score: r.score + 0.06 * Math.log10(1 + (r.cites || 0)) + (r.pdfs.length ? 0.05 : 0) })).sort((x, y) => y.score - x.score);
}

export const ENGINES = { arxiv: arxivSearch, openalex: openalexSearch, s2: s2Search, europepmc: epmcSearch, core: coreSearch, ieee: ieeeSearch };
const ENGINE_NAME = { arxiv: 'arXiv', openalex: 'OpenAlex', s2: 'Semantic Scholar', europepmc: 'Europe PMC', core: 'CORE', ieee: 'IEEE Xplore' };
const pdir = topic => path.join(topic, '.platopypus', 'papers');
function saveResults(topic, query, results, kind = 'search') {
    const items = results.map((r, i) => ({ ref: `r${i + 1}`, ...r }));
    T.writeJson(path.join(pdir(topic), 'search.json'), { query, kind, at: Date.now(), items });
    try { fs.appendFileSync(path.join(pdir(topic), 'searches.log'), `${new Date().toISOString()}\t${kind}\t${query}\t${items.length}\n`); } catch { /* fine */ }
    return items;
}
export async function search(topic, query, { limit = 10, engines = Object.keys(ENGINES), year = null, oa = false } = {}) {
    const q = String(query || '').trim(); if (q.length < 3) throw T.httpError(400, 'Search for some words.');
    const n = Math.min(Math.max(Number(limit) || 10, 1), 25); const per = Math.min(n + 5, 25);
    const failed = [];
    const used = [];
    const lists = await Promise.all(engines.filter(e => ENGINES[e]).map(e => ENGINES[e](q, per, { year, oa }).then(l => { if (l) used.push(ENGINE_NAME[e]); return l || []; }, err => { failed.push(`${ENGINE_NAME[e]} (${err.message})`); return []; })));
    let res = mergeAll(lists); if (oa) res = res.filter(r => r.pdfs.length);
    T.bump(topic, { searches: 1 });
    return { items: saveResults(topic, q, res.slice(0, n)), failed, used };
}

// ---------- one paper: every open copy we can find ----------
function lastResults(topic) { return T.readJson(path.join(pdir(topic), 'search.json'), { items: [] }).items || []; }
async function titleLookup(title) {
    const lists = await Promise.all([openalexSearch(title, 5).catch(() => []), arxivSearch(`"${title.replace(/"/g, '')}"`, 3).catch(() => [])]);
    const want = normTitle(title); const all = mergeAll(lists);
    const close = all.find(r => { const t = normTitle(r.title); return t === want || (want.length > 25 && (t.startsWith(want) || want.startsWith(t))); });
    return close || null;
}
export async function resolve(topic, input) {
    const k = identify(input); let r = null;
    if (k.ref) { r = lastResults(topic).find(x => x.ref === k.ref); if (!r) throw T.httpError(404, `No ${k.ref} in the last search (research papers "…" first).`); r = rec({ ...r, pdfs: [...r.pdfs] }); }
    else if (k.arxiv) { r = (await arxivById([k.arxiv]).catch(() => []))[0] || rec({ arxiv: k.arxiv, title: `arXiv:${k.arxiv}` }); arxivPdfs(r); }
    else if (k.doi) { r = await openalexOne(`doi:${k.doi}`) || rec({ doi: k.doi, landing: `https://doi.org/${k.doi}` }); }
    else if (k.pmcid) { const j = await json(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID:${k.pmcid}&format=json&resultType=core`).catch(() => null); r = j?.resultList?.result?.[0] ? fromEpmc(j.resultList.result[0]) : rec({ pmcid: k.pmcid }); }
    else if (k.s2) { r = await s2One(k.s2) || rec({ s2: k.s2 }); }
    else if (k.title) { r = await titleLookup(k.title); if (!r) throw T.httpError(404, `No paper found titled "${clip(k.title, 80)}". Try research papers "${clip(k.title, 60)}" and pick one.`); }
    else r = rec({ landing: k.url });
    if (k.pdf) addPdf(r, k.pdf, new URL(k.pdf).hostname);
    // Fill gaps from the other catalogues: Semantic Scholar often knows an open PDF OpenAlex does not, and the reverse.
    if (r.doi && !r.from.includes('Semantic Scholar')) { const s = await s2One(`DOI:${r.doi}`); if (s) merge(r, s); }
    else if (r.arxiv && !r.from.includes('Semantic Scholar') && r.pdfs.length < 3) { const s = await s2One(`arXiv:${bareArxiv(r.arxiv)}`); if (s) merge(r, s); }
    if (r.doi && !r.from.includes('OpenAlex')) { const o = await openalexOne(`doi:${r.doi}`); if (o) merge(r, o); }
    if (r.arxiv && !r.from.includes('arXiv') && !r.title) { const a = (await arxivById([bareArxiv(r.arxiv)]).catch(() => []))[0]; if (a) merge(r, a); }
    if (r.doi && /^10\.1101\//.test(r.doi)) addPdf(r, `https://www.biorxiv.org/content/${r.doi}.full.pdf`, 'bioRxiv');
    if (r.doi && /^10\.(1007|1186|1140|1245|1617)\//.test(r.doi)) addPdf(r, `https://link.springer.com/content/pdf/${r.doi}.pdf`, 'Springer');
    // PubMed Central's open-access papers are also on its open-data bucket (Europe PMC's and NCBI's PDF links refuse scripts).
    if (r.pmcid) { for (const v of [1, 2, 3]) { try { const j = await json(`https://pmc-oa-opendata.s3.amazonaws.com/${r.pmcid}.${v}/${r.pmcid}.${v}.json`, { tries: 1 }); const u = String(j.pdf_url || '').replace(/^s3:\/\/pmc-oa-opendata\//, 'https://pmc-oa-opendata.s3.amazonaws.com/').replace(/\?md5=.*$/, ''); if (u.startsWith('https://')) r.pdfs.unshift({ url: u, from: 'PubMed Central' }); } catch { break; } } }
    const K = await keys();
    if (r.doi && K.UNPAYWALL_EMAIL) { try { const u = await json(`https://api.unpaywall.org/v2/${encodeURIComponent(r.doi)}?email=${encodeURIComponent(K.UNPAYWALL_EMAIL)}`); for (const l of [u.best_oa_location, ...(u.oa_locations || [])].filter(Boolean)) addPdf(r, l.url_for_pdf, `Unpaywall (${l.host_type || 'open copy'})`); } catch { /* not known */ } }
    if (K.CORE_API_KEY && (r.doi || r.title) && r.pdfs.length < 4) { try { const c = await coreQuery(r.doi ? `doi:"${r.doi}"` : `title:"${r.title.replace(/"/g, '')}"`, 3); const same = (c || []).find(x => (r.doi && x.doi === r.doi) || normTitle(x.title) === normTitle(r.title)); if (same) merge(r, same); } catch { /* CORE is slow at times */ } }
    if (k.url && !r.landing) r.landing = k.url;
    // Publisher and repository copies first, then arXiv (often the same paper, sometimes an earlier version).
    const rank = p => (/arxiv/i.test(p.from) ? 1 : 0); r.pdfs.sort((a, b) => rank(a) - rank(b));
    if (r.from.includes('arXiv') && r.venue === 'arXiv') r.pdfs.sort((a, b) => rank(b) - rank(a));
    return r;
}
// Publisher copies that need a key in a header: tried after the open ones.
async function keyedCopies(r) {
    const K = await keys(); const out = []; if (!r.doi) return out;
    if (K.ELSEVIER_API_KEY && /^10\.1016\//.test(r.doi)) out.push({ url: `https://api.elsevier.com/content/article/doi/${r.doi}?httpAccept=application/pdf`, from: 'Elsevier', headers: { 'X-ELS-APIKey': K.ELSEVIER_API_KEY, ...(K.ELSEVIER_INSTTOKEN ? { 'X-ELS-Insttoken': K.ELSEVIER_INSTTOKEN } : {}) }, firstPageOnly: true });
    if (K.WILEY_TDM_TOKEN && /^10\.(1002|1111)\//.test(r.doi)) out.push({ url: `https://api.wiley.com/onlinelibrary/tdm/v1/articles/${encodeURIComponent(r.doi)}`, from: 'Wiley', headers: { 'Wiley-TDM-Client-Token': K.WILEY_TDM_TOKEN } });
    return out;
}
async function fetchPdf(url, headers = {}) {
    const res = await http(url, { accept: 'application/pdf,*/*;q=0.5', timeout: 90_000, max: MAX_PDF, tries: 2, headers });
    if (res.buf.subarray(0, 1024).indexOf('%PDF-') === -1) throw T.httpError(415, /html/i.test(res.type) ? 'a web page, not the PDF (probably a login or cookie wall)' : `not a PDF (${res.type || 'unknown type'})`);
    return res;
}
// Full text without a PDF: Europe PMC's open XML, or arXiv's HTML rendering.
async function fullText(r) {
    if (r.pmcid) { try { const xml = (await http(`https://www.ebi.ac.uk/europepmc/webservices/rest/${r.pmcid}/fullTextXML`, { accept: 'application/xml', max: 20 * 1024 * 1024 })).buf.toString('utf8'); const x = `${(xml.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/) || [])[1] || ''}

${(xml.match(/<body>([\s\S]*?)<\/body>/) || [])[1] || ''}`; const body = x.replace(/<ref-list[\s\S]*?<\/ref-list>/g, '').replace(/<\/(p|title|sec)>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); if (body.length > 2000) return { text: body, from: 'Europe PMC full text' }; } catch { /* none */ } }
    const sk = (await keys()).SPRINGER_API_KEY;
    if (sk && r.doi && /^10\.(1007|1186|1038|1140|1245)\//.test(r.doi)) { try { const x = (await http(`https://api.springernature.com/openaccess/jats?q=doi:${encodeURIComponent(r.doi)}&api_key=${encodeURIComponent(sk)}`, { accept: 'application/xml', max: 20 * 1024 * 1024 })).buf.toString('utf8'); const b = (x.match(/<body>([\s\S]*?)<\/body>/) || [])[1] || ''; const body = b.replace(/<\/(p|title|sec)>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); if (body.length > 2000) return { text: body, from: 'Springer Nature open-access full text' }; } catch { /* not open access */ } }
    if (r.arxiv) { try { const h = (await http(`https://arxiv.org/html/${bareArxiv(r.arxiv)}`, { accept: 'text/html', max: 30 * 1024 * 1024 })).buf.toString('utf8'); const t = T.htmlToText(h).text; if (t.length > 2000) return { text: t, from: 'arXiv HTML' }; } catch { /* none */ } }
    return null;
}

// ---------- into the topic ----------
function already(topic, r) {
    const d = normDoi(r.doi), a = bareArxiv(r.arxiv).toLowerCase(), t = normTitle(r.title);
    return T.listSources(topic).find(m => (d && normDoi(m.doi) === d) || (a && bareArxiv(m.paper?.arxiv || '').toLowerCase() === a) || (t.length > 25 && normTitle(m.title) === t && m.paper));
}
function logRequest(topic, row) {
    const f = path.join(pdir(topic), 'requests.json'); const all = T.readJson(f, []) || []; all.push({ at: Date.now(), ...row });
    T.writeJson(f, all.slice(-500));
}
function bibFor(r) {
    const preprint = r.arxiv && (!r.venue || r.venue === 'arXiv' || /^10\.48550\//.test(r.doi) || !r.doi);
    return {
        title: r.title, author: r.authors.join(' and '), year: r.year,
        ...(preprint ? { journal: `arXiv preprint arXiv:${bareArxiv(r.arxiv)}`, doi: r.doi || `10.48550/arXiv.${bareArxiv(r.arxiv)}`, type: 'article' } : { journal: r.venue, doi: r.doi, ...(r.venue ? { type: 'article' } : {}) }),
        url: r.landing || (r.doi ? `https://doi.org/${r.doi}` : ''),
    };
}
export async function get(topic, input, { note = '', abstractOnly = true } = {}) {
    const r = await resolve(topic, input);
    const have = already(topic, r);
    if (have) { logRequest(topic, { input, title: r.title || have.title, status: 'exists', id: have.id }); return { status: 'exists', id: have.id, title: have.title, paper: r }; }
    const tmpDir = path.join(pdir(topic), 'tmp'); fs.mkdirSync(tmpDir, { recursive: true });
    const stem = (normTitle(r.title).split(' ').slice(0, 8).join('-') || 'paper').slice(0, 70);
    const tried = []; let added = null, how = '', from = '';
    const copies = [...r.pdfs.slice(0, 8), ...await keyedCopies(r)];
    for (const p of copies) {
        try {
            const res = await fetchPdf(p.url, p.headers); const f = path.join(tmpDir, `${stem}-${crypto.randomBytes(3).toString('hex')}.pdf`); fs.writeFileSync(f, res.buf);
            try { added = await T.addSource(topic, f, { note }); } finally { fs.rmSync(f, { force: true }); }
            // Elsevier answers with the first page only when you are not entitled to the article.
            if (p.firstPageOnly && (added.meta.pages || 0) <= 1) { fs.rmSync(path.join(T.sourcesDir(topic), added.meta.id), { recursive: true, force: true }); added = null; throw T.httpError(403, 'first page only: not entitled'); }
            how = 'pdf'; from = `${p.from}: ${p.headers ? p.url.replace(/[?&](api_?key|apikey)=[^&]+/i, '') : res.url}`; break;
        } catch (e) { tried.push(`${p.from} (${e.message})`); }
    }
    if (!added) {
        const ft = await fullText(r);
        const body = ft ? ft.text : abstractOnly && r.abstract ? `Abstract\n\n${r.abstract}\n\n(Only the abstract: no open copy of the full paper was found. Ask the user for the PDF, or upload it in the app.)` : null;
        if (!body) { logRequest(topic, { input, title: r.title, status: 'failed', tried }); return { status: 'failed', paper: r, tried }; }
        const f = path.join(tmpDir, `${stem}-${crypto.randomBytes(3).toString('hex')}.md`); fs.writeFileSync(f, `# ${r.title}\n\n${body}\n`);
        try { added = await T.addSource(topic, f, { note }); } finally { fs.rmSync(f, { force: true }); }
        how = ft ? 'fulltext' : 'abstract'; from = ft ? ft.from : (r.from[0] || 'catalogue');
    }
    // The record: from the catalogue, then the publisher's own BibTeX when there is a published DOI.
    const id = added.meta.id; const mf = path.join(T.sourcesDir(topic), id, 'meta.json'); const meta = T.readJson(mf);
    const bib = bibFor(r); const { type, ...fields } = bib; meta.title = ''; meta.author = ''; meta.year = '';
    T.setFields(meta, fields, 'catalog'); if (type) T.setFields(meta, { type }, 'catalog');
    if (how !== 'pdf') meta.kind = 'web';
    meta.url = bib.url || meta.url; meta.site = r.venue || meta.site || '';
    meta.paper = { arxiv: bareArxiv(r.arxiv), doi: r.doi, pmcid: r.pmcid, openalex: r.openalex, s2: r.s2, copy: how, from, cites: r.cites };
    meta.metaFrom = 'catalog'; delete meta.needsMeta; meta.from = { ...(meta.from || {}) };
    T.writeJson(mf, meta);
    if (r.doi && !/^10\.48550\//.test(r.doi)) await T.resolveDoi(topic, id, r.doi).catch(() => null); else T.syncBib(topic);
    const final = T.readJson(mf);
    logRequest(topic, { input, title: final.title, status: how === 'pdf' ? 'added' : how, id, from, tried });
    const text = (() => { try { return fs.readFileSync(path.join(T.sourcesDir(topic), id, 'text.md'), 'utf8'); } catch { return ''; } })();
    return { status: how === 'pdf' ? 'added' : how, id, title: final.title, from, tried, pages: final.pages || 0, summary: T.summaryOf(final, text), paper: r };
}

// ---------- following the trail: what a paper cites, and what cites it ----------
async function workOf(topic, input) {
    if (/^s\d{2,4}$/.test(String(input))) {
        const m = T.sourceMeta(topic, input); const p = m.paper || {};
        if (p.openalex) return openalexOne(p.openalex);
        if (m.doi) return openalexOne(`doi:${normDoi(m.doi)}`);
        if (p.arxiv) return openalexOne(`doi:10.48550/arxiv.${p.arxiv.toLowerCase()}`);
        if (m.title) return titleLookup(m.title).then(r => (r?.openalex ? openalexOne(r.openalex) : null));
        return null;
    }
    const r = await resolve(topic, input); return r.openalex ? openalexOne(r.openalex) : r.doi ? openalexOne(`doi:${r.doi}`) : null;
}
export async function related(topic, input, { citedBy = false, limit = 20 } = {}) {
    const w = await workOf(topic, input);
    if (!w?.openalex) throw T.httpError(404, 'That paper is not in OpenAlex, so its references are not known. Read its reference list instead (research find "References" --source <id>).');
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50); let items = [];
    if (citedBy) { const j = await json(await oax(`https://api.openalex.org/works?filter=cites:${w.openalex}&sort=cited_by_count:desc&per-page=${n}&select=${OA_FIELDS}`)); items = (j.results || []).map(fromOpenAlex); }
    else {
        const full = await json(await oax(`https://api.openalex.org/works/${w.openalex}?select=referenced_works`)).catch(() => ({}));
        const ids = (full.referenced_works || []).map(u => String(u).split('/').pop()).slice(0, 100);
        for (let i = 0; i < ids.length; i += 50) { const j = await json(await oax(`https://api.openalex.org/works?filter=openalex:${ids.slice(i, i + 50).join('|')}&per-page=50&select=${OA_FIELDS}`)); items.push(...(j.results || []).map(fromOpenAlex)); }
        items.sort((a, b) => (b.cites || 0) - (a.cites || 0)); items = items.slice(0, n);
    }
    return { of: w.title, items: saveResults(topic, `${citedBy ? 'cited by' : 'references of'}: ${w.title}`, items, citedBy ? 'cited-by' : 'references') };
}
export function requests(topic) { return T.readJson(path.join(pdir(topic), 'requests.json'), []) || []; }

// ---------- how the commands print them ----------
export function line(r) {
    const ids = [r.arxiv && `arXiv:${bareArxiv(r.arxiv)}`, r.doi && !/^10\.48550\//.test(r.doi) && `doi:${r.doi}`, r.pmcid].filter(Boolean).join('  ');
    return `${r.ref ? r.ref.padEnd(4) : ''}${r.pdfs.length ? '[PDF] ' : '[abs] '}${clip(r.title, 110)}${r.year ? ` (${r.year})` : ''}\n      ${clip(authorsLine(r.authors), 70) || 'authors unknown'}${r.venue ? `; ${clip(r.venue, 50)}` : ''}${r.cites != null ? `; cited ${r.cites}` : ''}${ids ? `\n      ${ids}` : ''}`;
}
export function printResults(items, { abstracts = false } = {}) {
    return items.map(r => line(r) + (abstracts && r.abstract ? `\n      ${clip(r.abstract, 320)}` : '')).join('\n');
}
