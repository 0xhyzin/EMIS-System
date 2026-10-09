import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import defaultHandler, { createVercelHandler } from '../vercel-entry.js';
import { APP_VERSION } from '../public/js/appVersion.js';

const publicHost = 'school.vercel.app';
const configured = { EMIS_BACKEND_ORIGIN: 'https://persistent.example', EMIS_PROXY_SECRET: 'server-owned-secret' };

async function listen(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return server.address().port;
}

function request(port, path = '/', { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: publicHost, ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function fixtureTransport(port, inspect = () => {}) {
    return (options, callback) => {
        inspect(options);
        assert.equal(options.protocol, 'https:');
        assert.equal(options.hostname, 'persistent.example');
        return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port }, callback);
    };
}

test('default handler imports and responds from a read-only directory without loading or writing desktop stores', () => {
    assert.equal(typeof defaultHandler, 'function');
    const dir = mkdtempSync(join(tmpdir(), 'emis-vercel-readonly-'));
    const entry = new URL('../vercel-entry.js', import.meta.url).href;
    const loader = `export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'node:sqlite' || /(?:^|\\/)server\\.js$|(?:^|\\/)db\\//.test(specifier)) throw new Error('Desktop import forbidden');
        return nextResolve(specifier, context);
    }`;
    const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        for (const method of ['mkdirSync','writeFileSync','appendFileSync','chmodSync','renameSync']) fs[method] = () => { throw new Error('Write forbidden'); };
        syncBuiltinESMExports();
        const { default: handler } = await import(${JSON.stringify(entry)});
        if (typeof handler !== 'function') throw new Error('Missing default handler');
        for (const [method,url,expected] of [['GET','/',200],['POST','/api/employees',503],['GET','/api/deployment/status',200]]) {
            handler({ method,url }, { writeHead(status) { if(status !== expected) throw new Error('Unexpected status'); }, end() {} });
        }`;
    try {
        chmodSync(dir, 0o555);
        const result = spawnSync(process.execPath, [`--experimental-loader=data:text/javascript,${encodeURIComponent(loader)}`, '--input-type=module', '-e', source], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, DATA_DIR: join(dir, 'school-data'), EMIS_BACKEND_ORIGIN: '', EMIS_PROXY_SECRET: '' },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(readdirSync(dir), []);
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test('unconfigured deployment serves an honest setup page and blocks all data actions', async t => {
    const port = await listen(t, createVercelHandler({ env: {} }));
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.body, /الموقع في مرحلة تجهيز الاستضافة/);
    assert.match(page.body, /خادم بيانات المدرسة الدائم غير متصل بعد/);
    assert.doesNotMatch(page.body, /<(?:button|form|script)\b/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const head = await request(port, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], page.headers['content-length']);
    const status = await request(port, '/api/deployment/status');
    assert.deepEqual(JSON.parse(status.body), { ready: false, version: APP_VERSION });
    for (const [method, path] of [['GET', '/api/employees'], ['POST', '/api/employees'], ['DELETE', '/api/employees/1'], ['POST', '/api/auth/pairing/complete']]) {
        const body = method === 'GET' ? '' : '{"fullName":"fixture"}';
        const response = await request(port, path, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body });
        assert.equal(response.status, 503);
        assert.equal(JSON.parse(response.body).code, 'BACKEND_NOT_CONFIGURED');
    }
});

test('fallback has no file-serving surface and rejects traversal, absolute URLs and malformed paths', async t => {
    const port = await listen(t, createVercelHandler({ env: {} }));
    for (const path of ['/../data/school.db', '/%2e%2e/auth.key', '/assets/%2e%2e/auth.sqlite', '/assets/%5c..%5cauth.key', '//other.example/path', '/%zz']) {
        assert.equal((await request(port, path)).status, 400, path);
    }
    for (const path of ['/data/school.db', '/auth.key', '/assets/logo.png', '/css/style.css', '/vercel-entry.js']) {
        const response = await request(port, path);
        assert.equal(response.status, 404, path);
        assert.doesNotMatch(response.body, /SQLite|BEGIN|EMIS_PROXY_SECRET/);
    }
});

test('only a complete strict HTTPS origin and secret enable transport; invalid settings fail safely', async t => {
    for (const env of [
        {}, { ...configured, EMIS_PROXY_SECRET: '' }, { ...configured, EMIS_PROXY_SECRET: 'secret\nheader' },
        ...['http://persistent.example', 'https://user:pass@persistent.example', 'https://persistent.example/path', 'https://persistent.example/?key=secret', 'https://persistent.example/#secret', '//persistent.example', ' https://persistent.example'].map(EMIS_BACKEND_ORIGIN => ({ ...configured, EMIS_BACKEND_ORIGIN })),
    ]) {
        const port = await listen(t, createVercelHandler({ env, requestImpl: () => { assert.fail('Invalid configuration opened transport'); } }));
        const response = await request(port, '/api/employees');
        assert.equal(response.status, 503);
        assert.doesNotMatch(response.body, /persistent\.example|server-owned-secret|secret/);
    }
});

test('proxy streams request bodies, preserves paired cookies and exports, and replaces untrusted forwarding headers', async t => {
    const exportBody = Buffer.from('PK\u0003\u0004fixture-report');
    let received;
    const upstreamPort = await listen(t, (req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            received = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
            res.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': 'attachment; filename="report.docx"',
                'Set-Cookie': ['emis_session=new-session; Domain=persistent.example; Path=/; Secure; HttpOnly; SameSite=Strict', 'other=value; Path=/; Secure'],
                'Connection': 'x-remove-response', 'X-Remove-Response': 'private-hop',
            });
            res.end(exportBody);
        });
    });
    const port = await listen(t, createVercelHandler({ env: configured, requestImpl: fixtureTransport(upstreamPort) }));
    const payload = '{"employees":[1,2]}';
    const response = await request(port, '/api/export?format=word', { method: 'POST', body: payload, headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie: 'emis_session=existing-session',
        'x-emis-proxy-secret': 'visitor-secret', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost',
        'x-forwarded-proto': 'http', forwarded: 'for=127.0.0.1;host=localhost', connection: 'x-remove-request', 'x-remove-request': 'private-hop',
        'x-vercel-protection-bypass': 'vercel-account-secret', 'x-vercel-set-bypass-cookie': 'true',
    } });
    assert.equal(response.status, 200);
    assert.equal(response.body, exportBody.toString());
    assert.equal(response.headers['content-disposition'], 'attachment; filename="report.docx"');
    assert.equal(response.headers['x-remove-response'], undefined);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.headers['set-cookie'], ['emis_session=new-session; Path=/; Secure; HttpOnly; SameSite=Strict', 'other=value; Path=/; Secure']);
    assert.equal(received.body, payload);
    assert.equal(received.url, '/api/export?format=word');
    assert.equal(received.headers.cookie, 'emis_session=existing-session');
    assert.equal(received.headers.host, publicHost);
    assert.equal(received.headers['x-forwarded-host'], publicHost);
    assert.equal(received.headers['x-forwarded-proto'], 'https');
    assert.equal(received.headers['x-emis-proxy-secret'], configured.EMIS_PROXY_SECRET);
    assert.equal(received.headers.forwarded, undefined);
    assert.equal(received.headers['x-remove-request'], undefined);
    assert.equal(received.headers['x-vercel-protection-bypass'], undefined);
    assert.equal(received.headers['x-vercel-set-bypass-cookie'], undefined);
});

test('proxy rewrites backend redirects without disclosing the configured private origin', async t => {
    const upstreamPort = await listen(t, (req, res) => {
        res.writeHead(302, { Location: `${configured.EMIS_BACKEND_ORIGIN}/login?next=%2Fapi#done`, Refresh: `0; url=${configured.EMIS_BACKEND_ORIGIN}/login` });
        res.end();
    });
    const port = await listen(t, createVercelHandler({ env: configured, requestImpl: fixtureTransport(upstreamPort) }));
    const response = await request(port);
    assert.equal(response.headers.location, `https://${publicHost}/login?next=%2Fapi#done`);
    assert.equal(response.headers.refresh, undefined);
});

