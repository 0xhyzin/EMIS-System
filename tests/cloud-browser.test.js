import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MinistryBridge, MINISTRY_PORTAL, officialBrowserOrigin, validateBrowserInput, credentialsFromAcceptedResponse } from '../utils/authMinistry.js';
import { createCloudBrowserRouter } from '../routes/cloudBrowser.js';

function fixture(t, { cloudMode = true } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'emis-cloud-browser-'));
    const values = new Map();
    const store = { getSecret: key => values.get(key) || null, putSecret: (key, value) => values.set(key, value), deleteSecret: key => values.delete(key) };
    const calls = [];
    class Page extends EventEmitter {
        constructor(url = MINISTRY_PORTAL) { super(); this.address = url; this.closed = false; }
        url() { return this.address; }
        isClosed() { return this.closed; }
        async goto(url) { this.address = url; calls.push(['goto', url]); }
        async reload() { calls.push(['reload']); }
        async goBack() { calls.push(['back']); }
        async bringToFront() {}
        async screenshot(options) { calls.push(['frame', options]); return Buffer.from('fixture-jpeg'); }
        mouse = { click: async (x, y) => calls.push(['click', x, y]), wheel: async (x, y) => calls.push(['wheel', x, y]) };
        keyboard = { press: async key => calls.push(['press', key]), insertText: async text => calls.push(['text', text]) };
        close() { this.closed = true; this.emit('close'); }
    }
    const page = new Page();
    const context = new EventEmitter();
    context.pageList = [page];
    context.pages = () => context.pageList;
    context.newPage = async () => { const created = new Page('about:blank'); context.pageList.push(created); context.emit('page', created); return created; };
    context.route = async (pattern, handler) => { context.navigation = handler; };
    context.close = async () => context.emit('close');
    const launcher = { launchPersistentContext: async (profile, options) => { calls.push(['launch', profile, options]); return context; } };
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/chromium', launcher, cloudMode });
    t.after(async () => { await bridge.close(); rmSync(dataDir, { recursive: true, force: true }); });
    return { bridge, store, values, calls, page, context, Page };
}

test('hosted login uses a fixed viewport and denies arbitrary main-page navigation', async t => {
    const { bridge, calls, context } = fixture(t);
    await bridge.open();
    const options = calls.find(call => call[0] === 'launch')[2];
    assert.equal(options.headless, false);
    assert.deepEqual(options.viewport, { width: 1000, height: 760 });
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.serviceWorkers, 'block');
    for (const [url, nested, expected] of [
        ['https://login.microsoftonline.com/common/oauth2/authorize?secret=fixture', false, 'continue'],
        ['https://teacher.emis.gov.eg.evil.test/', false, 'abort'],
        ['file:///etc/passwd', false, 'abort'],
        ['http://127.0.0.1:3000/', false, 'abort'],
        ['https://aadcdn.msauth.net/asset.js', true, 'continue'],
    ]) {
        let decision;
        await context.navigation({ request: () => ({ isNavigationRequest: () => true, frame: () => ({ parentFrame: () => nested ? {} : null }), url: () => url }),
            abort: async () => { decision = 'abort'; }, continue: async () => { decision = 'continue'; } });
        assert.equal(decision, expected);
    }
    assert.match(bridge.getStatus().message, /أكمل تسجيل الدخول/);
    assert.equal(/الكمبيوتر/.test(bridge.getStatus().message), false);
});

test('only official HTTPS origins are disclosed and a Microsoft popup becomes the active view', async t => {
    const { bridge, context, page, Page } = fixture(t);
    await bridge.open();
    const popup = new Page('https://login.microsoftonline.com/common/login?code=fixture-secret#token=fixture');
    context.pageList.push(popup);
    context.emit('page', popup);
    assert.deepEqual(bridge.getBrowserState(), { available: true, origin: 'https://login.microsoftonline.com', status: 'waiting', width: 1000, height: 760 });
    assert.equal(JSON.stringify(bridge.getBrowserState()).includes('fixture-secret'), false);
    popup.close();
    assert.equal(bridge.page, page);
    page.address = 'https://evil.test/?token=fixture';
    assert.equal(bridge.getBrowserState().origin, null);
    assert.equal(bridge.getBrowserState().available, false);
    await assert.rejects(bridge.screenshot(), error => error.statusCode === 409);
    await assert.rejects(bridge.input({ action: 'text', text: 'private-password' }), error => error.statusCode === 409);
    for (const url of ['https://login.microsoftonline.com.evil.test/', 'https://x:secret@login.microsoftonline.com/', 'http://teacher.emis.gov.eg/', 'javascript:alert(1)', 'about:blank']) assert.equal(officialBrowserOrigin(url), null);
});

