import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import * as db from '../db/database.js';
import { buildEmployeeSchema } from '../public/js/employeeSchema.js';
import { createEmployeeDraft, renderEmployeeEditor, applyEmployeeEditorValues, appendEmployeeRecord, removeEmployeeRecord, employeeDraftName, employeeDraftPayload, employeeDetailsGroups } from '../public/js/completeEmployeeEditor.js';

let directory;
beforeEach(() => { directory = fs.mkdtempSync(join(os.tmpdir(), 'emis-complete-editor-')); db.initDatabase({ dataDir: directory }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });
const fixture = () => ({ basicInfo: { empFirstName: 'معلم', empFatherName: 'تجريبي', empMobile: '01012345678', tel: '0222222222', extraPhone: { number: '01112345678', primary: false } }, qlf: { qlfName: 'بكالوريوس', qlfEntityName: 'جامعة تجريبية', extraCertificate: 'بيان محفوظ' }, job: { degreeDesc: 'الثالثة', jobDesc: 'معلم' }, extraRecords: [{ title: 'تدريب', hours: 2, completed: false }], mixed: ['نص', 12, false] });
function fill(editor, changes) {
  renderEmployeeEditor(editor);
  const values = Object.fromEntries(editor.fields.map(field => [field.id, field.initialValue]));
  for (const [path, value] of changes) {
    const field = editor.fields.find(item => JSON.stringify(item.path) === JSON.stringify(path));
    assert.ok(field, `Editor is missing ${JSON.stringify(path)}`);
    values[field.id] = value;
  }
  applyEmployeeEditorValues(editor, values);
}

test('the actual complete form exposes all three requested examples and every observed extra leaf', () => {
  const raw = fixture(), editor = createEmployeeDraft({ raw_data: raw }, buildEmployeeSchema([raw]));
  const html = renderEmployeeEditor(editor);
  for (const path of [['basicInfo','empMobile'], ['basicInfo','tel'], ['qlf','qlfEntityName'], ['job','degreeDesc'], ['basicInfo','extraPhone','number'], ['extraRecords',0,'hours'], ['mixed',0], ['mixed',1], ['mixed',2]]) {
    assert.ok(editor.fields.some(field => JSON.stringify(field.path) === JSON.stringify(path)), JSON.stringify(path));
  }
  for (const label of ['رقم الهاتف المحمول', 'رقم الهاتف الأرضي', 'جهة التخرج', 'الدرجة الوظيفية']) assert.ok(html.includes(label));
  fill(editor, []);
  assert.deepEqual(employeeDraftPayload(editor).rawPatch, undefined, 'Opening and saving must not coerce any existing scalar type');
});

test('new-teacher form adds all requested data plus multiple qualifications, jobs and custom details', () => {
  const editor = createEmployeeDraft(undefined, buildEmployeeSchema());
  fill(editor, [[['basicInfo','empFirstName'],'إضافة'], [['basicInfo','empFatherName'],'تجريبية'], [['basicInfo','empMobile'],'01512345678'], [['basicInfo','tel'],'0233333333'], [['qlf',0,'qlfEntityName'],'جامعة أولى'], [['qlf',0,'qlfName'],'مؤهل أول'], [['job',0,'degreeDesc'],'الثانية']]);
  appendEmployeeRecord(editor, ['qlf']);
  fill(editor, [[['qlf',1,'qlfName'],'مؤهل ثان'], [['qlf',1,'qlfEntityName'],'جامعة ثانية']]);
  appendEmployeeRecord(editor, ['job']);
  fill(editor, [[['job',1,'jobDesc'],'وظيفة أخرى']]);
  appendEmployeeRecord(editor, ['customFields']);
  fill(editor, [[['customFields',0,'label'],'العمل الإضافي'], [['customFields',0,'value'],'مشرف نشاط']]);
  const saved = db.createEmployee(employeeDraftPayload(editor));
  assert.equal(saved.full_name, 'إضافة تجريبية');
  assert.equal(saved.raw_data.basicInfo.tel, '0233333333');
  assert.equal(saved.raw_data.qlf.length, 2); assert.equal(saved.raw_data.qlf[1].qlfEntityName, 'جامعة ثانية');
  assert.equal(saved.raw_data.job.length, 2); assert.equal(saved.raw_data.job[0].degreeDesc, 'الثانية');
  assert.deepEqual(saved.raw_data.customFields, [{ label: 'العمل الإضافي', value: 'مشرف نشاط' }]);
  assert.equal(saved.raw_data.secondment, undefined, 'Untouched virtual records must not be stored');
});

test('editing then appending/removing keeps typed draft values, raw extras and sequential record identity', () => {
  const raw = fixture();
  db.upsertEmployee(40, '', 'معلم تجريبي', raw);
  const editor = createEmployeeDraft(db.getEmployee(40), buildEmployeeSchema([raw]));
  fill(editor, [[['basicInfo','empMobile'],'01212345678'], [['qlf','qlfEntityName'],'جهة مصححة'], [['job','degreeDesc'],'الأولى'], [['extraRecords',0,'completed'],'true']]);
  appendEmployeeRecord(editor, ['qlf']);
  fill(editor, [[['qlf',1,'qlfName'],'مؤهل مضاف']]);
  removeEmployeeRecord(editor, ['job'], 0);
  appendEmployeeRecord(editor, ['job']);
  fill(editor, [[['job',0,'degreeDesc'],'درجة بديلة']]);
  const saved = db.updateEmployee(40, employeeDraftPayload(editor));
  assert.equal(saved.raw_data.basicInfo.empMobile, '01212345678');
  assert.equal(saved.raw_data.qlf[0].qlfEntityName, 'جهة مصححة');
  assert.equal(saved.raw_data.qlf[0].extraCertificate, 'بيان محفوظ');
  assert.equal(saved.raw_data.extraRecords[0].completed, true);
  assert.equal(saved.raw_data.job[0].degreeDesc, 'درجة بديلة');
  assert.deepEqual(saved.raw_data.mixed, ['نص', 12, false]);
});

test('legacy name-only records retain every component and explicit cleared codes stay empty', () => {
  db.upsertEmployee(50, '', 'أحمد علي حسن عبد الله', { basicInfo: { empCode: '50' } });
  const editor = createEmployeeDraft(db.getEmployee(50));
  fill(editor, [[['basicInfo','empFatherName'],'محمود'], [['basicInfo','empCode'],'']]);
  assert.equal(employeeDraftName(editor), 'أحمد محمود حسن عبد الله');
  const saved = db.updateEmployee(50, employeeDraftPayload(editor));
  assert.equal(saved.full_name, employeeDraftName(editor));
  const reopened = createEmployeeDraft(saved); renderEmployeeEditor(reopened);
  assert.equal(reopened.fields.find(field => JSON.stringify(field.path) === '["basicInfo","empCode"]').initialValue, '');
});

test('detail view includes additional typed fields and every repeated record', () => {
  const raw = fixture(); raw.qlf = [raw.qlf, { qlfName: 'مؤهل ثان', qlfEntityName: 'جهة ثانية' }];
  const groups = employeeDetailsGroups({ raw_data: raw }, buildEmployeeSchema([raw]));
  const fields = groups.flatMap(group => group.fields);
  assert.ok(fields.some(field => field.value === 'جهة ثانية'));
  assert.ok(fields.some(field => field.value === '0222222222'));
  assert.ok(fields.some(field => field.value === 'لا'));
});

test('a failed save can be corrected without retaining the rejected old field value', () => {
  const editor = createEmployeeDraft(undefined, buildEmployeeSchema());
  fill(editor, [[['basicInfo','empFirstName'],'معلم'], [['basicInfo','nationalIdNum'],'123']]);
  assert.throws(() => db.createEmployee(employeeDraftPayload(editor)), /١٤/);
  appendEmployeeRecord(editor, ['job']);
  fill(editor, [[['basicInfo','nationalIdNum'],'29001010000001'], [['job',0,'degreeDesc'],'الأولى']]);
  const saved = db.createEmployee(employeeDraftPayload(editor));
  assert.equal(saved.national_id, '29001010000001');
  assert.equal(saved.raw_data.job[0].degreeDesc, 'الأولى');
});

test('creating with an observed basic-info array uses safe object name paths', () => {
  const schema = buildEmployeeSchema([{ basicInfo: [{ empFirstName: 'مثال', extraValue: 'بيان' }] }]);
  const editor = createEmployeeDraft(undefined, schema);
  fill(editor, [[['basicInfo','empFirstName'],'اسم جديد'], [['basicInfo','extraValue'],'بيان جديد']]);
  // The server learns extra fields from the existing employees, just like the browser.
  db.upsertEmployee(65, '', 'مثال', { basicInfo: [{ empFirstName: 'مثال', extraValue: 'بيان' }] });
  const saved = db.createEmployee(employeeDraftPayload(editor));
  assert.equal(saved.full_name, 'اسم جديد');
  assert.equal(saved.raw_data.basicInfo.extraValue, 'بيان جديد');
});

test('new teacher requires only a name and leaves all optional fields and histories blank', () => {
  const editor = createEmployeeDraft(undefined, buildEmployeeSchema());
  fill(editor, [[['basicInfo','empFirstName'],'موظف بالاسم فقط']]);
  const saved = db.createEmployee(employeeDraftPayload(editor));
  assert.equal(saved.full_name,'موظف بالاسم فقط');
  assert.equal(saved.national_id,'');
  assert.equal(saved.source_emp_code,'');
  assert.equal(saved.raw_data.qlf,undefined);
  assert.equal(saved.raw_data.job,undefined);
  assert.equal(saved.raw_data.basicInfo.empMobile,undefined);
});
