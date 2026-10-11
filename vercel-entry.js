import { request as httpsRequest } from 'node:https';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { APP_VERSION } from './public/js/appVersion.js';
import { verifyCloudSession, verifyOwnerPassword, verifyCloudPairing } from './utils/cloudSession.js';
import { createCloudRuntime } from './utils/cloudRuntime.js';

// This gateway deliberately does not load the desktop server or its local stores.
const setupPage = readFileSync(new URL('./public/cloud-setup.html', import.meta.url));
const publicDir = realpathSync(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const unavailable = { error: 'الاستضافة لم تُربط بخادم بيانات دائم بعد.', code: 'BACKEND_NOT_CONFIGURED' };
const proxyFailure = { error: 'تعذر الاتصال بخادم المدرسة. حاول مرة أخرى لاحقًا.', code: 'BACKEND_UNAVAILABLE' };
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function backendConfiguration(env) {
    const origin = env.EMIS_BACKEND_ORIGIN;
    const secret = env.EMIS_PROXY_SECRET;
    if (typeof origin !== 'string' || typeof secret !== 'string' || !secret || !/^[\x21-\x7e]{1,1024}$/.test(secret)) return null;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
            || ![url.origin, `${url.origin}/`].includes(origin)) return null;
        return { url, secret };
    } catch { return null; }
}

