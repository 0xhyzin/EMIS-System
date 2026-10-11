import express from 'express';
import { randomInt, createHash } from 'node:crypto';
import { AuthStore } from '../utils/authStore.js';
import { MinistryBridge, findBrowser } from '../utils/authMinistry.js';
import { ownerPasswordHashIsValid, verifyOwnerPassword, signCloudSession, verifyCloudSession, signCloudPairing, verifyCloudPairing } from '../utils/cloudSession.js';

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

function configuredOrigin(env, key = 'APP_ORIGIN') {
    if (!env[key]) return null;
    const origin = new URL(env[key]);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error(`${key} must be an HTTP(S) origin without a path, query or credentials.`);
    }
    if (origin.protocol !== 'https:' && !LOOPBACK_HOSTS.has(origin.hostname) && env.ALLOW_INSECURE_LAN !== 'true') {
        throw new Error(`Use HTTPS for ${key}, or explicitly set ALLOW_INSECURE_LAN=true on a trusted private network.`);
    }
    return origin;
}

export function createAuth({ dataDir, env = process.env, store: providedStore, bridge: providedBridge, now = () => Date.now() }) {
    const cloudMode = env.EMIS_CLOUD === 'true';
    const origin = configuredOrigin(env);
    const previewOrigin = configuredOrigin(env, 'EMIS_PREVIEW_ORIGIN');
    const origins = [origin, previewOrigin].filter(Boolean);
    if (cloudMode) {
        if (!origin || origins.some(item => item.protocol !== 'https:')) throw new Error('Cloud mode requires HTTPS APP_ORIGIN and HTTPS EMIS_PREVIEW_ORIGIN when provided.');
        if (!ownerPasswordHashIsValid(env.EMIS_OWNER_PASSWORD_HASH)) throw new Error('Cloud mode requires a valid EMIS_OWNER_PASSWORD_HASH.');
        // Validate configuration at startup, before exposing a login endpoint.
        signCloudSession({ token: 'a'.repeat(43), expiresAt: 1 }, env.EMIS_SESSION_SECRET);
    }
    const store = providedStore || new AuthStore(dataDir, { now });
    const bridge = providedBridge || new MinistryBridge({ dataDir, store, now, cloudMode, browserPath: findBrowser(env) });
    const router = express.Router();
    let failures = [];

    function requestOrigin(req) {
        const configured = origins.find(item => req.headers.host?.toLowerCase() === item.host.toLowerCase());
        if (configured) return configured;
        if (!cloudMode && requestIsLocal(req)) return new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`);
        return null;
    }

    function trustedHost(req) {
        return !!requestOrigin(req);
    }

    function requireSameOrigin(req, res, next) {
        if (!trustedHost(req)) return res.status(403).json({ error: 'هذا العنوان غير مفعّل. افتح البرنامج من الكمبيوتر أو استخدم عنوان الهاتف المهيأ.' });
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
            return res.status(403).json({ error: 'طلب من موقع خارجي غير مسموح.' });
        }
        const expected = requestOrigin(req).origin;
        if (req.headers.origin && req.headers.origin !== expected) return res.status(403).json({ error: 'مصدر الطلب غير مسموح.' });
        next();
    }

    function sessionClaim(req) {
        const cookie = cookies(req)[COOKIE];
        return cloudMode ? verifyCloudSession(cookie, env.EMIS_SESSION_SECRET, now()) : { token: cookie };
    }

    function identity(req) {
        if (!cloudMode && requestIsLocal(req)) return { local: true, owner: true, user: { provider: 'local', name: 'هذا الكمبيوتر' }, expiresAt: null };
        if (!trustedHost(req)) return null;
        const claim = sessionClaim(req);
        if (!claim) return null;
        const session = store.getSession(claim.token);
        if (!session || (cloudMode && (session.expiresAt !== claim.expiresAt || !['cloud-owner', 'paired'].includes(session.user?.provider)))) return null;
        return { ...session, local: false, owner: cloudMode && session.user.provider === 'cloud-owner', sessionKey: createHash('sha256').update(claim.token).digest('hex') };
    }

    function requireAccess(req, res, next) {
        const auth = identity(req);
        if (!auth) return res.status(401).json(cloudMode
            ? { error: 'سجّل الدخول لفتح بيانات المدرسة.', cloudAccess: true, needsLogin: true, needsPairing: false }
            : { error: 'اربط هذا الجهاز برمز من الكمبيوتر لفتح بيانات المدرسة.', needsPairing: true });
        req.auth = auth;
        res.setHeader('Cache-Control', 'no-store');
        next();
    }

    function requireOwner(req, res, next) {
        const auth = identity(req);
        if (!auth?.owner) return res.status(cloudMode && !auth ? 401 : 403).json(cloudMode
            ? { error: 'هذا الإجراء يحتاج تسجيل الدخول بحساب صاحب المدرسة.', needsLogin: !auth }
            : { error: 'افتح هذا الإجراء على الكمبيوتر الذي يشغّل البرنامج.' });
        req.auth = auth;
        next();
    }

    function cookieOptions(req) {
        return { httpOnly: true, secure: cloudMode || !!req.socket.encrypted || (!requestIsLocal(req) && requestOrigin(req)?.protocol === 'https:'), sameSite: 'strict', path: '/' };
    }

    function setSessionCookie(req, res, session) {
        const cookie = cloudMode ? signCloudSession({ token: session.token, expiresAt: session.expiresAt }, env.EMIS_SESSION_SECRET) : session.token;
        res.cookie(COOKIE, cookie, { ...cookieOptions(req), maxAge: SESSION_TTL });
    }

    const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'تعذر إكمال العملية. حاول مرة أخرى.' });
    });

    router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use(requireSameOrigin);

    router.get('/status', (req, res) => {
        const auth = identity(req);
        const publicStatus = { authenticated: !!auth, localAccess: !!auth?.local, ownerAccess: !!auth?.owner,
            cloudAccess: cloudMode, needsLogin: cloudMode && !auth, needsPairing: !cloudMode && !auth, user: auth?.user || null };
        if (!auth) return res.json(publicStatus);
        res.json({
            ...publicStatus,
            sessionExpiresAt: auth.expiresAt,
            browserAvailable: !!bridge.browserPath,
            ministry: bridge.getStatus(),
            pairingAvailable: auth.owner && !!origin && !LOOPBACK_HOSTS.has(origin.hostname),
            phoneUrl: auth.owner && requestOrigin(req) && !LOOPBACK_HOSTS.has(requestOrigin(req).hostname) ? requestOrigin(req).origin
                : auth.owner && origin ? origin.origin : null,
        });
    });

    router.post('/login', safe(async (req, res) => {
        if (!cloudMode) return res.status(404).json({ error: 'هذا المسار متاح في النسخة المستضافة فقط.' });
        const rawAttempts = store.getSecret('cloud-owner-login-attempts');
        const attempts = (Array.isArray(rawAttempts) ? rawAttempts : [])
            .filter(time => Number.isSafeInteger(time) && time > now() - 5 * 60_000);
        if (attempts.length >= 10) {
            res.setHeader('Retry-After', '300');
            return res.status(429).json({ error: 'محاولات كثيرة. انتظر خمس دقائق ثم حاول مجددًا.' });
        }
        // Count attempts before the password calculation; the persistent limit survives restarts.
        store.putSecret('cloud-owner-login-attempts', [...attempts, now()]);
        if (!verifyOwnerPassword(req.body?.password, env.EMIS_OWNER_PASSWORD_HASH)) return res.status(401).json({ error: 'كلمة المرور غير صحيحة.', needsLogin: true });
        const oldSession = sessionClaim(req);
        if (oldSession) store.deleteSession(oldSession.token);
        const session = store.createSession({ provider: 'cloud-owner', name: 'صاحب المدرسة' }, SESSION_TTL);
        store.deleteSecret('cloud-owner-login-attempts');
        setSessionCookie(req, res, session);
        res.json({ success: true, expiresAt: session.expiresAt, ownerAccess: true, cloudAccess: true });
    }));

    router.post('/microsoft/start', requireOwner, safe(async (req, res) => {
        await bridge.open({ refresh: true });
        res.json({ success: true, ministry: bridge.getStatus(), ...(cloudMode ? { browserView: true } : {}) });
    }));

    router.post('/microsoft/disconnect', requireOwner, safe(async (req, res) => {
        store.clearSessions();
        res.clearCookie(COOKIE, cookieOptions(req));
        await bridge.disconnect();
        res.json({ success: true });
    }));

    router.post('/pairing/start', requireOwner, (req, res) => {
        if (!origin || LOOPBACK_HOSTS.has(origin.hostname)) return res.status(409).json({ error: 'حدّد APP_ORIGIN بعنوان وصول الهاتف أولًا، وشغّل الخادم على الشبكة المحلية.' });
        const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
        const expiresAt = store.createPairing(code);
        failures = [];
        const proof = cloudMode ? signCloudPairing(code, expiresAt, env.EMIS_SESSION_SECRET) : undefined;
        res.json({ code, expiresAt, ...(proof ? { proof } : {}), phoneUrl: cloudMode ? `${requestOrigin(req).origin}/#pair=${encodeURIComponent(proof)}` : origin.origin });
    });

    router.post('/pairing/complete', (req, res) => {
        if (cloudMode && !verifyCloudPairing(req.body?.code, req.body?.proof, env.EMIS_SESSION_SECRET, now())) return res.status(400).json({ error: 'افتح رابط الربط الذي أنشأه مدير البرنامج ثم أدخل الرمز.' });
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
        setSessionCookie(req, res, session);
        res.json({ success: true, expiresAt: session.expiresAt });
    });

    router.post('/logout', requireAccess, safe(async (req, res) => {
        store.deleteSession(sessionClaim(req)?.token);
        res.clearCookie(COOKIE, cookieOptions(req));
        if (req.auth.local) {
            store.clearSessions();
            await bridge.disconnect();
        }
        res.json({ success: true });
    }));

    return {
        router, requireAccess, requireSameOrigin, requireOwner, bridge,
        getMinistryCredentials: () => bridge.getCredentials(),
        invalidateMinistryCredentials: () => bridge.invalidate(),
        getAssistantApiKey: () => store.getSecret('groq-api-key'),
        setAssistantApiKey: value => store.putSecret('groq-api-key', value),
        clearAssistantApiKey: () => store.deleteSecret('groq-api-key'),
        close: async () => { await bridge.close(); store.close(); },
    };
}
