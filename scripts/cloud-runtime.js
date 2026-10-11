import { createApp } from '../server.js';
import { closeDatabase } from '../db/database.js';
import { Sandbox } from '@vercel/sandbox';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

if (process.env.EMIS_CLOUD !== 'true' || !process.env.EMIS_SANDBOX_NAME) throw new Error('Cloud runtime configuration is required.');
process.env.EMIS_BROWSER_PATH ||= chromium.executablePath();
const app = createApp();
const server = app.listen(3000, '0.0.0.0');
writeFileSync('/tmp/emis-server.pid', String(process.pid), { mode: 0o600 });
let stopping = false;
async function stop(stopSandbox = false) {
    if (stopping) return;
    stopping = true;
    clearInterval(idleTimer);
    server.close();
    server.closeAllConnections();
    try { await app.locals.auth.close(); } finally { closeDatabase(); }
    if (stopSandbox) {
        try {
            if (existsSync('/tmp/emis-oidc.token')) process.env.VERCEL_OIDC_TOKEN = readFileSync('/tmp/emis-oidc.token', 'utf8');
            const sandbox = await Sandbox.get({ name: process.env.EMIS_SANDBOX_NAME });
            await sandbox.stop();
        } catch { /* A session deadline can stop the VM before this request completes. */ }
    }
    process.exit(0);
}
// Status polling does not keep an unused school session running.
const idleTimer = setInterval(() => {
    if (!app.locals.cloudActiveRequests && Date.now() - app.locals.cloudLastActivity > 5 * 60_000) void stop(true);
}, 30_000);
idleTimer.unref();
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
