import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as db from '../db/database.js';
import { createAssistantRouter } from '../routes/assistant.js';
import { createGroqAssistantProvider, DEFAULT_ASSISTANT_MODEL } from '../utils/assistantProvider.js';
import { createUnifiedEmailService } from '../utils/unifiedEmail.js';

const fakeImage = { mimeType: 'image/png', dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') };
const toolCall = (name, args) => ({ id: 'call_example', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const mockProvider = replies => ({ model: DEFAULT_ASSISTANT_MODEL, status: () => ({ available: true, model: DEFAULT_ASSISTANT_MODEL }),
    async chat(messages) { return typeof replies === 'function' ? replies(messages) : replies.shift(); } });

function request(router, method, path, body, auth = { local: true }) {
    const req = Object.assign(new EventEmitter(), { method, url: path, originalUrl: path, body, auth, headers: {} });
    return new Promise((resolve, reject) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {},
            status(code) { this.statusCode = code; return this; },
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            getHeader(name) { return this.headers[name.toLowerCase()]; },
            json(value) { resolve({ status: this.statusCode, body: value, headers: this.headers }); return this; },
            send(value) { resolve({ status: this.statusCode, body: value, headers: this.headers }); return this; },
        });
        router.handle(req, res, error => error ? reject(error) : reject(new Error(`Missing route: ${method} ${path}`)));
    });
}

function zipXml(buffer, part = 'word/document.xml') {
    for (let offset = 0; offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
        const method = buffer.readUInt16LE(offset + 8), length = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
        const start = offset + 30 + nameLength + extraLength;
        if (name === part) return (method === 8 ? inflateRawSync(buffer.subarray(start, start + length)) : buffer.subarray(start, start + length)).toString();
        offset = start + length;
    }
    throw new Error(`Missing export part: ${part}`);
}
const wordXml = buffer => zipXml(buffer);

test('Groq status checks the key and model, caches only a verified result, and never returns the key', async () => {
    let requests = 0;
    const provider = createGroqAssistantProvider({ now: () => 1000, fetchImpl: async (url, init) => {
        requests++;
        assert.equal(url, 'https://api.groq.com/openai/v1/models');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        return init.headers.Authorization === 'Bearer correct-key'
            ? new Response(JSON.stringify({ data: [{ id: DEFAULT_ASSISTANT_MODEL }] }), { status: 200 })
            : new Response('', { status: 401 });
    } });
    assert.equal((await provider.status(null)).available, false);
    assert.equal(requests, 0);
    const ready = await provider.status('correct-key');
    assert.equal(ready.available, true);
    assert.equal(JSON.stringify(ready).includes('correct-key'), false);
    assert.equal((await provider.status('correct-key')).available, true);
    assert.equal(requests, 1, 'recently verified model status should be cached');
    const invalid = await provider.status('wrong-key');
    assert.equal(invalid.available, false);
    assert.match(invalid.message, /مفتاح/);
    assert.equal(requests, 2);
});

test('Groq sends a vision-only image as a data URL and reports limit and retired-model errors clearly', async () => {
    let payload;
    const provider = createGroqAssistantProvider({ fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(init.headers.Authorization, 'Bearer secret-for-test');
        assert.equal(init.redirect, 'error');
        payload = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'شايفة الصورة.' } }] }), { status: 200 });
    } });
    await provider.chat([{ role: 'user', content: 'اقرأ الصورة', image: fakeImage }], [], 'secret-for-test');
    assert.equal(payload.reasoning_effort, 'none');
    assert.equal(payload.max_completion_tokens, 450);
    assert.equal(payload.tools, undefined, 'vision-only first pass should not send tool schemas');
    assert.equal(payload.parallel_tool_calls, undefined);
    assert.equal(payload.messages[0].content[1].image_url.url, `data:image/png;base64,${fakeImage.dataBase64}`);
    assert.equal(JSON.stringify(payload).includes('secret-for-test'), false);
    for (const [status, expected] of [[429, /حد الاستخدام/], [404, /النموذج|نموذج/]]) {
        const failing = createGroqAssistantProvider({ fetchImpl: async () => new Response('', { status, headers: { 'retry-after': '7' } }) });
        await assert.rejects(failing.chat([{ role: 'user', content: 'تجربة' }], [], 'secret-for-test'), error => {
            assert.match(error.message, expected);
            if (status === 429) assert.equal(error.retryAfter, 7);
            return true;
        });
    }
});

