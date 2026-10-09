import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as db from '../db/database.js';
import { createApiRouter } from '../routes/api.js';
import { employeeEditorGroups, employeeEditorPayload } from '../public/js/employeeEditor.js';

let dir, router;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-api-test-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const credentials = async () => ({ bearerToken: 'private-test-token', utToken: 'private-test-ut', schoolInfo: { ty: 4, sc: 1, ed: 1, schoolName: 'مدرسة تجريبية' } });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function start(options = {}) { router = createApiRouter(options); }
// Exercise the actual Express router without opening a socket; works inside restricted build sandboxes.
async function request(path, method = 'GET', body, { onResponse } = {}) {
    const parsed = new URL(path, 'http://localhost');
    const req = Object.assign(new EventEmitter(), { method, url: parsed.pathname + parsed.search, originalUrl: path, headers: {}, body, query: Object.fromEntries(parsed.searchParams) });
    return new Promise((resolve, reject) => {
        let text = '';
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200, writableEnded: false, destroyed: false, headers: {},
            status(value) { this.statusCode = value; return this; },
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            flushHeaders() {},
            write(value) { text += value; return true; },
            end(value = '') {
                text += value; this.writableEnded = true;
                resolve({ status: this.statusCode, headers: this.headers, text: async () => text, json: async () => JSON.parse(text) });
                return this;
            },
            json(value) { this.setHeader('content-type', 'application/json'); return this.end(JSON.stringify(value)); },
            send(value) { return this.end(value); }
        });
        onResponse?.(res);
        router.handle(req, res, error => error ? reject(error) : res.status(404).json({ error: 'Not found' }));
    });
}
const full = code => ({ basicInfo: { empCode: code, empFirstName: 'موظف', empFatherName: 'تجريبي', nationalIdNum: `2900101000000${code}` }, job: { jobDesc: 'معلم' } });
const eventsFrom = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('expanded editor saves all form sections through the API and preserves legacy names when one part changes', async () => {
    await start();
    const values = Object.fromEntries(employeeEditorGroups().flatMap(group => group.fields).map(field => [`details:${field.path}`, field.value]));
    Object.assign(values, {
        'details:basicInfo.empFirstName': 'موظف', 'details:basicInfo.empFatherName': 'اختبار',
        'details:basicInfo.empBirthDate': '1990-03-02', 'details:basicInfo.empMobile': '01012345678',
        'details:basicInfo.empEmail': 'fixture@example.invalid', 'details:basicInfo.martStatDesc': 'متزوج',
        'details:qlf.qlfEntityName': 'جهة تجريبية', 'details:job.subjectDesc': 'اللغة العربية',
        'details:secondment.toGehaName': 'جهة الندب', staffType: 'seconded', notes: 'ملاحظة تجريبية',
    });
    const created = await request('/employees', 'POST', employeeEditorPayload(values));
    assert.equal(created.status, 201);
    const { employee } = await created.json();
    assert.equal(employee.full_name, 'موظف اختبار');
    assert.equal(employee.raw_data.qlf.qlfEntityName, 'جهة تجريبية');
    assert.equal(employee.raw_data.secondment.toGehaName, 'جهة الندب');
    const changed = { ...values, 'details:basicInfo.empMobile': '01087654321', 'details:job.subjectDesc': 'الرياضيات' };
    const updated = await request(`/employees/${employee.emp_code}`, 'PUT', employeeEditorPayload(changed, values));
    assert.equal(updated.status, 200);
    const raw = (await updated.json()).employee.raw_data;
    assert.equal(raw.basicInfo.empMobile, '01087654321'); assert.equal(raw.job.subjectDesc, 'الرياضيات');
    assert.equal(raw.basicInfo.empBirthDate, '1990-03-02'); assert.equal(raw.basicInfo.martStatDesc, 'متزوج');
    assert.equal((await request(`/employees/${employee.emp_code}`, 'PUT', { details: { 'basicInfo.empBirthDate': '2026-02-31' } })).status, 400);
    db.upsertEmployee(25, '', 'أحمد علي حسن عبد الله', {});
    const legacy = db.getEmployee(25);
    const initial = Object.fromEntries(employeeEditorGroups(legacy).flatMap(group => group.fields).map(field => [`details:${field.path}`, field.value]));
    const corrected = { ...initial, 'details:basicInfo.empFatherName': 'محمود' };
    const legacyResult = await request('/employees/25', 'PUT', employeeEditorPayload(corrected, initial));
    assert.equal(legacyResult.status, 200);
    assert.equal((await legacyResult.json()).employee.full_name, 'أحمد محمود حسن عبد الله');
});

