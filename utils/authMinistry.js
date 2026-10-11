import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parseUtToken } from './tokenParser.js';

export const MINISTRY_PORTAL = 'https://teacher.emis.gov.eg/';
const MINISTRY_API_ORIGIN = 'https://professopi.emis.gov.eg';
const CAPTURE_PATHS = new Set([
    '/api/Employee/GetEmployeeByEmpFlag',
    '/api/Employee/EmployeesNadb',
    '/api/Employee/GetEmployeeFullData',
]);
const normalizedCode = value => String(value).replace(/^0+(?=\d)/, '');
const CLEANUP_MESSAGE = 'أُلغي اتصال الوزارة، لكن تعذر مسح جلسة المتصفح. أغلق نافذة الوزارة ثم أعد تسجيل الخروج.';
const CLOUD_VIEWPORT = Object.freeze({ width: 1000, height: 760 });
const BROWSER_ORIGINS = new Set([
    'https://teacher.emis.gov.eg', 'https://professopi.emis.gov.eg',
    'https://login.microsoftonline.com', 'https://login.live.com', 'https://account.live.com',
]);
const BROWSER_KEYS = new Set([
    'Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
    'PageUp', 'PageDown', 'Control+A', 'Meta+A',
]);
const browserError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

// Only the origin is ever returned to the application. OAuth queries and fragments stay in Chromium.
export function officialBrowserOrigin(value) {
    try {
        const url = new URL(value);
        return !url.username && !url.password && BROWSER_ORIGINS.has(url.origin) ? url.origin : null;
    } catch { return null; }
}

export function validateBrowserInput(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw browserError('أمر المتصفح غير صحيح.', 400);
    const allowed = {
        click: ['action', 'x', 'y'], press: ['action', 'key'], text: ['action', 'text'],
        wheel: ['action', 'deltaX', 'deltaY'], back: ['action'], reload: ['action'], portal: ['action'],
    };
    if (!Object.hasOwn(allowed, payload.action) || Object.keys(payload).some(key => !allowed[payload.action].includes(key))) {
        throw browserError('أمر المتصفح غير صحيح.', 400);
    }
    if (payload.action === 'click' && !['x', 'y'].every((key, index) => Number.isFinite(payload[key])
        && payload[key] >= 0 && payload[key] < (index === 0 ? CLOUD_VIEWPORT.width : CLOUD_VIEWPORT.height))) {
        throw browserError('موضع النقر خارج نافذة المتصفح.', 400);
    }
    if (payload.action === 'press' && !BROWSER_KEYS.has(payload.key)) throw browserError('هذا المفتاح غير متاح.', 400);
    if (payload.action === 'text' && (typeof payload.text !== 'string' || !payload.text.length || payload.text.length > 2000
        || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(payload.text))) throw browserError('النص غير صحيح أو أطول من المسموح.', 400);
    if (payload.action === 'wheel' && !['deltaX', 'deltaY'].every(key => Number.isFinite(payload[key]) && Math.abs(payload[key]) <= 2000)) {
        throw browserError('مقدار التمرير غير صحيح.', 400);
    }
    return payload;
}

