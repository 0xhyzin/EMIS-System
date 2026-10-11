import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createVercelHandler } from '../vercel-entry.js';
import { hashOwnerPassword, signCloudSession, signCloudPairing } from '../utils/cloudSession.js';

const password = 'a-school-test-password-only';
const env = { EMIS_CLOUD: 'true', APP_ORIGIN: 'https://school.vercel.app', EMIS_SANDBOX_NAME: 'fixture', EMIS_SESSION_SECRET: 's'.repeat(48), EMIS_PROXY_SECRET: 'p'.repeat(48), EMIS_OWNER_PASSWORD_HASH: hashOwnerPassword(password) };
async function listen(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return server.address().port;
}
async function call(port, path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'school.vercel.app', origin: env.APP_ORIGIN, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
        });
        req.on('error', reject); req.end(data);
    });
}
test('public cloud shell, status and rejected logins never wake compute or expose private files', async t => {
    let starts = 0;
    const port = await listen(t, createVercelHandler({ env, resolveBackend: async () => { starts++; throw new Error('Should not wake'); } }));
    const page = await call(port, '/');
    assert.equal(page.status, 200); assert.match(page.body, /2\.10\.1/);
    assert.equal((await call(port, '/js/cloudBrowser.js')).status, 200);
    assert.equal(JSON.parse((await call(port, '/api/auth/status')).body).needsLogin, true);
    assert.equal((await call(port, '/api/employees')).status, 401);
    assert.equal((await call(port, '/data/school.db')).status, 401);
    assert.equal((await call(port, '/%2e%2e/.env.local')).status, 400);
    assert.equal((await call(port, '/api/auth/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
    assert.equal((await call(port, '/api/auth/login', { method: 'POST', body: { password }, headers: { origin: 'https://evil.invalid' } })).status, 403);
    assert.equal(starts, 0);
});
test('valid owner login forwards original JSON exactly once and restores public host through an authenticated header', async t => {
    let received;
    const upstream = await listen(t, (req, res) => {
        const chunks = []; req.on('data', value => chunks.push(value));
        req.on('end', () => { received = { headers: req.headers, body: Buffer.concat(chunks).toString() }; res.setHeader('Set-Cookie', 'emis_session=fixture; Path=/; Secure; HttpOnly'); res.end('{"success":true}'); });
    });
    let starts = 0;
    const handler = createVercelHandler({ env, resolveBackend: async () => { starts++; return { origin: 'https://fixture.vercel.run', secret: env.EMIS_PROXY_SECRET }; }, requestImpl: (options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: upstream }, callback) });
    // Vercel can detach the request socket after consuming the login body.
    const port = await listen(t, (req, res) => handler(new Proxy(req, { get(target, key) { if (key === 'socket') return null; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }), res));
    const response = await call(port, '/api/auth/login', { method: 'POST', body: { password }, headers: { 'x-emis-public-host': 'localhost', 'x-emis-proxy-secret': 'attacker' } });
    assert.equal(response.status, 200); assert.equal(starts, 1);
    assert.deepEqual(JSON.parse(received.body), { password });
    assert.equal(received.headers.host, 'fixture.vercel.run');
    assert.equal(received.headers['x-emis-public-host'], 'school.vercel.app');
    assert.equal(received.headers['x-emis-proxy-secret'], env.EMIS_PROXY_SECRET);
    assert.equal(response.headers['cache-control'], 'private, no-store');
});
test('only unexpired signed sessions or a code-specific pairing proof wake compute', async t => {
    let starts = 0;
    const port = await listen(t, createVercelHandler({ env, resolveBackend: async () => { starts++; throw new Error('Synthetic unavailable backend'); } }));
    const signed = signCloudSession({ token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 10000 }, env.EMIS_SESSION_SECRET);
    assert.equal((await call(port, '/api/employees', { headers: { cookie: `emis_session=${signed}` } })).status, 503);
    assert.equal((await call(port, '/api/employees', { headers: { cookie: `emis_session=${signed}z` } })).status, 401);
    const code = '12345678', proof = signCloudPairing(code, Date.now() + 60000, env.EMIS_SESSION_SECRET);
    assert.equal((await call(port, '/api/auth/pairing/complete', { method: 'POST', body: { code: '12345679', proof } })).status, 401);
    assert.equal((await call(port, '/api/auth/pairing/complete', { method: 'POST', body: { code, proof } })).status, 503);
    assert.equal(starts, 2);
});
