import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import * as db from '../db/database.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-complete-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const set = (path, value) => ({ op: 'set', path, value });
const append = (path, value) => ({ op: 'append', path, value });
const remove = (path, index) => ({ op: 'remove', path, index });
const fixture = () => ({
    basicInfo: { empCode: 10, nationalIdNum: '29001010000001', empFirstName: 'أحمد', empFatherName: 'محمد', empMobile: '01000000000', extraContact: { phone: '01100000000', verified: false } },
    qlf: { qlfName: 'مؤهل أول', qlfEntityName: 'جامعة أولى', extraCertificate: { hours: 45, approved: true } },
    job: [{ jobDesc: 'معلم', degreeDesc: 'الثالثة', extraRank: 7 }, { jobDesc: 'مدرس سابق', degreeDesc: 'الرابعة', extraRank: 4 }],
    secondment: null,
    career: { courses: [{ title: 'دورة أولى', days: 3, passed: false }], tags: ['لغة عربية', 'تدريب'], optional: null },
    unchanged: { nested: ['محفوظ', 3, false, null] }
});
function importFixture() { db.upsertEmployee(10, '29001010000001', 'أحمد محمد', fixture()); return db.getEmployee(10); }

test('all observed scalar fields, nested keys and typed values can be edited without touching other data', () => {
    importFixture();
    const rawPatch = [
        set(['basicInfo', 'empMobile'], '01200000000'), set(['qlf', 'qlfEntityName'], 'جامعة معدلة'),
        set(['job', 1, 'degreeDesc'], 'الثانية'), set(['basicInfo', 'extraContact', 'verified'], true),
        set(['qlf', 'extraCertificate', 'hours'], 72), set(['career', 'courses', 0, 'passed'], true),
        set(['career', 'tags', 1], 'تنمية مهنية'), set(['career', 'optional'], 'متاح')
    ];
    const actual = db.updateEmployee(10, { rawPatch }).raw_data;
    const expected = fixture();
    expected.basicInfo.empMobile = '01200000000'; expected.qlf.qlfEntityName = 'جامعة معدلة';
    expected.job[1].degreeDesc = 'الثانية'; expected.basicInfo.extraContact.verified = true;
    expected.qlf.extraCertificate.hours = 72; expected.career.courses[0].passed = true;
    expected.career.tags[1] = 'تنمية مهنية'; expected.career.optional = 'متاح';
    assert.deepEqual(actual, expected);
    assert.equal(db.getEmployee(10).full_name, 'أحمد محمد');
});

test('new employees can use fields observed on other employees and add repeated histories', () => {
    importFixture();
    const created = db.createEmployee({ staffType: 'seconded', notes: 'ملف جديد', rawPatch: [
        set(['basicInfo', 'empFirstName'], 'إضافة'), set(['basicInfo', 'empFatherName'], 'جديدة'),
        set(['basicInfo', 'extraContact', 'phone'], '01500000000'),
        set(['basicInfo', 'extraContact', 'verified'], false),
        append(['qlf'], { qlfName: 'بكالوريوس', qlfEntityName: 'جامعة جديدة', extraCertificate: { hours: 20, approved: false } }),
        append(['qlf'], { qlfName: 'دبلوم', empQlfDate: '٠١/٠٢/٢٠٢٠' }),
        append(['job'], { degreeDesc: 'الأولى', jobDesc: 'معلم أول' }),
        append(['secondment'], { fromGehaName: 'المدرسة الأصلية', toGehaName: 'المدرسة الجديدة' }),
        append(['career', 'courses'], { title: 'دورة جديدة', days: 2, passed: true })
    ] });
    assert.equal(created.source, 'manual'); assert.equal(created.full_name, 'إضافة جديدة');
    assert.equal(created.staff_type, 'seconded'); assert.equal(created.raw_data.notes, 'ملف جديد');
    assert.equal(created.raw_data.basicInfo.extraContact.verified, false);
    assert.equal(created.raw_data.qlf.length, 2); assert.equal(created.raw_data.qlf[1].empQlfDate, '2020-02-01');
    assert.deepEqual(created.raw_data.career.courses, [{ title: 'دورة جديدة', days: 2, passed: true }]);
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.deepEqual(db.getEmployee(created.emp_code), created);
});

test('appending converts a single object while retaining it and handles null and empty collections', () => {
    importFixture();
    const actual = db.updateEmployee(10, { rawPatch: [
        set(['qlf', 'qlfEntityName'], 'الجهة المصححة'), append(['qlf'], { qlfName: 'مؤهل ثان' }),
        append(['secondment'], { toGehaName: 'ندب أول' }), append(['career', 'tags'], 'نشاط جديد')
    ] }).raw_data;
    assert.deepEqual(actual.qlf, [{ ...fixture().qlf, qlfEntityName: 'الجهة المصححة' }, { qlfName: 'مؤهل ثان' }]);
    assert.deepEqual(actual.secondment, [{ toGehaName: 'ندب أول' }]);
    assert.deepEqual(actual.career.tags, ['لغة عربية', 'تدريب', 'نشاط جديد']);
    db.updateEmployee(10, { rawPatch: [remove(['secondment'], 0), append(['secondment'], { toGehaName: 'ندب بديل' })] });
    assert.deepEqual(db.getEmployee(10).raw_data.secondment, [{ toGehaName: 'ندب بديل' }]);
});