export function findBrowser(env = process.env) {
    if (env.EMIS_BROWSER_PATH) return isAbsolute(env.EMIS_BROWSER_PATH) && existsSync(env.EMIS_BROWSER_PATH) ? env.EMIS_BROWSER_PATH : null;
    const candidates = [
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ...[env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(base => [
            join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]),
        join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
    return candidates.find(path => existsSync(path)) || null;
}

function jwtExpiry(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
    } catch { return null; }
}

/** Headers are accepted only after the real Ministry server accepted this request.
 * JWT decoding here reads expiry/school metadata; it never verifies identity. */
export function credentialsFromAcceptedResponse(url, status, headers, now = Date.now()) {
    const endpoint = new URL(url);
    if (endpoint.origin !== MINISTRY_API_ORIGIN || !CAPTURE_PATHS.has(endpoint.pathname) || status !== 200) return null;
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const authorization = normalized.authorization || '';
    if (!/^Bearer\s+\S+$/i.test(authorization) || !normalized.ut) return null;
    const bearerToken = authorization.replace(/^Bearer\s+/i, '');
    const utToken = normalized.ut;
    const bearerExpiry = jwtExpiry(bearerToken);
    const utExpiry = jwtExpiry(utToken);
    // Unknown or expired lifetimes are never treated as a durable live connection.
    if (!bearerExpiry || !utExpiry) return null;
    const expiresAt = Math.min(bearerExpiry, utExpiry);
    if (expiresAt <= now + 60_000) return null;
    try {
        const schoolInfo = parseUtToken(utToken);
        const sc = String(normalized.sc || schoolInfo.sc || '');
        const ed = String(normalized.ed || schoolInfo.ed || '');
        const ty = String(normalized.ty || schoolInfo.ty || '');
        if (!/^\d+$/.test(sc) || !/^\d+$/.test(ed) || !/^\d+$/.test(ty) || Number(sc) <= 0) return null;
        if (normalizedCode(schoolInfo.sc) !== normalizedCode(sc) || normalizedCode(schoolInfo.ed) !== normalizedCode(ed)
            || normalizedCode(schoolInfo.ty) !== normalizedCode(ty)) return null;
        return { bearerToken, utToken, schoolInfo: { ...schoolInfo, sc, ed, ty }, expiresAt, capturedAt: now };
    } catch { return null; }
}

export function credentialsAreFresh(credentials, now = Date.now()) {
    return !!(credentials?.bearerToken && credentials?.utToken && credentials?.schoolInfo?.sc && credentials.expiresAt > now + 60_000);
}

export class MinistryBridge extends EventEmitter {
    constructor({ dataDir, store, browserPath = findBrowser(), launcher, now = () => Date.now(), cloudMode = process.env.EMIS_CLOUD === 'true' }) {
        super();
        this.store = store;
        this.now = now;
        this.browserPath = browserPath;
        this.launcher = launcher;
        this.cloudMode = cloudMode;
        this.profileDir = join(dataDir, 'ministry-browser');
        this.context = null;
        this.page = null;
        this.starting = null;
        this.renewing = null;
        this.disconnecting = null;
        this.cleanupRequired = !!store.getSecret('ministry-cleanup');
        this.generation = 0;
        this.attemptTimer = null;
        this.status = this.cleanupRequired ? 'error' : 'disconnected';
        this.message = this.cleanupRequired ? CLEANUP_MESSAGE : '';
        this.browserQueue = Promise.resolve();
        this.pendingBrowserOperations = 0;
        this.framePromise = null;
    }

    getStatus() {
        const credentials = this.store.getSecret('ministry');
        const connected = !this.cleanupRequired && credentialsAreFresh(credentials, this.now());
        const status = connected ? 'connected' : ['opening', 'waiting', 'error'].includes(this.status)
            ? this.status : credentials ? 'expired' : 'disconnected';
        const messages = {
            connected: this.cloudMode ? 'تم الاتصال بحساب المدرسة، وتُحفظ الجلسة على الاستضافة.' : 'تم الاتصال بحساب المدرسة، وتُحفظ الجلسة على هذا الجهاز.',
            disconnected: this.cloudMode ? 'افتح تسجيل الدخول بحساب Microsoft الخاص بموقع الوزارة من هنا.' : 'سجّل الدخول من هذا الكمبيوتر بحساب Microsoft الخاص بموقع الوزارة.',
            expired: 'انتهت صلاحية اتصال الوزارة. افتح تسجيل الدخول لتجديده؛ بياناتك المحفوظة متاحة.',
            opening: this.cloudMode ? 'جاري تجهيز نافذة تسجيل الدخول…' : 'جاري فتح متصفح تسجيل الدخول على الكمبيوتر…',
            waiting: 'أكمل تسجيل الدخول في المتصفح، ثم افتح قائمة العاملين في موقع الوزارة.',
            error: this.message || (this.cloudMode ? 'تعذر تجهيز نافذة تسجيل الدخول. حاول مرة أخرى.' : 'تعذر فتح تسجيل الدخول. تأكد من تثبيت Chrome أو Edge أو Chromium.'),
        };
        return {
            connected, status, message: messages[status],
            schoolInfo: credentials?.schoolInfo || null,
            expiresAt: credentials?.expiresAt || null,
        };
    }

    async handleResponse(response, generation = this.generation) {
        if (this.cleanupRequired || generation !== this.generation) return;
        // Checking URL before reading headers avoids touching other browser credentials.
        let endpoint;
        try { endpoint = new URL(response.url()); } catch { return; }
        if (endpoint.origin !== MINISTRY_API_ORIGIN || !CAPTURE_PATHS.has(endpoint.pathname) || response.status() !== 200) return;
        try {
            const headers = await response.request().allHeaders();
            const credentials = credentialsFromAcceptedResponse(response.url(), response.status(), headers, this.now());
            if (!credentials) return;
            // Some APIs return application errors with HTTP 200. Require an employee result.
            const body = await response.json();
            const failure = !body || body.success === false || body.isSuccess === false || body.succeeded === false || body.error
                || (Array.isArray(body.errors) && body.errors.length > 0);
            const basic = body?.basicInfo;
            const accepted = !failure && (endpoint.pathname === '/api/Employee/GetEmployeeFullData'
                ? basic && !Array.isArray(basic) && typeof basic.empFirstName === 'string' && basic.empFirstName.trim()
                : Array.isArray(body.data));
            if (!accepted) return;
            if (this.cleanupRequired || generation !== this.generation) return;
            const previous = this.store.getSecret('ministry');
            if (previous && ['sc', 'ed'].some(key => normalizedCode(previous.schoolInfo[key]) !== normalizedCode(credentials.schoolInfo[key]))) {
                this.status = 'error';
                this.message = 'هذا حساب مدرسة مختلفة. افصل حساب المدرسة الحالي قبل تبديله لتجنب خلط البيانات.';
                return;
            }
            this.store.putSecret('ministry', credentials);
            this.status = 'connected';
            this.message = '';
            clearTimeout(this.attemptTimer);
            this.emit('credentials', credentials);
        } catch { /* No raw browser errors or credentials are sent to logs/UI. */ }
    }

    async open({ refresh = false } = {}) {
        if (this.disconnecting) await this.disconnecting;
        if (this.cleanupRequired) await this.disconnect();
        if (this.starting) return this.starting;
        this.starting = this.openBrowser(refresh).finally(() => { this.starting = null; });
        return this.starting;
    }

    async openBrowser(refresh) {
        if (!this.browserPath) {
            this.status = 'error';
            this.message = this.cloudMode ? 'متصفح تسجيل الدخول غير متاح على الاستضافة. حاول مرة أخرى لاحقًا.' : 'ثبّت Chrome أو Edge أو Chromium على الكمبيوتر، ثم أعد تشغيل البرنامج.';
            throw Object.assign(new Error(this.message), { statusCode: 503 });
        }
        this.status = 'opening';
        try {
            if (!this.context) {
                mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
                try { chmodSync(this.profileDir, 0o700); } catch { /* Windows ACLs. */ }
                const launcher = this.launcher || (await import('playwright-core')).chromium;
                this.context = await launcher.launchPersistentContext(this.profileDir, {
                    executablePath: this.browserPath,
                    headless: false,
                    viewport: this.cloudMode ? { ...CLOUD_VIEWPORT } : null,
                    ...(this.cloudMode ? { acceptDownloads: false, serviceWorkers: 'block' } : {}),
                    timeout: 25_000,
                });
                const context = this.context;
                const generation = this.generation;
                context.on('response', response => void this.handleResponse(response, generation));
                if (this.cloudMode) {
                    // Main-page navigation is limited to the real Ministry and Microsoft flow.
                    // Assets and nested authentication frames keep their normal official behavior.
                    await context.route('**/*', async route => {
                        const request = route.request();
                        try {
                            const topLevel = request.isNavigationRequest() && !request.frame().parentFrame();
                            if (topLevel && request.url() !== 'about:blank' && !officialBrowserOrigin(request.url())) return route.abort();
                            await route.continue();
                        } catch { await route.abort().catch(() => {}); }
                    });
                    context.on('page', page => this.trackCloudPage(page));
                    for (const page of context.pages()) this.trackCloudPage(page);
                }
                context.on('close', () => {
                    if (this.context !== context) return;
                    this.generation++;
                    this.context = null;
                    this.page = null;
                    clearTimeout(this.attemptTimer);
                    this.status = 'disconnected';
                });
                this.page = this.context.pages()[0] || await this.context.newPage();
            }
            if (this.cloudMode && refresh) {
                const portal = this.context.pages().find(page => !page.isClosed() && officialBrowserOrigin(page.url()) === new URL(MINISTRY_PORTAL).origin);
                if (portal) this.page = portal;
            }
            if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
            // The user enters credentials only on the official Microsoft/Ministry pages.
            if (refresh && this.page.url().startsWith(MINISTRY_PORTAL)) {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
            } else {
                await this.page.goto(MINISTRY_PORTAL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
            }
            // Use the portal's own current button/PKCE flow, never an invented OAuth URL.
            // If its markup changes, the user can still click the visible login control.
            if (this.page.url().startsWith(`${MINISTRY_PORTAL}login`)) {
                const button = this.page.getByRole('button', { name: /تسجيل الدخول بحساب ميكروسوفت/ });
                try { await button.click({ timeout: 3_000 }); } catch { /* Leave the official page usable. */ }
            }
            await this.page.bringToFront();
            if (!credentialsAreFresh(this.store.getSecret('ministry'), this.now())) this.status = 'waiting';
            clearTimeout(this.attemptTimer);
            this.attemptTimer = setTimeout(() => {
                if (!credentialsAreFresh(this.store.getSecret('ministry'), this.now())) {
                    this.status = 'error';
                    this.message = 'لم يكتمل الاتصال بعد. أكمل الدخول وافتح قائمة العاملين، أو اضغط تسجيل الدخول للمحاولة مجددًا.';
                }
            }, 10 * 60_000);
            this.attemptTimer.unref?.();
        } catch (error) {
            this.status = 'error';
            this.message = this.cloudMode ? 'تعذر فتح موقع الوزارة الآن. أعد المحاولة بعد قليل.' : 'تعذر فتح موقع الوزارة. تحقق من الإنترنت، ووجود متصفح مدعوم وواجهة سطح مكتب على الكمبيوتر.';
            throw Object.assign(new Error(this.message), { statusCode: 503 });
        }
    }

    trackCloudPage(page) {
        this.page = page;
        page.on('close', () => {
            if (this.page !== page) return;
            this.page = this.context?.pages().filter(candidate => !candidate.isClosed()).at(-1) || null;
        });
    }

    getBrowserState() {
        const page = this.page;
        const origin = page && !page.isClosed() ? officialBrowserOrigin(page.url()) : null;
        return { available: !!(this.cloudMode && this.context && origin), origin,
            status: this.getStatus().status, ...CLOUD_VIEWPORT };
    }

    enqueueBrowserOperation(operation) {
        if (!this.cloudMode) return Promise.reject(browserError('نافذة تسجيل الدخول متاحة في نسخة الاستضافة فقط.', 404));
        if (this.pendingBrowserOperations >= 12) return Promise.reject(browserError('طلبات كثيرة. انتظر لحظة وأعد المحاولة.', 429));
        this.pendingBrowserOperations++;
        const result = this.browserQueue.then(operation);
        this.browserQueue = result.catch(() => {});
        return result.finally(() => { this.pendingBrowserOperations--; });
    }

    browserPage() {
        if (!this.context || !this.page || this.page.isClosed()) throw browserError('افتح تسجيل الدخول أولًا.');
        if (!officialBrowserOrigin(this.page.url())) throw browserError('جاري الانتقال إلى صفحة تسجيل الدخول الرسمية.');
        return this.page;
    }

    screenshot() {
        if (this.framePromise) return this.framePromise;
        this.framePromise = this.enqueueBrowserOperation(async () => {
            try {
                const page = this.browserPage();
                return await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: 5000 });
            } catch (error) {
                if (error.statusCode) throw error;
                throw browserError('تعذر عرض صفحة تسجيل الدخول الآن.', 503);
            }
        }).finally(() => { this.framePromise = null; });
        return this.framePromise;
    }

    input(payload) {
        // Reject unknown instructions before queueing; no selectors, code or arbitrary URLs are accepted.
        try { validateBrowserInput(payload); } catch (error) { return Promise.reject(error); }
        return this.enqueueBrowserOperation(async () => {
            try {
                const page = this.browserPage();
                switch (payload.action) {
                    case 'click': await page.mouse.click(payload.x, payload.y); break;
                    case 'press': await page.keyboard.press(payload.key); break;
                    case 'text': await page.keyboard.insertText(payload.text); break;
                    case 'wheel': await page.mouse.wheel(payload.deltaX, payload.deltaY); break;
                    case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }); break;
                    case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }); break;
                    case 'portal': await page.goto(MINISTRY_PORTAL, { waitUntil: 'domcontentloaded', timeout: 15_000 }); break;
                }
                return this.getBrowserState();
            } catch (error) {
                if (error.statusCode) throw error;
                throw browserError('تعذر إكمال الأمر في صفحة تسجيل الدخول. حاول مرة أخرى.', 503);
            }
        });
    }

    closeView() {
        return this.enqueueBrowserOperation(async () => {
            if (this.starting) await this.starting.catch(() => {});
            try { await this.close(); } catch { throw browserError('تعذر إغلاق نافذة تسجيل الدخول الآن.', 503); }
            return this.getBrowserState();
        });
    }

    async getCredentials() {
        if (this.cleanupRequired) throw Object.assign(new Error(CLEANUP_MESSAGE), { statusCode: 503 });
        const saved = this.store.getSecret('ministry');
        if (credentialsAreFresh(saved, this.now())) return saved;
        let resumedCloudProfile = false;
        // The cloud profile can resume its real Microsoft session after a sandbox restart.
        // Only a newly accepted Ministry employee response establishes renewed credentials.
        if (this.cloudMode && saved && !this.context) {
            resumedCloudProfile = true;
            if (!this.renewing) this.renewing = this.renewCloudProfile().finally(() => { this.renewing = null; });
            await this.renewing;
            const renewed = this.store.getSecret('ministry');
            if (credentialsAreFresh(renewed, this.now())) return renewed;
        }
        // Never unexpectedly open a login window from a phone or a background API call.
        // When the user already has the portal open, attempt one bounded refresh.
        if (!resumedCloudProfile && this.context && this.page && !this.page.isClosed()) {
            if (!this.renewing) this.renewing = this.renewFromOpenPortal().finally(() => { this.renewing = null; });
            await this.renewing;
            const renewed = this.store.getSecret('ministry');
            if (credentialsAreFresh(renewed, this.now())) return renewed;
        }
        throw Object.assign(new Error(saved
            ? (this.cloudMode ? 'انتهت جلسة الوزارة. افتح تسجيل الدخول من الموقع ثم أعد المزامنة.' : 'انتهت جلسة الوزارة. جدّد تسجيل الدخول من الكمبيوتر ثم أعد المزامنة.')
            : (this.cloudMode ? 'سجّل الدخول بحساب Microsoft من هنا وافتح قائمة العاملين أولًا.' : 'سجّل الدخول بحساب Microsoft من الكمبيوتر وافتح قائمة العاملين أولًا.')), { statusCode: 401 });
    }

    async renewCloudProfile() {
        let cleanup;
        const wait = new Promise(resolve => {
            const listener = () => { cleanup(); resolve(); };
            const timeout = setTimeout(() => { cleanup(); resolve(); }, 20_000);
            cleanup = () => { clearTimeout(timeout); this.off('credentials', listener); };
            this.on('credentials', listener);
        });
        try {
            await Promise.all([wait, this.open({ refresh: true }).catch(() => {})]);
        } finally { cleanup(); }
    }

    async renewFromOpenPortal() {
        let cleanup;
        const wait = new Promise(resolve => {
            const listener = () => { cleanup(); resolve(); };
            const timeout = setTimeout(() => { cleanup(); resolve(); }, 20_000);
            cleanup = () => { clearTimeout(timeout); this.off('credentials', listener); };
            this.on('credentials', listener);
        });
        try {
            const refreshing = this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
            await Promise.all([wait, refreshing]);
        } finally { cleanup(); }
    }

    invalidate() {
        const saved = this.store.getSecret('ministry');
        if (saved) this.store.putSecret('ministry', { ...saved, expiresAt: 0 });
        this.status = 'expired';
    }

    async close() {
        this.generation++;
        clearTimeout(this.attemptTimer);
        const context = this.context;
        if (context) await context.close();
        if (this.context === context) {
            this.context = null;
            this.page = null;
        }
    }

    async disconnect() {
        if (this.disconnecting) return this.disconnecting;
        this.disconnecting = (async () => {
            this.cleanupRequired = true;
            this.generation++;
            this.store.putSecret('ministry-cleanup', true);
            this.store.deleteSecret('ministry');
            this.status = 'disconnected';
            if (this.starting) await this.starting.catch(() => {});
            try {
                await this.close();
                rmSync(this.profileDir, { recursive: true, force: true });
                this.store.deleteSecret('ministry-cleanup');
                this.cleanupRequired = false;
                this.status = 'disconnected';
                this.message = '';
            } catch {
                this.status = 'error';
                this.message = CLEANUP_MESSAGE;
                throw Object.assign(new Error(this.message), { statusCode: 503 });
            }
        })().finally(() => { this.disconnecting = null; });
        return this.disconnecting;
    }
}
