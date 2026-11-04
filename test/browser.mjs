// Headless browser probe, run by CI after the smoke suite (which leaves a password-only box behind).
// Catches what the API suite cannot: app.js failing to evaluate (the 1.1.x blank page), uncaught errors while
// rendering each tab, and stale asset stamping.
//   BASE=http://127.0.0.1:7332 PASSWORD=smoke-password-12345 node test/browser.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:7332';
const PASSWORD = process.env.PASSWORD || 'smoke-password-12345';
const problems = [];
let checks = 0;
const check = (name, ok, extra = '') => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) problems.push(name); };

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 401/.test(m.text())) errors.push(`console: ${m.text()}`); });

await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(1500);
const version = await page.getAttribute('meta[name="porthole-version"]', 'content');
check('page carries a version stamp', /^\d+\.\d+\.\d+$/.test(version || ''), version);
const stamped = await page.$$eval('script[src], link[rel=stylesheet]', els => els.map(e => e.getAttribute('src') || e.getAttribute('href')).filter(u => /app\.js|styles\.css/.test(u)));
check('app.js and styles.css are version-stamped', stamped.length >= 2 && stamped.every(u => u.includes(`v=${version}`)), stamped.join(' '));
const probe = await page.evaluate(async () => { try { await import(`/app.js?probe=${Date.now()}`); return null; } catch (e) { return String(e); } });
check('app.js evaluates as a module', probe === null, probe || '');

// Sign in with the smoke password, then render every tab.
const login = await page.evaluate(async (password) => {
    const r = await fetch('/api/login/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Porthole': '1' }, body: JSON.stringify({ password }) });
    return r.status;
}, PASSWORD);
check('password sign-in works from the browser', login === 200, String(login));
await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(1500);
for (const tab of ['home', 'shells', 'services', 'files', 'more']) {
    const before = errors.length;
    await page.click(`.tabs [data-go="${tab}"]`);
    await page.waitForTimeout(1200);
    const visible = await page.isVisible(`#tab-${tab}`);
    const text = (await page.textContent(`#tab-${tab}`) || '').trim();
    check(`${tab} tab renders without errors`, visible && text.length > 10 && errors.length === before, errors.slice(before).join(' | ').slice(0, 300));
}
await page.screenshot({ path: process.env.SHOT || 'browser-probe.png', fullPage: false });

// Desktop: the sidebar replaces the bottom tabs, collapses with the hamburger, pages open in the content area,
// dialogs open as a side panel and confirmations stay centred.
{
    const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    desk.on('pageerror', e => errors.push(`desktop pageerror: ${e.message}`));
    await desk.goto(BASE + '/', { waitUntil: 'load' });
    await desk.evaluate(async (password) => { await fetch('/api/login/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Porthole': '1' }, body: JSON.stringify({ password }) }); }, PASSWORD);
    await desk.goto(BASE + '/', { waitUntil: 'load' }); await desk.waitForTimeout(1500);
    const nav = await desk.evaluate(() => { const r = document.querySelector('.tabs').getBoundingClientRect(); return { x: r.x, w: r.width, h: r.height, expanded: document.body.classList.contains('nav-expanded') }; });
    check('desktop: a full-height sidebar on the left', nav.x === 0 && nav.w > 200 && nav.h > 800 && nav.expanded, JSON.stringify(nav));
    const before = errors.length;
    for (const tab of ['home', 'shells', 'services', 'files', 'more']) { await desk.click(`.tabs [data-go="${tab}"]`); await desk.waitForTimeout(700); }
    check('desktop: every section opens from the sidebar', errors.length === before && await desk.isVisible('#tab-more'), errors.slice(before).join(' | ').slice(0, 200));
    await desk.click('.tabs [data-nav-page="vault"]'); await desk.waitForTimeout(700);
    const pg = await desk.evaluate(() => document.querySelector('#page-vault').getBoundingClientRect().x);
    check('desktop: More pages open beside the sidebar', await desk.isVisible('#page-vault') && pg >= 240, String(pg));
    await desk.click('#nav-burger'); await desk.waitForTimeout(400);
    const rail = await desk.evaluate(() => ({ w: document.querySelector('.tabs').getBoundingClientRect().width, kept: localStorage.getItem('porthole.rail') }));
    check('desktop: the hamburger collapses the sidebar to a rail and remembers it', rail.w < 100 && rail.kept === '1', JSON.stringify(rail));
    await desk.click('#nav-burger'); await desk.waitForTimeout(300);
    await desk.click('.tabs [data-go="services"]'); await desk.waitForTimeout(700);
    await desk.click('#services-new'); await desk.waitForTimeout(500);
    const dp = await desk.evaluate(() => { const r = document.querySelector('.dialog-panel').getBoundingClientRect(); return { right: Math.round(window.innerWidth - r.right), h: Math.round(r.height) }; });
    check('desktop: dialogs open as a side panel', dp.right === 0 && dp.h >= 880, JSON.stringify(dp));
    await desk.keyboard.press('Escape'); await desk.waitForTimeout(200);
    check('desktop: Escape closes the panel', await desk.isHidden('#dialog'));
    await desk.screenshot({ path: (process.env.SHOT || 'browser-probe.png').replace(/\.png$/, '-desktop.png') });
}
check('no uncaught errors overall', errors.length === 0, errors.join(' | ').slice(0, 500));
await browser.close();

if (problems.length) { console.log(`\n${problems.length} of ${checks} browser checks failed`); process.exit(1); }
console.log(`\nall ${checks} browser checks passed`);
