import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db/database.js';
import { getAllFields } from '../public/js/fieldMappings.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-details-test-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const fixture = () => ({
    basicInfo: { empCode: 10, nationalIdNum: '29001010000001', empFirstName: 'أحمد', empFatherName: 'محمد', empGrandFatherName: 'علي', empFamilyName: 'حسن', extraBasic: 'محفوظ' },
    qlf: [{ qlfName: 'مؤهل أول', empQlfDate: '2000-01-01', extraQlf: 'أول محفوظ' }, { qlfName: 'مؤهل ثان', qlfEntityName: 'جامعة ثانية', extraQlf: { nested: true } }],
    job: [{ jobDesc: 'معلم', subjectDesc: 'العربية', extraJob: 'وظيفة محفوظة' }, { jobDesc: 'وظيفة سابقة', jobDescNumber: 33 }],
    secondment: { fromGehaName: 'جهة سابقة', extraSecondment: [1, 2] },
    unrelated: { original: [1, { unchanged: true }] }
});
function importFixture() { db.upsertEmployee(10, '29001010000001', 'أحمد محمد علي حسن', fixture()); return db.getEmployee(10); }
function readPath(raw, path) { return path.split('.').reduce((value, part) => value?.[part], raw); }

test('all mapped fields support manual creation, editing and persistence after reopening', () => {
    const details = Object.fromEntries(getAllFields().map((field, index) => [field.path,
        field.path === 'basicInfo.nationalIdNum' ? '٢٩٠٠١٠١٠٠٠٠٠٠٢' : field.path === 'basicInfo.empCode' ? '٠٠١٢٣' : field.type === 'date' ? '٠٢/٠٣/٢٠٠١' : field.type === 'number' ? 42 : `قيمة ${index}`
    ]));
    const created = db.createEmployee({ details, staffType: 'seconded', notes: 'ملاحظة أولى' });
    assert.equal(created.full_name, 'قيمة 2 قيمة 3 قيمة 4 قيمة 5');
    assert.equal(created.national_id, '29001010000002');
    assert.equal(created.source_emp_code, '123');
    const changed = Object.fromEntries(getAllFields().map((field, index) => [field.path,
        field.path === 'basicInfo.nationalIdNum' ? '٢٩٠٠١٠١٠٠٠٠٠٠٣' : field.path === 'basicInfo.empCode' ? '٠٠١٢٤' : field.type === 'date' ? '٠٤/٠٥/٢٠٠٢' : field.type === 'number' ? 43 : `تعديل ${index}`
    ]));
    db.updateEmployee(created.emp_code, { details: changed, notes: 'ملاحظة معدلة' });
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    const actual = db.getEmployee(created.emp_code);
    for (const field of getAllFields()) {
        const expected = field.path === 'basicInfo.nationalIdNum' ? '29001010000003' : field.path === 'basicInfo.empCode' ? '124' : field.type === 'date' ? '2002-05-04' : String(changed[field.path]);
        assert.equal(readPath(actual.raw_data, field.path), expected, field.path);
    }
    assert.equal(actual.emp_code, created.emp_code);
    assert.equal(actual.source_emp_code, '124');
    assert.equal(actual.national_id, '29001010000003');
    assert.equal(actual.full_name, 'تعديل 2 تعديل 3 تعديل 4 تعديل 5');
    assert.equal(actual.raw_data.notes, 'ملاحظة معدلة');
    assert.equal(actual.staff_type, 'seconded');
});

test('partial and indexed edits preserve every untouched raw value and history entry', () => {
    importFixture();
    const expected = fixture();
    expected.qlf[0].qlfName = 'مؤهل أول معدل';
    expected.qlf[1].qlfEntityName = 'جهة ثانية معدلة';
    expected.job[0].jobDesc = 'كبير معلمين';
    expected.job[1].jobDescNumber = '77';
    db.updateEmployee(10, { details: { 'qlf.qlfName': 'مؤهل أول معدل', 'qlf.1.qlfEntityName': 'جهة ثانية معدلة', 'job.0.jobDesc': 'كبير معلمين', 'job.1.jobDescNumber': '٧٧' } });
    assert.deepEqual(db.getEmployee(10).raw_data, expected);
    db.updateEmployee(10, { details: { 'basicInfo.empMobile': '01000000000' } });
    const fresh = fixture(); fresh.qlf[0].extraQlf = 'تحديث الوزارة'; fresh.job[0].subjectDesc = 'تخصص جديد';
    assert.equal(db.upsertEmployee(10, '29001010000001', 'أحمد محمد علي حسن', fresh).status, 'saved');
    expected.qlf[0].extraQlf = 'تحديث الوزارة'; expected.job[0].subjectDesc = 'تخصص جديد'; expected.basicInfo.empMobile = '01000000000';
    assert.deepEqual(db.getEmployee(10).raw_data, expected);
});

