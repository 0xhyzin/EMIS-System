import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from './public/js/appVersion.js';

// This gateway deliberately does not load the desktop server or its local stores.
const setupPage = readFileSync(new URL('./public/cloud-setup.html', import.meta.url));
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

export function createVercelHandler({ env = process.env, requestImpl = httpsRequest, timeoutMs = 25_000 } = {}) {
    const backend = backendConfiguration(env);
    return function handler(req, res) {
        const path = safePath(req.url);
        if (path === null) return send(req, res, 400, { error: 'المسار غير صحيح.' });
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
            if (['forwarded', 'x-emis-proxy-secret', 'x-vercel-protection-bypass', 'x-vercel-set-bypass-cookie'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-forwarded-')) delete headers[name];
        }
        headers.host = req.headers.host;
        headers['x-forwarded-host'] = req.headers.host;
        headers['x-forwarded-proto'] = 'https';
        headers['x-forwarded-for'] = req.socket.remoteAddress || 'unknown';
        headers['x-emis-proxy-secret'] = backend.secret;

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
                req.pipe(upstream);
            } catch { fail(); }
        });
    };
}

export default createVercelHandler();