test('employee CRUD and school metadata contract work without ministry credentials; no token endpoint', async () => {
    await start();
    const result = await request('/employees', 'POST', { fullName: 'موظف يدوي', nationalId: '29001010000001', address: 'عنوان' });
    assert.equal(result.status, 201); const { employee } = await result.json(); assert.equal(employee.emp_code, -1);
    assert.equal((await request('/employees', 'POST', { fullName: 'مكرر', nationalId: '٢٩٠٠١٠١٠٠٠٠٠٠١' })).status, 409);
    assert.equal((await request('/employees/-1', 'PUT', { notes: 'ملاحظة' })).status, 200);
    assert.equal((await request('/employees/-1')).status, 200);
    assert.equal((await request('/employees/invalid')).status, 400);
    assert.equal((await request('/auth/tokens')).status, 404);
    db.saveSetting('schoolInfo', { sc: 7, ed: 3, ty: 4 });
    await request('/school-info', 'PUT', { schoolName: 'مدرسة جديدة', sc: 999 });
    assert.equal((await (await request('/school-info')).json()).sc, 7);
    assert.equal((await request('/employees/-1', 'DELETE')).status, 200);
    assert.equal((await request('/employees/-1')).status, 404);
});

test('partial normal sync retains failed and absent ministry rows, manual entries and reference order', async () => {
    db.upsertEmployee(2, '29001010000002', 'بيانات سابقة', full(2));
    db.upsertEmployee(4, '', 'غائب عن قائمة الوزارة', full(4));
    const manual = db.createEmployee({ fullName: 'إضافة يدوية', nationalId: '29001010000003', jobTitle: 'كبير معلمين' });
    db.rebuildReferenceValues();
    db.updateReferenceOrder('job.jobDesc', ['كبير معلمين', 'معلم']);
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }, { empCode: 3 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        const code = JSON.parse(init.body).empCode;
        return code === 2 ? new Response('', { status: 503 }) : json(full(code));
    } });
    const text = await (await request('/sync/start')).text();
    const events = eventsFrom(text);
    const done = events.find(event => event.step === 'done');
    assert.equal(done.partial, true); assert.equal(done.saved, 1); assert.equal(done.failed, 1); assert.equal(done.skipped, 1);
    assert.equal(done.mode, 'normal'); assert.equal(done.replaced, false); assert.equal(done.removed, 0);
    assert.equal(done.added, 1); assert.equal(done.updated, 0); assert.equal(done.protectedManual, 1); assert.equal(done.retained, 3);
    assert.equal(db.getEmployee(2).full_name, 'بيانات سابقة'); assert.equal(db.getEmployee(4).full_name, 'غائب عن قائمة الوزارة'); assert.equal(db.getAllEmployees().length, 4);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
    assert.deepEqual(db.getReferenceValues('job.jobDesc').map(row => row.field_value), ['كبير معلمين', 'معلم']);
    assert.match(done.message, /بياناتهم السابقة محفوظة/);
    assert.equal(done.failedEmployees.length, 1); assert.equal(done.failedEmployees[0].empCode, '2'); assert.match(done.failedEmployees[0].reason, /503/);
    assert.equal(text.includes('private-test-token'), false); assert.equal(db.getSetting('lastSync').failed, 1);
});

test('manual edits, additions and deletions during fetching survive the normal commit', async () => {
    db.upsertEmployee(4, '', 'نسخة الوزارة السابقة', full(4));
    const edited = db.createEmployee({ fullName: 'يدوي للتعديل' });
    const deleted = db.createEmployee({ fullName: 'يدوي للحذف' });
    let added, staged;
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        const code = JSON.parse(init.body).empCode;
        if (code === 2) {
            staged = db.getEmployee(1);
            assert.equal(db.getEmployee(4).full_name, 'نسخة الوزارة السابقة');
            await request(`/employees/${edited.emp_code}`, 'PUT', { fullName: 'يدوي معدل أثناء المزامنة', notes: 'ملاحظة جديدة' });
            await request(`/employees/${deleted.emp_code}`, 'DELETE');
            added = (await (await request('/employees', 'POST', { fullName: 'أضيف أثناء المزامنة', empCode: '2' })).json()).employee;
        }
        return json(full(code));
    } });
    const done = eventsFrom(await (await request('/sync/start')).text()).find(event => event.step === 'done');
    assert.equal(staged, null);
    assert.equal(done.saved, 1); assert.equal(done.skipped, 1);
    assert.equal(db.getEmployee(4).full_name, 'نسخة الوزارة السابقة'); assert.equal(db.getEmployee(deleted.emp_code), null);
    assert.equal(db.getEmployee(edited.emp_code).full_name, 'يدوي معدل أثناء المزامنة');
    assert.equal(db.getEmployee(edited.emp_code).raw_data.notes, 'ملاحظة جديدة');
    assert.deepEqual(db.getEmployee(added.emp_code), added);
});

