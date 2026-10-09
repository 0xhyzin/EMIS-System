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
    constructor({ dataDir, store, browserPath = findBrowser(), launcher, now = () => Date.now() }) {
        super();
        this.store = store;
        this.now = now;
        this.browserPath = browserPath;
        this.launcher = launcher;
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
    }

    getStatus() {
        const credentials = this.store.getSecret('ministry');
        const connected = !this.cleanupRequired && credentialsAreFresh(credentials, this.now());
        const status = connected ? 'connected' : ['opening', 'waiting', 'error'].includes(this.status)
            ? this.status : credentials ? 'expired' : 'disconnected';
        const messages = {
            connected: 'تم الاتصال بحساب المدرسة، وتُحفظ الجلسة على هذا الجهاز.',
            disconnected: 'سجّل الدخول من هذا الكمبيوتر بحساب Microsoft الخاص بموقع الوزارة.',
            expired: 'انتهت صلاحية اتصال الوزارة. افتح تسجيل الدخول لتجديده؛ بياناتك المحفوظة متاحة.',
            opening: 'جاري فتح متصفح تسجيل الدخول على الكمبيوتر…',
            waiting: 'أكمل تسجيل الدخول في المتصفح، ثم افتح قائمة العاملين في موقع الوزارة.',
            error: this.message || 'تعذر فتح تسجيل الدخول. تأكد من تثبيت Chrome أو Edge أو Chromium.',
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
            this.message = 'ثبّت Chrome أو Edge أو Chromium على الكمبيوتر، ثم أعد تشغيل البرنامج.';
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
                    viewport: null,
                    timeout: 25_000,
                });
                const context = this.context;
                const generation = this.generation;
                context.on('response', response => void this.handleResponse(response, generation));
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
            this.message = 'تعذر فتح موقع الوزارة. تحقق من الإنترنت، ووجود متصفح مدعوم وواجهة سطح مكتب على الكمبيوتر.';
            throw Object.assign(new Error(this.message), { statusCode: 503 });
        }
    }

    async getCredentials() {
        if (this.cleanupRequired) throw Object.assign(new Error(CLEANUP_MESSAGE), { statusCode: 503 });
        const saved = this.store.getSecret('ministry');
        if (credentialsAreFresh(saved, this.now())) return saved;
        // Never unexpectedly open a login window from a phone or a background API call.
        // When the user already has the portal open, attempt one bounded refresh.
        if (this.context && this.page && !this.page.isClosed()) {
            if (!this.renewing) this.renewing = this.renewFromOpenPortal().finally(() => { this.renewing = null; });
            await this.renewing;
            const renewed = this.store.getSecret('ministry');
            if (credentialsAreFresh(renewed, this.now())) return renewed;
        }
        throw Object.assign(new Error(saved
            ? 'انتهت جلسة الوزارة. جدّد تسجيل الدخول من الكمبيوتر ثم أعد المزامنة.'
            : 'سجّل الدخول بحساب Microsoft من الكمبيوتر وافتح قائمة العاملين أولًا.'), { statusCode: 401 });
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
