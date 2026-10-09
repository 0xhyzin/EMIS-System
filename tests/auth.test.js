import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { AuthStore } from '../utils/authStore.js';
import { createAuth, requestIsLocal } from '../routes/auth.js';
import { MinistryBridge, credentialsAreFresh, credentialsFromAcceptedResponse } from '../utils/authMinistry.js';

const jwt = payload => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
function fixtureHeaders(now = Date.now(), lifetime = 3600) {
    return {
        Authorization: `Bearer ${jwt({ exp: Math.floor(now / 1000) + lifetime })}`,
        Ut: jwt({ exp: Math.floor(now / 1000) + lifetime, UserTypes: 4,
            userData: Buffer.from(JSON.stringify({ UserLoginData: [{ SchoolCode: 123, EdaraCode: 45 }] })).toString('base64') }),
        Sc: '123', Ed: '45', Ty: '4',
    };
}
const acceptedUrl = 'https://professopi.emis.gov.eg/api/Employee/GetEmployeeByEmpFlag';

function temporaryStore(t, now = () => Date.now()) {
    const dataDir = mkdtempSync(join(tmpdir(), 'emis-auth-test-'));
    const store = new AuthStore(dataDir, { now });
    t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
    return { dataDir, store };
}

test('durable sessions are hashed and expire; ministry secrets are encrypted at rest', t => {
    let now = 1000;
    const { dataDir, store } = temporaryStore(t, () => now);
    const session = store.createSession({ name: 'fixture' }, 1000);
    store.putSecret('ministry', { bearerToken: 'SECRET-FIXTURE-BEARER', utToken: 'SECRET-FIXTURE-UT' });
    const reopened = new AuthStore(dataDir, { now: () => now });
    assert.equal(reopened.getSession(session.token).user.name, 'fixture');
    assert.equal(reopened.getSecret('ministry').bearerToken, 'SECRET-FIXTURE-BEARER');
    const bytes = readFileSync(join(dataDir, 'auth.sqlite'));
    assert.equal(bytes.includes(Buffer.from(session.token)), false);
    assert.equal(bytes.includes(Buffer.from('SECRET-FIXTURE-BEARER')), false);
    now = 2001;
    assert.equal(reopened.getSession(session.token), null);
    reopened.close();
});

test('pairing codes expire, are single use and are replaced by a new code', t => {
    let now = 1000;
    const { store } = temporaryStore(t, () => now);
    store.createPairing('12345678', 1000);
    assert.equal(store.consumePairing('12345678'), true);
    assert.equal(store.consumePairing('12345678'), false);
    store.createPairing('12345678', 1000);
    store.createPairing('87654321', 1000);
    assert.equal(store.consumePairing('12345678'), false);
    now = 2001;
    assert.equal(store.consumePairing('87654321'), false);
});

test('only successful exact Ministry employee responses with fresh school credentials are eligible', () => {
    const now = 1_700_000_000_000;
    const headers = fixtureHeaders(now);
    const credentials = credentialsFromAcceptedResponse(acceptedUrl, 200, headers, now);
    assert.equal(credentials.schoolInfo.sc, '123');
    assert.equal(credentialsAreFresh(credentials, now), true);
    assert.equal(credentialsAreFresh(credentials, now + 3_600_000), false);
    for (const url of [
        'https://professopi.emis.gov.eg.evil.test/api/Employee/GetEmployeeByEmpFlag',
        'http://professopi.emis.gov.eg/api/Employee/GetEmployeeByEmpFlag',
        'https://graph.microsoft.com/v1.0/me',
        'https://professopi.emis.gov.eg/api/Auth/Login',
    ]) assert.equal(credentialsFromAcceptedResponse(url, 200, headers, now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 401, headers, now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, fixtureHeaders(now, -1), now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, { ...headers, Sc: '999' }, now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, { ...headers, Ed: '999' }, now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, { ...headers, Ty: '999' }, now), null);
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, { ...headers, Sc: '00123' }, now).schoolInfo.sc, '00123');
    assert.equal(credentialsFromAcceptedResponse(acceptedUrl, 200, { ...headers, Authorization: 'Bearer opaque' }, now), null);
});