for (const mode of ['normal', 'full']) test(`authentication failure after a fetched detail discards the ${mode} snapshot and preserves the previous sync`, async () => {
    db.upsertEmployee(4, '', 'وزارة محفوظة', full(4));
    const manual = db.createEmployee({ fullName: 'يدوي محفوظ' });
    db.saveSetting('lastSync', { at: 'fixture-previous', saved: 1 });
    let invalidated = false;
    await start({ getMinistryCredentials: credentials, invalidateMinistryCredentials: () => { invalidated = true; }, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        return JSON.parse(init.body).empCode === 1 ? json(full(1)) : new Response('', { status: 403 });
    } });
    const events = eventsFrom(await (await request('/sync/start', 'POST', { mode, ...(mode === 'full' ? { confirmReset: true } : {}) })).text());
    assert.ok(invalidated); assert.equal(events.some(event => event.step === 'done'), false);
    assert.equal(events.at(-1).step, 'error'); assert.equal(events.at(-1).committed, false);
    assert.equal(db.getEmployee(1), null); assert.equal(db.getEmployee(4).full_name, 'وزارة محفوظة');
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
    assert.deepEqual(db.getSetting('lastSync'), { at: 'fixture-previous', saved: 1 });
});

for (const mode of ['normal', 'full']) test(`disconnecting during ${mode} detail fetching discards staged records and releases the sync lock`, async () => {
    db.upsertEmployee(4, '', 'نسخة قبل الإلغاء', full(4));
    let release, response;
    const detail = new Promise(resolve => { release = resolve; });
    let signal, secondRequested;
    const reachedSecond = new Promise(resolve => { secondRequested = resolve; });
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        if (JSON.parse(init.body).empCode === 1) return json(full(1));
        signal = init.signal; secondRequested(); return detail;
    } });
    const pending = request('/sync/start', mode === 'full' ? 'POST' : 'GET', mode === 'full' ? { mode: 'full', confirmReset: true } : undefined, { onResponse: res => { response = res; } });
    await reachedSecond;
    response.destroyed = true; response.emit('close');
    assert.equal(signal.aborted, true);
    release(json(full(2)));
    await pending;
    assert.equal(db.getEmployee(1), null); assert.equal(db.getEmployee(2), null);
    assert.equal(db.getEmployee(4).full_name, 'نسخة قبل الإلغاء'); assert.equal(db.getSetting('lastSync'), null);
    assert.equal((await request('/sync/start')).status, 200);
});

test('an empty normal ministry list retains both imported and manual employees', async () => {
    db.upsertEmployee(4, '', 'قديم من الوزارة', full(4));
    const manual = db.createEmployee({ fullName: 'يدوي دائم' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => json({ data: [], recordsTotal: 0 }) });
    const done = eventsFrom(await (await request('/sync/start')).text()).find(event => event.step === 'done');
    assert.equal(done.total, 0); assert.equal(done.saved, 0); assert.equal(done.removed, 0); assert.equal(done.replaced, false); assert.equal(done.retained, 2);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual); assert.equal(db.getEmployee(4).full_name, 'قديم من الوزارة');
});

for (const mode of ['normal', 'full']) test(`a nonempty ${mode} list with no usable employee details preserves the prior ministry snapshot`, async () => {
    db.upsertEmployee(4, '', 'محفوظ عند فشل الجميع', full(4));
    const manual = db.createEmployee({ fullName: 'يدوي محفوظ عند فشل الجميع' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async url => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        return json({ basicInfo: null });
    } });
    const events = eventsFrom(await (await request('/sync/start', 'POST', { mode, ...(mode === 'full' ? { confirmReset: true } : {}) })).text());
    assert.equal(events.some(event => event.step === 'done'), false);
    assert.equal(events.at(-1).failed, 2); assert.equal(events.at(-1).committed, false);
    assert.equal(db.getEmployee(4).full_name, 'محفوظ عند فشل الجميع'); assert.equal(db.getSetting('lastSync'), null);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
});