test('legacy aliases and detail paths use latest edit precedence, with details winning within a request', () => {
    importFixture();
    db.updateEmployee(10, { fullName: 'اسم قديم كامل طويل', qualification: 'مؤهل قديم' });
    db.updateEmployee(10, { details: { 'basicInfo.empFirstName': 'حديث', 'qlf.0.qlfName': 'مؤهل حديث' } });
    db.updateEmployee(10, { fullName: 'اسم تال كامل جديد', qualification: 'مؤهل أخير', details: { 'basicInfo.empFatherName': 'أب مختلف' } });
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture());
    const employee = db.getEmployee(10);
    assert.equal(employee.full_name, 'اسم أب مختلف كامل جديد');
    assert.equal(employee.raw_data.qlf[0].qlfName, 'مؤهل أخير');
    assert.equal(employee.raw_data.basicInfo.empGrandFatherName, 'كامل');
    assert.equal(employee.raw_data.basicInfo.empFamilyName, 'جديد');
});

test('existing legacy override documents migrate to detail patches without reviving stale names', () => {
    importFixture();
    const editor = new DatabaseSync(db.getDatabasePath());
    editor.prepare('UPDATE employees SET local_overrides=? WHERE emp_code=10').run(JSON.stringify({ fullName: 'اسم قديم كامل طويل', qualification: 'مؤهل قديم', notes: 'محفوظة' }));
    editor.close();
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture());
    db.updateEmployee(10, { details: { 'basicInfo.empFirstName': 'حديث', 'qlf.qlfName': 'مؤهل حديث' } });
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture());
    assert.equal(db.getEmployee(10).full_name, 'حديث قديم كامل طويل');
    assert.equal(db.getEmployee(10).raw_data.qlf[0].qlfName, 'مؤهل حديث');
    assert.equal(db.getEmployee(10).raw_data.notes, 'محفوظة');
});

test('invalid paths, indexes and scalar values reject the whole patch without changing data', () => {
    const original = importFixture();
    const invalidDetails = [
        { 'unknown.field': 'x' }, { 'basicInfo.__proto__': 'x' }, { '__proto__.polluted': 'x' },
        { 'qlf.constructor': 'x' }, { 'qlf.2.qlfName': 'x' }, { 'job.-1.jobDesc': 'x' },
        { 'job.1000.jobDesc': 'x' }, { 'job.01.jobDesc': 'x' }, { 'basicInfo.0.empFirstName': 'x' },
        { 'job.0.extraJob': 'x' }, { 'job.0.jobDesc': ['x'] }, { 'qlf.qlfName': {} },
        { 'basicInfo.empMobile': false }, { 'job.jobDescNumber': Infinity },
        { 'qlf.qlfName': 'a'.repeat(501) }, { 'basicInfo.empBirthDate': '2025-02-29' },
        { 'basicInfo.nationalIdNum': '123' }, { 'basicInfo.empCode': '-10' },
        { 'basicInfo.empCode': '9007199254740992' },
        { 'job.jobDesc': 'first', 'job.0.jobDesc': 'second' },
        JSON.parse('{"__proto__":"polluted"}'), null, [], 'text',
        Object.assign(Object.create({ polluted: true }), { 'qlf.qlfName': 'x' })
    ];
    for (const details of invalidDetails) {
        assert.throws(() => db.updateEmployee(10, { notes: 'لا تحفظ', details }), error => error instanceof db.DataError);
        assert.deepEqual(db.getEmployee(10), original);
    }
    assert.equal({}.polluted, undefined);
});

test('date fields normalize Arabic dates and allow explicit clearing without erasing other dates', () => {
    importFixture();
    db.updateEmployee(10, { details: { 'basicInfo.empBirthDate': '٠١/٠٢/١٩٩٠', 'job.1.jobDescDate': '2024-02-29', 'qlf.0.empQlfDate': null } });
    db.updateEmployee(10, { details: { 'job.1.jobDescDate': '' } });
    const raw = db.getEmployee(10).raw_data;
    assert.equal(raw.basicInfo.empBirthDate, '1990-02-01');
    assert.equal(raw.job[1].jobDescDate, '');
    assert.equal(raw.qlf[0].empQlfDate, '');
});

