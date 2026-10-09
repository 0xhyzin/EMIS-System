import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db/database.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-lists-test-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const imported = (empCode, fullName = `موظف الوزارة ${empCode}`) => ({ empCode, nationalId: '', fullName, rawData: { basicInfo: { empCode } }, staffType: 'core' });

test('custom lists retain chosen order, unique membership and manual members across database restart', () => {
    db.replaceMinistryEmployees([imported(10), imported(11)]);
    const manual = db.createEmployee({ fullName: 'عضو يدوي' });
    const list = db.createCustomList({ name: '  لجنة الامتحانات  ', memberIds: [11, manual.emp_code, 10, 11] });
    assert.equal(list.name, 'لجنة الامتحانات');
    assert.deepEqual(list.memberIds, [11, manual.emp_code, 10]);
    assert.equal(list.memberCount, 3); assert.equal(list.availableCount, 3); assert.equal(list.missingCount, 0);
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.deepEqual(db.getCustomList(list.id), list);
    assert.deepEqual(db.getCustomLists(), [list]);
});

test('ministry snapshot replacement retains membership IDs and restores returning members with fresh data', () => {
    db.replaceMinistryEmployees([imported(10), imported(11)]);
    const manual = db.createEmployee({ fullName: 'عضو يدوي دائم' });
    const list = db.createCustomList({ name: 'المتابعة', memberIds: [10, manual.emp_code, 11] });
    db.replaceMinistryEmployees([imported(11, 'اسم محدث'), imported(12)]);
    const missing = db.getCustomList(list.id);
    assert.deepEqual(missing.memberIds, [10, manual.emp_code, 11]);
    assert.equal(missing.availableCount, 2); assert.equal(missing.missingCount, 1);
    assert.equal(db.getEmployee(11).full_name, 'اسم محدث');
    db.closeDatabase(); db.initDatabase({ dataDir: dir });
    assert.equal(db.getCustomList(list.id).missingCount, 1);
    db.replaceMinistryEmployees([imported(10, 'عاد للوزارة'), imported(11)]);
    const restored = db.getCustomList(list.id);
    assert.deepEqual(restored.memberIds, list.memberIds);
    assert.equal(restored.availableCount, 3); assert.equal(restored.missingCount, 0);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
});

test('editing a list can retain its missing members but cannot add unknown employee IDs', () => {
    db.replaceMinistryEmployees([imported(10)]);
    const list = db.createCustomList({ name: 'قائمة أولى', memberIds: [10] });
    db.replaceMinistryEmployees([]);
    const retained = db.updateCustomList(list.id, { name: 'قائمة معدلة', memberIds: [10] });
    assert.equal(retained.missingCount, 1);
    assert.throws(() => db.updateCustomList(list.id, { name: 'تعديل غير صالح', memberIds: [10, 999] }), error => error.status === 400);
    assert.deepEqual(db.getCustomList(list.id), retained);
    assert.throws(() => db.createCustomList({ name: 'قائمة جديدة', memberIds: [10] }), error => error.status === 400);
    assert.equal(db.getCustomLists().length, 1);
    assert.equal(db.updateCustomList(list.id, { name: retained.name, memberIds: [] }).memberCount, 0);
});

test('invalid list names, IDs and members cannot change the saved list', () => {
    const manual = db.createEmployee({ fullName: 'عضو' });
    const list = db.createCustomList({ name: 'Staff', memberIds: [manual.emp_code] });
    for (const invalid of [null, [], {}, { name: '', memberIds: [] }, { name: ' '.repeat(5), memberIds: [] }, { name: 'x'.repeat(151), memberIds: [] }, { name: 'جديدة', memberIds: [0] }, { name: 'جديدة', memberIds: ['-1'] }, { name: 'جديدة', memberIds: [1.5] }, { name: 'جديدة', memberIds: [Number.MAX_SAFE_INTEGER + 1] }]) {
        assert.throws(() => db.updateCustomList(list.id, invalid), error => error.status === 400);
        assert.deepEqual(db.getCustomList(list.id), list);
    }
    assert.throws(() => db.createCustomList({ name: ' staff ', memberIds: [] }), error => error.status === 409);
    for (const id of [0, -1, 'bad', '1.5', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => db.getCustomList(id), error => error.status === 400);
    assert.equal(db.getCustomList(999), null);
    assert.throws(() => db.updateCustomList(999, { name: 'غير موجودة', memberIds: [] }), error => error.status === 404);
});

test('a failed member write rolls back the list name and all prior memberships together', () => {
    db.replaceMinistryEmployees([imported(10), imported(11)]);
    const list = db.createCustomList({ name: 'قبل المحاولة', memberIds: [10] });
    const editor = new DatabaseSync(db.getDatabasePath());
    editor.exec("CREATE TRIGGER reject_list_member BEFORE INSERT ON custom_list_members WHEN NEW.employee_id=11 BEGIN SELECT RAISE(ABORT, 'fixture list failure'); END;");
    editor.close();
    assert.throws(() => db.updateCustomList(list.id, { name: 'اسم لن يُحفظ', memberIds: [10, 11] }), /fixture list failure/);
    assert.deepEqual(db.getCustomList(list.id), list);
    assert.throws(() => db.createCustomList({ name: 'لن تُنشأ', memberIds: [10, 11] }), /fixture list failure/);
    assert.deepEqual(db.getCustomLists(), [list]);
});

test('deleting a list removes its memberships and leaves employees and other lists intact', () => {
    const manual = db.createEmployee({ fullName: 'عضو محفوظ' });
    const removed = db.createCustomList({ name: 'للحذف', memberIds: [manual.emp_code] });
    const retained = db.createCustomList({ name: 'للحفظ', memberIds: [manual.emp_code] });
    db.deleteCustomList(removed.id);
    assert.equal(db.getCustomList(removed.id), null);
    assert.deepEqual(db.getCustomLists(), [retained]);
    assert.deepEqual(db.getEmployee(manual.emp_code), manual);
    const reader = new DatabaseSync(db.getDatabasePath());
    assert.equal(reader.prepare('SELECT COUNT(*) count FROM custom_list_members WHERE list_id=?').get(removed.id).count, 0);
    reader.close();
});

test('deleted manual members stay missing instead of attaching to the next manual employee', () => {
    const manual = db.createEmployee({ fullName: 'يدوي محذوف' });
    const list = db.createCustomList({ name: 'عضوية محفوظة', memberIds: [manual.emp_code] });
    db.deleteEmployee(manual.emp_code);
    const replacement = db.createEmployee({ fullName: 'يدوي آخر' });
    assert.notEqual(replacement.emp_code, manual.emp_code);
    assert.deepEqual(db.getCustomList(list.id).memberIds, [manual.emp_code]);
    assert.equal(db.getCustomList(list.id).availableCount, 0);
    assert.equal(db.getCustomList(list.id).missingCount, 1);
});
