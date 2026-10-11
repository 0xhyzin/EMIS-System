import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createAuth } from '../routes/auth.js';
import { AuthStore } from '../utils/authStore.js';
import { hashOwnerPassword, ownerPasswordHashIsValid, verifyOwnerPassword, signCloudSession, verifyCloudSession } from '../utils/cloudSession.js';

const PASSWORD = 'fixture-only-owner-password-37!';
const PASSWORD_HASH = hashOwnerPassword(PASSWORD);
const SECRET = 'fixture-session-secret-32-characters-minimum';
const ORIGIN = 'https://school.example.invalid';
const PREVIEW = 'https://school-preview.example.invalid';
const CLOUD_ENV = { EMIS_CLOUD: 'true', APP_ORIGIN: ORIGIN, EMIS_PREVIEW_ORIGIN: PREVIEW,
    EMIS_OWNER_PASSWORD_HASH: PASSWORD_HASH, EMIS_SESSION_SECRET: SECRET };

function cookieOf(response) {
    const values = response.headers['set-cookie'];
    return (Array.isArray(values) ? values[0] : values)?.split(';')[0];
}

function cookieValue(cookie) { return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)); }

function fixture(t, { env = CLOUD_ENV, time = Date.now() } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'emis-cloud-auth-test-'));
    const events = [];
    let clock = time;
    let store, auth, app;
    const bridge = { browserPath: '/fixture/chromium',
        getStatus: () => ({ connected: true, schoolInfo: { schoolName: 'private-fixture-school' } }),
        open: async () => events.push('open'), disconnect: async () => events.push('disconnect'),
        close: async () => events.push('close'), getCredentials: async () => ({}) };
    function initialize() {
        store = new AuthStore(dir, { now: () => clock });
        auth = createAuth({ dataDir: dir, env, store, bridge, now: () => clock });
        app = express();
        app.use(express.json({ limit: '8kb' }));
        app.use('/api/auth', auth.router);
        app.get('/private', auth.requireSameOrigin, auth.requireAccess, (req, res) => res.json({ owner: req.auth.owner, local: req.auth.local, provider: req.auth.user.provider }));
        app.post('/owner', auth.requireSameOrigin, auth.requireOwner, (req, res) => res.json({ owner: req.auth.owner, local: req.auth.local }));
    }
    initialize();
    t.after(async () => { await auth.close(); rmSync(dir, { recursive: true, force: true }); });

    async function request(path, { method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
        const chunks = [];
        const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
        socket.remoteAddress = remoteAddress;
        const req = new IncomingMessage(socket);
        req.method = method; req.url = path; req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, ...headers };
        req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
        if (body !== undefined) {
            const bytes = Buffer.from(JSON.stringify(body));
            req.headers['content-type'] = 'application/json'; req.headers['content-length'] = String(bytes.length); req.push(bytes);
        }
        req.push(null); req.complete = true;
        const res = new ServerResponse(req); res.assignSocket(socket);
        await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); app(req, res); });
        const wire = Buffer.concat(chunks).toString();
        const responseBody = wire.slice(wire.indexOf('\r\n\r\n') + 4);
        return { status: res.statusCode, body: JSON.parse(responseBody), headers: res.getHeaders() };
    }
    return { request, events, bridge,
        get store() { return store; }, get auth() { return auth; }, get now() { return clock; },
        advance(ms) { clock += ms; },
        async restart() { await auth.close(); initialize(); },
        async login(options = {}) { return request('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, ...options }); },
    };
}

test('owner passwords use independently salted scrypt hashes and fail closed on malformed encodings', () => {
    const secondHash = hashOwnerPassword(PASSWORD);
    assert.notEqual(secondHash, PASSWORD_HASH);
    assert.equal(PASSWORD_HASH.includes(PASSWORD), false);
    assert.equal(ownerPasswordHashIsValid(PASSWORD_HASH), true);
    assert.equal(verifyOwnerPassword(PASSWORD, PASSWORD_HASH), true);
    assert.equal(verifyOwnerPassword(`${PASSWORD} `, PASSWORD_HASH), false);
    for (const password of [null, {}, '', 'a'.repeat(1025)]) assert.equal(verifyOwnerPassword(password, PASSWORD_HASH), false);
    for (const value of [null, '', PASSWORD, PASSWORD_HASH.replace('$32768$', '$1073741824$'), `${PASSWORD_HASH}=`, PASSWORD_HASH.replace('$v1$', '$v0$')]) {
        assert.equal(verifyOwnerPassword(PASSWORD, value), false);
    }
    assert.throws(() => hashOwnerPassword('short'));
});

test('signed cookies reject tampering, expired claims, weak secrets and invalid claim shapes', () => {
    const now = Date.now();
    const claim = { token: randomBytes(32).toString('base64url'), expiresAt: now + 1000 };
    const cookie = signCloudSession(claim, SECRET);
    assert.deepEqual(verifyCloudSession(cookie, SECRET, now), claim);
    assert.equal(verifyCloudSession(cookie, SECRET, claim.expiresAt), null);
    assert.equal(verifyCloudSession(cookie, `${SECRET}other`, now), null);
    assert.equal(verifyCloudSession(cookie, 'weak', now), null);
    const parts = cookie.split('.');
    const changed = Buffer.from(JSON.stringify({ ...claim, expiresAt: now + 99999999 })).toString('base64url');
    assert.equal(verifyCloudSession(`v1.${changed}.${parts[2]}`, SECRET, now), null);
    assert.equal(verifyCloudSession(`v2.${parts[1]}.${parts[2]}`, SECRET, now), null);
    assert.equal(verifyCloudSession(`${cookie}=`, SECRET, now), null);
    assert.equal(verifyCloudSession(`${cookie}.extra`, SECRET, now), null);
    assert.throws(() => signCloudSession(claim, 'weak'));
    assert.throws(() => signCloudSession({ ...claim, owner: true }, SECRET));
    assert.throws(() => signCloudSession({ ...claim, expiresAt: 'tomorrow' }, SECRET));
    const extraRole = Buffer.from(JSON.stringify({ ...claim, owner: true })).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(`v1.${extraRole}`).digest('base64url');
    assert.equal(verifyCloudSession(`v1.${extraRole}.${mac}`, SECRET, now), null);
});

test('cloud mode never grants implicit owner access to loopback or forwarded requests', async t => {
    const f = fixture(t);
    const status = await f.request('/api/auth/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { authenticated: false, localAccess: false, ownerAccess: false, cloudAccess: true, needsLogin: true, needsPairing: false, user: null });
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal((await f.request('/private')).status, 401);
    assert.equal((await f.request('/owner', { method: 'POST' })).status, 401);
    assert.equal((await f.request('/private', { headers: { host: 'localhost', origin: 'http://localhost' } })).status, 403);
    assert.equal((await f.request('/private', { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' } })).status, 401);
    assert.equal((await f.request('/api/auth/microsoft/start', { method: 'POST' })).status, 401);
    assert.equal(f.events.includes('open'), false);
});

test('owner login creates a secure signed persistent session; plain, forged and revoked cookies cannot access data', async t => {
    const f = fixture(t);
    assert.equal((await f.login({ body: { password: 'wrong-password' } })).status, 401);
    const loggedIn = await f.login();
    assert.equal(loggedIn.status, 200);
    const setCookie = [].concat(loggedIn.headers['set-cookie'])[0];
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=2592000/);
    const cookie = cookieOf(loggedIn);
    const claim = verifyCloudSession(cookieValue(cookie), SECRET, f.now);
    assert.ok(claim);
    assert.equal(f.store.getSession(claim.token).user.provider, 'cloud-owner');
    assert.deepEqual((await f.request('/private', { headers: { cookie } })).body, { owner: true, local: false, provider: 'cloud-owner' });
    assert.equal((await f.request('/private', { headers: { cookie: `emis_session=${claim.token}` } })).status, 401);
    assert.equal((await f.request('/private', { headers: { cookie: `${cookie.slice(0, -2)}zz` } })).status, 401);
    const stranger = signCloudSession({ token: randomBytes(32).toString('base64url'), expiresAt: claim.expiresAt }, SECRET);
    assert.equal((await f.request('/private', { headers: { cookie: `emis_session=${stranger}` } })).status, 401);
    await f.restart();
    assert.equal((await f.request('/owner', { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal(verifyCloudSession(cookieValue(cookie), SECRET, f.now)?.token, claim.token);
    assert.equal((await f.request('/private', { headers: { cookie } })).status, 401);
    assert.equal(f.events.includes('disconnect'), false);
});

test('canonical and explicit preview origins are isolated; same-site, foreign hosts and wrong origins fail', async t => {
    const f = fixture(t);
    for (const headers of [
        { origin: 'https://evil.invalid' }, { host: 'evil.invalid', origin: 'https://evil.invalid' },
        { origin: PREVIEW }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    ]) assert.equal((await f.login({ headers })).status, 403);
    const previewHeaders = { host: new URL(PREVIEW).host, origin: PREVIEW, 'sec-fetch-site': 'same-origin' };
    const login = await f.login({ headers: previewHeaders });
    assert.equal(login.status, 200);
    const cookie = cookieOf(login);
    const status = await f.request('/api/auth/status', { headers: { ...previewHeaders, cookie } });
    assert.equal(status.body.phoneUrl, PREVIEW);
    assert.equal(status.body.ownerAccess, true);
    assert.equal((await f.request('/owner', { method: 'POST', headers: { ...previewHeaders, origin: ORIGIN, cookie } })).status, 403);
});

test('paired cloud sessions are signed but never owners, and owner logout is device-only', async t => {
    const f = fixture(t);
    const ownerCookie = cookieOf(await f.login());
    const owner2Cookie = cookieOf(await f.login());
    const pairing = await f.request('/api/auth/pairing/start', { method: 'POST', headers: { cookie: ownerCookie } });
    assert.equal((await f.request('/api/auth/pairing/complete', { method: 'POST', body: { code: pairing.body.code } })).status, 400);
    const paired = await f.request('/api/auth/pairing/complete', { method: 'POST', body: { code: pairing.body.code, proof: pairing.body.proof } });
    assert.equal((await f.request('/api/auth/pairing/complete', { method: 'POST', body: { code: pairing.body.code, proof: pairing.body.proof } })).status, 400);
    const pairedCookie = cookieOf(paired);
    assert.ok(verifyCloudSession(cookieValue(pairedCookie), SECRET, f.now));
    assert.deepEqual((await f.request('/private', { headers: { cookie: pairedCookie } })).body, { owner: false, local: false, provider: 'paired' });
    for (const path of ['/owner', '/api/auth/microsoft/start', '/api/auth/microsoft/disconnect', '/api/auth/pairing/start']) {
        assert.equal((await f.request(path, { method: 'POST', headers: { cookie: pairedCookie } })).status, 403);
    }
    const start = await f.request('/api/auth/microsoft/start', { method: 'POST', headers: { cookie: ownerCookie } });
    assert.equal(start.body.browserView, true);
    assert.equal(f.events.includes('open'), true);
    await f.request('/api/auth/logout', { method: 'POST', headers: { cookie: ownerCookie } });
    assert.equal((await f.request('/private', { headers: { cookie: pairedCookie } })).status, 200);
    assert.equal((await f.request('/owner', { method: 'POST', headers: { cookie: owner2Cookie } })).status, 200);
    assert.equal(f.events.includes('disconnect'), false);
    const pending = await f.request('/api/auth/pairing/start', { method: 'POST', headers: { cookie: owner2Cookie } });
    await f.request('/api/auth/microsoft/disconnect', { method: 'POST', headers: { cookie: owner2Cookie } });
    assert.equal(f.events.includes('disconnect'), true);
    assert.equal((await f.request('/private', { headers: { cookie: pairedCookie } })).status, 401);
    assert.equal((await f.request('/owner', { method: 'POST', headers: { cookie: owner2Cookie } })).status, 401);
    assert.equal((await f.request('/api/auth/pairing/complete', { method: 'POST', body: { code: pending.body.code } })).status, 400);
});

test('cloud login throttling persists across restart and expires; sessions expire after 30 days', async t => {
    const f = fixture(t);
    for (let i = 0; i < 10; i++) assert.equal((await f.login({ body: { password: 'incorrect' } })).status, 401);
    await f.restart();
    assert.equal((await f.login()).status, 429);
    f.advance(5 * 60_000 + 1);
    const login = await f.login();
    assert.equal(login.status, 200);
    const cookie = cookieOf(login);
    f.advance(30 * 24 * 60 * 60_000 + 1);
    assert.equal((await f.request('/private', { headers: { cookie } })).status, 401);
});

test('local mode keeps implicit local owner behavior and disables password login', async t => {
    const f = fixture(t, { env: { APP_ORIGIN: ORIGIN } });
    const localHeaders = { host: 'localhost', origin: 'http://localhost' };
    const status = await f.request('/api/auth/status', { headers: localHeaders });
    assert.equal(status.body.authenticated, true); assert.equal(status.body.localAccess, true); assert.equal(status.body.cloudAccess, false);
    assert.equal(status.body.ownerAccess, true);
    assert.equal((await f.request('/owner', { method: 'POST', headers: localHeaders })).status, 200);
    assert.equal((await f.login({ headers: localHeaders })).status, 404);
    assert.equal((await f.request('/private', { remoteAddress: '192.168.1.2' })).status, 401);
});

test('cloud configuration refuses missing secrets, invalid password hashes and HTTP', () => {
    const bridge = { close: async () => {} };
    const store = {};
    for (const env of [
        { ...CLOUD_ENV, EMIS_SESSION_SECRET: '' },
        { ...CLOUD_ENV, EMIS_OWNER_PASSWORD_HASH: PASSWORD },
        { ...CLOUD_ENV, APP_ORIGIN: undefined },
        { ...CLOUD_ENV, APP_ORIGIN: 'http://school.example.invalid', ALLOW_INSECURE_LAN: 'true' },
        { ...CLOUD_ENV, EMIS_PREVIEW_ORIGIN: 'http://localhost:3000' },
    ]) assert.throws(() => createAuth({ env, store, bridge }));
});