test('name parts need an aggregate name and IDs stay consistent with duplicate checks', () => {
    const first = db.createEmployee({ details: { 'basicInfo.empFirstName': 'اسم', 'basicInfo.empFamilyName': 'عائلة', 'basicInfo.nationalIdNum': '٢٩٠٠١٠١٠٠٠٠٠٠١', 'basicInfo.empCode': '٠٠١٠' } });
    const second = db.createEmployee({ fullName: 'موظف آخر', empCode: '11', nationalId: '29001010000002' });
    assert.throws(() => db.createEmployee({ details: { 'basicInfo.empMobile': '0100' } }), /اسم/);
    assert.throws(() => db.updateEmployee(first.emp_code, { details: { 'basicInfo.empFirstName': '', 'basicInfo.empFamilyName': null } }), /اسم/);
    assert.throws(() => db.updateEmployee(first.emp_code, { details: { 'basicInfo.nationalIdNum': '٢٩٠٠١٠١٠٠٠٠٠٠٢' } }), error => error.status === 409);
    assert.throws(() => db.updateEmployee(first.emp_code, { details: { 'basicInfo.empCode': '٠١١' } }), error => error.status === 409);
    assert.deepEqual(db.getEmployee(first.emp_code), first);
    const corrected = db.updateEmployee(first.emp_code, { nationalId: second.national_id, empCode: second.source_emp_code, details: { 'basicInfo.nationalIdNum': '٢٩٠٠١٠١٠٠٠٠٠٠٣', 'basicInfo.empCode': '٠٠١٢', 'basicInfo.empFatherName': 'والد' } });
    assert.equal(corrected.full_name, 'اسم والد عائلة');
    assert.equal(corrected.national_id, corrected.raw_data.basicInfo.nationalIdNum);
    assert.equal(corrected.source_emp_code, corrected.raw_data.basicInfo.empCode);
    assert.equal(corrected.source_emp_code, '12');
});

test('local ministry code edits keep original fetch identity and custom-list membership stable', () => {
    importFixture();
    const list = db.createCustomList({ name: 'قائمة تجريبية', memberIds: [10] });
    const edited = db.updateEmployee(10, { details: { 'basicInfo.empCode': '٠٠١٢٣', 'basicInfo.nationalIdNum': '29001010000003' } });
    assert.equal(edited.emp_code, 10);
    assert.equal(edited.source_emp_code, '10');
    assert.equal(edited.raw_data.basicInfo.empCode, '123');
    assert.deepEqual(db.getCustomList(list.id).memberIds, [10]);
    assert.equal(db.getCustomList(list.id).availableCount, 1);
    for (const empCode of ['١٢٣', '٠٠١٠']) assert.throws(() => db.createEmployee({ fullName: 'مكرر', empCode }), error => error.status === 409);
    assert.equal(db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture()).status, 'saved');
    assert.equal(db.getEmployee(10).raw_data.basicInfo.empCode, '123');
    assert.equal(db.getEmployee(10).national_id, '29001010000003');
    db.updateEmployee(10, { empCode: '124' });
    assert.equal(db.getEmployee(10).raw_data.basicInfo.empCode, '124');
    assert.equal(db.getEmployee(10).source_emp_code, '10');
});

test('snapshot replacement removes detailed ministry corrections and preserves detailed manual data', () => {
    importFixture();
    const manual = db.createEmployee({ details: { 'basicInfo.empFirstName': 'إضافة يدوية', 'basicInfo.empEmail': 'fixture@example.invalid', 'secondment.toGehaName': 'جهة جديدة', 'job.kadrJobDecNum2': '٣٤' } });
    db.updateEmployee(manual.emp_code, { details: { 'basicInfo.genderDesc': 'ذكر', 'qlf.qlfEntityName': 'جامعة محفوظة' } });
    const preserved = db.getEmployee(manual.emp_code);
    db.updateEmployee(10, { details: { 'basicInfo.empCode': '125', 'basicInfo.empEmail': 'override@example.invalid', 'qlf.1.qlfName': 'تصحيح مؤهل' } });
    db.replaceMinistryEmployees([{ empCode: 10, nationalId: '29001010000001', fullName: 'أحمد محمد علي حسن', rawData: fixture(), staffType: 'core' }]);
    assert.deepEqual(db.getEmployee(manual.emp_code), preserved);
    assert.deepEqual(db.getEmployee(10).raw_data, fixture());
    assert.equal(db.getEmployee(10).has_local_changes, false);
});
