import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../db/database.js';
import { createAssistantRouter, selectAssistantTools } from '../routes/assistant.js';
import { createGroqAssistantProvider } from '../utils/assistantProvider.js';
import { AuthStore } from '../utils/authStore.js';

let dataDir;
beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'emis-assistant-security-'));
    db.initDatabase({ dataDir });
});
afterEach(() => {
    db.closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
});

const call = (name, args = {}) => ({ id: 'call_fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (name, args = {}) => ({ content: '', tool_calls: [call(name, args)] });
const session = token => ({ local: false, user: { name: 'linked phone' }, token });

test('only relevant tools are sent for each Arabic request, reducing the first free-tier prompt', () => {
    const names = (message, image = false) => selectAssistantTools(message, image).map(item => item.function.name);
    assert.deepEqual(names('تغيير البريد البديل').includes('update_unified_email'), true);
    assert.deepEqual(names('اعمل قائمة مخصصة').includes('create_custom_list'), true);
    assert.deepEqual(names('عدلي بيانات المعلم').includes('update_employee'), true);
    assert.deepEqual(names('اسم المدرسة').includes('update_school_info'), true);
    assert.deepEqual(names('اعملي كشف Word من الصورة', true).includes('export_custom_word'), true);
    assert.deepEqual(names('تصدير اكسل').includes('export_custom_word'), true);
    assert.equal(names('', true).some(name => name.startsWith('delete_') || name.startsWith('update_')), false);
    assert.ok(JSON.stringify(selectAssistantTools('كم عدد العاملين؟')).length < 2500);
    assert.ok(JSON.stringify(selectAssistantTools('اعملي كشف Word من الصورة', true)).length < 4000);
});

async function request(router, path, method = 'GET', body, auth = { local: true }) {
    const req = Object.assign(new EventEmitter(), {
        method, url: path, originalUrl: path, body, auth,
        headers: auth.local ? {} : { cookie: `emis_session=${auth.token}` },
        params: {}, query: {},
    });
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
            status(code) { this.statusCode = code; return this; },
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            getHeader(name) { return this.headers[name.toLowerCase()]; },
            write(value) { chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); return true; },
            end(value) {
                if (value != null) this.write(value);
                this.writableEnded = true;
                const buffer = Buffer.concat(chunks);
                resolve({ status: this.statusCode, headers: this.headers, buffer,
                    json: () => JSON.parse(buffer.toString('utf8')) });
                return this;
            },
            json(value) { this.setHeader('content-type', 'application/json'); return this.end(JSON.stringify(value)); },
            send(value) { return this.end(value); },
        });
        router.handle(req, res, error => error ? reject(error) : res.status(404).json({ error: 'not found' }));
    });
}

test('API key is set only from local access and is never returned by status or chat', async () => {
    let apiKey = null;
    let receivedKey = null;
    const router = createAssistantRouter({
        provider: { status: configured => ({ available: Boolean(configured) }), chat: async (messages, tools, key) => {
            receivedKey = key; return { content: 'رد تجريبي' };
        } },
        getApiKey: () => apiKey, setApiKey: value => { apiKey = value; }, deleteApiKey: () => { apiKey = null; },
    });
    const phone = session('a'.repeat(43));
    assert.equal((await request(router, '/settings', 'PUT', { apiKey: 'gsk_secret_test_key' }, phone)).status, 403);
    assert.equal(apiKey, null);
    const saved = await request(router, '/settings', 'PUT', { apiKey: 'gsk_secret_test_key' });
    assert.equal(saved.status, 200);
    assert.equal(saved.buffer.includes(Buffer.from(apiKey)), false);
    const status = await request(router, '/status', 'GET', undefined, phone);
    assert.equal(status.status, 200);
    assert.equal(status.json().configured, true);
    assert.equal(status.buffer.includes(Buffer.from(apiKey)), false);
    const chat = await request(router, '/chat', 'POST', { message: 'أهلاً' }, phone);
    assert.equal(chat.status, 200);
    assert.equal(chat.buffer.includes(Buffer.from(apiKey)), false);
    assert.equal(receivedKey, apiKey);
    assert.equal((await request(router, '/settings', 'DELETE', undefined, phone)).status, 403);
});

test('saved Groq key is encrypted in the local auth store', () => {
    const store = new AuthStore(dataDir);
    const key = 'gsk_fixture_secret_that_must_not_appear_in_storage';
    try {
        store.putSecret('groq-api-key', key);
        assert.equal(store.getSecret('groq-api-key'), key);
        assert.equal(readFileSync(join(dataDir, 'auth.sqlite')).includes(Buffer.from(key)), false);
    } finally { store.close(); }
});

