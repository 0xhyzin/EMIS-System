import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFields } from '../public/js/reportFields.js';
import { getValue, columnText, selectEmployees } from '../public/js/dataModel.js';

test('report columns include editor fields and independent repeatable records without storing values', () => {
  const employees = [{ emp_code: -1, raw_data: { basicInfo: { tel: 'fixture private number' },
    qlf: [{ qlfName: 'fixture private qualification' }, { qlfName: 'المؤهل الثاني' }],
    training: [{ title: 'fixture private training', hours: 20 }, { title: 'دورة ثانية', hours: 25 }] } }];
  const fields = buildReportFields(employees);
  for (const path of ['fullName', 'notes', 'basicInfo.tel', 'basicInfo.brchDesc', 'job.degreeDesc',
    'qlf.qlfEntityName', 'qlf.1.qlfName', 'training.title', 'training.1.hours']) {
    assert.ok(fields.some(field => field.path === path), path);
  }
  assert.equal(new Set(fields.map(field => field.path)).size, fields.length);
  assert.ok(!JSON.stringify(fields).includes('fixture private'));
  assert.equal(getValue(employees[0], 'qlf.1.qlfName'), 'المؤهل الثاني');
  assert.match(fields.find(field => field.path === 'qlf.1.qlfName').label, /السجل 2/);
});

test('a named extra field exports and filters the right values even when local record order differs', () => {
  const employees = [
    { emp_code: -1, raw_data: { customFields: [{ label: 'تكليف إضافي', value: 'الإشراف' }, { label: 'رقم الملف', value: '0007' }] } },
    { emp_code: -2, raw_data: { customFields: [{ label: 'رقم الملف', value: '0010' }, { label: 'تكليف إضافي', value: 'المكتبة' }] } },
    { emp_code: -3, raw_data: { customFields: [{ label: 'رقم الملف', value: 0 }] } },
  ];
  const column = buildReportFields(employees).find(field => field.label === 'رقم الملف');
  assert.ok(column);
  assert.equal(columnText(employees[0], column), '0007');
  assert.equal(columnText(employees[1], column), '0010');
  assert.equal(columnText(employees[2], column), '0');
  assert.deepEqual(selectEmployees(employees, { filters: [{ path: column.path, values: ['0010'] }] }).map(employee => employee.emp_code), [-2]);
  assert.equal(buildReportFields(employees).filter(field => field.label === 'رقم الملف').length, 1);
});

test('report choices keep safe scalar paths and malformed named paths cannot escape local data', () => {
  const hostile = JSON.parse('{"__proto__":{"secret":"x"},"basicInfo":{"constructor":"x"}}');
  const fields = buildReportFields([{ raw_data: hostile }, { raw_data: { basicInfo: [{ extra: 'value' }], customFields: { label: 'بيان / إضافي', value: false } } }]);
  assert.ok(!fields.some(field => /__proto__|constructor/.test(field.path)));
  assert.equal(getValue({ raw_data: { customFields: { label: 'بيان / إضافي', value: false } } }, fields.find(field => field.label === 'بيان / إضافي').path), 'false');
  assert.equal(getValue({}, 'customField:%bad%'), '');
  assert.equal({}.secret, undefined);
});
