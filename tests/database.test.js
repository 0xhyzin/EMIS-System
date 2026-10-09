import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db/database.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-db-test-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const sample = (overrides = {}) => ({ fullName: 'موظف تجريبي واحد', nationalId: '29001010000001', jobTitle: 'معلم', qualification: 'مؤهل تجريبي', ...overrides });
const ministry = (code = 10) => ({ basicInfo: { empCode: code, nationalIdNum: '29001010000001', empFirstName: 'موظف', empFatherName: 'تجريبي', empFamilyName: 'واحد', empEmail: 'example@example.invalid' }, qlf: [{ qlfName: 'مؤهل', qlfTypeName: 'حقل محفوظ' }], job: { jobDesc: 'معلم', subjectDesc: 'حقل إضافي' } });
const imported = (empCode, overrides = {}) => ({ empCode, nationalId: '', fullName: `موظف الوزارة ${empCode}`, rawData: ministry(empCode), staffType: 'core', ...overrides });

test('manual CRUD persists, preserves raw fields and uses monotonically decreasing IDs', () => {
    const employee = db.createEmployee(sample({ empCode: '١٢٣', nationalId: '٢٩٠٠١٠١٠٠٠٠٠٠١', qualificationDate: '02/03/2001' }));
    assert.equal(employee.source, 'manual'); assert.equal(employee.emp_code, -1); assert.equal(employee.source_emp_code, '123');
    assert.equal(employee.raw_data.qlf.empQlfDate, '2001-03-02');
    db.updateEmployee(employee.emp_code, { address: 'عنوان تجريبي', notes: 'ملاحظة' });
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.equal(db.getEmployee(-1).raw_data.job.jobDesc, 'معلم');
    assert.equal(db.getEmployee(-1).raw_data.notes, 'ملاحظة');
    db.deleteEmployee(-1);
    assert.equal(db.createEmployee(sample({ nationalId: '' })).emp_code, -2);
});

test('national ID and employee code duplicates normalize Arabic digits and leading zero codes', () => {
    db.createEmployee(sample({ empCode: '00123' }));
    assert.throws(() => db.createEmployee(sample({ nationalId: '٢٩٠٠١٠١٠٠٠٠٠٠١' })), error => error.status === 409);
    assert.throws(() => db.createEmployee(sample({ nationalId: '29001010000002', empCode: '١٢٣' })), error => error.status === 409);
    assert.throws(() => db.createEmployee(sample({ nationalId: '123' })), /١٤/);
    assert.throws(() => db.createEmployee(sample({ nationalId: '', startDate: '2025-02-31' })), /تاريخ/);
});

test('ministry sync cannot overwrite manual entries or create duplicate national IDs', () => {
    const manual = db.createEmployee(sample({ empCode: '10' }));
    assert.equal(db.upsertEmployee(10, manual.national_id, 'اسم الوزارة', ministry()).status, 'duplicate');
    assert.equal(db.getAllEmployees().length, 1);
    assert.equal(db.getEmployee(manual.emp_code).full_name, manual.full_name);
});

test('local ministry edits survive refresh, retain unmapped fields and array history', () => {
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', ministry());
    db.updateEmployee(10, { jobTitle: 'كبير معلمين', qualification: 'مؤهل محلي', fullName: 'اسم معدل', address: 'عنوان محفوظ', notes: 'ملاحظات' });
    const refreshed = ministry(); refreshed.job.subjectDesc = 'تخصص محدث';
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة الجديد', refreshed);
    const actual = db.getEmployee(10);
    assert.equal(actual.full_name, 'اسم معدل'); assert.equal(actual.source, 'ministry'); assert.equal(actual.has_local_changes, true);
    assert.equal(actual.raw_data.job.jobDesc, 'كبير معلمين'); assert.equal(actual.raw_data.job.subjectDesc, 'تخصص محدث');
    assert.equal(actual.raw_data.qlf[0].qlfName, 'مؤهل محلي'); assert.equal(actual.raw_data.qlf[0].qlfTypeName, 'حقل محفوظ');
    assert.equal(actual.raw_data.basicInfo.empEmail, 'example@example.invalid'); assert.equal(actual.raw_data.notes, 'ملاحظات');
});

