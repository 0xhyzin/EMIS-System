import { FIELD_GROUPS } from './fieldMappings.js';
import { getValue, westernDigits } from './dataModel.js';

const namePaths = ['empFirstName', 'empFatherName', 'empGrandFatherName', 'empFamilyName'].map(key => `basicInfo.${key}`);
const employmentFields = new Set(['recruitmentTypeDesc', 'edaraName', 'schoolName', 'stageName', 'empStartDate', 'empHiredate', 'orgMudriaName', 'terminateID']);

function dateInput(value) {
  const text = westernDigits(value).trim();
  if (!text) return { value: '', inputType: 'date' };
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const date = iso?.[1] || (local ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}` : '');
  if (date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) return { value: date, inputType: 'date' };
  // Keep unusual ministry values visible and unchanged unless the user edits them.
  return { value: String(value), inputType: 'text', dateHint: true };
}

export function employeeEditorGroups(employee) {
  const raw = employee?.raw_data || {};
  const groups = [];
  const fallbackNames = namePaths.some(path => getValue(employee, path).trim()) ? null : getValue(employee, 'fullName').trim().split(/\s+/);
  for (const [key, group] of Object.entries(FIELD_GROUPS)) {
    const section = Object.keys(group.fields)[0].split('.')[0];
    const entries = Array.isArray(raw[section]) && raw[section].length ? raw[section].map((_, index) => index) : [null];
    for (const index of entries) {
      const fields = Object.entries(group.fields).map(([basePath, info]) => {
        const property = basePath.split('.')[1];
        const path = index === null || (section === 'basicInfo' && index === 0) ? basePath : `${section}.${index}.${property}`;
        let value = getValue(employee, path);
        if (fallbackNames && namePaths.includes(basePath)) {
          const position = namePaths.indexOf(basePath);
          value = position === 3 ? fallbackNames.slice(3).join(' ') : fallbackNames[position] || '';
        }
        return { ...info, path, basePath, value, inputType: 'text', ...(info.type === 'date' ? dateInput(value) : {}) };
      });
      if (key === 'basicInfo') {
        groups.push({ key: 'personal', label: 'البيانات الشخصية والتواصل', fields: fields.filter(field => !employmentFields.has(field.basePath.split('.')[1])) });
        groups.push({ key: 'employment', label: 'بيانات العمل والتعيين', fields: fields.filter(field => employmentFields.has(field.basePath.split('.')[1])) });
      } else {
        groups.push({ key: `${key}-${index ?? 'main'}`, label: group.label + (entries.length > 1 ? ` — السجل ${index + 1}` : ''), fields });
      }
    }
  }
  return groups;
}

export function employeeEditorPayload(values, initialValues = null) {
  const details = {};
  const payload = {};
  for (const [name, value] of Object.entries(values)) {
    if (initialValues && value === initialValues[name]) continue;
    if (name === 'staffType' || name === 'notes') payload[name] = value;
    else if (name.startsWith('details:')) details[name.slice(8)] = value;
  }
  // Save the complete name shown in the preview, including legacy fallback parts.
  if (namePaths.some(path => Object.hasOwn(details, path))) {
    for (const path of namePaths) if (Object.hasOwn(values, `details:${path}`)) details[path] = values[`details:${path}`];
  }
  if (Object.keys(details).length) payload.details = details;
  return payload;
}

export function employeeEditorName(values) {
  return namePaths.map(path => String(values[`details:${path}`] || '').trim()).filter(Boolean).join(' ');
}