test('removal uses sequential indexes and preserves records that remain', () => {
    importFixture();
    const actual = db.updateEmployee(10, { rawPatch: [
        set(['job', 1, 'degreeDesc'], 'درجة معدلة'), remove(['job'], 0),
        append(['job'], { jobDesc: 'وظيفة جديدة' }), remove(['qlf'], 0),
        remove(['career', 'tags'], 0)
    ] }).raw_data;
    assert.deepEqual(actual.job, [{ ...fixture().job[1], degreeDesc: 'درجة معدلة' }, { jobDesc: 'وظيفة جديدة' }]);
    assert.deepEqual(actual.qlf, []); assert.deepEqual(actual.career.tags, ['تدريب']);
});

test('free Arabic custom fields can be created, edited and removed', () => {
    const employee = db.createEmployee({ fullName: 'معلم جديد', customFields: [{ label: '  أعمال إضافية  ', value: 'مشرف النشاط' }] });
    assert.deepEqual(employee.raw_data.customFields, [{ label: 'أعمال إضافية', value: 'مشرف النشاط' }]);
    const changed = db.updateEmployee(employee.emp_code, { rawPatch: [
        set(['customFields', 0, 'value'], 'مشرف المكتبة'), append(['customFields'], { label: 'عدد الحصص', value: 12 })
    ] });
    assert.deepEqual(changed.raw_data.customFields, [{ label: 'أعمال إضافية', value: 'مشرف المكتبة' }, { label: 'عدد الحصص', value: 12 }]);
    db.updateEmployee(employee.emp_code, { rawPatch: [remove(['customFields'], 0)] });
    assert.deepEqual(db.getEmployee(employee.emp_code).raw_data.customFields, [{ label: 'عدد الحصص', value: 12 }]);
});

test('raw edits keep ministry identity and saved lists stable while updating duplicate checks and display name', () => {
    importFixture();
    const list = db.createCustomList({ name: 'قائمة', memberIds: [10] });
    const other = db.createEmployee({ fullName: 'معلم آخر', empCode: '11', nationalId: '29001010000002' });
    const employee = db.updateEmployee(10, { rawPatch: [
        set(['basicInfo', 'empCode'], '٠٠١٢'), set(['basicInfo', 'nationalIdNum'], '٢٩٠٠١٠١٠٠٠٠٠٠٣'),
        set(['basicInfo', 'empFirstName'], 'اسم'), set(['basicInfo', 'empFatherName'], 'معدل')
    ] });
    assert.equal(employee.emp_code, 10); assert.equal(employee.source_emp_code, '10');
    assert.equal(employee.full_name, 'اسم معدل'); assert.equal(employee.national_id, '29001010000003');
    assert.equal(employee.raw_data.basicInfo.empCode, '12'); assert.deepEqual(db.getCustomList(list.id).memberIds, [10]);
    assert.throws(() => db.updateEmployee(10, { rawPatch: [set(['basicInfo', 'empCode'], other.source_emp_code)] }), error => error.status === 409);
    assert.throws(() => db.updateEmployee(10, { rawPatch: [set(['basicInfo', 'nationalIdNum'], other.national_id)] }), error => error.status === 409);
    assert.deepEqual(db.getEmployee(10), employee);
    for (const empCode of ['10', '12']) assert.throws(() => db.createEmployee({ fullName: 'مكرر', empCode }), error => error.status === 409);
});

test('manual identity corrections remain consistent across display, duplicate checks and reopening', () => {
    const employee = db.createEmployee({ rawPatch: [set(['basicInfo', 'empFirstName'], 'اسم'), set(['basicInfo', 'empCode'], '0014')] });
    db.updateEmployee(employee.emp_code, { rawPatch: [set(['basicInfo', 'empCode'], '٠٠١٥'), set(['basicInfo', 'nationalIdNum'], '29001010000003')] });
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    const actual = db.getEmployee(employee.emp_code);
    assert.equal(actual.emp_code, employee.emp_code); assert.equal(actual.source_emp_code, '15');
    assert.equal(actual.national_id, '29001010000003'); assert.equal(actual.raw_data.basicInfo.empCode, '15');
});

test('legacy detail edits and complete section edits follow latest changes without duplicating appends', () => {
    importFixture();
    db.updateEmployee(10, { notes: 'ملاحظة قديمة', details: { 'qlf.qlfName': 'تصحيح قديم', 'job.1.degreeDesc': 'درجة قديمة' } });
    db.updateEmployee(10, { rawPatch: [set(['notes'], 'ملاحظة حديثة'), set(['qlf', 'qlfName'], 'تصحيح جديد'), append(['qlf'], { qlfName: 'مؤهل مضاف' }), set(['basicInfo', 'empFirstName'], 'اسم جديد')] });
    db.updateEmployee(10, { details: { 'qlf.1.qlfName': 'المؤهل المضاف معدل', 'basicInfo.empFatherName': 'أب معدل' } });
    const saved = db.getEmployee(10);
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture());
    db.upsertEmployee(10, '29001010000001', 'اسم الوزارة', fixture());
    assert.deepEqual(db.getEmployee(10).raw_data, saved.raw_data);
    assert.equal(db.getEmployee(10).full_name, 'اسم جديد أب معدل');
    assert.equal(db.getEmployee(10).raw_data.qlf.length, 2);
});