test('a corrected national ID remains authoritative when the ministry still sends the old incorrect ID', () => {
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', ministry());
    db.updateEmployee(10, { nationalId: '29001010000002' });
    db.createEmployee(sample({ fullName: 'صاحب الرقم القومي الأصلي' }));
    const refreshed = ministry(); refreshed.job.subjectDesc = 'تخصص جديد';
    assert.equal(db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', refreshed).status, 'saved');
    assert.equal(db.getEmployee(10).national_id, '29001010000002');
    assert.equal(db.getEmployee(10).raw_data.job.subjectDesc, 'تخصص جديد');
    assert.equal(db.getEmployeeCount().total, 2);
});

test('missing ministry national ID placeholders neither merge nor suppress unrelated employees', () => {
    assert.equal(db.upsertEmployee(10, '0', 'موظف أول', ministry(10)).status, 'saved');
    assert.equal(db.upsertEmployee(11, '0', 'موظف ثان', ministry(11)).status, 'saved');
    db.deleteEmployee(10);
    assert.equal(db.upsertEmployee(12, '0', 'موظف ثالث', ministry(12)).status, 'saved');
    assert.equal(db.upsertEmployee(10, '0', 'الموظف المحذوف', ministry(10)).status, 'suppressed');
    assert.equal(db.getEmployeeCount().total, 2);
});

test('local deletion stays deleted through sync; explicit manual recreation restores person', () => {
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', ministry()); db.deleteEmployee(10);
    assert.equal(db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', ministry()).status, 'suppressed');
    const recreated = db.createEmployee(sample({ empCode: '10' }));
    assert.equal(db.upsertEmployee(10, recreated.national_id, 'اسم الوزارة', ministry()).status, 'duplicate');
    assert.equal(db.getAllEmployees().length, 1);
});

test('reference lists bind field key and preserve custom order across refresh', () => {
    db.createEmployee(sample({ jobTitle: 'معلم' }));
    db.createEmployee(sample({ fullName: 'موظف ثان', nationalId: '29001010000002', jobTitle: 'كبير معلمين' }));
    db.rebuildReferenceValues(); db.updateReferenceOrder('job.jobDesc', ['كبير معلمين', 'معلم']); db.rebuildReferenceValues();
    assert.deepEqual(db.getReferenceValues('job.jobDesc').map(row => row.field_value), ['كبير معلمين', 'معلم']);
    db.createEmployee(sample({ fullName: 'موظف ثالث', nationalId: '29001010000003', jobTitle: 'مدير' }));
    db.rebuildReferenceValues();
    assert.deepEqual(db.getReferenceValues('job.jobDesc').map(row => row.field_value), ['كبير معلمين', 'معلم', 'مدير']);
});

test('legacy database migration preserves every employee and writes a backup before deleting old tokens', () => {
    db.closeDatabase(); fs.rmSync(join(dir, 'school.db'));
    const old = new DatabaseSync(join(dir, 'school.db'));
    old.exec("CREATE TABLE employees (emp_code INTEGER PRIMARY KEY,national_id TEXT,full_name TEXT,raw_data TEXT,last_updated DATETIME DEFAULT CURRENT_TIMESTAMP); CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);");
    old.prepare('INSERT INTO employees (emp_code,national_id,full_name,raw_data) VALUES (?,?,?,?)').run(10, '29001010000001', 'اسم محفوظ', JSON.stringify(ministry()));
    old.prepare('INSERT INTO settings VALUES (?,?)').run('bearerToken', 'test-expired-secret'); old.close();
    db.initDatabase({ dataDir: dir });
    assert.equal(db.getAllEmployees().length, 1); assert.equal(db.getEmployee(10).source, 'ministry');
    assert.equal(db.getEmployee(10).raw_data.basicInfo.empEmail, 'example@example.invalid');
    assert.equal(db.getSetting('bearerToken'), null); assert.ok(fs.existsSync(join(dir, 'school.before-v2.db')));
});

test('existing table templates migrate without losing their columns, sort order, footer or title', () => {
    db.closeDatabase(); fs.rmSync(join(dir, 'school.db'));
    const old = new DatabaseSync(join(dir, 'school.db'));
    old.exec('CREATE TABLE table_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, columns TEXT, sorting TEXT, footer TEXT, title TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    const columns = [{ path: 'fullName', label: 'الاسم' }], sorting = [{ field: 'fullName', direction: 'asc' }], footer = [{ title: 'إحصاء', name: 'اسم تجريبي' }];
    old.prepare('INSERT INTO table_configs (name,columns,sorting,footer,title) VALUES (?,?,?,?,?)').run('قالب موجود', JSON.stringify(columns), JSON.stringify(sorting), JSON.stringify(footer), 'كشف قديم');
    old.close(); db.initDatabase({ dataDir: dir });
    const migrated = db.getTableConfig(1);
    assert.equal(migrated.name, 'قالب موجود'); assert.equal(migrated.title, 'كشف قديم');
    assert.deepEqual(migrated.columns, columns); assert.deepEqual(migrated.sorting, sorting); assert.deepEqual(migrated.footer, footer);
    assert.equal(migrated.orientation, 'landscape'); assert.equal(migrated.useArabicNumerals, false); assert.equal(migrated.exportFormat, 'word');
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.deepEqual(db.getTableConfig(1), migrated, 'migration remains idempotent after restarting');
});

test('snapshot replacement removes old ministry records and overrides while preserving complete manual records', () => {
    db.upsertEmployee(10, '29001010000001', 'نسخة قديمة', ministry());
    db.upsertEmployee(11, '', 'غائب عن القائمة الجديدة', ministry(11));
    db.updateEmployee(10, { fullName: 'تصحيح قديم', jobTitle: 'وظيفة قديمة', notes: 'ملاحظة قديمة' });
    const manual = db.createEmployee(sample({ fullName: 'موظف يدوي', nationalId: '29001010000002', empCode: '20', notes: 'ملاحظة محفوظة' }));
    db.updateEmployee(manual.emp_code, { address: 'عنوان محفوظ' });
    const before = db.getEmployee(manual.emp_code);
    const result = db.replaceMinistryEmployees([imported(10, { nationalId: '29001010000001', fullName: 'نسخة حديثة' }), imported(12, { staffType: 'seconded' })]);
    assert.deepEqual(result, { saved: 2, skipped: 0, removed: 2 });
    assert.equal(db.getEmployee(11), null);
    assert.equal(db.getEmployee(10).full_name, 'نسخة حديثة');
    assert.equal(db.getEmployee(10).has_local_changes, false);
    assert.equal(db.getEmployee(10).raw_data.notes, undefined);
    assert.equal(db.getEmployee(10).raw_data.job.jobDesc, 'معلم');
    assert.equal(db.getEmployee(12).staff_type, 'seconded');
    assert.deepEqual(db.getEmployee(manual.emp_code), before);
});

test('snapshot deduplication gives preserved manual national IDs and employee codes priority', () => {
    const byCode = db.createEmployee(sample({ nationalId: '29001010000002', empCode: '٢٠' }));
    const byNationalId = db.createEmployee(sample({ nationalId: '29001010000003' }));
    const result = db.replaceMinistryEmployees([
        imported('00020', { nationalId: '29001010000004' }),
        imported(21, { nationalId: '٢٩٠٠١٠١٠٠٠٠٠٠٣' }),
        imported(22, { nationalId: '29001010000005' }),
        imported(23, { nationalId: '29001010000005' })
    ]);
    assert.deepEqual(result, { saved: 1, skipped: 3, removed: 0 });
    assert.equal(db.getEmployeeCount().total, 3);
    assert.equal(db.getEmployee(byCode.emp_code).source, 'manual');
    assert.equal(db.getEmployee(byNationalId.emp_code).source, 'manual');
    assert.equal(db.getEmployee(22).source, 'ministry');
});

test('a valid empty snapshot clears only ministry data and an invalid snapshot clears nothing', () => {
    db.upsertEmployee(10, '', 'وزارة محفوظ', ministry());
    const manual = db.createEmployee(sample());
    for (const invalid of [null, {}, [imported(20, { fullName: 55 })], [imported(0)], [imported(20, { rawData: [] })], [imported(20, { staffType: 'unknown' })]]) {
        assert.throws(() => db.replaceMinistryEmployees(invalid), error => error instanceof db.DataError);
        assert.equal(db.getEmployeeCount().total, 2);
    }
    assert.deepEqual(db.replaceMinistryEmployees([]), { saved: 0, skipped: 0, removed: 1 });
    assert.deepEqual(db.getAllEmployees(), [manual]);
});

test('snapshot replacement restores currently listed ministry people previously deleted locally', () => {
    db.upsertEmployee(10, '29001010000001', 'حذف محلي سابق', ministry());
    db.deleteEmployee(10);
    assert.equal(db.upsertEmployee(10, '29001010000001', 'محظور قديمًا', ministry()).status, 'suppressed');
    assert.deepEqual(db.replaceMinistryEmployees([imported(10, { nationalId: '29001010000001' })]), { saved: 1, skipped: 0, removed: 0 });
    assert.equal(db.getEmployee(10).full_name, 'موظف الوزارة 10');
});

test('a failed database write rolls back deletion, inserts and suppression changes together', () => {
    db.upsertEmployee(10, '', 'بيانات الوزارة الأصلية', ministry());
    db.upsertEmployee(11, '', 'سجل محذوف', ministry(11));
    db.deleteEmployee(11);
    const manual = db.createEmployee(sample());
    const editor = new DatabaseSync(db.getDatabasePath());
    editor.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON employees WHEN NEW.emp_code=22 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    editor.close();
    assert.throws(() => db.replaceMinistryEmployees([imported(21), imported(22)]), /fixture failure/);
    assert.equal(db.getEmployee(10).full_name, 'بيانات الوزارة الأصلية');
    assert.equal(db.getEmployee(21), null);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
    assert.equal(db.upsertEmployee(11, '', 'لا يزال محذوفًا', ministry(11)).status, 'suppressed');
});
