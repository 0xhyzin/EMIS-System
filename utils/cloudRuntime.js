import { Sandbox } from '@vercel/sandbox';
import { getVercelOidcToken } from '@vercel/oidc';

export function createCloudRuntime({ env = process.env, getSandbox = Sandbox.get } = {}) {
    let resolving;
    let cached;
    async function start(sandbox) {
        const token = await getVercelOidcToken();
        await sandbox.writeFiles([{ path: '/tmp/emis-oidc.token', content: Buffer.from(token) }]);
        const result = await sandbox.runCommand({ cmd: 'bash', args: ['scripts/start-cloud-runtime.sh'], cwd: '/vercel/emis', env: {
            NODE_ENV: 'production', DATA_DIR: '/data/emis', EMIS_CLOUD: 'true', EMIS_SANDBOX_NAME: env.EMIS_SANDBOX_NAME,
            APP_ORIGIN: env.APP_ORIGIN, EMIS_PREVIEW_ORIGIN: env.EMIS_PREVIEW_ORIGIN || '',
            EMIS_OWNER_PASSWORD_HASH: env.EMIS_OWNER_PASSWORD_HASH, EMIS_SESSION_SECRET: env.EMIS_SESSION_SECRET,
            EMIS_PROXY_SECRET: env.EMIS_PROXY_SECRET, VERCEL_OIDC_TOKEN: token,
        } });
        if (result.exitCode !== 0) throw new Error('Cloud runtime startup failed.');
    }
    async function resolve() {
        if (!env.EMIS_SANDBOX_NAME || !env.EMIS_PROXY_SECRET) throw new Error('Cloud runtime is not configured.');
        const sandbox = await getSandbox({ name: env.EMIS_SANDBOX_NAME, resume: true, onResume: start });
        // Idempotent startup also covers a first session that has not run its resume hook.
        await start(sandbox);
        const origin = new URL(sandbox.domain(3000)).origin;
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                const response = await fetch(`${origin}/__health`, { headers: { 'x-emis-proxy-secret': env.EMIS_PROXY_SECRET }, signal: AbortSignal.timeout(4000), redirect: 'error' });
                if (response.ok && (await response.json()).ready) return { origin, secret: env.EMIS_PROXY_SECRET };
            } catch { /* The app is still starting after a resume. */ }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        throw new Error('Cloud runtime did not become ready.');
    }
    return { getBackend() {
        if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.backend);
        if (!resolving) resolving = resolve().then(backend => { cached = { backend, expiresAt: Date.now() + 10_000 }; return backend; }).finally(() => { resolving = undefined; });
        return resolving;
    } };
}