test('snapshot replacement discards imported complete edits and retains all manual data', () => {
    importFixture();
    const manual = db.createEmployee({ rawPatch: [set(['basicInfo', 'empFirstName'], 'إضافة محفوظة'), append(['qlf'], { qlfName: 'مؤهل أول' }), append(['qlf'], { qlfName: 'مؤهل ثان' }), append(['customFields'], { label: 'تفاصيل أخرى', value: 'محفوظة' })] });
    db.updateEmployee(10, { rawPatch: [set(['basicInfo', 'extraContact', 'verified'], true), append(['qlf'], { qlfName: 'مؤهل محلي' })] });
    db.replaceMinistryEmployees([{ empCode: 10, nationalId: '29001010000001', fullName: 'أحمد محمد', rawData: fixture() }]);
    assert.deepEqual(db.getEmployee(10).raw_data, fixture()); assert.equal(db.getEmployee(10).has_local_changes, false);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
});

test('invalid paths, unrecognized keys and unsafe input atomically reject every edit', () => {
    const original = importFixture();
    const invalid = [
        [set(['basicInfo', '__proto__', 'polluted'], true)], [set(['constructor', 'prototype', 'polluted'], true)],
        [set(['unseen', 'field'], 'غير مسموح')], [set(['job', -1, 'degreeDesc'], 'درجة')],
        [set(['job', 2, 'degreeDesc'], 'درجة')], [set(['job', '0', 'degreeDesc'], 'درجة')],
        [set(['basicInfo', 'extraContact'], 'نص')], [set(['qlf', 'qlfName'], {})], [set(['qlf', 'qlfName'], false)],
        [set(['career', 'optional'], Infinity)], [set(['career', 'optional'], 'x'.repeat(4001))],
        [append(['qlf'], { unseen: 'غير مسموح' })], [append(['qlf'], JSON.parse('{"__proto__":{"polluted":true}}'))],
        [remove(['job'], 99)], [remove(['job'], -1)], [remove(['basicInfo'], 0)],
        [append(['basicInfo'], { empFirstName: 'غير مسموح' })], [remove(['unchanged'], 0)],
        [set(['basicInfo', 'empBirthDate'], '2025-02-29')], [set(['basicInfo', 'nationalIdNum'], '123')],
        [set(['basicInfo', 'empCode'], '9007199254740992')],
        [{ op: 'set', path: ['career', 'optional'] }], [{ op: 'set', path: ['career', 'optional'], value: 'x', unknown: true }],
        [append(['customFields'], { label: '', value: 'قيمة' })], [append(['customFields'], { label: 'اسم بلا قيمة' })],
        [set(['basicInfo', 'empFirstName'], ''), set(['basicInfo', 'empFatherName'], '')]
    ];
    for (const rawPatch of invalid) {
        assert.throws(() => db.updateEmployee(10, { notes: 'لا تحفظ', rawPatch: [set(['basicInfo', 'empMobile'], 'تصحيح لا يحفظ'), ...rawPatch] }), error => error instanceof db.DataError);
        assert.deepEqual(db.getEmployee(10), original);
    }
    assert.equal({}.polluted, undefined);
});

test('raw operations cannot conflict with legacy aliases and invalid custom fields do not create records', () => {
    assert.throws(() => db.createEmployee({ fullName: 'تعارض', rawPatch: [set(['basicInfo', 'empFirstName'], 'اسم')] }), /واحدة/);
    assert.throws(() => db.createEmployee({ details: {}, rawPatch: [] }), /واحدة/);
    assert.throws(() => db.createEmployee({ fullName: 'غير محفوظ', customFields: [{ label: '', value: 'قيمة' }] }), /اسم/);
    assert.throws(() => db.createEmployee({ rawPatch: [set(['basicInfo', 'empMobile'], '0100')] }), /اسم/);
    assert.equal(db.getAllEmployees().length, 0);
});

test('a scalar stays editable when another employee uses an object at the same observed key', () => {
    db.upsertEmployee(10, '', 'موظف أول', { basicInfo: { empFirstName: 'موظف أول' }, extra: { status: 'حالة نصية' } });
    db.upsertEmployee(11, '', 'موظف ثان', { basicInfo: { empFirstName: 'موظف ثان' }, extra: { status: { title: 'حالة مفصلة' } } });
    db.updateEmployee(10, { rawPatch: [set(['extra', 'status'], 'حالة معدلة')] });
    assert.equal(db.getEmployee(10).raw_data.extra.status, 'حالة معدلة');
    assert.throws(() => db.updateEmployee(11, { rawPatch: [set(['extra', 'status'], 'حذف تفاصيل ضمني')] }), /داخل السجل/);
});
