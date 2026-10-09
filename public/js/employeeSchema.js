import { getAllFields } from './fieldMappings.js';

export const REPEATABLE_SECTIONS = ['qlf', 'job', 'secondment', 'customFields'];
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sectionLabels = { basicInfo: 'البيانات الشخصية والعمل والتواصل', qlf: 'المؤهلات وجهات التخرج', job: 'الدرجات الوظيفية والكادر', secondment: 'سجلات الندب', customFields: 'بيانات إضافية تختارها', notes: 'ملاحظات' };
const extraFields = {
  'basicInfo.tel': ['رقم الهاتف الأرضي', 'text'],
  'basicInfo.brchDesc': ['التخصص / الشعبة', 'text'],
  'basicInfo.martDate': ['تاريخ الحالة الاجتماعية', 'date'],
  'basicInfo.passportId': ['رقم جواز السفر', 'text'],
  'basicInfo.empIdCardNum': ['رقم بطاقة الموظف', 'text'],
  'basicInfo.secondmentGehaName': ['جهة الندب المسجلة', 'text'],
  'basicInfo.secondmentMudriaName': ['مديرية الندب المسجلة', 'text'],
  'basicInfo.secondmentRelatedName': ['التبعية في الندب', 'text'],
  'basicInfo.secondmentSchoolName': ['مدرسة الندب', 'text'],
  'basicInfo.secondmentStageName': ['مرحلة مدرسة الندب', 'text'],
  'basicInfo.toEdaraName': ['الإدارة المنقول إليها', 'text'],
  'basicInfo.toGehaName': ['الجهة المنقول إليها', 'text'],
  'basicInfo.toMudriaName': ['المديرية المنقول إليها', 'text'],
  'basicInfo.addressCode': ['كود محل السكن', 'text'],
  'basicInfo.birthCode': ['كود محل الميلاد', 'number'],
  'basicInfo.brchCode': ['كود التخصص / الشعبة', 'number'],
  'basicInfo.empFlag': ['كود حالة الموظف بالوزارة', 'number'],
  'basicInfo.genderCode': ['كود النوع', 'number'],
  'basicInfo.hireLawCode': ['كود قانون التعيين', 'number'],
  'basicInfo.isDeleted': ['علامة الحذف في بيانات الوزارة', 'boolean'],
  'basicInfo.martStatId': ['كود الحالة الاجتماعية', 'number'],
  'basicInfo.nationalityCode': ['كود الجنسية', 'number'],
  'basicInfo.recruitmentType': ['كود نوع التعيين', 'text'],
  'basicInfo.religionCode': ['كود الديانة', 'number'],
  'basicInfo.secondmentGehaCode': ['كود جهة الندب', 'number'],
  'basicInfo.secondmentSchoolCode': ['كود مدرسة الندب', 'number'],
  'basicInfo.toEdaraCode': ['كود الإدارة المنقول إليها', 'number'],
  'basicInfo.toGehaCode': ['كود الجهة المنقول إليها', 'number'],
  'basicInfo.toMudriaCode': ['كود المديرية المنقول إليها', 'number'],
  'job.degreeCode': ['كود الدرجة الوظيفية', 'number'],
  'job.empCode': ['كود الموظف في السجل الوظيفي', 'text'],
  'job.hasSubject': ['له مادة تدريس', 'boolean'],
  'job.isCurrent': ['السجل الوظيفي الحالي', 'boolean'],
  'job.isFirstHire': ['بيانات التعيين الأول', 'boolean'],
  'job.isUpdated': ['علامة تحديث السجل الوظيفي', 'boolean'],
  'job.jobClsCode': ['كود المجموعة النوعية', 'number'],
  'qlf.empCode': ['كود الموظف في سجل المؤهل', 'text'],
  'qlf.isLatestQlf': ['المؤهل الأحدث', 'boolean'],
  'qlf.qlfCode': ['كود المؤهل', 'number'],
  'qlf.qlfEntityCode': ['كود جهة التخرج', 'number'],
  'qlf.qlfGradId': ['كود تقدير المؤهل', 'number'],
  fromAnotherGeha: ['وافد من جهة أخرى', 'boolean'],
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 150 && !unsafeKeys.has(key);
const fallbackLabel = key => sectionLabels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
const scalar = (label, type = 'text', known = false) => ({ kind: 'scalar', label, type, nullable: true, ...(known ? { known: true } : {}) });
const object = label => ({ kind: 'object', label, fields: {} });

function mergeObserved(node, value, key, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return node || scalar(fallbackLabel(key));
  if (Array.isArray(value)) {
    if (node?.kind !== 'array') node = { kind: 'array', label: node?.label || fallbackLabel(key), item: node?.kind === 'object' ? node : undefined };
    for (const entry of value) node.item = mergeObserved(node.item, entry, key, depth + 1);
    node.item ||= scalar('القيمة');
    return node;
  }
  if (plain(value)) {
    if (node?.kind === 'array') { node.item = mergeObserved(node.item, value, key, depth + 1); return node; }
    if (node?.kind !== 'object') node = object(node?.label || fallbackLabel(key));
    for (const [property, child] of Object.entries(value)) {
      if (!safeKey(property)) continue;
      node.fields[property] = mergeObserved(node.fields[property], child, property, depth + 1);
    }
    return node;
  }
  if (node?.kind === 'scalar' && node.known) return node;
  if (node?.kind === 'object' || node?.kind === 'array') return node;
  const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text';
  return scalar(node?.label || fallbackLabel(key), type);
}

export function buildEmployeeSchema(rawRecords = []) {
  const root = object('بيانات الموظف');
  const definitions = [...getAllFields().map(field => [field.path, field.label, field.type === 'enum' ? 'text' : field.type]), ...Object.entries(extraFields).map(([path, [label, type]]) => [path, label, type])];
  for (const [path, label, originalType] of definitions) {
    const parts = path.split('.');
    let parent = root;
    for (const part of parts.slice(0, -1)) parent = parent.fields[part] ||= object(fallbackLabel(part));
    const type = ['basicInfo.empCode', 'basicInfo.nationalIdNum'].includes(path) ? 'text' : originalType;
    parent.fields[parts.at(-1)] = scalar(label, type, true);
  }
  root.fields.basicInfo.fields.empMobile.label = 'رقم الهاتف المحمول / الموبايل';
  root.fields.notes = scalar('ملاحظات', 'text', true);
  root.fields.customFields = object('بيانات إضافية تختارها');
  root.fields.customFields.fields.label = scalar('اسم البيان', 'text', true);
  root.fields.customFields.fields.value = scalar('قيمة البيان', 'text', true);
  for (const key of REPEATABLE_SECTIONS) root.fields[key] = { kind: 'array', label: sectionLabels[key], item: root.fields[key], repeatable: true };
  for (const raw of rawRecords) if (plain(raw)) mergeObserved(root, raw, 'بيانات الموظف');
  return root;
}

export function getSchemaAtPath(schema, path) {
  if (!Array.isArray(path) || path.length > 16) return null;
  let node = schema;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Number.isSafeInteger(part) || part < 0 || node?.kind !== 'array') return null;
      node = node.item;
    } else {
      if (!safeKey(part)) return null;
      // Ministry often sends one record as an object, later local records use arrays.
      if (node?.kind === 'array') node = node.item;
      if (node?.kind !== 'object' || !Object.hasOwn(node.fields, part)) return null;
      node = node.fields[part];
    }
  }
  return node || null;
}

export function blankSchemaValue(node) {
  if (node?.kind === 'array') return [];
  if (node?.kind === 'object') return {}; // New records gain only the fields the user fills in.
  return node?.type === 'boolean' || node?.type === 'number' ? null : '';
}
