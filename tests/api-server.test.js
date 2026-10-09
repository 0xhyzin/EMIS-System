import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { closeDatabase } from '../db/database.js';
import { APP_VERSION } from '../public/js/appVersion.js';

let app, dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-server-test-')); app = createApp({ dataDir: dir }); });
afterEach(async () => { await app.locals.auth.close(); closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });

async function request(path, { method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.remoteAddress = remoteAddress;
    const req = new IncomingMessage(socket);
    req.method = method; req.url = path; req.headers = { host: 'localhost', ...headers };
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    if (body !== undefined) {
        const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        req.headers['content-type'] ||= 'application/json'; req.headers['content-length'] = String(bytes.length); req.push(bytes);
    }
    req.push(null);
    // A real HTTP parser marks the whole message complete before body parsing
    // ends. Otherwise IncomingMessage treats end-of-stream as an aborted request
    // and destroys this fake socket before an asynchronous handler can respond.
    req.complete = true;
    const res = new ServerResponse(req); res.assignSocket(socket);
    await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); app(req, res); });
    const wire = Buffer.concat(chunks).toString();
    const bodyStart = wire.indexOf('\r\n\r\n') + 4;
    return { status: res.statusCode, body: wire.slice(bodyStart), headers: res.getHeaders() };
}

test('full app allows local CRUD while guarding remote and external-origin access', async () => {
    assert.equal((await request('/api/employees/count')).status, 200);
    assert.equal((await request('/api/employees', { method: 'POST', body: { fullName: 'موظف اختبار التطبيق' } })).status, 201);
    const saved = await request('/api/employees');
    assert.equal(JSON.parse(saved.body).length, 1); assert.equal(saved.headers['cache-control'], 'no-store');
    assert.equal((await request('/api/employees', { headers: { origin: 'https://external.invalid' } })).status, 403);
    assert.equal((await request('/api/employees', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/employees', { remoteAddress: '192.0.2.10' })).status, 401);
    assert.equal((await request('/api/employees', { headers: { host: 'untrusted.invalid' } })).status, 403);
    assert.equal((await request('/api/auth/tokens')).status, 404);
});

test('app JSON error handling rejects malformed requests without exposing internals', async () => {
    const malformed = await request('/api/employees', { method: 'POST', body: '{broken' });
    assert.equal(malformed.status, 400); assert.match(JSON.parse(malformed.body).error, /صيغة/);
    assert.equal(malformed.body.includes('SyntaxError'), false);
});

test('unified-email reads and writes reject unpaired and external-origin callers before ministry access', async () => {
    const path = '/api/employees/101/unified-email';
    const body = { field: 'mobile', value: '01012345678', previousValue: '', expectedEmpCode: 101 };
    for (const method of ['GET', 'PATCH']) {
        const options = { method, ...(method === 'PATCH' ? { body } : {}) };
        const remote = await request(path, { ...options, remoteAddress: '192.0.2.10' });
        assert.equal(remote.status, 401); assert.equal(JSON.parse(remote.body).needsPairing, true);
        assert.equal((await request(path, { ...options, headers: { origin: 'https://external.invalid' } })).status, 403);
        assert.equal((await request(path, { ...options, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    }
});

test('local unified-email requests reach the protected route and missing employees cannot trigger remote changes', async () => {
    const body = { field: 'altEmail', value: 'fixture@example.invalid', previousValue: '', expectedEmpCode: 101 };
    for (const method of ['GET', 'PATCH']) {
        const result = await request('/api/employees/101/unified-email', { method, ...(method === 'PATCH' ? { body } : {}) });
        assert.equal(result.status, 404); assert.match(JSON.parse(result.body).error, /الموظف غير موجود/);
        assert.equal(result.headers['cache-control'], 'no-store');
    }
});

test('public version check identifies editor and safe sync contract before pairing or mutations', async () => {
    const result = await request('/api/version', { remoteAddress: '192.0.2.10' });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { version: APP_VERSION, completeEmployeeEditor: true, syncModes: ['normal','full'] });
    assert.equal(result.headers['cache-control'], 'no-store');
});

test('an explicit phone origin is shared by the host guard and authentication middleware', async () => {
    await app.locals.auth.close(); closeDatabase();
    app = createApp({ dataDir: dir, appOrigin: 'https://school.example.invalid' });
    const options = { remoteAddress: '192.0.2.10', headers: { host: 'school.example.invalid', origin: 'https://school.example.invalid' } };
    const status = await request('/api/auth/status', options);
    assert.equal(status.status, 200); assert.equal(JSON.parse(status.body).needsPairing, true);
    assert.equal((await request('/api/employees', options)).status, 401);
});
