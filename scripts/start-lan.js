import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const virtualInterface = /^(?:lo\d*$|docker|veth|br-|bridge|virbr|vmnet|vbox|tun\d|tap\d|utun|wg\d|tailscale|zt[a-z0-9]|vpn|ve-|vEthernet)/i;

export function isPrivateIPv4(address) {
    if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
    const parts = address.split('.').map(Number);
    if (parts.some(part => part > 255)) return false;
    return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function interfacePriority(name) {
    if (/^(?:eth\d|en\d|en[opsx]|ethernet(?:\s|$))/i.test(name)) return 0;
    if (/^(?:wlan|wl[pax]|wifi|wi-fi|wireless)/i.test(name)) return 1;
    return 2;
}

export function findLanAddresses(interfaces) {
    const candidates = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        if (virtualInterface.test(name)) continue;
        for (const entry of entries || []) {
            if (entry.internal || !['IPv4', 4].includes(entry.family) || !isPrivateIPv4(entry.address)) continue;
            if (!candidates.some(candidate => candidate.name === name && candidate.address === entry.address)) {
                candidates.push({ name, address: entry.address });
            }
        }
    }
    return candidates.sort((a, b) => interfacePriority(a.name) - interfacePriority(b.name)
        || a.name.localeCompare(b.name, 'en', { numeric: true })
        || a.address.localeCompare(b.address, 'en', { numeric: true }));
}

export function lanConfiguration(env, interfaces) {
    const candidates = findLanAddresses(interfaces);
    let suppliedOrigin = null;
    if (env.APP_ORIGIN) {
        try { suppliedOrigin = new URL(env.APP_ORIGIN); }
        catch { throw new Error('APP_ORIGIN غير صحيح. استخدم عنوانًا مثل http://192.168.1.20:3000.'); }
        if (!['http:', 'https:'].includes(suppliedOrigin.protocol) || suppliedOrigin.username || suppliedOrigin.password
            || suppliedOrigin.pathname !== '/' || suppliedOrigin.search || suppliedOrigin.hash || !isPrivateIPv4(suppliedOrigin.hostname)) {
            throw new Error('تشغيل الهاتف يقبل عنوان IPv4 خاصًا داخل الشبكة فقط، دون مسار أو بيانات دخول في APP_ORIGIN.');
        }
    }
    const inferredPort = suppliedOrigin?.protocol === 'http:' ? suppliedOrigin.port || '80' : '3000';
    const port = Number(env.PORT || (suppliedOrigin ? inferredPort : '3000'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT يجب أن يكون رقم منفذ بين 1 و65535.');
    if (suppliedOrigin?.protocol === 'http:' && Number(suppliedOrigin.port || 80) !== port) {
        throw new Error('منفذ APP_ORIGIN يجب أن يطابق PORT عند تشغيل الهاتف عبر HTTP.');
    }
    if (!suppliedOrigin && !candidates.length) {
        throw new Error('لم أجد عنوان شبكة محلية مناسبًا. اتصل بشبكة Wi-Fi أو Ethernet ثم أعد المحاولة. يمكنك تحديد APP_ORIGIN بعنوان IPv4 محلي صحيح.');
    }
    const selected = suppliedOrigin
        ? candidates.find(candidate => candidate.address === suppliedOrigin.hostname) || { name: 'APP_ORIGIN', address: suppliedOrigin.hostname }
        : candidates[0];
    const origin = suppliedOrigin?.origin || `http://${selected.address}:${port}`;
    return {
        candidates, selected, origin, port,
        childEnv: { ...env, HOST: '0.0.0.0', PORT: String(port), APP_ORIGIN: origin, ALLOW_INSECURE_LAN: 'true' },
    };
}

export function startLan({ env = process.env, interfaces = networkInterfaces(), spawnImpl = spawn } = {}) {
    const config = lanConfiguration(env, interfaces);
    console.log('تشغيل الهاتف على شبكة المنزل أو المدرسة الموثوقة. اترك هذا الكمبيوتر والبرنامج يعملان.');
    if (config.origin.startsWith('http:')) console.log('اتصال الشبكة المحلية HTTP غير مشفّر؛ لا تستخدم شبكة عامة ولا تفتح منفذ البرنامج على الإنترنت.');
    if (config.candidates.length > 1) {
        console.log('عناوين الشبكة المتاحة (يمكن اختيار عنوان آخر باستخدام APP_ORIGIN):');
        for (const candidate of config.candidates) console.log(`  ${candidate.address === config.selected.address ? '*' : '-'} ${candidate.name}: ${candidate.address}`);
    }
    console.log(`على الكمبيوتر: http://localhost:${config.port} — افتح «الربط والإعدادات» ثم «إنشاء رمز ربط جهاز» للحصول على الرمز.`);
    console.log(`على الهاتف: ${config.origin}`);
    const child = spawnImpl(process.execPath, [join(projectDir, 'server.js')], {
        cwd: projectDir,
        env: config.childEnv,
        stdio: 'inherit',
    });
    const forwardInterrupt = () => { if (!child.killed) child.kill('SIGINT'); };
    const forwardTerminate = () => { if (!child.killed) child.kill('SIGTERM'); };
    const cleanup = () => {
        process.off('SIGINT', forwardInterrupt);
        process.off('SIGTERM', forwardTerminate);
    };
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);
    child.once('error', () => {
        cleanup();
        console.error('تعذر تشغيل الخادم. تأكد من تثبيت Node.js والتبعيات ثم أعد المحاولة.');
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        cleanup();
        process.exitCode = Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    });
    return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { startLan(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