test('failure of the seconded list never replaces employees after a successful core list', async () => {
    db.upsertEmployee(4, '', 'قديم محفوظ', full(4));
    await start({ getMinistryCredentials: credentials, fetchImpl: async url => url.endsWith('GetEmployeeByEmpFlag') ? json({ data: [{ empCode: 1 }] }) : new Response('', { status: 503 }) });
    const events = eventsFrom(await (await request('/sync/start')).text());
    assert.equal(events.at(-1).step, 'error'); assert.equal(events.at(-1).committed, false);
    assert.equal(db.getEmployee(4).full_name, 'قديم محفوظ'); assert.equal(db.getEmployee(1), null);
});

test('custom-list CRUD and employee filtering support empty, manual, missing and invalid selections', async () => {
    await start();
    const manual = db.createEmployee({ fullName: 'اختيار يدوي', staffType: 'seconded' });
    db.upsertEmployee(1, '', 'اختيار الوزارة', full(1));
    db.upsertEmployee(2, '', 'خارج القائمة', full(2));
    const created = await request('/custom-lists', 'POST', { name: 'قائمة تجريبية', memberIds: [manual.emp_code, 1] });
    assert.equal(created.status, 201); const { list } = await created.json();
    assert.equal(list.memberCount, 2); assert.equal(list.missingCount, 0);
    assert.equal((await (await request('/custom-lists')).json()).length, 1);
    assert.deepEqual((await (await request(`/employees?listId=${list.id}`)).json()).map(row => row.emp_code).sort((a, b) => a - b), [manual.emp_code, 1]);
    assert.deepEqual((await (await request(`/employees?listId=${list.id}&staffType=seconded`)).json()).map(row => row.emp_code), [manual.emp_code]);
    db.replaceMinistryEmployees([]);
    assert.equal((await (await request(`/custom-lists/${list.id}`)).json()).missingCount, 1);
    assert.deepEqual((await (await request(`/employees?listId=${list.id}`)).json()).map(row => row.emp_code), [manual.emp_code]);
    assert.equal((await request(`/custom-lists/${list.id}`, 'PUT', { name: 'قائمة باسم جديد', memberIds: [1] })).status, 200);
    assert.deepEqual(await (await request(`/employees?listId=${list.id}`)).json(), []);
    assert.equal((await request(`/custom-lists/${list.id}`, 'PUT', { name: 'قائمة فارغة', memberIds: [] })).status, 200);
    assert.deepEqual(await (await request(`/employees?listId=${list.id}`)).json(), []);
    assert.equal((await request('/custom-lists', 'POST', { name: 'عضو غير موجود', memberIds: [999] })).status, 400);
    assert.equal((await request('/custom-lists', 'POST', { name: 'قائمة فارغة', memberIds: [] })).status, 409);
    assert.equal((await request('/employees?listId=invalid')).status, 400);
    assert.equal((await request('/employees?listId=999')).status, 404);
    assert.equal((await request(`/custom-lists/${list.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/custom-lists/${list.id}`)).status, 404);
    assert.equal((await request(`/custom-lists/${list.id}`, 'DELETE')).status, 404);
    assert.equal(db.getEmployee(manual.emp_code).source, 'manual');
});

test('401 ends sync, invalidates captured credentials and never reports success', async () => {
    let invalidated = false;
    await start({ getMinistryCredentials: credentials, invalidateMinistryCredentials: () => { invalidated = true; }, fetchImpl: async () => new Response('', { status: 401 }) });
    const result = await (await request('/sync/start')).text();
    assert.ok(invalidated); assert.ok(result.includes('"step":"error"')); assert.equal(result.includes('"step":"done"'), false);
});

test('invalid or timed-out ministry responses never erase saved employees', async () => {
    db.createEmployee({ fullName: 'محفوظ' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => json({ unexpected: [] }) });
    assert.ok((await (await request('/sync/start')).text()).includes('"step":"error"'));
    assert.equal(db.getAllEmployees().length, 1);
});