test('image is validated and forwarded as image content; invalid or oversized payloads are rejected before provider', async () => {
    let seenMessages;
    let calls = 0;
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async messages => {
            calls++; seenMessages = messages; return { content: 'الصورة واضحة' };
        } }, getApiKey: () => 'gsk_fixture',
    });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const sent = await request(router, '/chat', 'POST', { message: 'اقرأ الصورة', image: { mimeType: 'image/png', dataBase64: bytes.toString('base64') } });
    assert.equal(sent.status, 200);
    assert.equal(seenMessages.at(-1).image.dataBase64, bytes.toString('base64'));
    assert.equal(seenMessages.at(-1).content, 'اقرأ الصورة');
    const mismatch = await request(router, '/chat', 'POST', { message: 'صورة', image: { mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') } });
    assert.equal(mismatch.status, 400);
    assert.equal(calls, 1);
});

test('a real vision-capable provider sees an image only once before tool rounds', async () => {
    const seen = [];
    const router = createAssistantRouter({
        provider: { visionPreflight: true, status: () => ({ available: true }), chat: async (messages, tools) => {
            seen.push({ messages, tools });
            return seen.length === 1 ? { content: 'كشف من عمودين: الرقم والاسم' } : { content: 'فهمت شكل الكشف.' };
        } }, getApiKey: () => 'gsk_fixture',
    });
    const image = { mimeType: 'image/png', dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') };
    const response = await request(router, '/chat', 'POST', { message: 'اعملي كشف زي الصورة', image });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].tools.length, 0);
    assert.equal(seen[0].messages.at(-1).image.dataBase64, image.dataBase64);
    assert.ok(seen[1].tools.length > 0);
    assert.equal(seen[1].messages.some(message => message.image), false);
    assert.match(seen[1].messages.at(-1).content, /كشف من عمودين/);
});

test('a short minute limit retries once without asking the user to send the photo again', async () => {
    let calls = 0;
    const delays = [];
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => {
            calls++;
            if (calls === 1) throw Object.assign(new Error('limit'), { status: 429, retryAfter: 1 });
            return { content: 'الرد بعد انتظار قصير' };
        } },
        getApiKey: () => 'gsk_fixture', wait: async ms => { delays.push(ms); },
    });
    const response = await request(router, '/chat', 'POST', { message: 'كم عدد العاملين؟' });
    assert.equal(response.status, 200);
    assert.equal(response.json().reply, 'الرد بعد انتظار قصير');
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1250]);
});

test('an image or imported text cannot silently modify records; confirmation is one-time and owned by one session', async () => {
    const employee = db.createEmployee({ fullName: 'معلم تجريبي' });
    let response = toolResponse('delete_employee', { empCode: employee.emp_code });
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => response }, getApiKey: () => 'gsk_fixture',
    });
    const phoneA = session('a'.repeat(43));
    const phoneB = session('b'.repeat(43));
    const image = { mimeType: 'image/png', dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') };
    const blocked = await request(router, '/chat', 'POST', { message: 'إيه اللي في الصورة؟', image }, phoneA);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json().pendingAction, undefined);
    assert.ok(db.getEmployee(employee.emp_code));
    const staged = await request(router, '/chat', 'POST', { message: 'احذف المعلم ده', image }, phoneA);
    assert.equal(staged.status, 200);
    const token = staged.json().pendingAction.token;
    assert.ok(db.getEmployee(employee.emp_code));
    assert.equal((await request(router, '/confirm', 'POST', { token }, phoneB)).status, 404);
    assert.ok(db.getEmployee(employee.emp_code));
    assert.equal((await request(router, '/confirm', 'POST', { token }, phoneA)).status, 200);
    assert.equal(db.getEmployee(employee.emp_code), null);
    assert.equal((await request(router, '/confirm', 'POST', { token }, phoneA)).status, 404);
});

test('confirmation rejects an employee changed after preview even within the same second', async () => {
    const employee = db.createEmployee({ fullName: 'معلم للتعديل', notes: 'قبل' });
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => toolResponse('update_employee', {
            empCode: employee.emp_code, changes: { notes: 'من المساعد' },
        }) }, getApiKey: () => 'gsk_fixture',
    });
    const staged = await request(router, '/chat', 'POST', { message: 'عدل ملاحظة المعلم' });
    assert.equal(staged.status, 200);
    const token = staged.json().pendingAction.token;
    db.updateEmployee(employee.emp_code, { notes: 'تعديل يدوي بعد المعاينة' });
    const confirmed = await request(router, '/confirm', 'POST', { token });
    assert.equal(confirmed.status, 409);
    assert.equal(db.getEmployee(employee.emp_code).raw_data.notes, 'تعديل يدوي بعد المعاينة');
});

