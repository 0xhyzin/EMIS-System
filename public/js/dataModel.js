// Shared by the browser and Word exporter: one selection and formatting contract.
export const DEFAULT_COLUMNS = [
  { id: 'index', path: 'index', label: 'م', isIndex: true, width: 3.5 },
  { id: 'name', path: 'fullName', label: 'الاسم', width: 16 },
  { id: 'national', path: 'basicInfo.nationalIdNum', label: 'الرقم القومي', width: 12 },
  { id: 'start', path: 'basicInfo.empStartDate', label: 'تاريخ استلام العمل', type: 'date', width: 8.5 },
  { id: 'hire', path: 'basicInfo.empHiredate', label: 'تاريخ التعيين', type: 'date', width: 8.5 },
  { id: 'qualification', label: 'المؤهل وتاريخه', isMerged: true, type: 'merged', fields: ['qlf.qlfName', 'qlf.empQlfDate'], separator: 'newline', width: 15 },
  { id: 'job', label: 'الوظيفة على الكادر', isMerged: true, type: 'merged', fields: ['job.jobDesc', 'job.kadrJobStartDate'], separator: 'newline', width: 11 },
  { id: 'address', path: 'basicInfo.addressDesc', label: 'عنوان السكن', width: 17 },
  { id: 'notes', path: 'notes', label: 'ملاحظات', width: 8.5 },
];

export function westernDigits(value) {
  return String(value ?? '').replace(/[٠-٩۰-۹]/g, digit => {
    const n = digit.charCodeAt(0);
    return String(n >= 1776 ? n - 1776 : n - 1632);
  });
}
export function normalizeArabic(value) {
  return westernDigits(value).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ').toLowerCase().trim();
}
export function getValue(employee, path) {
  const raw = employee?.raw_data ?? employee ?? {};
  // Extra local fields are matched by their label, never by their array position.
  if (typeof path === 'string' && path.startsWith('customField:')) {
    let label;
    try { label = decodeURIComponent(path.slice('customField:'.length)); } catch { return ''; }
    if (!label || label.length > 150 || /[\u0000-\u001f\u007f]/.test(label)) return '';
    const records = Array.isArray(raw.customFields) ? raw.customFields : raw.customFields ? [raw.customFields] : [];
    const value = records.find(field => typeof field?.label === 'string' && field.label.trim() === label)?.value;
    return value == null || typeof value === 'object' ? '' : String(value);
  }
  const basic = Array.isArray(raw.basicInfo) ? raw.basicInfo[0] : raw.basicInfo;
  if (path === 'basicInfo.nationalIdNum' && !basic?.nationalIdNum) return String(employee?.national_id ?? '');
  if (path === 'basicInfo.empCode' && basic?.empCode == null) return String(employee?.source_emp_code || (employee?.emp_code > 0 ? employee.emp_code : ''));
  if (path === 'fullName') return employee?.full_name || raw.fullName ||
    ['empFirstName', 'empFatherName', 'empGrandFatherName', 'empFamilyName'].map(key => basic?.[key]).filter(Boolean).join(' ');
  if (path === 'source') return employee?.source || 'ministry';
  if (path === 'staffType') return employee?.staff_type || 'core';
  let value = raw;
  for (const part of String(path || '').split('.')) {
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) value = value[0];
    if (value == null || ['__proto__', 'constructor', 'prototype'].includes(part)) return '';
    value = value[part];
  }
  return value == null || typeof value === 'object' ? '' : String(value);
}
export function formatDate(value, arabic = false) {
  let result = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(result);
  if (match) result = Number(match[1]) < 1900 ? '' : `${match[3]}/${match[2]}/${match[1]}`;
  return arabic ? result.replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]) : result;
}
function sortableDate(value) {
  const s = westernDigits(value);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return Date.parse(m ? `${m[3]}-${m[2]}-${m[1]}` : s);
}
export function selectEmployees(employees, { staffType = 'all', source = 'all', search = '', filters = [], sorting = [], memberIds = null } = {}) {
  const query = normalizeArabic(search);
  // An empty custom list means zero employees, not the whole school.
  const members = Array.isArray(memberIds) ? new Set(memberIds.map(Number)) : null;
  const selected = employees.filter(emp => {
    if (members && !members.has(Number(emp.emp_code))) return false;
    if (staffType && staffType !== 'all' && emp.staff_type !== staffType) return false;
    if (source && source !== 'all' && (emp.source || 'ministry') !== source) return false;
    if (query && !normalizeArabic([getValue(emp, 'fullName'), emp.emp_code, emp.national_id,
      getValue(emp, 'basicInfo.nationalIdNum'), getValue(emp, 'basicInfo.empCode')].join(' ')).includes(query)) return false;
    return (filters || []).every(filter => {
      if (!filter.path || !Array.isArray(filter.values) || !filter.values.length) return true;
      const match = filter.values.map(String).includes(getValue(emp, filter.path).trim());
      return filter.mode === 'exclude' ? !match : match;
    });
  });
  return selected.sort((a, b) => {
    for (const rule of sorting || []) {
      const va = getValue(a, rule.path || rule.field).trim(), vb = getValue(b, rule.path || rule.field).trim();
      if (va === vb) continue;
      if (!va || !vb) return !va ? 1 : -1; // Missing values always last.
      let comparison = 0;
      if (rule.direction === 'custom' && Array.isArray(rule.customOrder)) {
        const ia = rule.customOrder.indexOf(va), ib = rule.customOrder.indexOf(vb);
        comparison = (ia < 0 ? rule.customOrder.length : ia) - (ib < 0 ? rule.customOrder.length : ib);
      } else if (rule.type === 'date' || /Date|date$/.test(rule.path || '')) {
        const da = sortableDate(va), db = sortableDate(vb);
        if (!Number.isFinite(da) || !Number.isFinite(db)) {
          if (Number.isFinite(da) !== Number.isFinite(db)) return Number.isFinite(da) ? -1 : 1;
        } else comparison = da - db;
      } else {
        comparison = normalizeArabic(va).localeCompare(normalizeArabic(vb), 'ar', { numeric: rule.type === 'number' });
      }
      if (comparison && Number.isFinite(comparison)) return rule.direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}
export function columnText(employee, column, index = 0, { useArabicNumerals = false } = {}) {
  let text;
  const value = path => formatDate(getValue(employee, path));
  if (column.isIndex || column.path === 'index' || column.type === 'index') text = String(index + 1);
  else if (column.type === 'manual') text = String(column.manualValues?.[String(employee?.emp_code)] ?? '');
  else if (column.isMerged || column.type === 'merged') {
    const paths = column.parts ? column.parts.map(part => part.path) : column.fields || [];
    const separator = { newline: '\n', space: ' ', dash: ' - ', none: '' }[column.separator] ?? column.separator ?? '\n';
    text = paths.map(value).filter(Boolean).join(separator);
  } else text = value(column.path || column.field);
  return useArabicNumerals ? text.replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]) : text;
}
