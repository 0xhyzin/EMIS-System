import express from 'express';
import { randomInt } from 'node:crypto';
import { AuthStore } from '../utils/authStore.js';
import { MinistryBridge, findBrowser } from '../utils/authMinistry.js';

const COOKIE = 'emis_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const position = part.indexOf('=');
        return position < 0 ? [] : [part.slice(0, position).trim(), part.slice(position + 1).trim()];
    }).filter(part => part.length === 2));
}

export function requestIsLocal(req) {
    try {
        // A reverse proxy must never turn an internet request into desktop-owner access.
        if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(name => req.headers[name])) return false;
        const host = new URL(`http://${req.headers.host}`).hostname;
        return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress) && LOOPBACK_HOSTS.has(host);
    } catch { return false; }
}

function configuredOrigin(env) {
    if (!env.APP_ORIGIN) return null;
    const origin = new URL(env.APP_ORIGIN);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path, query or credentials.');
    }
    if (origin.protocol !== 'https:' && !LOOPBACK_HOSTS.has(origin.hostname) && env.ALLOW_INSECURE_LAN !== 'true') {
        throw new Error('Use HTTPS for APP_ORIGIN, or explicitly set ALLOW_INSECURE_LAN=true on a trusted private network.');
    }
    return origin;
}

export function createAuth({ dataDir, env = process.env, store: providedStore, bridge: providedBridge, now = () => Date.now() }) {
    const store = providedStore || new AuthStore(dataDir, { now });
    const bridge = providedBridge || new MinistryBridge({ dataDir, store, now, browserPath: findBrowser(env) });
    const origin = configuredOrigin(env);
    const router = express.Router();
    let failures = [];

    function trustedHost(req) {
        if (requestIsLocal(req)) return true;
        return !!origin && req.headers.host?.toLowerCase() === origin.host.toLowerCase();
    }

    function requireSameOrigin(req, res, next) {
        if (!trustedHost(req)) return res.status(403).json({ error: 'هذا العنوان غير مفعّل. افتح البرنامج من الكمبيوتر أو استخدم عنوان الهاتف المهيأ.' });
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
            return res.status(403).json({ error: 'طلب من موقع خارجي غير مسموح.' });
        }
        const expected = requestIsLocal(req) ? `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}` : origin.origin;
        if (req.headers.origin && req.headers.origin !== expected) return res.status(403).json({ error: 'مصدر الطلب غير مسموح.' });
        next();
    }

    function identity(req) {
        if (requestIsLocal(req)) return { local: true, user: { provider: 'local', name: 'هذا الكمبيوتر' }, expiresAt: null };
        if (!trustedHost(req)) return null;
        const session = store.getSession(cookies(req)[COOKIE]);
        return session ? { ...session, local: false } : null;
    }

    function requireAccess(req, res, next) {
        const auth = identity(req);
        if (!auth) return res.status(401).json({ error: 'اربط هذا الجهاز برمز من الكمبيوتر لفتح بيانات المدرسة.', needsPairing: true });
        req.auth = auth;
        res.setHeader('Cache-Control', 'no-store');
        next();
    }

    function localOnly(req, res, next) {
        if (!requestIsLocal(req)) return res.status(403).json({ error: 'افتح هذا الإجراء على الكمبيوتر الذي يشغّل البرنامج.' });
        next();
    }

    function cookieOptions(req) {
        return { httpOnly: true, secure: !!req.socket.encrypted || (!requestIsLocal(req) && origin?.protocol === 'https:'), sameSite: 'strict', path: '/' };
    }

    const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'تعذر إكمال العملية. حاول مرة أخرى.' });
    });

    router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use(requireSameOrigin);

    router.get('/status', (req, res) => {
        const auth = identity(req);
        const publicStatus = { authenticated: !!auth, localAccess: !!auth?.local, needsPairing: !auth, user: auth?.user || null };
        if (!auth) return res.json(publicStatus);
        res.json({
            ...publicStatus,
            sessionExpiresAt: auth.expiresAt,
            browserAvailable: !!bridge.browserPath,
            ministry: bridge.getStatus(),
            pairingAvailable: auth.local && !!origin && !LOOPBACK_HOSTS.has(origin.hostname),
            phoneUrl: auth.local && origin ? origin.origin : null,
        });
    });

    router.post('/microsoft/start', localOnly, safe(async (req, res) => {
        await bridge.open({ refresh: true });
        res.json({ success: true, ministry: bridge.getStatus() });
    }));

    router.post('/microsoft/disconnect', localOnly, safe(async (req, res) => {
        store.clearSessions();
        await bridge.disconnect();
        res.json({ success: true });
    }));

    router.post('/pairing/start', localOnly, (req, res) => {
        if (!origin || LOOPBACK_HOSTS.has(origin.hostname)) return res.status(409).json({ error: 'حدّد APP_ORIGIN بعنوان وصول الهاتف أولًا، وشغّل الخادم على الشبكة المحلية.' });
        const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
        const expiresAt = store.createPairing(code);
        failures = [];
        res.json({ code, expiresAt, phoneUrl: origin.origin });
    });

    router.post('/pairing/complete', (req, res) => {
        failures = failures.filter(time => time > now() - 5 * 60_000);
        if (failures.length >= 10) {
            res.setHeader('Retry-After', '300');
            return res.status(429).json({ error: 'محاولات كثيرة. انتظر خمس دقائق أو أنشئ رمزًا جديدًا من الكمبيوتر.' });
        }
        if (!store.consumePairing(req.body?.code)) {
            failures.push(now());
            return res.status(400).json({ error: 'رمز الربط غير صحيح أو انتهت صلاحيته.' });
        }
        const session = store.createSession({ provider: 'paired', name: 'جهاز مرتبط بالمدرسة' }, SESSION_TTL);
        res.cookie(COOKIE, session.token, { ...cookieOptions(req), maxAge: SESSION_TTL });
        res.json({ success: true, expiresAt: session.expiresAt });
    });

    router.post('/logout', requireAccess, safe(async (req, res) => {
        store.deleteSession(cookies(req)[COOKIE]);
        res.clearCookie(COOKIE, cookieOptions(req));
        if (req.auth.local) {
            store.clearSessions();
            await bridge.disconnect();
        }
        res.json({ success: true });
    }));

    return {
        router, requireAccess, requireSameOrigin,
        getMinistryCredentials: () => bridge.getCredentials(),
        invalidateMinistryCredentials: () => bridge.invalidate(),
        getAssistantApiKey: () => store.getSecret('groq-api-key'),
        setAssistantApiKey: value => store.putSecret('groq-api-key', value),
        clearAssistantApiKey: () => store.deleteSecret('groq-api-key'),
        close: async () => { await bridge.close(); store.close(); },
    };
}
