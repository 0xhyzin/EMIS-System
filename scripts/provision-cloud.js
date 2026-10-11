import { Sandbox, Drive } from '@vercel/sandbox';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { hashOwnerPassword } from '../utils/cloudSession.js';

const root = resolve(import.meta.dirname, '..');
const privateDir = resolve(root, 'work/cloud-deploy');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const configPath = resolve(privateDir, 'secrets.json');
let config;
if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8'));
else {
    const password = randomBytes(24).toString('base64url');
    config = { EMIS_CLOUD: 'true', EMIS_SANDBOX_NAME: 'emis-school-v210', APP_ORIGIN: 'https://emis-system.vercel.app',
        EMIS_PREVIEW_ORIGIN: 'https://emis-system-git-codex-emis-290-0xhyzins-projects.vercel.app',
        EMIS_OWNER_PASSWORD_HASH: hashOwnerPassword(password), EMIS_SESSION_SECRET: randomBytes(48).toString('base64url'),
        EMIS_PROXY_SECRET: randomBytes(48).toString('base64url') };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    writeFileSync(resolve(privateDir, 'owner-password.txt'), password, { mode: 0o600, flag: 'wx' });
}
async function run(sandbox, params, label) {
    console.log(label);
    const result = await sandbox.runCommand(params);
    if (result.exitCode !== 0) {
        const error = await result.stderr();
        // Installation output contains no application credentials.
        console.log(error.slice(-2500));
        throw new Error(`${label} failed (${result.exitCode})`);
    }
}
const drive = await Drive.getOrCreate({ name: 'emis-school-data', region: 'iad1', maxSize: 1024 * 1024 * 1024 });
const sandbox = await Sandbox.getOrCreate({ name: config.EMIS_SANDBOX_NAME, image: 'vercel/sandbox/node:24', region: 'iad1',
    mounts: { '/data': drive }, ports: [3000], resources: { vcpus: 1 }, timeout: 45 * 60_000, persistent: true,
    snapshotExpiration: 0, keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true }, resume: true });
writeFileSync(resolve(privateDir, 'sandbox.json'), JSON.stringify({ name: sandbox.name, drive: drive.name }), { mode: 0o600 });
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    .filter(file => file && !/^(data|work|outputs|node_modules|\.git|\.vercel)(\/|$)|^\.env/.test(file));
for (let index = 0; index < files.length; index += 20) {
    await sandbox.writeFiles(files.slice(index, index + 20).map(file => ({ path: `/vercel/emis/${file}`, content: readFileSync(resolve(root, file)) })));
}
await run(sandbox, { cmd: 'npm', args: ['ci', '--omit=dev', '--no-audit', '--no-fund'], cwd: '/vercel/emis', timeoutMs: 180_000 }, 'Installing application dependencies');
await run(sandbox, { cmd: 'apt-get', args: ['update'], sudo: true, timeoutMs: 180_000 }, 'Preparing system packages');
await run(sandbox, { cmd: 'apt-get', args: ['install', '-y', '--no-install-recommends', 'libreoffice-writer', 'xvfb', 'fonts-noto-core', 'fonts-liberation', 'util-linux', 'procps'], sudo: true,
    env: { DEBIAN_FRONTEND: 'noninteractive' }, timeoutMs: 300_000 }, 'Installing PDF and browser display tools');
await run(sandbox, { cmd: 'node', args: ['node_modules/playwright-core/cli.js', 'install-deps', 'chromium'], cwd: '/vercel/emis', sudo: true, timeoutMs: 240_000 }, 'Installing browser system libraries');
await run(sandbox, { cmd: 'node', args: ['node_modules/playwright-core/cli.js', 'install', 'chromium'], cwd: '/vercel/emis', timeoutMs: 240_000 }, 'Installing Chromium');
await run(sandbox, { cmd: 'bash', args: ['scripts/start-cloud-runtime.sh'], cwd: '/vercel/emis', env: { ...config, DATA_DIR: '/data/emis', NODE_ENV: 'production', VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN } }, 'Starting cloud runtime');
writeFileSync(resolve(privateDir, 'runtime-origin.txt'), sandbox.domain(3000), { mode: 0o600 });
console.log(JSON.stringify({ provisioned: true, name: sandbox.name }));
