import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllFields } from '../public/js/fieldMappings.js';
import { getValue } from '../public/js/dataModel.js';
import { employeeEditorGroups, employeeEditorPayload, employeeEditorName } from '../public/js/employeeEditor.js';

test('editor offers every employee field for new and existing staff, including identifiers', () => {
  const expected = getAllFields().map(field => field.path).sort();
  for (const employee of [undefined, { emp_code: 10, source: 'ministry', raw_data: {} }]) {
    const fields = employeeEditorGroups(employee).flatMap(group => group.fields);
    assert.deepEqual(fields.map(field => field.path).sort(), expected);
    assert.equal(new Set(fields.map(field => field.path)).size, fields.length);
    assert.equal(fields.find(field => field.path === 'basicInfo.empCode').value, employee ? '10' : '');
  }
});

test('all stored qualification and job history entries have independent editable paths', () => {
  const employee = { raw_data: { qlf: [{ qlfName: 'مؤهل أول' }, { qlfName: 'مؤهل ثان', qlfEntityName: 'جهة ثانية' }], job: [{ jobDesc: 'وظيفة أولى' }, { jobDesc: 'وظيفة ثانية' }] } };
  const fields = employeeEditorGroups(employee).flatMap(group => group.fields);
  assert.equal(fields.find(field => field.path === 'qlf.1.qlfName').value, 'مؤهل ثان');
  assert.equal(fields.find(field => field.path === 'job.1.jobDesc').value, 'وظيفة ثانية');
  assert.equal(getValue(employee, 'qlf.qlfName'), 'مؤهل أول');
  assert.equal(getValue(employee, 'qlf.1.qlfName'), 'مؤهل ثان');
  assert.equal(getValue(employee, 'qlf.2.qlfName'), '');
});

test('dates show correctly without silently clearing unusual ministry values', () => {
  const employee = { raw_data: { basicInfo: { empBirthDate: '1988-03-02T00:00:00Z', empHiredate: '١/٩/٢٠١٠', empStartDate: 'تاريخ غير محدد' } } };
  const fields = employeeEditorGroups(employee).flatMap(group => group.fields);
  assert.equal(fields.find(field => field.path === 'basicInfo.empBirthDate').value, '1988-03-02');
  assert.equal(fields.find(field => field.path === 'basicInfo.empHiredate').value, '2010-09-01');
  const start = fields.find(field => field.path === 'basicInfo.empStartDate');
  assert.equal(start.inputType, 'text'); assert.equal(start.value, 'تاريخ غير محدد');
  const initial = Object.fromEntries(fields.map(field => [`details:${field.path}`, field.value]));
  assert.deepEqual(employeeEditorPayload(initial, initial), {});
});

test('legacy array-shaped basic data retain the editable name and displayed identity', () => {
  const employee = { emp_code: 10, source_emp_code: '10', raw_data: { basicInfo: [{ empCode: '20', nationalIdNum: '00000000000001', empFirstName: 'أحمد', empFatherName: 'علي' }] } };
  const fields = employeeEditorGroups(employee).flatMap(group => group.fields);
  const values = Object.fromEntries(fields.map(field => [`details:${field.path}`, field.value]));
  assert.equal(employeeEditorName(values), 'أحمد علي');
  assert.equal(values['details:basicInfo.empCode'], '20');
  assert.equal(values['details:basicInfo.nationalIdNum'], '00000000000001');
  const payload = employeeEditorPayload({ ...values, 'details:basicInfo.empFatherName': 'محمود' }, values);
  assert.equal(payload.details['basicInfo.empFirstName'], 'أحمد');
  assert.equal(payload.details['basicInfo.empFatherName'], 'محمود');
  employee.raw_data.basicInfo[0].empCode = '';
  assert.equal(getValue(employee, 'basicInfo.empCode'), '', 'A deliberately cleared displayed code stays blank');
});

test('payload sends only actual edits and deliberate clearing while keeping identifiers as text', () => {
  const initial = { 'details:basicInfo.nationalIdNum': '00000000000001', 'details:basicInfo.empMobile': '01011111111', 'details:qlf.1.qlfName': 'قديم', 'details:job.kadrJobStartDate': '2020-01-01', staffType: 'core', notes: '' };
  const edited = { ...initial, 'details:basicInfo.empMobile': '٠١٠٢٢٢٢٢٢٢٢', 'details:qlf.1.qlfName': 'مؤهل معدل', 'details:job.kadrJobStartDate': '', notes: 'ملاحظة' };
  assert.deepEqual(employeeEditorPayload(edited, initial), { details: { 'basicInfo.empMobile': '٠١٠٢٢٢٢٢٢٢٢', 'qlf.1.qlfName': 'مؤهل معدل', 'job.kadrJobStartDate': '' }, notes: 'ملاحظة' });
  assert.equal(employeeEditorPayload(initial).details['basicInfo.nationalIdNum'], '00000000000001');
});

test('name preview follows separate components and legacy full names remain available', () => {
  const employee = { full_name: 'أحمد علي حسن عبد الله', raw_data: {} };
  const fields = employeeEditorGroups(employee).flatMap(group => group.fields);
  const values = Object.fromEntries(fields.map(field => [`details:${field.path}`, field.value]));
  assert.equal(employeeEditorName(values), employee.full_name);
  const originalValues = { ...values };
  values['details:basicInfo.empFatherName'] = 'محمود';
  assert.equal(employeeEditorName(values), 'أحمد محمود حسن عبد الله');
  assert.deepEqual(employeeEditorPayload(values, originalValues).details, {
    'basicInfo.empFirstName': 'أحمد', 'basicInfo.empFatherName': 'محمود',
    'basicInfo.empGrandFatherName': 'حسن', 'basicInfo.empFamilyName': 'عبد الله',
  });
  const realParts = employeeEditorGroups({ full_name: 'اسم آخر', raw_data: { basicInfo: { empFirstName: 'عبد الرحمن', empFatherName: 'علي' } } }).flatMap(group => group.fields);
  assert.equal(realParts.find(field => field.path === 'basicInfo.empFirstName').value, 'عبد الرحمن');
});