test('remote input is narrowly validated, bounded and never written to the credential store', async t => {
    const { bridge, calls, values } = fixture(t);
    await bridge.open();
    await bridge.input({ action: 'click', x: 400, y: 300 });
    await bridge.input({ action: 'text', text: 'private-fixture-password' });
    await bridge.input({ action: 'press', key: 'Enter' });
    await bridge.input({ action: 'wheel', deltaX: 0, deltaY: 600 });
    assert.deepEqual(calls.filter(call => ['click', 'text', 'press', 'wheel'].includes(call[0])), [
        ['click', 400, 300], ['text', 'private-fixture-password'], ['press', 'Enter'], ['wheel', 0, 600],
    ]);
    assert.equal(JSON.stringify([...values]).includes('private-fixture-password'), false);
    assert.equal(Object.values(bridge).includes('private-fixture-password'), false);
    for (const invalid of [
        { action: 'navigate', url: 'https://evil.test/' }, { action: 'eval', script: 'fixture' },
        { action: 'click', x: 1000, y: 0 }, { action: 'click', x: -1, y: 2 },
        { action: 'text', text: 'x'.repeat(2001) }, { action: 'text', text: '\u0000' },
        { action: 'press', key: 'Control+L' }, { action: 'press', key: 'F12' },
        { action: 'portal', url: 'https://evil.test/' }, { action: 'wheel', deltaX: 0, deltaY: Infinity },
    ]) assert.throws(() => validateBrowserInput(invalid), error => error.statusCode === 400);
});

test('frame calls are coalesced and the queue rejects a flood while browser operations are pending', async t => {
    const { bridge, page } = fixture(t);
    await bridge.open();
    let finish;
    let frames = 0;
    page.screenshot = async () => { frames++; return new Promise(resolve => { finish = resolve; }); };
    const first = bridge.screenshot();
    const second = bridge.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames, 1);
    const queued = Array.from({ length: 11 }, () => bridge.input({ action: 'press', key: 'Tab' }));
    await assert.rejects(bridge.input({ action: 'press', key: 'Tab' }), error => error.statusCode === 429);
    finish(Buffer.from('jpeg'));
    assert.equal((await first).toString(), 'jpeg');
    assert.equal((await second).toString(), 'jpeg');
    await Promise.all(queued);
    assert.equal(bridge.pendingBrowserOperations, 0);
});

test('closing the cloud view retains saved credentials and the dedicated browser profile', async t => {
    const { bridge, store } = fixture(t);
    store.putSecret('ministry', { bearerToken: 'fixture', utToken: 'fixture', schoolInfo: { sc: '123' }, expiresAt: Date.now() + 3_600_000 });
    await bridge.open();
    const state = await bridge.closeView();
    assert.equal(state.available, false);
    assert.equal(state.status, 'connected');
    assert.equal(store.getSecret('ministry').bearerToken, 'fixture');
    assert.equal(bridge.cleanupRequired, false);
    assert.match(bridge.getStatus().message, /الاستضافة/);
});