test('paginated sync downloads the next list page and classifies seconded employees consistently', async () => {
    const pageStarts = [];
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('GetEmployeeByEmpFlag')) {
            pageStarts.push(body.start);
            return json({ data: body.start === 0 ? Array.from({ length: 500 }, (_, index) => ({ empCode: index + 1 })) : [{ empCode: 501 }], recordsTotal: 501 });
        }
        if (url.endsWith('EmployeesNadb')) return json({ data: [{ empCode: '1' }] });
        return json({ basicInfo: { empCode: body.empCode, empFirstName: 'موظف', empFatherName: `تجريبي ${body.empCode}` } });
    } });
    const result = await (await request('/sync/start')).text();
    assert.deepEqual(pageStarts, [0, 500]); assert.equal(db.getEmployeeCount().total, 501); assert.equal(db.getEmployee(1).staff_type, 'seconded');
    assert.ok(result.includes('"step":"done"'));
});

test('sync follows a ministry page-size cap and normalizes employee codes before classifying staff', async () => {
    const starts = [];
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('GetEmployeeByEmpFlag')) {
            starts.push(body.start);
            return json({ data: body.start === 0 ? [{ empCode: '001' }, { empCode: 2 }] : [{ empCode: 3 }], recordsFiltered: '3' });
        }
        if (url.endsWith('EmployeesNadb')) return json({ data: [{ empCode: '١' }] });
        return json(full(body.empCode));
    } });
    const result = await (await request('/sync/start')).text();
    assert.deepEqual(starts, [0, 2]);
    assert.equal(db.getEmployeeCount().total, 3); assert.equal(db.getEmployee(1).staff_type, 'seconded');
    assert.ok(result.includes('"step":"done"'));
});

test('a prematurely empty list page is an error and never reports a complete sync', async () => {
    db.createEmployee({ fullName: 'سجل محفوظ' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        return json({ data: body.start === 0 ? [{ empCode: 1 }] : [], recordsTotal: 3 });
    } });
    const result = await (await request('/sync/start')).text();
    assert.ok(result.includes('"step":"error"')); assert.equal(result.includes('"step":"done"'), false);
    assert.equal(db.getEmployeeCount().total, 1); assert.equal(db.getSetting('lastSync'), null);
});

test('school mismatch rejects sync before mixing another school with the saved database', async () => {
    db.saveSetting('schoolInfo', { sc: 77, ed: 1, ty: 4, schoolName: 'المدرسة الأصلية' });
    db.createEmployee({ fullName: 'موظف محفوظ' });
    let calls = 0;
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => { calls++; return json({ data: [] }); } });
    const result = await (await request('/sync/start')).text();
    assert.ok(result.includes('مدرسة مختلفة')); assert.equal(calls, 0);
    assert.equal(db.getSetting('schoolInfo').sc, 77); assert.equal(db.getEmployeeCount().total, 1);
});

test('school isolation also compares administration code while allowing equivalent numeric codes', async () => {
    db.saveSetting('schoolInfo', { sc: '001', ed: 77, ty: 4 });
    db.createEmployee({ fullName: 'سجل المدرسة المحفوظ' });
    let calls = 0;
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => { calls++; return json({ data: [] }); } });
    assert.ok((await (await request('/sync/start')).text()).includes('مدرسة مختلفة'));
    assert.equal(calls, 0);
    db.saveSetting('schoolInfo', { sc: '001', ed: '٠١', ty: 4 });
    assert.ok((await (await request('/sync/start')).text()).includes('"step":"done"'));
    assert.equal(calls, 2);
});

test('network timeout is retried and reported without losing local data', async () => {
    db.createEmployee({ fullName: 'محفوظ أثناء انقطاع الخدمة' });
    let calls = 0;
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => { calls++; throw new DOMException('fixture timeout', 'TimeoutError'); } });
    const result = await (await request('/sync/start')).text();
    assert.equal(calls, 2); assert.ok(result.includes('مهلة')); assert.equal(db.getEmployeeCount().total, 1);
});

test('sync refuses a second concurrent request and releases the lock after completion', async () => {
    let release;
    const firstPage = new Promise(resolve => { release = resolve; });
    let calls = 0;
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => { calls++; return calls === 1 ? firstPage : json({ data: [] }); } });
    const pending = request('/sync/start');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await request('/sync/start')).status, 409);
    release(json({ data: [] }));
    assert.ok((await (await pending).text()).includes('"step":"done"'));
    assert.equal((await request('/sync/start')).status, 200);
});

