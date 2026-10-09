import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmployeeSchema, getSchemaAtPath, blankSchemaValue } from '../public/js/employeeSchema.js';

test('complete schema includes phone, graduation entity, degree and previously omitted ministry fields with Arabic labels', () => {
  const schema = buildEmployeeSchema();
  for (const path of ['basicInfo.empMobile','basicInfo.tel','basicInfo.martDate','basicInfo.passportId','basicInfo.toEdaraName','basicInfo.secondmentSchoolName','qlf.qlfEntityName','qlf.isLatestQlf','job.degreeDesc','job.isCurrent','fromAnotherGeha']) {
    const field = getSchemaAtPath(schema, path.split('.'));
    assert.equal(field.kind, 'scalar', path);
    assert.match(field.label, /[\u0600-\u06ff]/, path);
  }
  assert.equal(getSchemaAtPath(schema, ['basicInfo','nationalIdNum']).type, 'text');
  assert.equal(getSchemaAtPath(schema, ['job',0,'isCurrent']).type, 'boolean');
  assert.equal(getSchemaAtPath(schema, ['qlf',1,'qlfEntityName']).label, 'جهة التخرج');
});

test('observed nested and extra fields become available when adding another teacher without leaking employee values', () => {
  const raw = { basicInfo: { privateExtra: 'private fixture value' }, professional: { license: { active: true, code: 17 } }, training: [{ title: 'private fixture course', hours: 40 }], special: null };
  const schema = buildEmployeeSchema([raw]);
  assert.equal(getSchemaAtPath(schema, ['basicInfo','privateExtra']).type, 'text');
  assert.equal(getSchemaAtPath(schema, ['professional','license','active']).type, 'boolean');
  assert.equal(getSchemaAtPath(schema, ['training',0,'hours']).type, 'number');
  assert.equal(getSchemaAtPath(schema, ['special']).type, 'text');
  assert.ok(!JSON.stringify(schema).includes('private fixture'));
  assert.deepEqual(blankSchemaValue(schema.fields.qlf.item), {});
});

test('object and array records share their full schema while hostile prototype paths remain unavailable', () => {
  const schema = buildEmployeeSchema([{ qlf: { extra: 'x' } }, { qlf: [{ secondExtra: 'y' }] }, JSON.parse('{"__proto__":{"polluted":true},"basicInfo":{"constructor":"x"}}')]);
  assert.equal(getSchemaAtPath(schema, ['qlf','extra']).kind, 'scalar');
  assert.equal(getSchemaAtPath(schema, ['qlf',2,'secondExtra']).kind, 'scalar');
  assert.equal(getSchemaAtPath(schema, ['basicInfo','constructor']), null);
  assert.equal(getSchemaAtPath(schema, ['__proto__','polluted']), null);
  assert.equal(getSchemaAtPath(schema, ['qlf',-1,'extra']), null);
  assert.equal({}.polluted, undefined);
  assert.equal(getSchemaAtPath(schema, ['customFields',0,'label']).label, 'اسم البيان');
});