test('Groq 429 distinguishes an oversized first request from used quota without leaking provider details', async () => {
    const cases = [
        {
            detail: 'Request too large for model `qwen/qwen3.8-27b` in organization `org_private` on tokens per minute (TPM): Limit 8,000, Used 0, Requested ~12,345. key-secret',
            retry: '50.1', match: /الطلب نفسه أكبر|الانتظار وحده/, noRetry: true,
        },
        {
            detail: 'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_private` on tokens per minute (TPM): Limit 8000, Used 0, Requested 9000. key-secret',
            retry: '22', match: /الطلب نفسه أكبر|الانتظار وحده/, noRetry: true,
        },
        {
            detail: 'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_private` on tokens per minute (TPM): Limit 8000, Used 7700, Requested 700. key-secret',
            retry: '3.2', match: /حد الاستخدام المؤقت/, expectedRetry: 4,
        },
        {
            detail: 'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_private` on tokens per day (TPD): Limit 200000, Used 199900, Requested 500. key-secret',
            retry: '120', match: /حد الاستخدام اليومي/, expectedRetry: 120,
        },
    ];
    for (const item of cases) {
        const provider = createGroqAssistantProvider({ fetchImpl: async () => new Response(JSON.stringify({ error: {
            message: item.detail, type: 'tokens', code: 'rate_limit_exceeded',
        } }), { status: 429, headers: { 'retry-after': item.retry } }) });
        await assert.rejects(provider.chat([{ role: 'user', content: 'السلام عليكم' }], [], 'key-secret'), error => {
            assert.equal(error.status, 429);
            assert.match(error.message, item.match);
            assert.doesNotMatch(error.message, /key-secret|org_private/);
            assert.equal(error.retryAfter, item.noRetry ? undefined : item.expectedRetry);
            return true;
        });
    }
});

test('Groq model check explains a 429 on a new key as account-level, without claiming prior use', async () => {
    const provider = createGroqAssistantProvider({ fetchImpl: async () => new Response(JSON.stringify({ error: {
        message: 'Rate limit reached for model `example` in organization `org_private` on requests per minute (RPM): Limit 30, Used 30, Requested 1.',
    } }), { status: 429, headers: { 'retry-after': '2' } }) });
    const result = await provider.status('brand-new-key');
    assert.equal(result.available, false);
    assert.match(result.message, /المفتاح الجديد يشترك في حدود الحساب/);
    assert.doesNotMatch(result.message, /brand-new-key|org_private|استخدمتِ المفتاح/);
});

test('search sends only a compact matching employee summary to the provider', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-workflow-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    const person = db.createEmployee({ fullName: 'أحمد حسن', nationalId: '29901011234567', notes: 'سر محلي لا يلزم إرساله' });
    let result;
    const provider = mockProvider(messages => {
        if (messages.some(message => message.role === 'tool')) {
            result = JSON.parse(messages.at(-1).content);
            return { content: 'وجدت أحمد.' };
        }
        return { tool_calls: [toolCall('search_employees', { query: 'أحمد' })] };
    });
    const router = createAssistantRouter({ provider, getApiKey: () => 'fixture-key' });
    const response = await request(router, 'POST', '/chat', { message: 'ابحث عن أحمد', history: [] });
    assert.equal(response.status, 200);
    assert.equal(result.employees[0].empCode, person.emp_code);
    assert.equal(JSON.stringify(result).includes('29901011234567'), false);
    assert.equal(JSON.stringify(result).includes('سر محلي'), false);
});