test('normal POST protects whole imported rows edited during fetching and honors deletions made during fetching', async () => {
    db.upsertEmployee(1, '', 'قبل التعديل', full(1));
    db.upsertEmployee(2, '', 'سيحذف محليًا', full(2));
    db.upsertEmployee(3, '', 'يمكن تحديثه', full(3));
    let edited;
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }, { empCode: 3 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        const code = JSON.parse(init.body).empCode;
        if (code === 3) {
            edited = db.updateEmployee(1, { fullName: 'تعديل أثناء الجلب', notes: 'ملاحظة محفوظة' });
            db.deleteEmployee(2);
        }
        const updated = full(code); updated.job.jobDesc = 'تحديث وزارة جديد';
        return json(updated);
    } });
    const done = eventsFrom(await (await request('/sync/start', 'POST', { mode: 'normal' })).text()).at(-1);
    assert.equal(done.step, 'done'); assert.equal(done.mode, 'normal'); assert.equal(done.updated, 1);
    assert.equal(done.protectedEdited, 1); assert.equal(done.skipped, 2); assert.equal(done.retained, 1);
    assert.deepEqual(db.getEmployee(1), edited);
    assert.equal(db.getEmployee(1).raw_data.job.jobDesc, 'معلم'); assert.equal(db.getEmployee(2), null);
    assert.equal(db.getEmployee(3).raw_data.job.jobDesc, 'تحديث وزارة جديد');
});

test('full sync requires explicit POST confirmation and rejects unsafe requests before ministry access', async () => {
    const manual = db.createEmployee({ fullName: 'لا يحذف دون تأكيد' });
    let calls = 0;
    await start({ getMinistryCredentials: async () => { calls++; return credentials(); }, fetchImpl: async () => { calls++; return json({ data: [] }); } });
    for (const [path, method, body] of [
        ['/sync/start?mode=full', 'GET'], ['/sync/start?mode=full&confirmReset=true', 'GET'],
        ['/sync/start', 'POST', { mode: 'full' }], ['/sync/start', 'POST', { mode: 'full', confirmReset: false }],
        ['/sync/start', 'POST', { mode: 'full', confirmReset: 'true' }], ['/sync/start?mode=full', 'POST', { confirmReset: true }],
        ['/sync/start?mode=unknown', 'GET'], ['/sync/start', 'POST', { mode: ['full'], confirmReset: true }]
    ]) {
        const response = await request(path, method, body);
        assert.equal(response.status, 400); assert.ok((await response.json()).error);
    }
    assert.equal(calls, 0); assert.deepEqual(db.getAllEmployees(), [manual]);
});

test('confirmed full sync replaces all employees including manual and edited rows while retaining lists and settings', async () => {
    db.upsertEmployee(1, '', 'وزارة قديم', full(1));
    db.upsertEmployee(2, '', 'محذوف في الوزارة', full(2));
    db.updateEmployee(1, { notes: 'تصحيح محلي', jobTitle: 'وظيفة محلية' });
    const manual = db.createEmployee({ fullName: 'يدوي يحذف', nationalId: '29001010000003' });
    const list = db.createCustomList({ name: 'قائمة باقية', memberIds: [1, 2, manual.emp_code] });
    db.saveSetting('fixture', { kept: true });
    db.deleteEmployee(2);
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }, { empCode: 3 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        return json(full(JSON.parse(init.body).empCode));
    } });
    const done = eventsFrom(await (await request('/sync/start', 'POST', { mode: 'full', confirmReset: true })).text()).at(-1);
    assert.equal(done.step, 'done'); assert.equal(done.mode, 'full'); assert.equal(done.replaced, true);
    assert.equal(done.removed, 2); assert.equal(done.saved, 3); assert.equal(done.retained, 0);
    assert.equal(done.protectedManual, 0); assert.equal(done.protectedEdited, 0); assert.deepEqual(done.failedEmployees, []);
    assert.equal(db.getEmployee(manual.emp_code), null); assert.deepEqual(db.getEmployee(1).raw_data, full(1));
    assert.equal(db.getEmployee(1).has_local_changes, false); assert.equal(db.getEmployee(2).source, 'ministry');
    assert.equal(db.getEmployee(3).source, 'ministry');
    assert.deepEqual(db.getCustomList(list.id).memberIds, [1, 2, manual.emp_code]); assert.equal(db.getCustomList(list.id).missingCount, 1);
    assert.deepEqual(db.getSetting('fixture'), { kept: true }); assert.equal(db.getSetting('lastSync').mode, 'full');
});

