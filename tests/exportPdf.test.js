import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertWordToPdf, findLibreOfficePath, PDF_MIME } from '../utils/exportPdf.js';
import { buildWordExport } from '../utils/exportWord.js';
import { createExportRouter } from '../routes/export.js';
import * as db from '../db/database.js';

const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF\n');
const converterEnv = { ...process.env, EMIS_SOFFICE_PATH: process.execPath };

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'emis-pdf-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

function xmlParts(buffer) {
    const files = {};
    for (let offset = 0; offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
        const method = buffer.readUInt16LE(offset + 8), length = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
        const start = offset + 30 + nameLength + extraLength, data = buffer.subarray(start, start + length);
        // Report content is deterministic; creation metadata has new timestamps.
        if (name.endsWith('.xml') && name !== 'docProps/core.xml') files[name] = (method === 8 ? inflateRawSync(data) : data).toString();
        offset = start + length;
    }
    return files;
}

function request(router, format, body) {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/export/${format}`, body, headers: {} });
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200, headers: {},
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            status(value) { this.statusCode = value; return this; },
            send(buffer) { resolve({ status: this.statusCode, headers: this.headers, buffer }); },
            json(value) { resolve({ status: this.statusCode, headers: this.headers, error: value.error }); },
        };
        router.handle(req, res, error => reject(error || new Error('Missing PDF export route')));
    });
}

test('converter discovery supports PATH, Mac application and Windows Program Files', async () => {
    for (const fixture of [
        { platform: 'linux', env: { PATH: '/fixture/bin' }, expected: '/fixture/bin/soffice' },
        { platform: 'darwin', env: {}, expected: '/Applications/LibreOffice.app/Contents/MacOS/soffice' },
        { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, expected: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' },
    ]) {
        assert.equal(await findLibreOfficePath({ ...fixture, isExecutable: async candidate => candidate === fixture.expected }), fixture.expected);
    }
    assert.equal(await findLibreOfficePath({ env: converterEnv }), process.execPath);
});

test('missing and invalid converter paths provide an actionable 503', async () => {
    await assert.rejects(findLibreOfficePath({ env: {}, isExecutable: async () => false }), error => error.status === 503 && error.expose && /ثبّت LibreOffice/.test(error.message));
    await assert.rejects(findLibreOfficePath({ env: { EMIS_SOFFICE_PATH: 'relative/soffice' } }), error => error.status === 503 && /المسار الكامل/.test(error.message));
    await assert.rejects(findLibreOfficePath({ env: { EMIS_SOFFICE_PATH: '/not-installed/soffice' } }), error => error.status === 503 && /EMIS_SOFFICE_PATH/.test(error.message));
});

test('conversion uses private input, isolated profile, bounded execFile arguments and cleans up', async t => {
    const tempRoot = await temporary(t), input = Buffer.from('exact original Word bytes');
    let outputDirectory;
    const result = await convertWordToPdf(input, {
        env: converterEnv, tempRoot,
        runConverter: async (executable, args, options) => {
            assert.equal(executable, process.execPath);
            outputDirectory = args[args.indexOf('--outdir') + 1];
            const inputFile = args.at(-1);
            assert.equal(dirname(inputFile), outputDirectory);
            assert.deepEqual(await readFile(inputFile), input);
            if (process.platform !== 'win32') {
                assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
                assert.equal((await stat(inputFile)).mode & 0o777, 0o600);
            }
            const profile = fileURLToPath(args.find(value => value.startsWith('-env:UserInstallation=')).slice('-env:UserInstallation='.length));
            assert.equal(profile, join(outputDirectory, 'profile'));
            assert.ok(args.includes('--headless'));
            assert.ok(args.includes('pdf:writer_pdf_Export'));
            assert.equal(options.cwd, outputDirectory);
            assert.equal(options.timeout, 60_000);
            assert.equal(options.maxBuffer, 1024 * 1024);
            assert.equal(options.killSignal, 'SIGKILL');
            assert.equal(options.shell, undefined);
            await writeFile(join(outputDirectory, 'report.pdf'), pdfBytes);
        },
    });
    assert.deepEqual(result, pdfBytes);
    assert.ok(outputDirectory.startsWith(tempRoot));
    assert.deepEqual(await readdir(tempRoot), []);
});

test('simultaneous exports use distinct document directories and profiles', async t => {
    const tempRoot = await temporary(t), directories = [], profiles = [];
    const runConverter = async (executable, args) => {
        const directory = args[args.indexOf('--outdir') + 1];
        directories.push(directory);
        profiles.push(args.find(value => value.startsWith('-env:UserInstallation=')));
        await new Promise(resolve => setTimeout(resolve, 10));
        await writeFile(join(directory, 'report.pdf'), pdfBytes);
    };
    const results = await Promise.all([1, 2].map(value => convertWordToPdf(Buffer.from(`report ${value}`), { env: converterEnv, tempRoot, runConverter })));
    assert.equal(new Set(directories).size, 2);
    assert.equal(new Set(profiles).size, 2);
    results.forEach(result => assert.deepEqual(result, pdfBytes));
    assert.deepEqual(await readdir(tempRoot), []);
});

for (const fixture of [
    { label: 'failed process', cause: new Error('private converter stderr'), status: 500, message: /تعذّر إنشاء ملف PDF/ },
    { label: 'process timeout', cause: Object.assign(new Error('private timeout'), { killed: true }), status: 504, message: /وقتًا أطول/ },
    { label: 'converter removed after discovery', cause: Object.assign(new Error('private path'), { code: 'ENOENT' }), status: 503, message: /تعذّر تشغيل LibreOffice/ },
    { label: 'missing output', status: 500, message: /لم ينشئ LibreOffice/ },
    { label: 'invalid PDF output', output: 'invalid', status: 500, message: /ملف PDF صالحًا/ },
]) {
    test(`conversion cleans up after ${fixture.label} without exposing process details`, async t => {
        const tempRoot = await temporary(t);
        await assert.rejects(convertWordToPdf(Buffer.from('Word input'), {
            env: converterEnv, tempRoot,
            runConverter: async (executable, args) => {
                if (fixture.cause) throw fixture.cause;
                if (fixture.output) await writeFile(join(args[args.indexOf('--outdir') + 1], 'report.pdf'), fixture.output);
            },
        }), error => error.status === fixture.status && error.expose === true && fixture.message.test(error.message) && !/private/.test(error.message));
        assert.deepEqual(await readdir(tempRoot), []);
    });
}

test('PDF route sends the same selected custom Word report, preserving manual data and signatures', async t => {
    const dataDir = await temporary(t);
    db.initDatabase({ dataDir });
    t.after(() => db.closeDatabase());
    const included = db.createEmployee({ fullName: 'عضو الكشف المختار' });
    const excluded = db.createEmployee({ fullName: 'خارج الكشف' });
    const list = db.createCustomList({ name: 'قائمة PDF', memberIds: [included.emp_code] });
    db.saveSetting('schoolInfo', { schoolName: 'مدرسة تجربة PDF' });
    let convertedParts;
    const router = createExportRouter({ pdfConverter: async buffer => { convertedParts = xmlParts(buffer); return pdfBytes; } });
    const options = {
        listId: list.id, memberIds: [excluded.emp_code], title: 'كشف/اختبار PDF', orientation: 'portrait', useArabicNumerals: true,
        columns: [{ path: 'fullName', label: 'اسم العامل' }, { type: 'manual', label: 'قيمة مكتوبة', manualValues: { [included.emp_code]: '00123' } }],
        footer: [{ label: 'مسؤول الإحصاء', name: 'اسم التوقيع' }],
    };
    const pdf = await request(router, 'pdf', options);
    const word = await request(router, 'word', options);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], PDF_MIME);
    assert.equal(pdf.headers['cache-control'], 'no-store');
    assert.equal(decodeURIComponent(pdf.headers['content-disposition'].split("filename*=UTF-8''")[1]), 'كشفاختبار PDF.pdf');
    assert.deepEqual(pdf.buffer, pdfBytes);
    // Compare OOXML parts, not ZIP bytes whose creation timestamps can differ.
    assert.deepEqual(convertedParts, xmlParts(word.buffer));
    assert.match(convertedParts['word/document.xml'], /عضو الكشف المختار/);
    assert.doesNotMatch(convertedParts['word/document.xml'], /خارج الكشف/);
    assert.match(convertedParts['word/document.xml'], /٠٠١٢٣/);
    assert.match(convertedParts['word/document.xml'], /w:orient="portrait"/);
    assert.match(convertedParts['word/document.xml'], /w:fill="D9D9D9"/);
    assert.match(convertedParts['word/header1.xml'], /مدرسة تجربة PDF/);
    assert.match(convertedParts['word/footer1.xml'], /اسم التوقيع/);
});

test('hourly PDF passes the identical hourly Word form to the converter', async t => {
    const dataDir = await temporary(t);
    db.initDatabase({ dataDir });
    t.after(() => db.closeDatabase());
    let convertedParts;
    const router = createExportRouter({ pdfConverter: async buffer => { convertedParts = xmlParts(buffer); return pdfBytes; } });
    const options = { modelId: 'hourly-contract-period-1', modelOptions: { subject: 'الرياضيات', periodStart: '2026-10-01', periodEnd: '2026-10-31' } };
    const pdf = await request(router, 'pdf', options);
    const word = await request(router, 'word', options);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-disposition'], /employees\.pdf/);
    assert.deepEqual(convertedParts, xmlParts(word.buffer));
    assert.match(convertedParts['word/document.xml'], /الرياضيات/);
});

test('PDF route validates before conversion and exposes the converter installation hint', async t => {
    const dataDir = await temporary(t);
    db.initDatabase({ dataDir });
    t.after(() => db.closeDatabase());
    let calls = 0;
    const router = createExportRouter({ pdfConverter: async () => {
        calls++;
        throw Object.assign(new Error('لتصدير PDF، ثبّت LibreOffice على الكمبيوتر.'), { status: 503, expose: true });
    } });
    assert.equal((await request(router, 'pdf', { columns: [] })).status, 400);
    assert.equal(calls, 0);
    const result = await request(router, 'pdf', {});
    assert.equal(result.status, 503);
    assert.match(result.error, /ثبّت LibreOffice/);
    assert.equal(calls, 1);
    const broken = createExportRouter({ pdfConverter: async () => { throw new Error('private converter details'); } });
    const failed = await request(broken, 'pdf', {});
    assert.equal(failed.status, 500);
    assert.match(failed.error, /ملف PDF/);
    assert.doesNotMatch(failed.error, /private|Word/);
});

const integrationPath = process.env.EMIS_TEST_SOFFICE_PATH || process.env.EMIS_SOFFICE_PATH;
test('installed LibreOffice renders a real Arabic report as PDF', { skip: !integrationPath }, async () => {
    const word = await buildWordExport([{ emp_code: 101, full_name: 'معلم تجربة PDF', source: 'manual', staff_type: 'core', raw_data: {} }], {
        title: 'تجربة التصدير', orientation: 'portrait',
        columns: [{ path: 'fullName', label: 'الاسم' }, { type: 'manual', label: 'القيمة', manualValues: { 101: '00123' } }],
        footer: [{ label: 'الإحصاء', name: 'اسم الموقّع' }],
    });
    const pdf = await convertWordToPdf(word, { env: { ...process.env, EMIS_SOFFICE_PATH: integrationPath } });
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.length > 1000);
});