test('an image-only tool call cannot stage a write and same-second employee edits invalidate a pending confirmation', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-confirm-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    let provider = mockProvider([{ tool_calls: [toolCall('create_employee', { employee: { fullName: 'اسم من الصورة' } })] }]);
    let router = createAssistantRouter({ provider, getApiKey: () => 'fixture-key' });
    const rejected = await request(router, 'POST', '/chat', { message: '', image: fakeImage, history: [] });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.pendingAction, undefined);
    assert.equal(db.getEmployeeCount().total, 0);
    const person = db.createEmployee({ fullName: 'موظف للتعديل', notes: 'الأصل' });
    provider = mockProvider([{ tool_calls: [toolCall('update_employee', { empCode: person.emp_code, changes: { notes: 'من المساعد' } })] }]);
    router = createAssistantRouter({ provider, getApiKey: () => 'fixture-key' });
    const staged = await request(router, 'POST', '/chat', { message: 'عدل ملاحظات الموظف', history: [] });
    assert.equal(staged.status, 200);
    assert.ok(staged.body.pendingAction?.token);
    const timestamp = db.getEmployee(person.emp_code).last_updated;
    db.updateEmployee(person.emp_code, { notes: 'تعديل من صفحة الموظف' });
    assert.equal(db.getEmployee(person.emp_code).last_updated, timestamp, 'fixture proves the old timestamp check could miss this edit');
    const confirm = await request(router, 'POST', '/confirm', { token: staged.body.pendingAction.token });
    assert.equal(confirm.status, 409);
    assert.equal(db.getEmployee(person.emp_code).raw_data.notes, 'تعديل من صفحة الموظف');
});

test('a photo-based Word request exports only selected matched people in their requested order', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-word-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    const first = db.createEmployee({ fullName: 'ألف خارج الكشف' });
    const second = db.createEmployee({ fullName: 'باء داخل الكشف' });
    const provider = mockProvider([{ tool_calls: [toolCall('export_custom_word', {
        title: 'كشف من الصورة', columns: [{ path: 'index' }, { path: 'fullName' }], memberIds: [second.emp_code],
    })] }]);
    const router = createAssistantRouter({ provider, getApiKey: () => 'fixture-key' });
    const generated = await request(router, 'POST', '/chat', { message: 'اعملي كشف Word للناس اللي في الصورة', image: fakeImage, history: [] });
    assert.equal(generated.status, 200);
    assert.ok(generated.body.download?.url);
    const file = await request(router, 'GET', generated.body.download.url.replace('/api/assistant', ''), undefined);
    assert.equal(file.status, 200);
    const xml = wordXml(file.body);
    assert.match(xml, /باء داخل الكشف/);
    assert.doesNotMatch(xml, /ألف خارج الكشف/);
    assert.equal(db.getEmployeeCount().total, 2);
    const noneSelected = createAssistantRouter({ provider: mockProvider([{ tool_calls: [toolCall('export_custom_word', {
        title: 'كشف', columns: [{ path: 'fullName' }],
    })] }]), getApiKey: () => 'fixture-key' });
    const safe = await request(noneSelected, 'POST', '/chat', { message: '', image: fakeImage, history: [] });
    assert.equal(safe.status, 200);
    assert.equal(safe.body.download, undefined);
    assert.match(safe.body.reply, /الصورة/);
    assert.ok(first.emp_code !== second.emp_code);
});