test('custom Word export can use exact employee IDs and download stays within its session', async () => {
    const selected = db.createEmployee({ fullName: 'معلم في الكشف' });
    db.createEmployee({ fullName: 'معلم خارج الكشف' });
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => toolResponse('export_custom_word', {
            title: 'كشف تجريبي', columns: [{ path: 'index' }, { path: 'fullName' }], memberIds: [selected.emp_code],
        }) }, getApiKey: () => 'gsk_fixture',
    });
    const phoneA = session('a'.repeat(43));
    const phoneB = session('b'.repeat(43));
    const result = await request(router, '/chat', 'POST', { message: 'اعملي كشف بالمعلم ده' }, phoneA);
    assert.equal(result.status, 200);
    assert.match(result.json().reply, /1 موظف/);
    const url = result.json().download.url.replace('/api/assistant', '');
    assert.equal((await request(router, url, 'GET', undefined, phoneB)).status, 404);
    const file = await request(router, url, 'GET', undefined, phoneA);
    assert.equal(file.status, 200);
    assert.equal(file.buffer.subarray(0, 2).toString(), 'PK');
    assert.equal(file.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('Groq provider sends image and key only to its fixed HTTPS endpoint', async () => {
    let captured;
    const provider = createGroqAssistantProvider({ model: 'fixture-vision', fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'وصف الصورة' } }] }) };
    } });
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
    const answer = await provider.chat([{ role: 'user', content: 'صف', image: { mimeType: 'image/png', dataBase64: image } }], [], 'gsk_fixture');
    assert.equal(answer.content, 'وصف الصورة');
    assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(captured.options.headers.Authorization, 'Bearer gsk_fixture');
    const body = JSON.parse(captured.options.body);
    assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${image}`);
    assert.equal(captured.options.body.includes('gsk_fixture'), false);
});

test('unified-email changes from chat are previewed and use the same school-scoped service after confirmation', async () => {
    const person = db.createEmployee({ fullName: 'معلمة بريد', empCode: '123456' });
    const account = { empCode: 123456, empName: 'معلمة بريد', empEmail: 'school@emis.gov.eg',
        jobTitle: 'معلمة', altEmail: 'old@example.com', mobile: '01012345678' };
    let changed = null;
    let called = 0;
    const emailService = {
        async get(id) { called++; assert.equal(id, person.emp_code); return account; },
        async update(id, payload) { changed = { id, payload }; return { success: true, employee: { ...account, altEmail: payload.value } }; },
    };
    let response = toolResponse('get_unified_email', { empCode: person.emp_code });
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => response },
        getApiKey: () => 'gsk_fixture', emailService,
    });
    const read = await request(router, '/chat', 'POST', { message: 'اعرضي البريد الموحد للمعلمة' });
    assert.equal(read.status, 200);
    assert.equal(changed, null);
    assert.ok(called > 0);
    response = toolResponse('update_unified_email', { empCode: person.emp_code, field: 'altEmail', value: 'new@example.com' });
    const staged = await request(router, '/chat', 'POST', { message: 'غيري البريد البديل للمعلمة إلى new@example.com' });
    assert.equal(staged.status, 200);
    assert.match(staged.json().pendingAction.details, /old@example.com/);
    assert.equal(changed, null);
    const confirmed = await request(router, '/confirm', 'POST', { token: staged.json().pendingAction.token });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(changed, { id: person.emp_code, payload: {
        field: 'altEmail', value: 'new@example.com',
        previousValue: 'old@example.com', expectedEmpCode: 123456,
    } });
});

test('assistant exposes known validation failures without treating them as server crashes', async () => {
    db.createEmployee({ fullName: 'أصل', nationalId: '12345678901234' });
    const router = createAssistantRouter({
        provider: { status: () => ({ available: true }), chat: async () => toolResponse('create_employee', {
            employee: { fullName: 'مكرر', nationalId: '12345678901234' },
        }) }, getApiKey: () => 'gsk_fixture',
    });
    const staged = await request(router, '/chat', 'POST', { message: 'أضيفي موظف مكرر' });
    const result = await request(router, '/confirm', 'POST', { token: staged.json().pendingAction.token });
    assert.equal(result.status, 409);
    assert.match(result.json().error, /موجود بالفعل/);
});
