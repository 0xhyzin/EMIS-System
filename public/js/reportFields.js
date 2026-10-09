import { getAllFields } from './fieldMappings.js';
import { buildEmployeeSchema } from './employeeSchema.js';

/** Report choices use the same complete schema as the editor, without retaining values. */
export function buildReportFields(employees = []) {
  const rawRecords = employees.map(employee => employee?.raw_data ?? employee ?? {});
  const schema = buildEmployeeSchema(rawRecords);
  const fields = [{ path: 'fullName', label: 'الاسم بالكامل', type: 'text', group: 'البيانات الأساسية' },
    ...getAllFields(), { path: 'notes', label: 'ملاحظات', type: 'text', group: 'بيانات محلية' }];
  const paths = new Set(fields.map(field => field.path));
  const add = field => {
    if (!paths.has(field.path)) { paths.add(field.path); fields.push(field); }
  };
  function atPath(raw, path) {
    let value = raw;
    for (const part of path) {
      if (Array.isArray(value) && typeof part !== 'number') value = value[0];
      value = value?.[part];
    }
    return value;
  }
  function walk(node, path = [], group = '', recordLabels = []) {
    if (!node || path.length > 16 || path[0] === 'customFields') return;
    if (node.kind === 'scalar') {
      const joined = path.join('.');
      // Literal dots in observed keys cannot be addressed by legacy dot paths.
      if (!path.length || path.some(part => typeof part === 'string' && part.includes('.'))) return;
      add({ path: joined, label: `${node.label}${recordLabels.length ? ` (${recordLabels.join('، ')})` : ''}`,
        type: node.type === 'boolean' ? 'text' : node.type, group });
    } else if (node.kind === 'object') {
      for (const [key, child] of Object.entries(node.fields)) {
        walk(child, [...path, key], group || child.label, recordLabels);
      }
    } else if (node.kind === 'array') {
      // The existing shorthand selects the first object or first array entry.
      walk(node.item, path, group, recordLabels);
      const length = rawRecords.reduce((maximum, raw) => {
        const value = atPath(raw, path);
        return Math.max(maximum, Array.isArray(value) ? value.length : value && typeof value === 'object' ? 1 : 0);
      }, 1);
      for (let index = 1; index < Math.min(length, 100); index++) {
        walk(node.item, [...path, index], group, [...recordLabels, `السجل ${index + 1}`]);
      }
    }
  }
  walk(schema);
  for (const raw of rawRecords) {
    const entries = Array.isArray(raw.customFields) ? raw.customFields : raw.customFields ? [raw.customFields] : [];
    for (const entry of entries) {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
      if (!label || label.length > 150 || /[\u0000-\u001f\u007f]/.test(label)) continue;
      add({ path: `customField:${encodeURIComponent(label)}`, label, type: 'text', group: 'بيانات إضافية تختارها' });
    }
  }
  return fields;
}