test('capture requires actual employee result; errors with HTTP 200 do not establish connection', async t => {
    const { dataDir, store } = temporaryStore(t);
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser' });
    const response = body => ({ url: () => acceptedUrl, status: () => 200,
        request: () => ({ allHeaders: async () => fixtureHeaders() }), json: async () => body });
    await bridge.handleResponse(response({ error: 'not authorized' }));
    assert.equal(store.getSecret('ministry'), null);
    await bridge.handleResponse(response({ success: false, data: [] }));
    assert.equal(store.getSecret('ministry'), null);
    await bridge.handleResponse(response({ succeeded: false, data: [] }));
    assert.equal(store.getSecret('ministry'), null);
    await bridge.handleResponse({ ...response({ basicInfo: {} }), url: () => acceptedUrl.replace('GetEmployeeByEmpFlag', 'GetEmployeeFullData') });
    assert.equal(store.getSecret('ministry'), null);
    await bridge.handleResponse(response({ data: [] }));
    assert.equal(bridge.getStatus().connected, true);
    assert.equal((await bridge.getCredentials()).schoolInfo.sc, '123');
});

test('expired credentials never reopen the browser unexpectedly; open portal can renew once', async t => {
    const now = Date.now();
    const { dataDir, store } = temporaryStore(t);
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser' });
    const fresh = credentialsFromAcceptedResponse(acceptedUrl, 200, fixtureHeaders(now), now);
    store.putSecret('ministry', { ...fresh, expiresAt: now - 1 });
    await assert.rejects(bridge.getCredentials(), error => error.statusCode === 401);
    assert.equal(bridge.getStatus().status, 'expired');
    let reloads = 0;
    bridge.context = {};
    bridge.page = { isClosed: () => false, reload: async () => {
        reloads++;
        store.putSecret('ministry', fresh);
        bridge.emit('credentials', fresh);
    } };
    const [first, second] = await Promise.all([bridge.getCredentials(), bridge.getCredentials()]);
    assert.equal(first.bearerToken, fresh.bearerToken);
    assert.equal(second.utToken, fresh.utToken);
    assert.equal(reloads, 1);
    bridge.invalidate();
    assert.equal(bridge.getStatus().connected, false);
    assert.equal(bridge.getStatus().status, 'expired');
});

test('a pending browser response cannot restore credentials after disconnect', async t => {
    const { dataDir, store } = temporaryStore(t);
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser' });
    let finish;
    const body = new Promise(resolve => { finish = resolve; });
    const capture = bridge.handleResponse({ url: () => acceptedUrl, status: () => 200,
        request: () => ({ allHeaders: async () => fixtureHeaders() }), json: () => body });
    await bridge.disconnect();
    finish({ data: [] });
    await capture;
    assert.equal(store.getSecret('ministry'), null);
    assert.equal(bridge.getStatus().connected, false);
});

test('login opens the real portal in a dedicated visible browser profile and uses its own button', async t => {
    const { dataDir, store } = temporaryStore(t);
    const calls = [];
    const listeners = new Map();
    const page = { isClosed: () => false, url: () => 'https://teacher.emis.gov.eg/login',
        goto: async url => calls.push(['goto', url]),
        getByRole: (role, options) => ({ click: async () => calls.push(['button', role, options.name.test('تسجيل الدخول بحساب ميكروسوفت')]) }),
        bringToFront: async () => calls.push(['front']) };
    const context = { pages: () => [page], on: (event, listener) => listeners.set(event, listener),
        close: async () => { calls.push(['close']); listeners.get('close')?.(); } };
    const launcher = { launchPersistentContext: async (profile, options) => {
        calls.push(['launch', profile, options]); return context;
    } };
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/chrome', launcher });
    await Promise.all([bridge.open(), bridge.open()]);
    assert.equal(calls.filter(call => call[0] === 'launch').length, 1);
    assert.equal(calls[0][1], join(dataDir, 'ministry-browser'));
    assert.equal(calls[0][2].headless, false);
    assert.equal(calls[0][2].executablePath, '/fixture/chrome');
    assert.deepEqual(calls.find(call => call[0] === 'goto'), ['goto', 'https://teacher.emis.gov.eg/']);
    assert.deepEqual(calls.find(call => call[0] === 'button'), ['button', 'button', true]);
    assert.equal(bridge.getStatus().connected, false);
    assert.equal(bridge.getStatus().status, 'waiting');
    await bridge.disconnect();
    assert.equal(bridge.context, null);
});