for (const failure of ['incomplete', 'http']) test(`confirmed full sync commits successful details despite an ${failure} employee failure and reports the failed code safely`, async () => {
    db.upsertEmployee(1, '', 'وزارة قديم', full(1));
    db.updateEmployee(1, { notes: 'تصحيح محلي سيستبدل' });
    db.upsertEmployee(2, '', 'السجل السابق للموظف المتعذر', full(2));
    db.upsertEmployee(4, '', 'لم يعد في قائمة الوزارة', full(4));
    const manual = db.createEmployee({ fullName: 'يدوي سيحذف' });
    db.saveSetting('lastSync', { at: 'previous' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 1 }, { empCode: 2 }, { empCode: 3 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        const code = JSON.parse(init.body).empCode;
        if (code !== 2) return json(full(code));
        return failure === 'http' ? new Response('never reveal this payload', { status: 503 }) : json({ basicInfo: null, unsafeResponseDetails: 'never reveal this payload' });
    } });
    const text = await (await request('/sync/start', 'POST', { mode: 'full', confirmReset: true })).text();
    const events = eventsFrom(text), done = events.at(-1);
    assert.equal(done.step, 'done'); assert.equal(done.mode, 'full'); assert.equal(done.partial, true); assert.equal(done.replaced, true);
    assert.equal(done.saved, 2); assert.equal(done.failed, 1); assert.equal(done.retained, 0); assert.equal(done.removed, 4);
    assert.equal(done.protectedManual, 0); assert.equal(done.protectedEdited, 0);
    assert.equal(done.failedEmployees.length, 1); assert.equal(done.failedEmployees[0].empCode, '2');
    if (failure === 'http') assert.match(done.failedEmployees[0].reason, /503/);
    else assert.equal(done.failedEmployees[0].reason, 'بيانات الموظف غير مكتملة من الوزارة.');
    assert.equal(events.some(event => event.step === 'error'), false); assert.equal(text.includes('never reveal'), false);
    assert.deepEqual(db.getAllEmployees().map(employee => employee.emp_code).sort((a, b) => a - b), [1, 3]);
    assert.equal(db.getEmployee(manual.emp_code), null); assert.equal(db.getEmployee(2), null); assert.equal(db.getEmployee(4), null);
    assert.deepEqual(db.getEmployee(1).raw_data, full(1)); assert.equal(db.getEmployee(1).has_local_changes, false);
    assert.deepEqual(db.getEmployee(3).raw_data, full(3));
    const lastSync = db.getSetting('lastSync');
    assert.equal(lastSync.mode, 'full'); assert.equal(lastSync.saved, 2); assert.equal(lastSync.failed, 1);
    assert.deepEqual(lastSync.failedEmployees, done.failedEmployees); assert.notEqual(lastSync.at, 'previous');
});

test('a confirmed successful empty full sync clears every employee', async () => {
    db.upsertEmployee(1, '', 'قديم', full(1)); db.createEmployee({ fullName: 'يدوي' });
    await start({ getMinistryCredentials: credentials, fetchImpl: async () => json({ data: [], recordsTotal: 0 }) });
    const done = eventsFrom(await (await request('/sync/start', 'POST', { mode: 'full', confirmReset: true })).text()).at(-1);
    assert.equal(done.step, 'done'); assert.equal(done.removed, 2); assert.equal(done.saved, 0); assert.equal(done.total, 0);
    assert.deepEqual(db.getAllEmployees(), []);
});

test('invalid ministry codes are reported without exposing arbitrary code text or dropping normal saved rows', async () => {
    db.upsertEmployee(4, '', 'قديم محفوظ', full(4));
    await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
        if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: [{ empCode: 'untrusted-sensitive-code' }, { empCode: 1 }] });
        if (url.endsWith('EmployeesNadb')) return json({ data: [] });
        return json(full(JSON.parse(init.body).empCode));
    } });
    const text = await (await request('/sync/start?mode=normal')).text();
    const done = eventsFrom(text).at(-1);
    assert.equal(done.step, 'done'); assert.equal(done.failed, 1);
    assert.deepEqual(done.failedEmployees, [{ empCode: null, reason: 'كود موظف غير صالح من الوزارة.' }]);
    assert.equal(text.includes('untrusted-sensitive-code'), false); assert.equal(db.getEmployee(4).full_name, 'قديم محفوظ');
});

