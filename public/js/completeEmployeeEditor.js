import { buildEmployeeSchema, getSchemaAtPath, blankSchemaValue } from './employeeSchema.js';
import { normalizeArabic, westernDigits } from './dataModel.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const nameKeys = ['empFirstName', 'empFatherName', 'empGrandFatherName', 'empFamilyName'];
const primaryRecords = new Set(['qlf', 'job', 'secondment']);
const clone = value => structuredClone(value);
const samePath = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const pathStartsWith = (path, prefix) => prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
const rawAt = (raw, path) => path.reduce((value, part) => value?.[part], raw);
function setAt(raw, path, value) {
  let parent = raw;
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index];
    if (!parent[part] || typeof parent[part] !== 'object') parent[part] = typeof path[index + 1] === 'number' ? [] : {};
    parent = parent[part];
  }
  parent[path.at(-1)] = value;
}
function inputValue(value, node) {
  if (node.type === 'boolean') return { value: value == null ? '' : String(value), type: 'boolean' };
  if (node.type !== 'date') return { value: value == null ? '' : String(value), type: 'text' };
  const text = westernDigits(value).trim();
  if (!text) return { value: '', type: 'date' };
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const date = iso?.[1] || (local ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}` : '');
  if (date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) return { value: date, type: 'date' };
  return { value: String(value), type: 'text', dateHint: true };
}
function displayValue(editor, path) {
  const value = rawAt(editor.raw, path);
  const last = path.at(-1);
  if (value != null && !(value === '' && editor.fallbackNames && path[0] === 'basicInfo' && nameKeys.includes(last))) return value;
  if (path[0] === 'basicInfo' && (path.length === 2 || path[1] === 0)) {
    if (editor.fallbackNames && nameKeys.includes(last)) return editor.fallbackNames[nameKeys.indexOf(last)];
    if (last === 'nationalIdNum') return editor.employee?.national_id || value;
    if (last === 'empCode') return editor.employee?.source_emp_code || (editor.employee?.emp_code > 0 ? editor.employee.emp_code : value);
  }
  return value;
}
export function createEmployeeDraft(employee, schema = buildEmployeeSchema([employee?.raw_data || {}])) {
  const raw = clone(employee?.raw_data || {});
  const basic = Array.isArray(raw.basicInfo) ? raw.basicInfo[0] : raw.basicInfo;
  const parts = (employee?.full_name || '').trim().split(/\s+/);
  const fallbackNames = !nameKeys.some(key => basic?.[key]) && parts[0] ? [parts[0] || '', parts[1] || '', parts[2] || '', parts.slice(3).join(' ')] : null;
  return { employee, schema, raw, operations: [], fields: [], arrays: [], fallbackNames, search: '', staffType: employee?.staff_type || 'core', initialStaffType: employee?.staff_type || 'core', removedArrays: new Set() };
}
export function employeeDraftName(editor) {
  const basic = Array.isArray(editor.raw.basicInfo) ? editor.raw.basicInfo[0] : editor.raw.basicInfo;
  return nameKeys.map((key, index) => String(basic?.[key] ?? editor.fallbackNames?.[index] ?? '').trim()).filter(Boolean).join(' ');
}
function ensureRecordParents(editor, path) {
  for (let index = 0; index < path.length; index++) {
    if (typeof path[index] !== 'number') continue;
    const parentPath = path.slice(0, index);
    const existing = rawAt(editor.raw, parentPath);
    const length = Array.isArray(existing) ? existing.length : existing && typeof existing === 'object' ? 1 : 0;
    if (path[index] >= length) appendEmployeeRecord(editor, parentPath);
  }
}
function setEmployeeField(editor, path, value) {
  ensureRecordParents(editor, path);
  setAt(editor.raw, path, value);
  // Keep the newest scalar edit after a failed save. An earlier rejected value must
  // not be replayed before its correction; record changes still keep their ordering.
  for (let index = editor.operations.length - 1; index >= 0; index--) {
    const previous = editor.operations[index];
    if (previous.op !== 'set' && (pathStartsWith(path, previous.path) || pathStartsWith(previous.path, path))) break;
    if (previous.op === 'set' && samePath(previous.path, path)) { previous.value = value; return; }
  }
  editor.operations.push({ op: 'set', path: clone(path), value });
}
export function appendEmployeeRecord(editor, path) {
  const node = getSchemaAtPath(editor.schema, path);
  if (node?.kind !== 'array') throw new Error('تعذر إضافة سجل في هذا القسم.');
  ensureRecordParents(editor, path);
  const value = blankSchemaValue(node.item);
  const previous = rawAt(editor.raw, path);
  const records = Array.isArray(previous) ? previous : previous && typeof previous === 'object' ? [previous] : [];
  records.push(clone(value));
  setAt(editor.raw, path, records);
  editor.operations.push({ op: 'append', path: clone(path), value: clone(value) });
  editor.removedArrays.delete(JSON.stringify(path));
}
export function removeEmployeeRecord(editor, path, index) {
  const previous = rawAt(editor.raw, path);
  const records = Array.isArray(previous) ? previous : previous && typeof previous === 'object' ? [previous] : [];
  if (!Number.isInteger(index) || index < 0 || index >= records.length) throw new Error('السجل المطلوب غير موجود.');
  const recordPath = Array.isArray(previous) ? [...path, index] : path;
  for (let position = editor.operations.length - 1; position >= 0; position--) {
    const operation = editor.operations[position];
    if (operation.op !== 'set' && (pathStartsWith(operation.path, path) || pathStartsWith(path, operation.path))) break;
    if (operation.op === 'set' && pathStartsWith(operation.path, recordPath)) editor.operations.splice(position, 1);
  }
  records.splice(index, 1);
  setAt(editor.raw, path, records);
  editor.operations.push({ op: 'remove', path: clone(path), index });
  if (!records.length) editor.removedArrays.add(JSON.stringify(path));
}
export function applyEmployeeEditorValues(editor, values) {
  const changed = [];
  for (const field of editor.fields) {
    if (!Object.hasOwn(values, field.id) || values[field.id] === field.initialValue) continue;
    const text = String(values[field.id]);
    let value = text;
    if (field.node.type === 'boolean') value = text === '' ? null : text === 'true';
    if (field.node.type === 'number') {
      value = text.trim() === '' ? null : Number(westernDigits(text));
      if (value !== null && !Number.isFinite(value)) throw new Error(`اكتب رقمًا صحيحًا في «${field.node.label}».`);
    }
    changed.push({ field, value, text });
  }
  // Validate all controls before applying any edits, so a bad numeric field cannot partly flush the form.
  if (editor.fallbackNames && changed.some(({ field }) => field.path[0] === 'basicInfo' && nameKeys.includes(field.path.at(-1)))) {
    const prefix = changed.find(({ field }) => field.path[0] === 'basicInfo' && nameKeys.includes(field.path.at(-1))).field.path.slice(0, -1);
    nameKeys.forEach((key, index) => setEmployeeField(editor, [...prefix, key], editor.fallbackNames[index]));
    editor.fallbackNames = null;
  }
  for (const { field, value, text } of changed) { setEmployeeField(editor, field.path, value); field.initialValue = text; }
  if (Object.hasOwn(values, 'staffType')) editor.staffType = values.staffType;
  return editor;
}
export function flushEmployeeEditor(editor, form) {
  const values = Object.fromEntries(editor.fields.map(field => [field.id, form.elements.namedItem(field.id)?.value ?? field.initialValue]));
  values.staffType = form.elements.namedItem('staffType').value;
  return applyEmployeeEditorValues(editor, values);
}
export function employeeDraftPayload(editor) {
  const payload = {};
  if (editor.operations.length) payload.rawPatch = clone(editor.operations);
  if (!editor.employee || editor.staffType !== editor.initialStaffType) payload.staffType = editor.staffType;
  return payload;
}
function fieldHTML(editor, node, path, context) {
  const value = displayValue(editor, path);
  if (!node.known && value != null && typeof value !== 'object') node = { ...node, kind: 'scalar', type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text' };
  const control = inputValue(value, node);
  const id = `complete-employee-field-${editor.fields.length}`;
  const multiline = node.type === 'text' && (/address|notes/i.test(String(path.at(-1))) || String(value ?? '').length > 180);
  editor.fields.push({ id, path: clone(path), node, initialValue: control.value });
  const numeric = node.type === 'number';
  const phone = /Mobile|Phone|^tel$/i.test(String(path.at(-1)));
  const attributes = `id="${id}" name="${id}"${numeric ? ' inputmode="decimal"' : phone ? ' inputmode="tel"' : ''}${phone || /email|IdNum|empCode/i.test(String(path.at(-1))) ? ' dir="ltr"' : ''}`;
  const extraBoolean = control.type === 'boolean' && !['', 'true', 'false'].includes(control.value) ? `<option value="${escape(control.value)}" selected>${escape(control.value)} (القيمة الحالية)</option>` : '';
  const input = control.type === 'boolean' ? `<select ${attributes}><option value=""${control.value === '' ? ' selected' : ''}>غير محدد</option><option value="true"${control.value === 'true' ? ' selected' : ''}>نعم</option><option value="false"${control.value === 'false' ? ' selected' : ''}>لا</option>${extraBoolean}</select>` : multiline ? `<textarea ${attributes}>${escape(control.value)}</textarea>` : `<input ${attributes} type="${control.type}" value="${escape(control.value)}" autocomplete="off">`;
  const search = normalizeArabic([node.label, ...context, ...path.filter(part => typeof part === 'string')].join(' '));
  return `<div class="employee-complete-field${multiline ? ' full' : ''}" data-editor-search="${escape(search)}"><label for="${id}">${escape(node.label)}</label>${input}${control.dateHint ? '<p class="field-hint">القيمة الحالية كما وردت. يمكنك تصحيح التاريخ هنا دون فقده.</p>' : ''}</div>`;
}
function objectHTML(editor, node, value, path, context) {
  const ordinary = [], codes = [], nested = [];
  for (const [key, child] of Object.entries(node.fields || {})) {
    const childPath = [...path, key];
    if (child.kind !== 'scalar') { nested.push(nodeHTML(editor, child, value?.[key], childPath, [...context, child.label])); continue; }
    const markup = fieldHTML(editor, child, childPath, context);
    (/^كود /.test(child.label) && !['empCode', 'nationalIdNum'].includes(key) ? codes : ordinary).push(markup);
  }
  return `${ordinary.length ? `<div class="form-grid">${ordinary.join('')}</div>` : ''}${nested.join('')}${codes.length ? `<details class="employee-code-fields" data-editor-container><summary>أكواد وبيانات تفصيلية (${codes.length})</summary><div class="form-grid">${codes.join('')}</div></details>` : ''}`;
}
function nodeHTML(editor, node, value, path, context = []) {
  if (value != null && typeof value !== 'object' && node.kind !== 'scalar') return `<div class="form-grid">${fieldHTML(editor, { ...node, kind: 'scalar', known: false }, path, context)}</div>`;
  if (node.kind === 'scalar') return `<div class="form-grid">${fieldHTML(editor, node, path, context)}</div>`;
  if (node.kind === 'object') return objectHTML(editor, node, value, path, context);
  // Personal identity remains one stable section. Some ministry responses wrap it in an array;
  // new teachers still use the implicit object paths so saving never appends/removes identities.
  if (path.length === 1 && path[0] === 'basicInfo') {
    if (!Array.isArray(value) || !value.length) return nodeHTML(editor, node.item, value || {}, path, context);
    return value.map((record, index) => `<div class="employee-personal-record" data-editor-container>${value.length > 1 ? `<h3 class="employee-section-hint">البيانات الشخصية — السجل ${index + 1}</h3>` : ''}${nodeHTML(editor, node.item, record, [...path, index], context)}</div>`).join('');
  }
  const id = editor.arrays.length;
  const arrayEntry = { path: clone(path), node };
  editor.arrays.push(arrayEntry);
  const singleton = value && typeof value === 'object' && !Array.isArray(value);
  let records = Array.isArray(value) ? value : singleton ? [value] : [];
  const placeholder = !records.length && primaryRecords.has(path[0]) && path.length === 1 && !editor.removedArrays.has(JSON.stringify(path));
  arrayEntry.placeholder = placeholder;
  if (placeholder) records = [blankSchemaValue(node.item)];
  const itemLabel = ({ qlf: 'المؤهل', job: 'السجل الوظيفي', secondment: 'سجل الندب', customFields: 'البيان الإضافي' })[path[0]] || 'السجل';
  const rows = records.map((record, index) => {
    const recordPath = singleton ? path : [...path, index];
    const recordContext = [...context, `${itemLabel} ${index + 1}`];
    return `<section class="employee-record" data-editor-container><div class="employee-record-heading"><h3>${escape(itemLabel)} ${index + 1}</h3>${placeholder ? '<small class="muted">أضف البيانات المطلوبة</small>' : `<button type="button" class="text-button danger" data-remove-record="${id}" data-record-index="${index}">حذف ${escape(itemLabel)}</button>`}</div>${nodeHTML(editor, node.item, record, recordPath, recordContext)}</section>`;
  }).join('');
  const addLabel = ({ qlf: 'إضافة مؤهل آخر', job: 'إضافة سجل وظيفي آخر', secondment: 'إضافة سجل ندب', customFields: 'إضافة بيان باسم تختاره' })[path[0]] || `إضافة سجل إلى ${node.label}`;
  return `<div class="employee-records" data-editor-container>${rows || '<p class="muted employee-record-empty" data-editor-empty>لا توجد سجلات بعد. استخدم زر الإضافة أدناه.</p>'}<button type="button" class="button secondary small employee-add-record" data-append-record="${id}" data-editor-search="${escape(normalizeArabic([...context, node.label, addLabel].join(' ')))}">+ ${escape(addLabel)}</button></div>`;
}
export function renderEmployeeEditor(editor) {
  editor.fields = []; editor.arrays = [];
  return Object.entries(editor.schema.fields).map(([key, node]) => {
    if (key === 'notes') return '';
    const content = nodeHTML(editor, node, editor.raw[key], [key], [node.label]);
    return `<details class="employee-edit-section employee-complete-section" data-editor-container open><summary><span>${escape(node.label)}</span></summary>${key === 'customFields' ? '<p class="employee-section-hint muted">أي بيان إضافي تحتاجه: اكتب اسمه وقيمته، ويمكنك إضافة أكثر من بيان.</p>' : ''}${content}</details>`;
  }).join('') + `<details class="employee-edit-section employee-complete-section" data-editor-container open><summary><span>نوع القوة والملاحظات</span></summary><div class="form-grid"><div class="employee-complete-field" data-editor-search="نوع القوة اساسية منتدب"><label for="complete-staffType">نوع القوة</label><select id="complete-staffType" name="staffType"><option value="core">قوة أساسية</option><option value="seconded"${editor.staffType === 'seconded' ? ' selected' : ''}>منتدب</option></select></div>${fieldHTML(editor, editor.schema.fields.notes, ['notes'], ['الملاحظات'])}</div></details>`;
}
export function filterEmployeeEditor(container, query) {
  const words = normalizeArabic(query).split(' ').filter(Boolean);
  for (const element of container.querySelectorAll('[data-editor-search]')) element.hidden = words.length > 0 && !words.every(word => element.dataset.editorSearch.includes(word));
  for (const element of [...container.querySelectorAll('[data-editor-container]')].reverse()) {
    const visible = [...element.querySelectorAll('[data-editor-search]')].some(field => !field.hidden);
    element.hidden = !!words.length && !visible;
    if (words.length && visible && element.tagName === 'DETAILS') element.open = true;
  }
  const count = [...container.querySelectorAll('.employee-complete-field')].filter(field => !field.hidden).length;
  return count;
}
export function employeeDetailsGroups(employee, schema = buildEmployeeSchema([employee?.raw_data || {}])) {
  const editor = createEmployeeDraft(employee, schema);
  const groups = [];
  function visit(node, value, path, group) {
    if (node.kind === 'scalar' || (value != null && typeof value !== 'object')) {
      const current = displayValue(editor, path);
      if (current !== null && current !== undefined && current !== '') group.fields.push({ label: node.label, value: typeof current === 'boolean' ? current ? 'نعم' : 'لا' : String(current) });
    } else if (node.kind === 'object') {
      for (const [key, child] of Object.entries(node.fields || {})) visit(child, value?.[key], [...path, key], group);
    } else {
      const singleton = value && typeof value === 'object' && !Array.isArray(value);
      const records = Array.isArray(value) ? value : singleton ? [value] : [];
      records.forEach((record, index) => {
        const nested = { label: `${node.label} — السجل ${index + 1}`, fields: [] };
        visit(node.item, record, singleton ? path : [...path, index], nested);
        if (nested.fields.length) groups.push(nested);
      });
    }
  }
  for (const [key, node] of Object.entries(schema.fields)) {
    if (key === 'notes') continue;
    const group = { label: node.label, fields: [] };
    visit(node, editor.raw[key], [key], group);
    if (group.fields.length) groups.push(group);
  }
  return groups;
}