test('a restored cloud profile renews only through a newly accepted official response', async t => {
    const { bridge, page, store } = fixture(t);
    const jwt = payload => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
    const headers = { Authorization: `Bearer ${jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })}`,
        Ut: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, UserTypes: 4, userData: Buffer.from(JSON.stringify({ UserLoginData: [{ SchoolCode: 123, EdaraCode: 45 }] })).toString('base64') }), Sc: '123', Ed: '45', Ty: '4' };
    const url = 'https://professopi.emis.gov.eg/api/Employee/GetEmployeeByEmpFlag';
    const fresh = credentialsFromAcceptedResponse(url, 200, headers);
    assert.ok(fresh);
    store.putSecret('ministry', { ...fresh, expiresAt: 1 });
    page.goto = async value => {
        page.address = value;
        await bridge.handleResponse({ url: () => url, status: () => 200, request: () => ({ allHeaders: async () => headers }), json: async () => ({ data: [] }) });
    };
    page.reload = () => page.goto(MINISTRY_PORTAL);
    assert.equal((await bridge.getCredentials()).bearerToken, fresh.bearerToken);
    assert.equal(bridge.getStatus().connected, true);
});

test('local browser behavior keeps its desktop viewport and never exposes a hosted view', async t => {
    const { bridge, calls } = fixture(t, { cloudMode: false });
    await bridge.open();
    assert.equal(calls.find(call => call[0] === 'launch')[2].viewport, null);
    assert.equal(bridge.getBrowserState().available, false);
    await assert.rejects(bridge.screenshot(), error => error.statusCode === 404);
    assert.match(bridge.getStatus().message, /أكمل تسجيل الدخول/);
});

async function routerFixture(t) {
    const calls = [];
    const bridge = { cloudMode: true, getBrowserState: () => ({ available: true, origin: 'https://teacher.emis.gov.eg', width: 1000, height: 760, status: 'waiting' }),
        screenshot: async () => { calls.push('frame'); return Buffer.from('jpeg-fixture'); },
        input: async body => { calls.push(body.action); return { success: true }; }, closeView: async () => { calls.push('close'); return { available: false }; } };
    const auth = {
        requireSameOrigin: (req, res, next) => req.headers.origin && req.headers.origin !== 'https://school.test' ? res.status(403).json({ error: 'origin' }) : next(),
        requireAccess: (req, res, next) => !req.headers.authorization ? res.status(401).json({ error: 'session' }) : next(),
        requireOwner: (req, res, next) => req.headers.authorization !== 'owner-fixture' ? res.status(403).json({ error: 'owner' }) : next(),
    };
    const app = express();
    app.use('/api/auth/browser', createCloudBrowserRouter({ auth, bridge }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const call = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/browser${path}`, { ...options, headers: { authorization: 'owner-fixture', ...options.headers } });
    return { call, calls, bridge };
}

test('all browser routes reject anonymous, paired and cross-origin callers before touching Chromium', async t => {
    const { call, calls } = await routerFixture(t);
    for (const [path, method] of [['/state', 'GET'], ['/frame', 'GET'], ['/input', 'POST'], ['/close', 'POST']]) {
        const unauthorized = await call(path, { method, headers: { authorization: '' } });
        assert.equal(unauthorized.status, 401);
        const paired = await call(path, { method, headers: { authorization: 'paired-fixture' } });
        assert.equal(paired.status, 403);
        const crossOrigin = await call(path, { method, headers: { origin: 'https://evil.test' } });
        assert.equal(crossOrigin.status, 403);
    }
    assert.deepEqual(calls, []);
});

test('owner frames are JPEG with no caching; body and command limits reject malformed inputs', async t => {
    const { call, calls, bridge } = await routerFixture(t);
    const frame = await call('/frame');
    assert.equal(frame.status, 200);
    assert.match(frame.headers.get('content-type'), /image\/jpeg/);
    assert.equal(frame.headers.get('cache-control'), 'no-store');
    assert.equal(await frame.text(), 'jpeg-fixture');
    for (const body of [{ action: 'text', text: 'x'.repeat(2001) }, { action: 'navigate', url: 'https://evil.test' }]) {
        const response = await call('/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 400);
    }
    const oversized = await call('/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'text', text: 'x'.repeat(9000) }) });
    assert.equal(oversized.status, 413);
    const malformed = await call('/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fixture-password":' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes('fixture-password'), false);
    bridge.screenshot = async () => { throw new Error('fixture-secret-url?token=private'); };
    const failed = await call('/frame');
    assert.equal(failed.status, 503);
    assert.equal((await failed.text()).includes('fixture-secret-url'), false);
    assert.deepEqual(calls, ['frame']);
});