test('browser responses emitted during closing cannot restore a signed-out account', async t => {
    const { dataDir, store } = temporaryStore(t);
    const listeners = new Map();
    let finishBody;
    const body = new Promise(resolve => { finishBody = resolve; });
    const page = { isClosed: () => false, url: () => 'https://teacher.emis.gov.eg/',
        goto: async () => {}, bringToFront: async () => {} };
    const context = { pages: () => [page], on: (event, listener) => listeners.set(event, listener),
        close: async () => {
            listeners.get('response')({ url: () => acceptedUrl, status: () => 200,
                request: () => ({ allHeaders: async () => fixtureHeaders() }), json: () => body });
            listeners.get('close')();
        } };
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser',
        launcher: { launchPersistentContext: async () => context } });
    await bridge.open();
    await bridge.disconnect();
    finishBody({ data: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.getSecret('ministry'), null);
    assert.equal(bridge.getStatus().connected, false);
});

test('failed browser cleanup still revokes ministry credentials and blocks reconnect until cleanup succeeds', async t => {
    const { dataDir, store } = temporaryStore(t);
    const bridge = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser' });
    store.putSecret('ministry', credentialsFromAcceptedResponse(acceptedUrl, 200, fixtureHeaders()));
    let canClose = false;
    bridge.context = { close: async () => { if (!canClose) throw new Error('fixture cleanup failure'); } };
    await assert.rejects(bridge.disconnect(), error => error.statusCode === 503);
    assert.equal(store.getSecret('ministry'), null);
    assert.equal(bridge.getStatus().connected, false);
    assert.equal(bridge.getStatus().status, 'error');
    const restarted = new MinistryBridge({ dataDir, store, browserPath: '/fixture/browser' });
    assert.equal(restarted.cleanupRequired, true);
    assert.equal(restarted.getStatus().status, 'error');
    await assert.rejects(restarted.getCredentials(), error => error.statusCode === 503);
    await assert.rejects(bridge.open(), error => error.statusCode === 503);
    await bridge.handleResponse({ url: () => acceptedUrl, status: () => 200,
        request: () => ({ allHeaders: async () => fixtureHeaders() }), json: async () => ({ data: [] }) });
    assert.equal(store.getSecret('ministry'), null);
    canClose = true;
    await bridge.disconnect();
    assert.equal(bridge.context, null);
    assert.equal(bridge.cleanupRequired, false);
    assert.equal(store.getSecret('ministry-cleanup'), null);
});

test('localhost checks reject DNS rebinding and forwarded proxy requests', () => {
    const request = (host, remoteAddress, extra = {}) => ({ headers: { host, ...extra }, socket: { remoteAddress } });
    assert.equal(requestIsLocal(request('localhost:3000', '127.0.0.1')), true);
    assert.equal(requestIsLocal(request('[::1]:3000', '::1')), true);
    assert.equal(requestIsLocal(request('attacker.test:3000', '127.0.0.1')), false);
    assert.equal(requestIsLocal(request('localhost:3000', '192.168.1.9')), false);
    assert.equal(requestIsLocal(request('localhost:3000', '127.0.0.1', { 'x-forwarded-for': '203.0.113.1' })), false);
});

