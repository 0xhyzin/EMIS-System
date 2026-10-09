import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';
import { initDatabase, getDatabasePath, closeDatabase } from './db/database.js';
import { createApiRouter } from './routes/api.js';
import exportRouter from './routes/export.js';
import { createAuth } from './routes/auth.js';
import { createAssistantRouter } from './routes/assistant.js';
import { createGroqAssistantProvider } from './utils/assistantProvider.js';
import multer from 'multer';
import { APP_VERSION } from './public/js/appVersion.js';

const projectDir = dirname(fileURLToPath(import.meta.url));
const loopbackHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function createApp(options = {}) {
    initDatabase({ dataDir: options.dataDir });
    const dataDir = dirname(getDatabasePath());
    const app = express();
    app.disable('x-powered-by');
    const configuredOrigin = options.appOrigin ?? process.env.APP_ORIGIN;
    const auth = options.auth || createAuth({ dataDir, env: { ...process.env, APP_ORIGIN: configuredOrigin } });
    app.locals.auth = auth;
    app.locals.dataDir = dataDir;
    let trustedOrigin = null;
    if (configuredOrigin) {
        const parsed = new URL(configuredOrigin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
        trustedOrigin = parsed.origin;
    }
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        let requestOrigin;
        try { requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin; }
        catch { return res.status(400).json({ error: 'عنوان الخادم غير صحيح.' }); }
        const host = new URL(requestOrigin).hostname;
        const isCanonical = trustedOrigin && new URL(requestOrigin).host === new URL(trustedOrigin).host;
        if (!loopbackHost(host) && !isCanonical) return res.status(403).json({ error: 'عنوان الوصول غير مسموح. اضبط APP_ORIGIN للوصول من الهاتف.' });
        if (req.path.startsWith('/api/')) {
            res.setHeader('Cache-Control', 'no-store');
            const origin = req.get('origin');
            const expectedOrigin = isCanonical ? trustedOrigin : requestOrigin;
            if ((origin && origin !== expectedOrigin) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'الطلب يجب أن يأتي من نفس الموقع.' });
        }
        next();
    });
    // The assistant resizes images before upload and its route enforces a 1 MiB image cap.
    app.use(express.json({ limit: '2mb' }));
    app.get('/api/version', (req, res) => res.json({ version: APP_VERSION, completeEmployeeEditor: true, syncModes: ['normal', 'full'] }));
    app.use('/api/auth', auth.router);
    app.use('/api', auth.requireAccess, auth.requireSameOrigin);
    const apiRouter = createApiRouter({ getMinistryCredentials: () => auth.getMinistryCredentials(),
        invalidateMinistryCredentials: () => auth.invalidateMinistryCredentials?.(), ...options.apiOptions });
    app.use('/api/assistant', createAssistantRouter({
        provider: options.assistantProvider || createGroqAssistantProvider(options.assistantProviderOptions),
        getApiKey: () => auth.getAssistantApiKey?.(),
        setApiKey: value => auth.setAssistantApiKey?.(value),
        deleteApiKey: () => auth.clearAssistantApiKey?.(),
        emailService: apiRouter.unifiedEmailService,
    }));

    const assetsDir = join(dataDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
    app.get('/assets/logo.png', (req, res, next) => {
        const path = join(assetsDir, 'logo.png');
        if (fs.existsSync(path)) { res.setHeader('Cache-Control', 'no-cache'); return res.sendFile(path); }
        next();
    });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    app.post('/api/upload-logo', upload.single('logo'), (req, res) => {
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (!req.file || !req.file.buffer.subarray(0, 8).equals(signature)) return res.status(400).json({ error: 'اختر صورة شعار بصيغة PNG لا يتجاوز حجمها ٢ ميجابايت.' });
        const temp = join(assetsDir, 'logo.pending.png');
        fs.writeFileSync(temp, req.file.buffer, { mode: 0o600 });
        fs.renameSync(temp, join(assetsDir, 'logo.png'));
        res.json({ success: true, path: '/assets/logo.png' });
    });
    app.use('/api', apiRouter);
    app.use('/api', exportRouter);
    app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));
    app.use(express.static(join(projectDir, 'public'), {
        etag: false,
        setHeaders(res, path) { if (/\.(html|js|css)$/i.test(path)) res.setHeader('Cache-Control', 'no-store'); }
    }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error instanceof multer.MulterError) return res.status(400).json({ error: 'تعذر رفع الصورة. الحد الأقصى للشعار ٢ ميجابايت.' });
        if (error.type === 'entity.too.large') return res.status(413).json({ error: 'حجم الطلب أكبر من الحد المسموح.' });
        if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'صيغة البيانات المرسلة غير صحيحة.' });
        res.status(500).json({ error: 'حدث خطأ أثناء تنفيذ الطلب.' });
    });
    return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    if (!['localhost', '127.0.0.1', '::1'].includes(host) && !process.env.APP_ORIGIN) throw new Error('Set APP_ORIGIN to the trusted address before enabling access from other devices.');
    const app = createApp();
    const server = app.listen(port, host, () => console.log(`دفتر المدرسة ${APP_VERSION}\nمجلد البرنامج: ${projectDir}\nيعمل على ${process.env.APP_ORIGIN || `http://${host}:${port}`}`));
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => server.closeAllConnections(), 5000);
        deadline.unref();
        server.close(async () => {
            clearTimeout(deadline);
            try { await app.locals.auth.close(); } finally { closeDatabase(); }
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