test('proxy delivers SSE chunks before completion instead of buffering the response', async t => {
    let finished = false;
    const upstreamPort = await listen(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write('data: first\n\n');
        const timer = setTimeout(() => { finished = true; res.end('data: last\n\n'); }, 60);
        res.on('close', () => clearTimeout(timer));
    });
    const port = await listen(t, createVercelHandler({ env: configured, requestImpl: fixtureTransport(upstreamPort) }));
    await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/api/assistant/chat', headers: { host: publicHost } }, res => {
            let first = true;
            let body = '';
            res.on('data', chunk => {
                if (first) { assert.equal(finished, false); first = false; }
                body += chunk;
            });
            res.on('end', () => { assert.equal(body, 'data: first\n\ndata: last\n\n'); resolve(); });
            res.on('error', reject);
        }).on('error', reject);
    });
});

test('transport errors and timeouts return the same safe 502 without internal URLs or secrets', async t => {
    const brokenPort = await listen(t, createVercelHandler({ env: configured, requestImpl: () => { throw new Error('secret persistent.example internal'); } }));
    const hangingUpstream = await listen(t, () => {});
    const timeoutPort = await listen(t, createVercelHandler({ env: configured, requestImpl: fixtureTransport(hangingUpstream), timeoutMs: 20 }));
    for (const port of [brokenPort, timeoutPort]) {
        const response = await request(port, '/api/employees');
        assert.equal(response.status, 502);
        assert.equal(JSON.parse(response.body).code, 'BACKEND_UNAVAILABLE');
        assert.doesNotMatch(response.body, /secret|persistent\.example|Error|stack/);
    }
});

test('malformed upstream headers become a safe 502 instead of crashing invocation', async t => {
    const port = await listen(t, createVercelHandler({ env: configured, requestImpl: (options, callback) => {
        const upstream = new PassThrough();
        process.nextTick(() => {
            const response = Readable.from(['internal details']);
            response.statusCode = 200;
            response.headers = { 'x-invalid': 'bad\nsecret' };
            callback(response);
        });
        return upstream;
    } }));
    const response = await request(port, '/api/employees');
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).code, 'BACKEND_UNAVAILABLE');
    assert.doesNotMatch(response.body, /internal|secret/);
});