test('network data requires paired cookie; origin, login control and brute-force gates apply', async t => {
    const { dataDir, store } = temporaryStore(t);
    const bridge = { browserPath: '/fixture/browser', getStatus: () => ({ connected: true, schoolInfo: { schoolName: 'PRIVATE FIXTURE' } }),
        open: async () => {}, disconnect: async () => {}, getCredentials: async () => {}, close: async () => {} };
    const auth = createAuth({ dataDir, store, bridge, env: { APP_ORIGIN: 'https://school.test' } });
    const app = express.Router();
    app.use('/api/auth', auth.router);
    app.get('/api/employees', auth.requireSameOrigin, auth.requireAccess, (req, res) => res.json({ records: ['fixture'] }));
    // Invoke the real Express router without opening a socket (works in a network sandbox).
    const call = (path, options = {}) => new Promise((resolve, reject) => {
        const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
        headers.host ||= 'localhost:3000';
        const req = { method: options.method || 'GET', url: path, headers,
            socket: { remoteAddress: headers.host === 'localhost:3000' ? '127.0.0.1' : '192.168.1.5' },
            body: options.body ? JSON.parse(options.body) : {} };
        const responseHeaders = new Map();
        const result = { status: 200, headers: responseHeaders, cookieOptions: null };
        const res = {
            setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); return this; },
            status(code) { result.status = code; return this; },
            json(body) { result.json = async () => body; resolve(result); return this; },
            cookie(name, token, cookieOptions) { result.cookieOptions = cookieOptions; responseHeaders.set('set-cookie', `${name}=${token}`); return this; },
            clearCookie(name, cookieOptions) { result.cookieOptions = cookieOptions; responseHeaders.set('set-cookie', `${name}=`); return this; },
        };
        app.handle(req, res, error => error ? reject(error) : reject(new Error('Unmatched test route')));
    });
    const remoteHeaders = { Host: 'school.test', Origin: 'https://school.test', 'Content-Type': 'application/json' };
    assert.equal((await call('/api/employees', { headers: remoteHeaders })).status, 401);
    assert.equal((await call('/api/employees', { headers: { Host: 'evil.test' } })).status, 403);
    const status = await (await call('/api/auth/status', { headers: remoteHeaders })).json();
    assert.equal(status.needsPairing, true);
    assert.equal(status.ministry, undefined);
    assert.equal((await call('/api/auth/microsoft/start', { method: 'POST', headers: remoteHeaders })).status, 403);
    assert.equal((await call('/api/auth/pairing/start', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await call('/api/employees', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await call('/api/auth/pairing/start', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    const pairing = await (await call('/api/auth/pairing/start', { method: 'POST' })).json();
    const paired = await call('/api/auth/pairing/complete', { method: 'POST', headers: remoteHeaders, body: JSON.stringify({ code: pairing.code }) });
    assert.equal(paired.status, 200);
    const setCookie = paired.headers.get('set-cookie');
    assert.equal(paired.cookieOptions.httpOnly, true);
    assert.equal(paired.cookieOptions.secure, true);
    assert.equal(paired.cookieOptions.sameSite, 'strict');
    const cookie = setCookie.split(';')[0];
    assert.equal((await call('/api/employees', { headers: { ...remoteHeaders, Cookie: cookie } })).status, 200);
    assert.equal((await call('/api/auth/pairing/complete', { method: 'POST', headers: remoteHeaders, body: JSON.stringify({ code: pairing.code }) })).status, 400);
    await call('/api/auth/logout', { method: 'POST', headers: { ...remoteHeaders, Cookie: cookie } });
    assert.equal((await call('/api/employees', { headers: { ...remoteHeaders, Cookie: cookie } })).status, 401);
    for (let i = 0; i < 9; i++) await call('/api/auth/pairing/complete', { method: 'POST', headers: remoteHeaders, body: '{"code":"wrong"}' });
    assert.equal((await call('/api/auth/pairing/complete', { method: 'POST', headers: remoteHeaders, body: '{"code":"wrong"}' })).status, 429);
    const pendingCode = await (await call('/api/auth/pairing/start', { method: 'POST' })).json();
    const otherDevice = store.createSession({ provider: 'paired' });
    await call('/api/auth/logout', { method: 'POST' });
    assert.equal(store.getSession(otherDevice.token), null);
    assert.equal(store.consumePairing(pendingCode.code), false);
    const failingLogoutSession = store.createSession({ provider: 'paired' });
    const failingLogoutCode = await (await call('/api/auth/pairing/start', { method: 'POST' })).json();
    bridge.disconnect = async () => { throw Object.assign(new Error('fixture cleanup failure'), { statusCode: 503 }); };
    assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 503);
    assert.equal(store.getSession(failingLogoutSession.token), null);
    assert.equal(store.consumePairing(failingLogoutCode.code), false);
    const failingDisconnectSession = store.createSession({ provider: 'paired' });
    assert.equal((await call('/api/auth/microsoft/disconnect', { method: 'POST' })).status, 503);
    assert.equal(store.getSession(failingDisconnectSession.token), null);
});
