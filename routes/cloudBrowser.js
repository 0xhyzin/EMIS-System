import express from 'express';
import { validateBrowserInput } from '../utils/authMinistry.js';

/** A narrow, owner-only view of the official login page. This exposes neither CDP nor a general browser API. */
export function createCloudBrowserRouter({ auth, bridge = auth?.bridge }) {
    if (!auth?.requireAccess || !auth?.requireOwner || !auth?.requireSameOrigin || !bridge) {
        throw new Error('Cloud browser requires owner authentication and a Ministry bridge.');
    }
    const router = express.Router();
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });
    router.use(auth.requireSameOrigin, auth.requireAccess, auth.requireOwner);
    router.use((req, res, next) => {
        if (!bridge.cloudMode) return res.status(404).json({ error: 'نافذة تسجيل الدخول متاحة في نسخة الاستضافة فقط.' });
        if (Number(req.headers['content-length']) > 8192) return res.status(413).json({ error: 'حجم الطلب أكبر من المسموح.' });
        next();
    });
    router.use(express.json({ limit: '8kb', strict: true }));
    const safe = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(error => {
        const status = [400, 403, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
        res.status(status).json({ error: error.statusCode === status ? error.message : 'تعذر إكمال العملية في صفحة تسجيل الدخول. حاول مرة أخرى.' });
    });

    router.get('/state', (req, res) => res.json(bridge.getBrowserState()));
    router.get('/frame', safe(async (req, res) => {
        const frame = await bridge.screenshot();
        res.type('image/jpeg').send(frame);
    }));
    router.post('/input', safe(async (req, res) => {
        // Also enforce the limit if an application-level JSON parser already read this body.
        if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > 8192) return res.status(413).json({ error: 'حجم الطلب أكبر من المسموح.' });
        validateBrowserInput(req.body);
        res.json(await bridge.input(req.body));
    }));
    router.post('/close', safe(async (req, res) => {
        if (Object.keys(req.body || {}).length) return res.status(400).json({ error: 'طلب إغلاق النافذة غير صحيح.' });
        res.json(await bridge.closeView());
    }));
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'طلب المتصفح غير صحيح أو أكبر من المسموح.' });
    });
    return router;
}