test('ministry alternate contact changes use the shared service only after a separate confirmation', async () => {
    const calls = [];
    const account = { empCode: 101, empName: 'معلمة تجريبية', empEmail: 'unified@example.com', jobTitle: 'معلم', altEmail: 'old@example.com', mobile: '01012345678' };
    const emailService = { async get(id) { assert.equal(id, 101); calls.push('read'); return { ...account }; },
        async update(id, patch) { calls.push('write'); assert.equal(id, 101); assert.deepEqual(patch, {
            field: 'altEmail', value: 'new@example.com', previousValue: 'old@example.com', expectedEmpCode: 101,
        }); return { success: true, employee: { ...account, altEmail: patch.value } }; } };
    const provider = mockProvider([{ tool_calls: [toolCall('update_unified_email', { empCode: 101, field: 'altEmail', value: 'new@example.com' })] }]);
    const router = createAssistantRouter({ provider, getApiKey: () => 'fixture-key', emailService });
    const staged = await request(router, 'POST', '/chat', { message: 'غيري الإيميل البديل للمعلمة', history: [] });
    assert.equal(staged.status, 200);
    assert.deepEqual(calls, ['read']);
    assert.match(staged.body.pendingAction.details, /old@example.com/);
    assert.match(staged.body.pendingAction.details, /new@example.com/);
    const result = await request(router, 'POST', '/confirm', { token: staged.body.pendingAction.token });
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ['read', 'write']);
    assert.equal(result.body.result.employee.altEmail, 'new@example.com');
});

test('assistant email confirmation works with the real strict shared service contract', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-email-contract-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    const person = db.createEmployee({ fullName: 'معلمة تجريبية للبريد', empCode: '101' });
    let account = { empCode: 101, empName: person.full_name, empEmail: 'unified@example.com', altEmail: 'old@example.com', mobile: '01012345678' };
    const writes = [];
    const emailService = createUnifiedEmailService({ credentials: async () => ({ school: { ed: 1, sc: 1 }, headers: {} }),
        invalidateMinistryCredentials() {}, fetchImpl: async (url, init) => {
            if (url.endsWith('GetEmployeeUnifiedEmailInfo')) return new Response(JSON.stringify(account));
            assert.ok(url.endsWith('UpdateEmployeeAltEmail'));
            const payload = JSON.parse(init.body); writes.push(payload);
            account = { ...account, altEmail: payload.altEmail };
            return new Response(JSON.stringify({ success: true }));
        } });
    const router = createAssistantRouter({ provider: mockProvider([{ tool_calls: [toolCall('update_unified_email', {
        empCode: person.emp_code, field: 'altEmail', value: 'new@example.com',
    })] }]), getApiKey: () => 'fixture-key', emailService });
    const staged = await request(router, 'POST', '/chat', { message: 'غير البريد البديل للمعلمة', history: [] });
    assert.equal(staged.status, 200); assert.deepEqual(writes, []);
    const confirmed = await request(router, 'POST', '/confirm', { token: staged.body.pendingAction.token });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(writes, [{ empCode: 101, altEmail: 'new@example.com' }]);
    assert.equal(confirmed.body.result.employee.altEmail, 'new@example.com');
    assert.equal((await request(router, 'POST', '/confirm', { token: staged.body.pendingAction.token })).status, 404);
});

