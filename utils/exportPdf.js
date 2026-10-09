import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const PDF_MIME = 'application/pdf';
const runFile = promisify(execFile);

function pdfError(message, status = 500, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.status = status;
    // Only these fixed, user-facing messages may be exposed by the route.
    error.expose = true;
    return error;
}

async function executableFile(filename, platform) {
    try {
        await access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return (await stat(filename)).isFile();
    } catch { return false; }
}

/** Find an installed converter; no developer-machine paths are embedded here. */
export async function findLibreOfficePath({ env = process.env, platform = process.platform, isExecutable = executableFile } = {}) {
    const paths = platform === 'win32' ? win32 : { isAbsolute, join };
    if (env.EMIS_SOFFICE_PATH) {
        if (paths.isAbsolute(env.EMIS_SOFFICE_PATH) && await isExecutable(env.EMIS_SOFFICE_PATH, platform)) return env.EMIS_SOFFICE_PATH;
        throw pdfError('تعذّر العثور على LibreOffice في المسار المحدد. راجع EMIS_SOFFICE_PATH واكتب المسار الكامل للبرنامج.', 503);
    }
    const names = platform === 'win32' ? ['soffice.com', 'soffice.exe', 'libreoffice.exe'] : ['libreoffice', 'soffice'];
    const searchPaths = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(path => path && paths.isAbsolute(path));
    const candidates = searchPaths.flatMap(path => names.map(name => paths.join(path, name)));
    if (platform === 'darwin') {
        candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
        if (env.HOME) candidates.push(join(env.HOME, 'Applications/LibreOffice.app/Contents/MacOS/soffice'));
    } else if (platform === 'win32') {
        for (const directory of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
            for (const name of ['soffice.com', 'soffice.exe']) candidates.push(win32.join(directory, 'LibreOffice', 'program', name));
        }
        if (env.LOCALAPPDATA) {
            for (const name of ['soffice.com', 'soffice.exe']) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', name));
        }
    } else {
        candidates.push('/usr/bin/libreoffice', '/usr/bin/soffice', '/usr/local/bin/libreoffice', '/opt/libreoffice/program/soffice');
    }
    for (const candidate of new Set(candidates)) {
        if (await isExecutable(candidate, platform)) return candidate;
    }
    throw pdfError('لتصدير PDF، ثبّت LibreOffice على الكمبيوتر الذي يشغّل البرنامج، ثم أعد المحاولة. يمكنك تحديد المسار الكامل للبرنامج في EMIS_SOFFICE_PATH.', 503);
}

/** Render the existing Word file so PDF keeps exactly the same report content. */
export async function convertWordToPdf(wordBuffer, { env = process.env, platform = process.platform, runConverter = runFile, tempRoot = tmpdir() } = {}) {
    const converter = await findLibreOfficePath({ env, platform });
    const directory = await mkdtemp(join(tempRoot, 'emis-pdf-'));
    try {
        await chmod(directory, 0o700);
        const input = join(directory, 'report.docx');
        await writeFile(input, wordBuffer, { mode: 0o600 });
        // Separate profiles allow simultaneous exports without touching an open
        // LibreOffice session or sharing locks between employee reports.
        const profile = pathToFileURL(join(directory, 'profile')).href;
        try {
            await runConverter(converter, [
                `-env:UserInstallation=${profile}`, '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
                '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory, input,
            ], { env, cwd: directory, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
        } catch (cause) {
            if (cause.code === 'ENOENT' || cause.code === 'EACCES') throw pdfError('تعذّر تشغيل LibreOffice لتصدير PDF. تأكد من تثبيته ومن صحة المسار في EMIS_SOFFICE_PATH.', 503, cause);
            if (cause.killed && cause.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw pdfError('استغرق إنشاء PDF وقتًا أطول من المسموح. جرّب تصدير عدد أقل من العاملين ثم أعد المحاولة.', 504, cause);
            throw pdfError('تعذّر إنشاء ملف PDF. تأكد من عمل LibreOffice وحاول مرة أخرى.', 500, cause);
        }
        let buffer;
        try { buffer = await readFile(join(directory, 'report.pdf')); }
        catch (cause) { throw pdfError('لم ينشئ LibreOffice ملف PDF. راجع إعدادات الكشف وحاول مرة أخرى.', 500, cause); }
        if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw pdfError('لم ينتج LibreOffice ملف PDF صالحًا. حاول التصدير مرة أخرى.', 500);
        return buffer;
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}
