import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as db from '../db/database.js';
import { createApiRouter } from '../routes/api.js';

const BASE = 'https://professopi.emis.gov.eg/api/EmployeeUnifiedEmails/';
const READ = 'GetEmployeeUnifiedEmailInfo';
const EMAIL = 'UpdateEmployeeAltEmail';
const MOBILE = 'UpdateEmployeeMobile';
const privateToken = 'private-fixture-token';
const privateUt = 'private-fixture-ut';
const credentials = async () => ({ bearerToken: privateToken, utToken: privateUt, schoolInfo: { ty: 4, sc: 1, ed: 2, schoolName: 'مدرسة الاختبار' } });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const remoteEmployee = code => ({ empCode: code, empName: 'موظف تجريبي', empEmail: 'teacher@school.example', jobTitle: 'معلم', altEmail: 'old@example.com', mobile: '01012345678', isEmailActivated: true });
const update = (changes = {}) => ({ field: 'altEmail', value: 'new@example.com', previousValue: 'old@example.com', expectedEmpCode: '101', ...changes });
let dir, router;

beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-unified-email-test-'));
    db.initDatabase({ dataDir: dir });
    db.upsertEmployee(101, '', 'موظف محلي', { basicInfo: { empCode: 101, empFirstName: 'موظف', empFatherName: 'محلي', empEmail: 'local@example.com', empMobile: '01112345678' }, notes: 'لا تغير هذه البيانات' });
});
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });

// Exercise Express with an isolated database and injected ministry responses, without sockets or live credentials.
async function request(path = '/employees/101/unified-email', method = 'GET', body) {
    const parsed = new URL(path, 'http://localhost');
    const req = Object.assign(new EventEmitter(), { method, url: parsed.pathname + parsed.search, originalUrl: path, headers: {}, body, query: Object.fromEntries(parsed.searchParams) });
    return new Promise((resolve, reject) => {
        let text = '';
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200, writableEnded: false, destroyed: false, headers: {},
            status(value) { this.statusCode = value; return this; },
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            end(value = '') { text += value; this.writableEnded = true; resolve({ status: this.statusCode, text, body: JSON.parse(text), headers: this.headers }); return this; },
            json(value) { this.setHeader('content-type', 'application/json'); return this.end(JSON.stringify(value)); }
        });
        router.handle(req, res, error => error ? reject(error) : res.status(404).json({ error: 'Not found' }));
    });
}

function setup({ code = 101, handle, getCredentials = credentials, ...options } = {}) {
    const state = { employee: remoteEmployee(code), calls: [], invalidations: 0 };
    router = createApiRouter({
        getMinistryCredentials: getCredentials,
        invalidateMinistryCredentials: () => state.invalidations++,
        fetchImpl: async (url, init) => {
            assert.ok(url.startsWith(BASE), 'unified email actions must use the dedicated official service');
            assert.equal(init.method, 'POST');
            const call = { endpoint: url.slice(BASE.length), body: JSON.parse(init.body), headers: init.headers };
            state.calls.push(call);
            if (handle) {
                const response = await handle(call, state);
                if (response !== undefined) return response;
            }
            if (call.endpoint === READ) return json(state.employee);
            if (call.endpoint === EMAIL) state.employee.altEmail = call.body.altEmail;
            else if (call.endpoint === MOBILE) state.employee.mobile = call.body.mobile;
            else assert.fail(`Unexpected ministry endpoint ${call.endpoint}`);
            return json({ success: true });
        },
        ...options
    });
    return state;
}
const writes = state => state.calls.filter(call => call.endpoint !== READ);
function noSecrets(result) {
    assert.equal(result.text.includes(privateToken), false);
    assert.equal(result.text.includes(privateUt), false);
}

test('loads ministry contact details using the stable imported code despite a locally edited display code', async () => {
    db.updateEmployee(101, { empCode: '999', fullName: 'اسم معدل محليًا' });
    const before = db.getEmployee(101);
    const state = setup();
    const result = await request();
    assert.equal(result.status, 200);
    assert.equal(String(result.body.employee.empCode), '101');
    for (const field of ['empName', 'empEmail', 'jobTitle', 'altEmail', 'mobile']) assert.equal(result.body.employee[field], state.employee[field]);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].endpoint, READ);
    assert.equal(String(state.calls[0].body.empCode), '101');
    assert.equal(Number(state.calls[0].body.edaraCode), 2);
    assert.equal(Number(state.calls[0].body.schoolCode), 1);
    assert.equal(state.calls[0].headers.Authorization, `Bearer ${privateToken}`);
    assert.equal(state.calls[0].headers.Ut, privateUt);
    assert.deepEqual(db.getEmployee(101), before);
    noSecrets(result);
});