test('assistant custom tables honor Excel selection or an explicit format in the message, preserving selected people', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-excel-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    const excluded = db.createEmployee({ fullName: 'ألف خارج الكشف' });
    const selected = db.createEmployee({ fullName: 'باء في الكشف', nationalId: '29901011234567' });
    for (const [message, selection, expected] of [
        ['اعمل كشف للأسماء المحددة', 'excel', 'excel'], ['اعمل كشف Excel للأسماء المحددة', 'word', 'excel'],
        ['اعمل كشف Word للأسماء المحددة', 'excel', 'word'], ['اعمل كشف اكسل للأسماء المحددة', undefined, 'excel'],
        ['اعمل كشف للأسماء المحددة', 'pdf', 'pdf'], ['اعمل كشف PDF للأسماء المحددة', 'word', 'pdf'],
        ['اعمل كشف Word للأسماء المحددة', 'pdf', 'word'], ['اعمل بي دي اف للأسماء المحددة', undefined, 'pdf'],
    ]) {
        const router = createAssistantRouter({ provider: mockProvider([{ tool_calls: [toolCall('export_custom_word', {
            title: 'كشف مختار', columns: [{ path: 'fullName' }, { path: 'basicInfo.nationalIdNum' }], memberIds: [selected.emp_code],
        })] }]), getApiKey: () => 'fixture-key', pdfConverter: async buffer => {
            assert.match(wordXml(buffer), /باء في الكشف/);
            assert.doesNotMatch(wordXml(buffer), /ألف خارج الكشف/);
            return Buffer.from('%PDF-1.7\nfixture');
        } });
        const result = await request(router, 'POST', '/chat', { message, exportFormat: selection, history: [] });
        assert.equal(result.status, 200);
        assert.ok(result.body.download?.filename.endsWith(expected === 'pdf' ? '.pdf' : expected === 'excel' ? '.xlsx' : '.docx'));
        const file = await request(router, 'GET', result.body.download.url.replace('/api/assistant', ''), undefined);
        assert.equal(file.status, 200);
        assert.equal(file.headers['content-type'], expected === 'pdf' ? 'application/pdf' : expected === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        if (expected === 'word') assert.match(wordXml(file.body), /باء في الكشف/);
        else if (expected === 'pdf') assert.equal(file.body.toString(), '%PDF-1.7\nfixture');
        else {
            const strings = zipXml(file.body, 'xl/sharedStrings.xml');
            assert.match(strings, /باء في الكشف/); assert.match(strings, /29901011234567/); assert.doesNotMatch(strings, /ألف خارج الكشف/);
        }
        assert.equal(db.getEmployee(excluded.emp_code).full_name, 'ألف خارج الكشف');
    }
    const invalid = createAssistantRouter({ provider: mockProvider([]), getApiKey: () => 'fixture-key' });
    assert.equal((await request(invalid, 'POST', '/chat', { message: 'اعمل كشف', exportFormat: 'csv' })).status, 400);
});

test('assistant field lookup and custom exports include named local fields and later qualification records', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'emis-assistant-report-fields-'));
    db.initDatabase({ dataDir: directory });
    t.after(() => { db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    db.upsertEmployee(101, '', 'معلم بيانات إضافية', {
        basicInfo: { empCode: 101, empFirstName: 'معلم', empFatherName: 'بيانات إضافية' },
        qlf: [{ qlfName: 'مؤهل أول' }, { qlfName: 'مؤهل ثان للتصدير' }],
        customFields: [{ label: 'عمل إضافي', value: 'مشرف نشاط تجريبي' }],
    });
    const customPath = `customField:${encodeURIComponent('عمل إضافي')}`;
    for (const format of ['word', 'excel']) {
        let lookedUp = false;
        const router = createAssistantRouter({ provider: mockProvider(messages => {
            if (!messages.some(message => message.role === 'tool')) return { tool_calls: [toolCall('list_report_fields', { query: 'عمل إضافي' })] };
            const fields = JSON.parse(messages.at(-1).content);
            assert.ok(fields.fields.some(field => field.path === customPath)); lookedUp = true;
            return { tool_calls: [toolCall('export_custom_word', { title: 'كشف البيانات الإضافية', memberIds: [101],
                columns: [{ path: 'fullName' }, { path: customPath }, { path: 'qlf.1.qlfName' }] })] };
        }), getApiKey: () => 'fixture-key' });
        const result = await request(router, 'POST', '/chat', { message: 'اعملي كشف بالعمل الإضافي والمؤهل الثاني', exportFormat: format });
        assert.equal(result.status, 200); assert.equal(lookedUp, true);
        const file = await request(router, 'GET', result.body.download.url.replace('/api/assistant', ''), undefined);
        const xml = format === 'word' ? wordXml(file.body) : zipXml(file.body, 'xl/sharedStrings.xml');
        assert.match(xml, /مشرف نشاط تجريبي/); assert.match(xml, /مؤهل ثان للتصدير/);
        assert.doesNotMatch(xml, /مؤهل أول/);
    }
});