test('full sync authentication and list failures never clear previous employees', async () => {
    db.upsertEmployee(4, '', 'وزارة محفوظ', full(4)); db.createEmployee({ fullName: 'يدوي محفوظ' });
    const original = db.getAllEmployees();
    for (const failAt of ['core', 'seconded', 'detail']) {
        await start({ getMinistryCredentials: credentials, fetchImpl: async url => {
            if (url.endsWith('GetEmployeeByEmpFlag')) return failAt === 'core' ? json({ unexpected: [] }) : json({ data: [{ empCode: 1 }] });
            if (url.endsWith('EmployeesNadb')) return failAt === 'seconded' ? new Response('', { status: 503 }) : json({ data: [] });
            return new Response('', { status: 401 });
        } });
        const events = eventsFrom(await (await request('/sync/start', 'POST', { mode: 'full', confirmReset: true })).text());
        assert.equal(events.at(-1).step, 'error'); assert.equal(events.at(-1).committed, false); assert.equal(events.at(-1).retained, 2);
        assert.equal(events.some(event => event.step === 'done'), false); assert.deepEqual(db.getAllEmployees(), original);
    }
});

test('HTTP 200 business errors cannot be mistaken for successful empty ministry lists or employee details', async () => {
    db.upsertEmployee(4, '', 'وزارة محفوظة قبل رفض الطلب', full(4));
    const manual = db.createEmployee({ fullName: 'إضافة يدوية محفوظة' });
    db.saveSetting('lastSync', { at: 'previous-business-error' });
    const original = db.getAllEmployees();
    for (const failAt of ['core', 'seconded', 'detail']) for (const failure of [
        { success: false }, { isSuccess: false }, { succeeded: false }, { error: 'never expose service detail' }, { errors: ['never expose service detail'] },
    ]) {
        await start({ getMinistryCredentials: credentials, fetchImpl: async (url, init) => {
            assert.equal(init.redirect, 'error', 'secret-bearing requests must not follow redirects');
            if (url.endsWith('GetEmployeeByEmpFlag')) return json({ data: failAt === 'detail' ? [{ empCode: 1 }] : [], ...(failAt === 'core' ? failure : {}) });
            if (url.endsWith('EmployeesNadb')) return json({ data: [], ...(failAt === 'seconded' ? failure : {}) });
            return json({ ...full(1), ...failure });
        } });
        const text = await (await request('/sync/start', 'POST', { mode: 'full', confirmReset: true })).text();
        const events = eventsFrom(text);
        assert.equal(events.at(-1).step, 'error');
        assert.equal(events.at(-1).committed, false);
        assert.equal(events.some(event => event.step === 'done'), false);
        assert.deepEqual(db.getAllEmployees(), original);
        assert.deepEqual(db.getEmployee(manual.emp_code), manual);
        assert.deepEqual(db.getSetting('lastSync'), { at: 'previous-business-error' });
        assert.equal(text.includes('never expose service detail'), false);
    }
});

test('saved report templates retain page orientation, numeral style and file format after restart', async () => {
    await start();
    const body = { name: 'قالب جدول محفوظ', title: 'عنوان الجدول', columns: [{ path: 'fullName', label: 'الاسم' }],
        sorting: [{ field: 'fullName', direction: 'desc' }], footer: [{ title: 'مديرة المدرسة', name: 'اسم تجريبي' }],
        orientation: 'portrait', useArabicNumerals: true, exportFormat: 'excel' };
    const saved = await request('/table-config', 'POST', body);
    assert.equal(saved.status, 201);
    const { id } = await saved.json();
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    const loaded = await request(`/table-config/${id}`);
    assert.equal(loaded.status, 200);
    const config = await loaded.json();
    for (const key of ['name', 'title', 'columns', 'sorting', 'footer', 'orientation', 'useArabicNumerals', 'exportFormat']) assert.deepEqual(config[key], body[key]);
    const pdfSaved = await request('/table-config', 'POST', { ...body, name: 'قالب PDF', exportFormat: 'pdf' });
    assert.equal(pdfSaved.status, 201);
    const pdfId = (await pdfSaved.json()).id;
    assert.equal((await (await request(`/table-config/${pdfId}`)).json()).exportFormat, 'pdf');
    for (const update of [{ orientation: 'invalid' }, { exportFormat: 'csv' }, { useArabicNumerals: 'true' }]) {
        assert.equal((await request('/table-config', 'POST', { ...body, ...update })).status, 400);
    }
    const legacy = await request('/table-config', 'POST', { name: 'قالب قديم', columns: body.columns });
    const defaultConfig = await (await request(`/table-config/${(await legacy.json()).id}`)).json();
    assert.equal(defaultConfig.orientation, 'landscape');
    assert.equal(defaultConfig.useArabicNumerals, false);
    assert.equal(defaultConfig.exportFormat, 'word');
});