function filteredHeaders(headers) {
    const blocked = new Set(hopHeaders);
    for (const name of String(headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function safePath(requestUrl) {
    if (typeof requestUrl !== 'string' || !requestUrl.startsWith('/') || requestUrl.startsWith('//') || requestUrl.includes('#')) return null;
    try {
        const path = decodeURIComponent(requestUrl.split('?')[0]);
        if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return null;
        return path;
    } catch { return null; }
}

function send(req, res, status, body, contentType = 'application/json; charset=utf-8') {
    req.resume?.();
    const content = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        ...(contentType.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : content);
}

function sessionCookie(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('emis_session='));
    return cookie?.slice('emis_session='.length);
}
function staticFile(path, req, res) {
    if (!['GET', 'HEAD'].includes(req.method) || path.split('/').some(part => part.startsWith('.'))) return false;
    try {
        const target = realpathSync(join(publicDir, path === '/' ? 'index.html' : path));
        if (!target.startsWith(publicDir + sep) || !statSync(target).isFile()) return false;
        const extension = target.slice(target.lastIndexOf('.'));
        if (!mime[extension]) return false;
        const buffer = readFileSync(target);
        res.writeHead(200, { 'Content-Type': mime[extension], 'Content-Length': buffer.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
        res.end(req.method === 'HEAD' ? undefined : buffer);
        return true;
    } catch { return false; }
}
async function readLoginBody(req) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2048) throw new Error('Login body too large');
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    return { body, data: JSON.parse(body.toString('utf8')) };
}

export function createVercelHandler({ env = process.env, requestImpl = httpsRequest, timeoutMs = 120_000, resolveBackend } = {}) {
    const configuredBackend = backendConfiguration(env);
    const cloud = env.EMIS_CLOUD === 'true';
    const runtime = cloud ? createCloudRuntime({ env }) : null;
    const loginFailures = new Map();
    return async function handler(req, res) {
        const path = safePath(req.url);
        if (path === null) return send(req, res, 400, { error: 'المسار غير صحيح.' });
        let backend = configuredBackend;
        let loginBody;
        if (cloud) {
            const allowed = [env.APP_ORIGIN, env.EMIS_PREVIEW_ORIGIN].filter(Boolean).map(origin => new URL(origin).host);
            if (!allowed.includes(req.headers.host)) return send(req, res, 403, { error: 'عنوان الموقع غير مسموح.' });
            const origin = req.headers.origin;
            if ((origin && origin !== `https://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(req, res, 403, { error: 'الطلب يجب أن يأتي من نفس الموقع.' });
            const session = verifyCloudSession(sessionCookie(req), env.EMIS_SESSION_SECRET);
            if (!(path === '/assets/logo.png' && session) && staticFile(path, req, res)) return;
            if (path === '/api/version' && ['GET', 'HEAD'].includes(req.method)) return send(req, res, 200, { version: APP_VERSION, completeEmployeeEditor: true, syncModes: ['normal', 'full'] });
            if (!session) {
                if (path === '/api/auth/status' && ['GET', 'HEAD'].includes(req.method)) return send(req, res, 200, { authenticated: false, cloudAccess: true, localAccess: false, ownerAccess: false, needsLogin: true, needsPairing: false, user: null });
                if (!['/api/auth/login', '/api/auth/pairing/complete'].includes(path) || req.method !== 'POST') return send(req, res, 401, { error: 'سجّل الدخول لفتح بيانات المدرسة.', needsLogin: true });
                const address = req.socket?.remoteAddress || 'unknown';
                const now = Date.now();
                const failures = (loginFailures.get(address) || []).filter(time => time > now - 300_000);
                if (failures.length >= 10) return send(req, res, 429, { error: 'محاولات كثيرة. انتظر خمس دقائق.' });
                try {
                    const read = await readLoginBody(req);
                    const valid = path === '/api/auth/login' ? verifyOwnerPassword(read.data?.password, env.EMIS_OWNER_PASSWORD_HASH)
                        : verifyCloudPairing(read.data?.code, read.data?.proof, env.EMIS_SESSION_SECRET);
                    if (!valid) throw new Error('Invalid login');
                    loginBody = read.body;
                    loginFailures.delete(address);
                } catch {
                    loginFailures.set(address, [...failures, now]);
                    if (loginFailures.size > 1000) loginFailures.delete(loginFailures.keys().next().value);
                    return send(req, res, 401, { error: 'كلمة المرور غير صحيحة.', needsLogin: true });
                }
            }
            try {
                const resolved = await (resolveBackend ? resolveBackend() : runtime.getBackend());
                backend = backendConfiguration({ EMIS_BACKEND_ORIGIN: resolved.origin, EMIS_PROXY_SECRET: resolved.secret });
                if (!backend) throw new Error('Invalid runtime origin');
            } catch { return send(req, res, 503, { error: 'يتعذر تشغيل الاستضافة الآن. انتظر قليلًا ثم حاول مجددًا.', code: 'CLOUD_STARTING' }); }
        }
        if (!backend) {
            if (path === '/api/deployment/status' && ['GET', 'HEAD'].includes(req.method)) return send(req, res, 200, { ready: false, version: APP_VERSION });
            if (path === '/api' || path.startsWith('/api/')) return send(req, res, 503, unavailable);
            if (['/', '/cloud-setup.html'].includes(path) && ['GET', 'HEAD'].includes(req.method)) return send(req, res, 200, setupPage, 'text/html; charset=utf-8');
            return send(req, res, 404, { error: 'الصفحة غير موجودة.' });
        }

        let publicOrigin;
        try {
            const host = req.headers.host;
            if (typeof host !== 'string' || /[\s/@\\?#]/.test(host)) throw new Error('Invalid host');
            publicOrigin = new URL(`https://${host}`).origin;
        } catch { return send(req, res, 400, { error: 'عنوان الموقع غير صحيح.' }); }

        const headers = filteredHeaders(req.headers);
        for (const name of Object.keys(headers)) {
            if (['forwarded', 'x-emis-proxy-secret', 'x-emis-public-host', 'x-vercel-protection-bypass', 'x-vercel-set-bypass-cookie'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-forwarded-')) delete headers[name];
        }
        headers.host = req.headers.host;
        headers['x-forwarded-host'] = req.headers.host;
        headers['x-forwarded-proto'] = 'https';
        headers['x-forwarded-for'] = req.socket.remoteAddress || 'unknown';
        headers['x-emis-proxy-secret'] = backend.secret;
        if (cloud) {
            // The Sandbox edge routes by Host. Public host is restored only after secret validation.
            headers.host = backend.url.host;
            headers['x-emis-public-host'] = req.headers.host;
        }

        return new Promise(resolve => {
            let upstream;
            let upstreamResponse;
            let completed = false;
            const finish = () => { if (!completed) { completed = true; clearTimeout(deadline); resolve(); } };
            const fail = () => {
                if (completed) return;
                if (!res.headersSent) send(req, res, 502, proxyFailure);
                else res.destroy();
                finish();
                upstreamResponse?.destroy();
                upstream?.destroy();
            };
            const deadline = setTimeout(fail, timeoutMs);
            deadline.unref();
            res.once('finish', finish);
            res.once('close', () => {
                if (!completed) {
                    finish();
                    upstreamResponse?.destroy();
                    upstream?.destroy();
                }
            });
            req.once('aborted', fail);
            req.once('error', fail);
            try {
                upstream = requestImpl({
                    protocol: 'https:', hostname: backend.url.hostname, port: backend.url.port || 443,
                    method: req.method, path: req.url, headers,
                }, response => {
                    upstreamResponse = response;
                    if (completed) return response.destroy();
                    try {
                        clearTimeout(deadline);
                        upstream?.setTimeout?.(timeoutMs, fail);
                        const responseHeaders = filteredHeaders(response.headers);
                        responseHeaders['cache-control'] = 'private, no-store';
                        delete responseHeaders['x-emis-proxy-secret'];
                        delete responseHeaders.refresh;
                        if (responseHeaders.location) {
                            try {
                                const redirect = new URL(responseHeaders.location, backend.url);
                                if (redirect.origin === backend.url.origin) responseHeaders.location = `${publicOrigin}${redirect.pathname}${redirect.search}${redirect.hash}`;
                            } catch { delete responseHeaders.location; }
                        }
                        if (responseHeaders['set-cookie']) {
                            const cookies = Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']];
                            responseHeaders['set-cookie'] = cookies.map(cookie => cookie.replace(/;\s*domain=[^;]*/ig, ''));
                        }
                        response.once('error', fail);
                        response.once('aborted', fail);
                        res.writeHead(response.statusCode || 502, responseHeaders);
                        response.pipe(res);
                    } catch { fail(); }
                });
                upstream.once('error', fail);
                if (loginBody) {
                    upstream.end(loginBody);
                } else req.pipe(upstream);
            } catch { fail(); }
        });
    };
}

export default createVercelHandler();