test('manual staff use their explicit ministry code and never their negative local ID', async () => {
    const manual = db.createEmployee({ fullName: 'موظف يدوي', empCode: '٧٧٧' });
    const state = setup({ code: 777 });
    const result = await request(`/employees/${manual.emp_code}/unified-email`);
    assert.equal(result.status, 200);
    assert.equal(String(state.calls[0].body.empCode), '777');
    assert.equal(String(result.body.employee.empCode), '777');
});

test('manual staff without a ministry code and missing or malformed local IDs do not reach the ministry', async () => {
    const manual = db.createEmployee({ fullName: 'موظف دون كود' });
    const state = setup();
    assert.equal((await request(`/employees/${manual.emp_code}/unified-email`)).status, 400);
    assert.equal((await request('/employees/99999/unified-email')).status, 404);
    assert.ok([400, 404].includes((await request('/employees/not-a-code/unified-email')).status));
    assert.equal(state.calls.length, 0);
});

test('missing ministry credentials and a mismatched school block account access before any ministry request', async () => {
    let state = setup({ getCredentials: async () => null });
    assert.equal((await request()).status, 401);
    assert.equal(state.calls.length, 0);
    db.saveSetting('schoolInfo', { sc: 99, ed: 2, ty: 4 });
    state = setup();
    assert.equal((await request()).status, 409);
    assert.equal(state.calls.length, 0);
});

test('missing, malformed or mismatched ministry accounts are not returned as editable employees', async () => {
    for (const [payload, status] of [[null, 404], [[], 502], [{}, 502], [{ ...remoteEmployee(999) }, 502]]) {
        setup({ handle: () => json(payload) });
        const result = await request();
        assert.equal(result.status, status);
        assert.equal(result.body.employee, undefined);
        noSecrets(result);
    }
});

test('alternate email update checks the current account, writes one exact field, and confirms by reading back', async () => {
    const before = db.getEmployee(101);
    const state = setup();
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.employee.altEmail, 'new@example.com');
    assert.equal(result.body.employee.mobile, '01012345678');
    assert.deepEqual(state.calls.map(call => call.endpoint), [READ, EMAIL, READ]);
    assert.deepEqual(state.calls[1].body, { empCode: 101, altEmail: 'new@example.com' });
    assert.deepEqual(db.getEmployee(101), before, 'ministry email changes must not overwrite local employee edits');
    noSecrets(result);
});

test('mobile update normalizes Arabic digits and preserves the alternate email', async () => {
    const state = setup();
    const result = await request(undefined, 'PATCH', update({ field: 'mobile', value: '٠١٢٩٨٧٦٥٤٣٢', previousValue: '01012345678' }));
    assert.equal(result.status, 200);
    assert.equal(result.body.employee.mobile, '01298765432');
    assert.equal(result.body.employee.altEmail, 'old@example.com');
    assert.deepEqual(state.calls.map(call => call.endpoint), [READ, MOBILE, READ]);
    assert.deepEqual(state.calls[1].body, { empCode: 101, mobile: '01298765432' });
});

test('only the alternate email and mobile fields accept strictly valid mutation payloads', async () => {
    const invalid = [
        null, [], {}, update({ field: 'empEmail' }), update({ field: 'empName' }), update({ empCode: 999 }),
        update({ unifiedEmail: 'another@school.example' }), update({ value: '' }), update({ value: 'not an email' }),
        update({ value: 'عربي@example.com' }), update({ value: `${'a'.repeat(250)}@example.com` }),
        update({ value: 12 }), update({ previousValue: {} }), update({ expectedEmpCode: {} }),
        update({ field: 'mobile', value: '01012', previousValue: '01012345678' }),
        update({ field: 'mobile', value: '01312345678', previousValue: '01012345678' }),
        update({ field: 'mobile', value: '+201012345678', previousValue: '01012345678' }),
        { field: 'altEmail', value: 'new@example.com', expectedEmpCode: '101' },
        { field: 'altEmail', value: 'new@example.com', previousValue: 'old@example.com' }
    ];
    const state = setup();
    for (const body of invalid) assert.equal((await request(undefined, 'PATCH', body)).status, 400, JSON.stringify(body));
    assert.equal(writes(state).length, 0);
});

test('stale account identity or stale previous contact data refuses a write', async () => {
    let state = setup();
    assert.equal((await request(undefined, 'PATCH', update({ expectedEmpCode: '999' }))).status, 409);
    assert.equal(writes(state).length, 0);
    state = setup();
    state.employee.altEmail = 'changed-elsewhere@example.com';
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 409);
    assert.equal(writes(state).length, 0);
    assert.equal(state.employee.altEmail, 'changed-elsewhere@example.com');
});

