import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db/database.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-sync-modes-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const national = code => `2900101000${String(code).padStart(4, '0')}`;
const imported = (empCode, changes = {}) => ({
    empCode, nationalId: national(empCode), fullName: `معلم تجريبي ${empCode}`, staffType: 'core',
    rawData: {
        basicInfo: { empCode, nationalIdNum: national(empCode), empFirstName: 'معلم', empFatherName: `تجريبي ${empCode}` },
        qlf: [{ qlfName: 'مؤهل أصلي', empQlfDate: '2001-03-02', extra: { hours: 24, passed: true } }],
        job: { jobDesc: 'معلم', subjectDesc: 'تخصص أصلي' }, notes: 'بيانات أصلية'
    }, ...changes
});
function seed(...codes) {
    for (const code of codes) {
        const employee = imported(code);
        db.upsertEmployee(employee.empCode, employee.nationalId, employee.fullName, employee.rawData, employee.staffType);
    }
}
function sql(callback) {
    const connection = new DatabaseSync(db.getDatabasePath());
    try { return callback(connection); } finally { connection.close(); }
}
function storedState() {
    return sql(connection => Object.fromEntries(['employees', 'employee_suppressions', 'settings', 'custom_lists', 'custom_list_members'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

test('normal is the default and counts newly imported employees separately from updates', () => {
    assert.deepEqual(db.synchronizeEmployees([imported(10), imported(11, { staffType: 'seconded' })]), {
        mode: 'normal', added: 2, updated: 0, saved: 2, protectedManual: 0, protectedEdited: 0, retained: 0, skipped: 0, removed: 0
    });
    assert.equal(db.getEmployee(11).staff_type, 'seconded');
    const result = db.synchronizeEmployees([imported(10, { fullName: 'اسم وزارة محدث' }), imported(12)]);
    assert.deepEqual(result, { mode: 'normal', added: 1, updated: 1, saved: 2, protectedManual: 0, protectedEdited: 0, retained: 1, skipped: 0, removed: 0 });
    assert.equal(db.getEmployee(10).full_name, 'اسم وزارة محدث');
    assert.equal(db.getEmployee(11).full_name, 'معلم تجريبي 11');
    assert.equal(db.getEmployeeCount().total, 3);
});

test('empty saves and reverted editor changes do not mark untouched imported employees as locally edited', () => {
    seed(10);
    sql(connection => connection.prepare("UPDATE employees SET last_updated='2000-01-02 03:04:05' WHERE emp_code=10").run());
    const original = db.getEmployee(10), before = storedState();
    for (const input of [{}, { details: {} }, { rawPatch: [] }, { staffType: 'core' },
        { notes: original.raw_data.notes },
        { rawPatch: [{ op: 'set', path: ['job', 'subjectDesc'], value: original.raw_data.job.subjectDesc }] },
    ]) {
        assert.deepEqual(db.updateEmployee(10, input), original);
        assert.deepEqual(storedState(), before);
        assert.equal(db.getEmployee(10).has_local_changes, false);
    }
    const changed = imported(10); changed.rawData.job.subjectDesc = 'تحديث وزارة جديد';
    const result = db.synchronizeEmployees([changed]);
    assert.equal(result.updated, 1); assert.equal(result.protectedEdited, 0);
    assert.equal(db.getEmployee(10).raw_data.job.subjectDesc, 'تحديث وزارة جديد');
    db.updateEmployee(10, { notes: 'تعديل فعلي محفوظ' });
    const locallyEdited = storedState();
    db.updateEmployee(10, { notes: 'تعديل فعلي محفوظ' });
    assert.deepEqual(storedState(), locallyEdited, 'a no-op must also preserve existing real overrides');
});

test('normal refresh preserves all manual and locally edited employees including people missing from the snapshot', () => {
    seed(10, 11, 12, 13);
    const manual = db.createEmployee({ fullName: 'موظف يدوي', empCode: '20', nationalId: national(20), notes: 'ملاحظة يدوية' });
    db.updateEmployee(12, { address: 'عنوان محلي للغائب' });
    db.updateEmployee(13, { rawPatch: [{ op: 'set', path: ['qlf', 0, 'extra', 'hours'], value: 72 }], staffType: 'seconded' });
    sql(connection => connection.prepare("UPDATE employees SET last_updated='2000-01-02 03:04:05'").run());
    const retained = [11, 12, 13, manual.emp_code].map(code => db.getEmployee(code));
    const result = db.synchronizeEmployees([imported(10, { fullName: 'اسم الوزارة الجديد' }), imported(13), imported(14), imported(20)], { mode: 'normal' });
    assert.deepEqual(result, { mode: 'normal', added: 1, updated: 1, saved: 2, protectedManual: 1, protectedEdited: 2, retained: 4, skipped: 2, removed: 0 });
    for (const employee of retained) assert.deepEqual(db.getEmployee(employee.emp_code), employee);
    assert.equal(db.getEmployee(10).full_name, 'اسم الوزارة الجديد');
    assert.equal(db.getEmployee(14).source, 'ministry');
    assert.equal(db.getEmployee(20), null);
});

test('normal refresh retains the entire edited raw document, original timestamp and exact local overrides', () => {
    seed(10);
    db.updateEmployee(10, { rawPatch: [
        { op: 'set', path: ['qlf', 0, 'empQlfDate'], value: '01/02/2020' },
        { op: 'append', path: ['qlf'], value: { qlfName: 'مؤهل محلي ثان', empQlfDate: '2021-04-03' } },
        { op: 'append', path: ['customFields'], value: { label: 'عمل إضافي', value: 'إشراف' } }
    ] });
    sql(connection => connection.prepare("UPDATE employees SET last_updated='2000-01-02 03:04:05' WHERE emp_code=10").run());
    const before = storedState();
    const changed = imported(10); changed.rawData.job.subjectDesc = 'تحديث الوزارة في حقل لم يعدل محليًا';
    const result = db.synchronizeEmployees([changed]);
    assert.equal(result.protectedEdited, 1); assert.equal(result.skipped, 1); assert.equal(result.saved, 0);
    assert.deepEqual(storedState(), before);
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.deepEqual(storedState(), before);
});

test('normal refresh preserves local deletions by both employee code and national identity', () => {
    seed(10, 11);
    db.deleteEmployee(10);
    const manual = db.createEmployee({ fullName: 'يدوي محذوف', empCode: '20', nationalId: national(20) });
    db.deleteEmployee(manual.emp_code);
    const suppressions = storedState().employee_suppressions;
    const result = db.synchronizeEmployees([
        imported(10, { nationalId: national(90) }),
        imported(30, { nationalId: national(10) }),
        imported(20, { nationalId: national(91) }),
        imported(31, { nationalId: national(20) }), imported(12)
    ]);
    assert.equal(result.added, 1); assert.equal(result.skipped, 4); assert.equal(result.retained, 1);
    assert.deepEqual(db.getAllEmployees().map(row => row.emp_code).sort((a, b) => a - b), [11, 12]);
    assert.deepEqual(storedState().employee_suppressions, suppressions);
});

test('corrected ministry identity protects stable source code, displayed code and the corrected national ID', () => {
    seed(10);
    db.updateEmployee(10, { rawPatch: [
        { op: 'set', path: ['basicInfo', 'empCode'], value: '٠٠٣١' },
        { op: 'set', path: ['basicInfo', 'nationalIdNum'], value: national(40) }
    ] });
    const corrected = db.getEmployee(10);
    const manual = db.createEmployee({ fullName: 'موظف يدوي محمي', empCode: '50', nationalId: national(50) });
    const result = db.synchronizeEmployees([
        imported(10), imported('00031', { nationalId: national(60) }),
        imported(41, { nationalId: national(40) }), imported(50),
        imported(51, { nationalId: national(50) }), imported(70)
    ]);
    assert.equal(result.skipped, 5); assert.equal(result.added, 1); assert.equal(result.updated, 0);
    assert.equal(result.protectedManual, 1); assert.equal(result.protectedEdited, 1); assert.equal(result.retained, 2);
    assert.deepEqual(db.getEmployee(10), corrected);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
    assert.equal(db.getEmployeeCount().total, 3);
});

test('full refresh replaces all employees and clears deletions while retaining settings and list memberships', () => {
    seed(10, 11, 12);
    db.updateEmployee(10, { fullName: 'تعديل سيستبدل', notes: 'ملاحظة محلية' });
    db.deleteEmployee(12);
    const manual = db.createEmployee({ fullName: 'يدوي سيستبدل', empCode: '20', nationalId: national(20) });
    const list = db.createCustomList({ name: 'قائمة محفوظة', memberIds: [10, manual.emp_code, 11] });
    db.saveSetting('schoolInfo', { name: 'مدرسة تجريبية', district: 'إدارة تجريبية' });
    const before = storedState();
    const result = db.synchronizeEmployees([imported(10), imported(12), imported(20)], { mode: 'full' });
    assert.deepEqual(result, { mode: 'full', added: 3, updated: 0, saved: 3, protectedManual: 0, protectedEdited: 0, retained: 0, skipped: 0, removed: 3 });
    assert.equal(db.getEmployee(manual.emp_code), null); assert.equal(db.getEmployee(11), null);
    assert.equal(db.getEmployee(10).full_name, 'معلم تجريبي 10'); assert.equal(db.getEmployee(10).has_local_changes, false);
    assert.equal(db.getEmployee(20).source, 'ministry'); assert.equal(db.getEmployee(12).source, 'ministry');
    const after = storedState();
    assert.deepEqual(after.employee_suppressions, []);
    for (const table of ['settings', 'custom_lists', 'custom_list_members']) assert.deepEqual(after[table], before[table]);
    assert.deepEqual(db.getCustomList(list.id).memberIds, list.memberIds);
    assert.equal(db.getCustomList(list.id).availableCount, 1); assert.equal(db.getCustomList(list.id).missingCount, 2);
    assert.notEqual(db.createEmployee({ fullName: 'يدوي جديد' }).emp_code, manual.emp_code);
});

test('an empty normal snapshot preserves employees and deletions while empty full clears both', () => {
    seed(10, 11, 12);
    db.updateEmployee(10, { notes: 'تعديل محفوظ' }); db.deleteEmployee(12);
    db.createEmployee({ fullName: 'إضافة يدوية' });
    const before = storedState();
    assert.deepEqual(db.synchronizeEmployees([]), { mode: 'normal', added: 0, updated: 0, saved: 0, protectedManual: 1, protectedEdited: 1, retained: 3, skipped: 0, removed: 0 });
    assert.deepEqual(storedState(), before);
    assert.deepEqual(db.synchronizeEmployees([], { mode: 'full' }), { mode: 'full', added: 0, updated: 0, saved: 0, protectedManual: 0, protectedEdited: 0, retained: 0, skipped: 0, removed: 3 });
    assert.equal(db.getEmployeeCount().total, 0); assert.deepEqual(storedState().employee_suppressions, []);
    assert.deepEqual(storedState().settings, before.settings);
});

test('invalid snapshots and modes reject before changing employees, suppressions or settings', () => {
    seed(10, 11); db.deleteEmployee(11); db.createEmployee({ fullName: 'بيانات يدوية محفوظة' });
    const before = storedState();
    const invalid = [null, {}, [imported(20), null], [imported(20), imported(21, { fullName: '' })],
        [imported(20), imported(21, { rawData: [] })], [imported(20), imported(21, { rawData: null })],
        [imported(20), imported(21, { staffType: 'unexpected' })], [imported(20), imported(0)],
        [imported(20), imported(Number.MAX_SAFE_INTEGER + 1)], [imported(20), imported('00020')]];
    for (const mode of ['normal', 'full']) for (const snapshot of invalid) {
        assert.throws(() => db.synchronizeEmployees(snapshot, { mode }), error => error instanceof db.DataError);
        assert.deepEqual(storedState(), before);
    }
    assert.throws(() => db.synchronizeEmployees([imported(20)], { mode: 'unknown' }), error => error instanceof db.DataError);
    assert.deepEqual(storedState(), before);
});

for (const mode of ['normal', 'full']) test(`${mode} sync rolls back earlier writes, deletions and suppression changes on a later SQLite failure`, () => {
    seed(10, 11); db.deleteEmployee(11);
    const manual = db.createEmployee({ fullName: 'يدوي محفوظ' });
    db.createCustomList({ name: 'قائمة محفوظة', memberIds: [10, manual.emp_code] });
    db.saveSetting('displayFixture', { enabled: true });
    sql(connection => connection.exec("CREATE TRIGGER fail_later_sync_row BEFORE INSERT ON employees WHEN NEW.emp_code=22 BEGIN SELECT RAISE(ABORT, 'sync fixture rollback'); END;"));
    const before = storedState();
    assert.throws(() => db.synchronizeEmployees([imported(10, { fullName: 'لا تحفظ هذا التعديل' }), imported(21), imported(22)], { mode }), /sync fixture rollback/);
    assert.deepEqual(storedState(), before);
    assert.equal(db.upsertEmployee(11, national(11), 'لا يزال محذوفًا', imported(11).rawData).status, 'suppressed');
});