test('changing a manual ministry code after loading its contact panel prevents updating the former account', async () => {
    const manual = db.createEmployee({ fullName: 'موظف يدوي', empCode: '777' });
    db.updateEmployee(manual.emp_code, { empCode: '778' });
    const state = setup({ code: 778 });
    const result = await request(`/employees/${manual.emp_code}/unified-email`, 'PATCH', update({ expectedEmpCode: '777' }));
    assert.equal(result.status, 409);
    assert.equal(writes(state).length, 0);
});

test('a mismatched fresh ministry response refuses mutation even if the requested previous value matches', async () => {
    const state = setup({ code: 999 });
    assert.equal((await request(undefined, 'PATCH', update())).status, 502);
    assert.equal(writes(state).length, 0);
});

test('upstream authentication errors invalidate the ministry session without exposing its tokens', async () => {
    for (const status of [401, 403]) {
        let state = setup({ handle: () => new Response(privateToken, { status }) });
        let result = await request();
        assert.equal(result.status, 401);
        assert.equal(state.invalidations, 1);
        assert.equal(writes(state).length, 0);
        noSecrets(result);
        state = setup({ handle: call => call.endpoint === EMAIL ? new Response(privateUt, { status }) : undefined });
        result = await request(undefined, 'PATCH', update());
        assert.equal(result.status, 401);
        assert.equal(state.invalidations, 1);
        assert.equal(writes(state).length, 1);
        noSecrets(result);
    }
});

test('ministry write HTTP failure is not retried automatically or reported as saved', async () => {
    const state = setup({ handle: call => call.endpoint === EMAIL ? new Response(privateToken, { status: 503 }) : undefined });
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 502);
    assert.notEqual(result.body.success, true);
    assert.equal(writes(state).length, 1);
    noSecrets(result);
});

test('a network failure after mutation is treated as uncertain and never sends a second write', async () => {
    const state = setup({ handle: (call, state) => {
        if (call.endpoint === EMAIL) {
            state.employee.altEmail = call.body.altEmail;
            throw new Error(`${privateToken}: simulated connection lost after saving`);
        }
    } });
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 502);
    assert.match(result.body.error, /أعد جلب/);
    assert.equal(writes(state).length, 1);
    assert.equal(state.employee.altEmail, 'new@example.com');
    noSecrets(result);
});

test('HTTP 200 with a ministry business error is never reported as a successful save', async () => {
    const state = setup({ handle: call => call.endpoint === EMAIL ? json({ success: false, message: privateToken }) : undefined });
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 502);
    assert.notEqual(result.body.success, true);
    assert.equal(writes(state).length, 1);
    assert.equal(state.employee.altEmail, 'old@example.com');
    noSecrets(result);
});

test('successful HTTP status without a matching readback reports uncertainty and leaves local data untouched', async () => {
    const before = db.getEmployee(101);
    const state = setup({ handle: call => call.endpoint === EMAIL ? json({ success: true }) : undefined });
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 502);
    assert.match(result.body.error, /أعد جلب/);
    assert.notEqual(result.body.success, true);
    assert.equal(writes(state).length, 1);
    assert.deepEqual(db.getEmployee(101), before);
});

test('failure to read back a saved change does not resend the mutation', async () => {
    const state = setup({ handle: (call, state) => {
        if (call.endpoint === READ && writes(state).length) throw new Error('fixture readback unavailable');
    } });
    const result = await request(undefined, 'PATCH', update());
    assert.equal(result.status, 502);
    assert.match(result.body.error, /أعد جلب/);
    assert.equal(writes(state).length, 1);
    assert.equal(state.employee.altEmail, 'new@example.com');
});

test('concurrent mutations of one ministry account are locked until verification completes', async () => {
    let release, notifyStarted;
    const writing = new Promise(resolve => { notifyStarted = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const state = setup({ handle: async call => {
        if (call.endpoint === EMAIL) { notifyStarted(); await blocked; }
    } });
    const first = request(undefined, 'PATCH', update());
    await writing;
    let second;
    try { second = await request(undefined, 'PATCH', update({ field: 'mobile', value: '01298765432', previousValue: '01012345678' })); }
    finally { release(); }
    assert.equal(second.status, 409);
    assert.equal((await first).status, 200);
    assert.equal(writes(state).length, 1);
    const next = await request(undefined, 'PATCH', update({ field: 'mobile', value: '01298765432', previousValue: '01012345678' }));
    assert.equal(next.status, 200, 'successful completion releases the per-account lock');
    assert.equal(writes(state).length, 2);
});

test('a failed write releases the per-account lock so a fresh retry can proceed', async () => {
    let failNext = true;
    const state = setup({ handle: call => {
        if (call.endpoint === EMAIL && failNext) { failNext = false; throw new Error('fixture interrupted write'); }
    } });
    assert.equal((await request(undefined, 'PATCH', update())).status, 502);
    assert.equal((await request(undefined, 'PATCH', update())).status, 200);
    assert.equal(writes(state).length, 2);
});
