import { DEFAULT_COLUMNS, getValue, formatDate, columnText, selectEmployees, westernDigits, normalizeArabic } from './dataModel.js';
import { REPORT_MODELS, getReportModel, DEFAULT_HOURLY_OPTIONS, hourlyEmployeeKey, hourlyRow, normalizeHourlyOptions } from './reportModels.js';
import { buildReportFields } from './reportFields.js';
import { normalizeSignatures } from './reportLayout.js';
import { buildEmployeeSchema } from './employeeSchema.js';
import { createEmployeeDraft, renderEmployeeEditor, flushEmployeeEditor, employeeDraftName, employeeDraftPayload, appendEmployeeRecord, removeEmployeeRecord, filterEmployeeEditor, employeeDetailsGroups } from './completeEmployeeEditor.js';
import { APP_VERSION } from './appVersion.js';
import { consumeSyncStream } from './syncStream.js';
import { mountUnifiedEmailEditor } from './unifiedEmailEditor.js';
import { mountAssistantChat } from './assistantChat.js';
import { exportFormatInfo, createReportExport } from './api.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  school: '<path d="m3 10 9-7 9 7M5 9v12h14V9M2 21h20M9 21v-6h6v6m-7-9h2m4 0h2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8m-8 4h8"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-6h4l1 3 3 1 3 2-1 4 1 4-3 2-3 1-1 3h-4l-1-3-3-1-3-2 1-4-1-4 3-2 3-1Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5"/>',
  transfer: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  filter: '<path d="M4 6h16M7 12h10m-7 6h4"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  sparkles: '<path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Zm7 14 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
let allFields = buildReportFields([]);
const state = { employees: [], school: {}, auth: null, staffType: 'all', source: 'all', search: '', filters: [], sorting: [{ path: 'fullName', direction: 'asc', type: 'text' }], page: 1, columns: structuredClone(DEFAULT_COLUMNS), syncing: false, configs: [], customLists: [], customListId: null, reportModel: 'staff-register', exportFormat: 'word', exporting: false, hourlyOptions: structuredClone(DEFAULT_HOURLY_OPTIONS), hourlyOptionsDirty: false };
const pageSize = 15;
state.signatures = normalizeSignatures();
let uiIdSequence = 0;
const uiId = () => `column-${Date.now()}-${++uiIdSequence}`;
const preferenceKey = 'school-register.report.v2';
let authPoll, reportTimer;

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && error.needsPairing) showPairing();
    throw new Error(error.error || error.message || 'تعذر الاتصال بالخادم. حاول مرة أخرى.');
  }
  return response.status === 204 ? null : response.json();
}
async function verifyAppVersion() {
  let version;
  try { version = await request('/version', { cache: 'no-store' }); }
  catch { throw new Error('تعذر التأكد من إصدار البرنامج. أوقف التشغيل القديم وشغّل النسخة المحدّثة من نفس المجلد ثم حدّث الصفحة.'); }
  if (version.version !== APP_VERSION || !version.completeEmployeeEditor || !version.syncModes?.includes('full')) {
    const message = 'ملفات الواجهة والبرنامج من إصدارين مختلفين. أوقف البرنامج، واستبدل ملفات التحديث كلها، ثم شغّله مجددًا وحدّث الصفحة.';
    $('global-error').textContent = message; $('global-error').hidden = false;
    throw new Error(message);
  }
}
const send = async (path, method, data) => { await verifyAppVersion(); return request(path, { method, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }); };
function toast(message, error = false) {
  const element = document.createElement('div'); element.className = `toast${error ? ' error' : ''}`; element.textContent = message; $('toasts').append(element); setTimeout(() => element.remove(), 5500);
}
async function busy(button, fn, label = 'جارٍ التنفيذ…') {
  const old = button.innerHTML; button.disabled = true; button.textContent = label;
  try { return await fn(); } catch (error) { toast(error.message, true); } finally { button.innerHTML = old; button.disabled = false; }
}
function modal(title, body, { subtitle = '', footer = '', required = false } = {}) {
  $('modal-content').innerHTML = `<div class="modal-header"><div><h2 id="modal-title">${escape(title)}</h2>${subtitle ? `<p>${escape(subtitle)}</p>` : ''}</div>${required ? '' : `<button class="icon-button" data-close aria-label="إغلاق">${icon('close')}</button>`}</div>${body}${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  $('modal').dataset.required = String(required); if (!$('modal').open) $('modal').showModal();
  $('modal').querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('modal').close()));
}
$('modal').addEventListener('cancel', event => { if ($('modal').dataset.required === 'true') event.preventDefault(); });
$('modal').addEventListener('click', event => { if (event.target === $('modal') && $('modal').dataset.required !== 'true') { const box = $('modal').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('modal').close(); } });
function options(fields, selected) { return fields.map(field => `<option value="${escape(field.path)}"${field.path === selected ? ' selected' : ''}>${escape(field.label)}</option>`).join(''); }
function fieldInfo(path) { return allFields.find(field => field.path === path) || { label: path, type: 'text' }; }
function selectedCustomList() { return state.customLists.find(list => list.id === state.customListId); }
function selectedEmployees() { return selectEmployees(state.employees, { ...state, memberIds: selectedCustomList()?.memberIds ?? null }); }
function updateSelection() { state.page = 1; renderEmployees(); renderReport(); }
function savePreferences() {
  try { localStorage.setItem(preferenceKey, JSON.stringify({ columns: state.columns, title: $('report-title').value, orientation: $('orientation').value, numerals: $('numerals').value, footer: state.signatures, exportFormat: state.exportFormat, reportModel: state.reportModel })); } catch { /* App remains usable when browser storage is unavailable. */ }
}
function restorePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null'); if (!saved) return;
    if (Array.isArray(saved.columns) && saved.columns.length && saved.columns.length <= 30 && saved.columns.every(column => column && typeof column === 'object' && typeof column.label === 'string')) state.columns = saved.columns;
    if (typeof saved.title === 'string') $('report-title').value = saved.title;
    if (['landscape', 'portrait'].includes(saved.orientation)) $('orientation').value = saved.orientation;
    if (['western', 'arabic'].includes(saved.numerals)) $('numerals').value = saved.numerals;
    if (['word', 'excel', 'pdf'].includes(saved.exportFormat)) state.exportFormat = saved.exportFormat;
    if (getReportModel(saved.reportModel)) state.reportModel = saved.reportModel;
    if (Array.isArray(saved.footer)) state.signatures = normalizeSignatures(saved.footer);
  } catch { /* Discard invalid preferences. */ }
}

async function loadData() {
  const [employees, school, configs, customLists, hourlyOptions] = await Promise.all([request('/employees'), request('/school-info'), request('/table-config'), request('/custom-lists'), request('/report-models/hourly-contract-period-1/settings')]);
  state.employees = employees; state.school = school || {}; state.configs = configs; state.customLists = customLists;
  allFields = buildReportFields(employees);
  if (!state.hourlyOptionsDirty) state.hourlyOptions = normalizeHourlyOptions(hourlyOptions);
  if (!selectedCustomList()) state.customListId = null;
  $('global-error').hidden = true;
  $('stat-total').textContent = employees.length;
  $('stat-core').textContent = employees.filter(e => e.staff_type === 'core').length;
  $('stat-seconded').textContent = employees.filter(e => e.staff_type === 'seconded').length;
  $('stat-manual').textContent = employees.filter(e => e.source === 'manual').length;
  $('nav-count').textContent = employees.length; $('tab-count').textContent = employees.length;
  $('sidebar-school').textContent = school.schoolName || 'إدارة بيانات المدرسة';
  for (const [id, key] of [['school-name', 'schoolName'], ['edara-name', 'edaraName'], ['mudria-name', 'mudriaName']]) $(id).value = school[key] || '';
  renderCustomLists(); renderEmployees(); renderFilterRules(); renderSortRules(); renderReport(); renderConfigs();
}
function employeeName(emp) { return emp.full_name || getValue(emp, 'fullName') || 'بدون اسم'; }
function nameCell(emp) {
  const name = employeeName(emp); const initials = name.split(/\s+/).slice(0, 2).map(n => n[0]).join(' ');
  const code = getValue(emp, 'basicInfo.empCode') || (emp.emp_code > 0 ? emp.emp_code : '');
  return `<button class="employee-name" data-action="view" data-id="${Number(emp.emp_code)}"><span class="initials" aria-hidden="true">${escape(initials)}</span><span><strong>${escape(name)}</strong><small>${code ? `كود الموظف: ${escape(code)}` : 'سجل محلي بالمدرسة'}</small></span></button>`;
}
function sourceBadge(emp) { return `<span class="source-mark${emp.source === 'manual' || emp.has_local_changes ? ' manual' : ''}">${emp.source === 'manual' ? 'إضافة يدوية' : emp.has_local_changes ? 'معدّل يدويًا · محفوظ' : 'موقع الوزارة'}</span>`; }
function staffBadge(emp) { return `<span class="pill${emp.staff_type === 'seconded' ? ' seconded' : ''}">${emp.staff_type === 'seconded' ? 'منتدب' : 'قوة أساسية'}</span>`; }
function actions(emp) { return ['view', 'edit', 'delete'].map(action => `<button class="icon-button${action === 'delete' ? ' danger' : ''}" data-action="${action}" data-id="${Number(emp.emp_code)}" aria-label="${{ view: 'عرض بيانات', edit: 'تعديل بيانات', delete: 'حذف' }[action]} ${escape(employeeName(emp))}" title="${{ view: 'عرض البيانات', edit: 'تعديل', delete: 'حذف' }[action]}">${icon({ view: 'eye', edit: 'edit', delete: 'trash' }[action])}</button>`).join('') + `<button type="button" class="button email-button employee-email-button" data-action="unified-email" data-id="${Number(emp.emp_code)}" aria-label="تغيير بيانات البريد — ${escape(employeeName(emp))}">${icon('mail')}<span>تغيير بيانات البريد</span></button>`; }
function renderEmployees() {
  const employees = selectedEmployees(); const pages = Math.max(1, Math.ceil(employees.length / pageSize)); state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * pageSize, rows = employees.slice(start, start + pageSize);
  $('employee-rows').innerHTML = rows.map((emp, i) => `<tr><td class="index-cell">${start + i + 1}</td><td>${nameCell(emp)}</td><td><bdi class="numeric">${escape(emp.national_id || '—')}</bdi></td><td>${escape(getValue(emp, 'job.jobDesc') || 'غير محدد')}</td><td>${staffBadge(emp)}</td><td>${sourceBadge(emp)}</td><td><div class="row-actions">${actions(emp)}</div></td></tr>`).join('');
  $('employee-cards').innerHTML = rows.map(emp => `<article class="employee-card"><div class="employee-card-top">${nameCell(emp)}${staffBadge(emp)}</div><div class="employee-card-bottom"><bdi class="numeric">${escape(emp.national_id || 'لم يُسجّل رقم قومي')}</bdi><span class="muted">${escape(getValue(emp, 'job.jobDesc'))}</span></div><div class="employee-card-bottom"><div class="employee-card-tags">${sourceBadge(emp)}</div><div class="row-actions">${actions(emp)}</div></div></article>`).join('');
  $('empty-state').hidden = employees.length > 0;
  const emptyList = selectedCustomList() && !state.employees.some(emp => selectedCustomList().memberIds.includes(emp.emp_code));
  if (!employees.length) $('empty-state').innerHTML = `${icon(state.employees.length ? 'search' : 'users')}<h3>${emptyList ? 'لا يوجد أعضاء متاحون في هذه القائمة' : state.employees.length ? 'لا توجد نتائج مطابقة' : 'ابدأ بسجل المدرسة'}</h3><p>${emptyList ? 'اختر أعضاء للقائمة. الأعضاء غير المتاحين حاليًا لا يدخلون في الكشف.' : state.employees.length ? 'جرّب تغيير البحث أو إزالة بعض شروط التصفية.' : 'أضف موظفًا يدويًا، أو اربط حساب الوزارة لاستيراد العاملين.'}</p><button class="button secondary" id="empty-action">${emptyList ? 'تعديل أعضاء القائمة' : state.employees.length ? 'إزالة البحث والتصفية' : 'إضافة أول موظف'}</button>`;
  $('empty-action')?.addEventListener('click', () => emptyList ? editCustomList(selectedCustomList()) : state.employees.length ? resetFilters() : editEmployee());
  $('result-summary').textContent = employees.length ? `عرض ${start + 1}–${Math.min(start + pageSize, employees.length)} من ${employees.length} موظف` : 'لا توجد بيانات للعرض';
  $('page-number').textContent = `${state.page} / ${pages}`; $('previous-page').disabled = state.page <= 1; $('next-page').disabled = state.page >= pages;
  const active = state.filters.filter(filter => filter.values.length); $('filter-count').textContent = active.length ? `(${active.length})` : '';
  $('active-filters').hidden = !active.length && !state.search && state.source === 'all';
  $('active-filters').innerHTML = [...active.map(filter => `<span class="chip">${escape(fieldInfo(filter.path).label)}: ${filter.mode === 'exclude' ? 'استبعاد ' : ''}${escape(filter.values.join('، '))}</span>`), ...(state.search ? [`<span class="chip">بحث: ${escape(state.search)}</span>`] : []), ...(state.source !== 'all' ? [`<span class="chip">${state.source === 'manual' ? 'الإضافات اليدوية' : 'بيانات الوزارة'}</span>`] : [])].join('');
}
function employeeFromEvent(event) { const button = event.target.closest('[data-action]'); return button ? { button, emp: state.employees.find(emp => emp.emp_code === Number(button.dataset.id)) } : {}; }
for (const id of ['employee-rows', 'employee-cards']) $(id).addEventListener('click', event => { const { button, emp } = employeeFromEvent(event); if (!emp) return; if (button.dataset.action === 'view') viewEmployee(emp); else if (button.dataset.action === 'edit') editEmployee(emp); else if (button.dataset.action === 'delete') deleteEmployee(emp); else if (button.dataset.action === 'unified-email') editUnifiedEmail(emp); });

function editUnifiedEmail(emp) {
  modal('تغيير بيانات البريد', '<div class="modal-body unified-email-body" id="unified-email-editor"></div>', { subtitle: `قراءة وتحديث بيانات البريد المسجلة في الوزارة — ${employeeName(emp)}`, footer: '<button type="button" class="button secondary" data-close>إغلاق</button>' });
  const root = $('unified-email-editor');
  mountUnifiedEmailEditor(root, { employeeId: emp.emp_code, request, send, isCurrent: () => $('modal').open && $('unified-email-editor') === root });
}

function editEmployee(emp) {
  const schema = buildEmployeeSchema(state.employees.map(employee => employee.raw_data || {}));
  const editor = createEmployeeDraft(emp, schema);
  modal(emp ? 'تعديل كل بيانات الموظف' : 'إضافة موظف بكل بياناته', `<form id="employee-form"><div class="modal-body employee-editor-body"><div class="employee-editor-overview"><div><span class="muted">الاسم بالكامل</span><strong id="employee-name-preview"></strong></div><button type="button" class="text-button" id="toggle-employee-sections">فتح كل الأقسام</button></div><p class="muted employee-editor-hint">كل البيانات اختيارية ما عدا اسم الموظف. يمكنك إضافة أكثر من مؤهل أو سجل وظيفي أو ندب، أو إضافة بيان جديد باسمه.</p><div class="employee-editor-search"><label for="employee-field-search">ابحث عن البيان المطلوب</label><input type="search" id="employee-field-search" placeholder="مثال: الهاتف، جهة التخرج، الدرجة الوظيفية…" autocomplete="off"><div class="employee-editor-shortcuts"><button type="button" class="chip" data-find-field="الهاتف">رقم الهاتف</button><button type="button" class="chip" data-find-field="جهة التخرج">جهة التخرج</button><button type="button" class="chip" data-find-field="الدرجة الوظيفية">الدرجة الوظيفية</button><button type="button" class="text-button" id="clear-employee-search">عرض كل البيانات</button></div><p class="muted" id="employee-field-count" aria-live="polite"></p></div><div id="complete-employee-sections">${renderEmployeeEditor(editor)}</div><p id="employee-no-fields" class="employee-search-empty" hidden>لا يوجد بيان بهذا الاسم. يمكنك إضافة بيان جديد في قسم «بيانات إضافية تختارها».</p><div id="employee-form-error" class="alert error" hidden role="alert" tabindex="-1"></div></div><div class="modal-footer"><span class="muted employee-save-hint">لا تُحفظ التغييرات إلا عند الضغط على الحفظ.</span><button type="button" class="button secondary" data-close>إلغاء</button><button type="submit" class="button primary">${emp ? 'حفظ التعديلات' : 'إضافة إلى السجل'}</button></div></form>`, { subtitle: emp?.source === 'ministry' ? 'المزامنة العادية تحتفظ بهذا الموظف وتعديلاته اليدوية. المزامنة الكلية فقط تعيد بياناته من الوزارة.' : 'تُحفظ الإضافات اليدوية في قاعدة المدرسة، وتبقى موجودة بعد المزامنة العادية؛ المزامنة الكلية فقط تمسحها.' });
  const form = $('employee-form');
  const sections = $('complete-employee-sections');
  const nameKeys = ['empFirstName', 'empFatherName', 'empGrandFatherName', 'empFamilyName'];
  const updateName = () => { const name = nameKeys.map(key => { const field = editor.fields.find(item => item.path[0] === 'basicInfo' && item.path.at(-1) === key); return field ? form.elements.namedItem(field.id).value.trim() : ''; }).filter(Boolean).join(' '); $('employee-name-preview').textContent = name || 'اكتب اسم الموظف في البيانات الشخصية'; };
  const showError = error => { const alert = $('employee-form-error'); if (alert) { alert.textContent = error.message || String(error); alert.hidden = false; alert.focus(); } else toast(error.message, true); };
  const updateToggle = () => { $('toggle-employee-sections').textContent = [...sections.querySelectorAll('details')].every(section => section.open) ? 'طي كل الأقسام' : 'فتح كل الأقسام'; };
  const applySearch = () => { editor.search = $('employee-field-search').value; const count = filterEmployeeEditor(sections, editor.search); $('employee-field-count').textContent = `${count} بيان${editor.search.trim() ? ' مطابق للبحث' : ' متاح'}`; $('employee-no-fields').hidden = count > 0; updateToggle(); };
  const redraw = () => { sections.innerHTML = renderEmployeeEditor(editor); applySearch(); updateName(); };
  form.addEventListener('input', updateName); updateName(); applySearch();
  sections.addEventListener('toggle', updateToggle, true);
  $('employee-field-search').addEventListener('input', applySearch);
  $('clear-employee-search').addEventListener('click', () => { $('employee-field-search').value = ''; applySearch(); });
  form.querySelectorAll('[data-find-field]').forEach(button => button.addEventListener('click', () => { $('employee-field-search').value = button.dataset.findField; applySearch(); $('employee-field-search').focus(); }));
  $('toggle-employee-sections').addEventListener('click', () => { const all = [...sections.querySelectorAll('details')], open = !all.every(section => section.open); all.forEach(section => { section.open = open; }); updateToggle(); });
  sections.addEventListener('click', event => {
    const button = event.target.closest('[data-append-record], [data-remove-record]');
    if (!button) return;
    try {
      flushEmployeeEditor(editor, form);
      const append = button.dataset.appendRecord !== undefined;
      const entry = editor.arrays[Number(append ? button.dataset.appendRecord : button.dataset.removeRecord)];
      if (append) {
        if (entry.placeholder && !entry.path.reduce((value, part) => value?.[part], editor.raw)?.length) appendEmployeeRecord(editor, entry.path);
        appendEmployeeRecord(editor, entry.path);
      } else removeEmployeeRecord(editor, entry.path, Number(button.dataset.recordIndex));
      $('employee-form-error').hidden = true; redraw();
      const newEntry = editor.arrays.findIndex(item => JSON.stringify(item.path) === JSON.stringify(entry.path));
      const newButton = sections.querySelector(`[data-append-record="${newEntry}"]`);
      if (append) { $('employee-field-search').value = ''; applySearch(); const record = newButton?.closest('.employee-records')?.querySelector('.employee-record:last-of-type'); record?.querySelector('input,select,textarea')?.focus(); } else newButton?.focus();
    } catch (error) { showError(error); }
  });
  form.addEventListener('invalid', event => { $('employee-field-search').value = ''; applySearch(); let parent = event.target.parentElement; while (parent && parent !== form) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; } }, true);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter || form.querySelector('[type="submit"]');
    try { flushEmployeeEditor(editor, form); } catch (error) { showError(error); return; }
    if (!employeeDraftName(editor)) { $('employee-field-search').value = ''; applySearch(); const first = sections.querySelector('details'); if (first) first.open = true; showError('اكتب اسم الموظف في قسم البيانات الشخصية.'); return; }
    const payload = employeeDraftPayload(editor);
    if (!Object.keys(payload).length) { $('modal').close(); return; }
    $('employee-form-error').hidden = true; button.disabled = true;
    try { await send(emp ? `/employees/${emp.emp_code}` : '/employees', emp ? 'PUT' : 'POST', payload); $('modal').close(); await loadData(); toast(emp ? 'تم حفظ التعديلات.' : 'تمت إضافة الموظف إلى سجل المدرسة.'); }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  });
}
function viewEmployee(emp) {
  const sections = employeeDetailsGroups(emp).map(group => {
    const fields = group.fields;
    return fields.length ? `<h3 class="details-heading">${escape(group.label)}</h3><div class="detail-grid">${fields.map(field => `<div class="detail-value"><small>${escape(field.label)}</small><span dir="auto">${escape(field.value)}</span></div>`).join('')}</div>` : '';
  }).join('');
  modal(employeeName(emp), `<div class="modal-body">${sections || '<p class="muted">لم تُضف بيانات تفصيلية بعد.</p>'}${getValue(emp, 'notes') ? `<h3 class="details-heading">ملاحظات</h3><p>${escape(getValue(emp, 'notes'))}</p>` : ''}</div>`, { subtitle: `${emp.source === 'manual' ? 'إضافة يدوية' : 'موقع الوزارة'}${emp.has_local_changes ? ' · توجد تعديلات محلية محفوظة' : ''}`, footer: `${emp.source !== 'manual' ? '<button id="download-certificate" class="button secondary">صحيفة الأحوال</button>' : ''}<button id="details-edit" class="button primary">تعديل البيانات</button>` });
  $('details-edit').addEventListener('click', () => editEmployee(emp));
  $('download-certificate')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    await download(`/api/certificate/${emp.emp_code}`, {}, `${employeeName(emp)}_صحيفة`, true); toast('تم تحميل الصحيفة.');
  }));
}
function deleteEmployee(emp) {
  modal('حذف الموظف من دفتر المدرسة', `<div class="modal-body"><p>سيتم حذف <strong>${escape(employeeName(emp))}</strong> من السجل المحلي والكشوف.</p><p class="muted">${emp.source === 'manual' ? 'لا يمكن التراجع عن الحذف من داخل البرنامج.' : 'المزامنة العادية تحافظ على حذفه محليًا. المزامنة الكلية تعيده إذا كان موجودًا بموقع الوزارة.'}</p></div>`, { footer: '<button class="button secondary" data-close>إلغاء</button><button class="button danger-button" id="confirm-delete">تأكيد الحذف</button>' });
  $('confirm-delete').addEventListener('click', event => busy(event.currentTarget, async () => { await send(`/employees/${emp.emp_code}`, 'DELETE'); $('modal').close(); await loadData(); toast('تم حذف الموظف من السجل.'); }));
}

function renderCustomLists() {
  const select = $('custom-list');
  select.innerHTML = '<option value="">كل العاملين بالمدرسة</option>' + state.customLists.map(list => `<option value="${Number(list.id)}">${escape(list.name)} (${Number(list.availableCount)})</option>`).join('');
  select.value = state.customListId ?? '';
  const list = selectedCustomList();
  $('edit-list').hidden = !list; $('delete-list').hidden = !list;
  $('custom-list-summary').textContent = list
    ? `${list.availableCount} موظف متاح من ${list.memberCount} عضو في القائمة.${list.missingCount ? ` ${list.missingCount} غير متاح حاليًا؛ يعود تلقائيًا للقائمة إذا عاد بنفس الكود بعد المزامنة.` : ''} التصفية والتصدير يخصان هذه القائمة.`
    : 'أنشئ قائمة بأشخاص تختارهم، ثم اعرضها أو صدّرها وحدها.';
}
function editCustomList(list) {
  const chosen = new Set(list?.memberIds || []);
  const available = new Set(state.employees.map(emp => emp.emp_code));
  const missingIds = [...chosen].filter(id => !available.has(id));
  const rows = selectEmployees(state.employees, { sorting: [{ path: 'fullName', direction: 'asc' }] });
  const initialStaffType = ['core', 'seconded'].includes(state.staffType) ? state.staffType : 'all';
  const staffTypeChoices = [
    ['all', 'كل العاملين'],
    ['core', 'القوة الأساسية'],
    ['seconded', 'المنتدبون'],
  ].map(([type, label]) => `<option value="${type}"${type === initialStaffType ? ' selected' : ''}>${label} (${type === 'all' ? rows.length : rows.filter(emp => emp.staff_type === type).length})</option>`).join('');
  modal(list ? 'تعديل القائمة المخصصة' : 'إنشاء قائمة مخصصة', `<form id="custom-list-form"><div class="modal-body"><label for="list-name">اسم القائمة</label><input id="list-name" name="name" required maxlength="150" value="${escape(list?.name || '')}" placeholder="مثال: لجنة الامتحانات"><div class="list-picker-type"><label for="list-member-staff-type">نوع العاملين المعروضين</label><select id="list-member-staff-type">${staffTypeChoices}</select></div><div class="list-picker-search"><label for="list-member-search">ابحث داخل النوع المعروض</label><input id="list-member-search" type="search" placeholder="الاسم، الرقم القومي، أو كود الموظف…" autocomplete="off"></div><div class="list-picker-tools"><span id="list-picker-count" class="list-picker-count" aria-live="polite"></span><div class="button-row"><button type="button" id="select-visible-members" class="button secondary small">تحديد كل المعروض</button><button type="button" id="clear-visible-members" class="button secondary small">إلغاء تحديد المعروض</button></div></div><p class="list-picker-hint">التحديد والإلغاء يخصان الأسماء المعروضة فقط بعد اختيار النوع والبحث. اختياراتك في الأنواع الأخرى محفوظة.</p><div id="list-picker-members" class="list-picker-members"></div>${missingIds.length ? `<div class="list-picker-missing"><p>الأعضاء التاليون غير موجودين في السجل الحالي. احتفظ بتحديدهم لعودتهم تلقائيًا عند جلبهم مجددًا، أو ألغِ تحديدهم لإزالتهم من القائمة.</p>${missingIds.map(id => `<label><input type="checkbox" checked data-missing-member="${Number(id)}">عضو غير متاح — ${id > 0 ? 'كود الموظف' : 'رقم السجل المحلي'} ${Number(id)}</label>`).join('')}</div>` : ''}<div id="custom-list-error" class="alert error" role="alert" hidden></div></div><div class="modal-footer"><button type="button" class="button secondary" data-close>إلغاء</button><button type="submit" class="button primary">حفظ القائمة وعرضها</button></div></form>`, { subtitle: 'اختر أعضاء من سجل المدرسة. اختيار شخص هنا لا ينسخ بياناته ولا يغيّر مصدرها.' });
  let visible = rows;
  const updateCount = () => {
    const selectedVisible = visible.filter(emp => chosen.has(emp.emp_code)).length;
    $('list-picker-count').textContent = `المعروض ${visible.length} · المحدد منهم ${selectedVisible} · إجمالي المختارين ${chosen.size}`;
    $('select-visible-members').disabled = !visible.length || selectedVisible === visible.length;
    $('clear-visible-members').disabled = !selectedVisible;
  };
  const renderPicker = () => {
    visible = selectEmployees(rows, { staffType: $('list-member-staff-type').value, search: $('list-member-search').value });
    $('list-picker-members').innerHTML = visible.map(emp => `<label class="list-member"><input type="checkbox" data-list-member="${Number(emp.emp_code)}"${chosen.has(emp.emp_code) ? ' checked' : ''}><span><strong>${escape(employeeName(emp))}</strong><small>${emp.staff_type === 'seconded' ? 'منتدب' : 'قوة أساسية'} · ${escape(getValue(emp, 'job.jobDesc') || 'الوظيفة غير محددة')} · ${emp.source === 'manual' ? 'إضافة يدوية' : 'موقع الوزارة'}${getValue(emp, 'basicInfo.empCode') ? ` · كود ${escape(getValue(emp, 'basicInfo.empCode'))}` : ''}</small></span></label>`).join('') || '<p class="empty-state">لا توجد أسماء مطابقة. غيّر نوع القوة أو البحث، أو أضف الموظف إلى سجل المدرسة أولًا.</p>';
    updateCount();
  };
  $('list-member-staff-type').addEventListener('change', renderPicker);
  $('list-member-search').addEventListener('input', renderPicker);
  $('list-picker-members').addEventListener('change', event => { const id = Number(event.target.dataset.listMember); if (!Number.isSafeInteger(id) || !available.has(id)) return; if (event.target.checked) chosen.add(id); else chosen.delete(id); updateCount(); });
  $('custom-list-form').querySelectorAll('[data-missing-member]').forEach(input => input.addEventListener('change', () => { const id = Number(input.dataset.missingMember); if (input.checked) chosen.add(id); else chosen.delete(id); updateCount(); }));
  $('select-visible-members').addEventListener('click', () => { visible.forEach(emp => chosen.add(emp.emp_code)); renderPicker(); });
  $('clear-visible-members').addEventListener('click', () => { visible.forEach(emp => chosen.delete(emp.emp_code)); renderPicker(); });
  $('custom-list-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true; $('custom-list-error').hidden = true;
    try {
      const result = await send(list ? `/custom-lists/${list.id}` : '/custom-lists', list ? 'PUT' : 'POST', { name: $('list-name').value.trim(), memberIds: [...chosen] });
      state.customListId = result.list.id;
      await loadData(); resetFilters(); $('modal').close();
      toast('تم حفظ القائمة. المعروض الآن هم أعضاء القائمة فقط.');
    } catch (error) { const alert = $('custom-list-error'); if (alert) { alert.textContent = error.message; alert.hidden = false; } else toast(error.message, true); }
    finally { button.disabled = false; }
  });
  renderPicker();
}
$('custom-list').addEventListener('change', event => { state.customListId = event.target.value ? Number(event.target.value) : null; renderCustomLists(); resetFilters(); });
$('create-list').addEventListener('click', () => editCustomList());
$('edit-list').addEventListener('click', () => { const list = selectedCustomList(); if (list) editCustomList(list); });
$('delete-list').addEventListener('click', () => {
  const list = selectedCustomList(); if (!list) return;
  modal('حذف القائمة المخصصة', `<div class="modal-body"><p>هل تريد حذف قائمة <strong>${escape(list.name)}</strong>؟</p><p class="muted">يُحذف اسم القائمة واختيارات أعضائها فقط. الموظفون يظلون موجودين في سجل المدرسة.</p></div>`, { footer: '<button type="button" class="button secondary" data-close>إلغاء</button><button type="button" class="button danger-button" id="confirm-delete-list">حذف القائمة</button>' });
  $('confirm-delete-list').addEventListener('click', event => busy(event.currentTarget, async () => { await send(`/custom-lists/${list.id}`, 'DELETE'); state.customListId = null; await loadData(); resetFilters(); $('modal').close(); toast('تم حذف القائمة. بيانات الموظفين محفوظة.'); }));
});

function valuesFor(path) { return [...new Set(state.employees.map(emp => getValue(emp, path).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar')); }
function renderFilterRules() {
  $('filter-rules').innerHTML = state.filters.map((rule, index) => `<div class="rule"><div class="rule-line"><select aria-label="حقل شرط ${index + 1}" data-filter="${index}" data-key="path">${options(allFields, rule.path)}</select><select aria-label="نوع شرط ${index + 1}" data-filter="${index}" data-key="mode"><option value="include">يشمل</option><option value="exclude"${rule.mode === 'exclude' ? ' selected' : ''}>يستبعد</option></select><button class="icon-button danger" data-remove-filter="${index}" aria-label="حذف الشرط">${icon('close')}</button></div><div class="rule-values">${valuesFor(rule.path).map(value => `<label><input type="checkbox" data-filter-value="${index}" value="${escape(value)}"${rule.values.includes(value) ? ' checked' : ''}>${escape(formatDate(value))}</label>`).join('') || '<span class="muted">لا توجد قيم محفوظة لهذا الحقل.</span>'}</div></div>`).join('');
}
function renderSortRules() {
  $('sort-rules').innerHTML = state.sorting.map((rule, index) => `<div class="rule"><div class="rule-line"><span class="rule-order">${index + 1}</span><select data-sort="${index}" data-key="path" aria-label="حقل ترتيب ${index + 1}">${options(allFields, rule.path)}</select><select data-sort="${index}" data-key="direction" aria-label="اتجاه ترتيب ${index + 1}"><option value="asc">تصاعدي</option><option value="desc"${rule.direction === 'desc' ? ' selected' : ''}>تنازلي</option><option value="custom"${rule.direction === 'custom' ? ' selected' : ''}>ترتيب مخصص</option></select><button class="icon-button" data-sort-up="${index}" aria-label="رفع أولوية الترتيب"${!index ? ' disabled' : ''}>↑</button><button class="icon-button danger" data-remove-sort="${index}" aria-label="حذف الترتيب">${icon('close')}</button></div>${rule.direction === 'custom' ? `<div class="custom-order">${(rule.customOrder || []).map((value, vi) => `<div><span>${escape(value)}</span><button class="icon-button" data-custom-rule="${index}" data-custom-index="${vi}" data-step="-1" aria-label="تحريك لأعلى"${vi === 0 ? ' disabled' : ''}>↑</button><button class="icon-button" data-custom-rule="${index}" data-custom-index="${vi}" data-step="1" aria-label="تحريك لأسفل"${vi === rule.customOrder.length - 1 ? ' disabled' : ''}>↓</button></div>`).join('') || '<small>لا توجد قيم لهذا الحقل.</small>'}</div>` : ''}</div>`).join('');
}
$('filter-rules').addEventListener('change', event => {
  const el = event.target;
  if (el.dataset.filter !== undefined) { const rule = state.filters[Number(el.dataset.filter)]; rule[el.dataset.key] = el.value; if (el.dataset.key === 'path') rule.values = []; renderFilterRules(); }
  else if (el.dataset.filterValue !== undefined) { const rule = state.filters[Number(el.dataset.filterValue)]; rule.values = el.checked ? [...rule.values, el.value] : rule.values.filter(value => value !== el.value); }
  updateSelection();
});
$('filter-rules').addEventListener('click', event => { const button = event.target.closest('[data-remove-filter]'); if (button) { state.filters.splice(Number(button.dataset.removeFilter), 1); renderFilterRules(); updateSelection(); } });
$('sort-rules').addEventListener('change', event => {
  const el = event.target; if (el.dataset.sort === undefined) return; const rule = state.sorting[Number(el.dataset.sort)]; rule[el.dataset.key] = el.value; rule.type = fieldInfo(rule.path).type;
  if (rule.direction === 'custom') rule.customOrder = valuesFor(rule.path); renderSortRules(); updateSelection();
});
$('sort-rules').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.removeSort !== undefined) state.sorting.splice(Number(button.dataset.removeSort), 1);
  if (button.dataset.sortUp !== undefined) { const i = Number(button.dataset.sortUp); [state.sorting[i - 1], state.sorting[i]] = [state.sorting[i], state.sorting[i - 1]]; }
  if (button.dataset.customRule !== undefined) { const list = state.sorting[Number(button.dataset.customRule)].customOrder, i = Number(button.dataset.customIndex), to = i + Number(button.dataset.step); [list[i], list[to]] = [list[to], list[i]]; }
  renderSortRules(); updateSelection();
});
function resetFilters() { state.filters = []; state.sorting = [{ path: 'fullName', type: 'text', direction: 'asc' }]; state.search = ''; state.source = 'all'; state.staffType = 'all'; $('search').value = ''; $('source-filter').value = 'all'; document.querySelectorAll('[data-staff]').forEach(button => button.classList.toggle('active', button.dataset.staff === 'all')); renderFilterRules(); renderSortRules(); updateSelection(); }

function exportOptions() { return { title: $('report-title').value, columns: state.columns, orientation: $('orientation').value, useArabicNumerals: $('numerals').value === 'arabic', footer: state.signatures, exportFormat: state.exportFormat, staffType: state.staffType, source: state.source, search: state.search, filters: state.filters, sorting: state.sorting, listId: state.customListId ?? undefined }; }
function hourlyExportOptions(modelOptions) { return { modelId: 'hourly-contract-period-1', modelOptions, exportFormat: state.exportFormat, staffType: state.staffType, source: state.source, search: state.search, filters: state.filters, sorting: state.sorting, listId: state.customListId ?? undefined }; }
function renderExportChoice() {
  const info = exportFormatInfo(state.exportFormat);
  for (const id of ['export-format', 'assistant-export-format']) { $(id).value = state.exportFormat; $(id).disabled = state.exporting; }
  $('export-word').disabled = state.exporting;
  if (!state.exporting) $('export-word').innerHTML = `${icon('download')}تحميل ملف ${info.label}`;
  $('report-preview-format').textContent = `نفس الجدول والتنسيق في ${exportFormatInfo(state.exportFormat).label}`;
}
async function saveHourlyOptions() {
  const revision = state.hourlyRevision || 0;
  const payload = normalizeHourlyOptions(state.hourlyOptions);
  const saved = normalizeHourlyOptions(await send('/report-models/hourly-contract-period-1/settings', 'PUT', payload));
  if ((state.hourlyRevision || 0) === revision) {
    state.hourlyOptions = saved;
    state.hourlyOptionsDirty = false;
    renderHourlyReport(selectedEmployees());
  }
  return saved;
}
function renderColumns() {
  $('report-columns').innerHTML = state.columns.map((col, index) => `<div class="report-column${col.type === 'manual' ? ' manual-column' : ''}"><input aria-label="عنوان العمود ${index + 1}" value="${escape(col.label)}" data-column-label="${index}" maxlength="120">${col.type === 'manual' ? `<button type="button" class="text-button manual-values-button" data-manual-column="${index}">بيانات كل موظف</button>` : ''}<button class="icon-button" data-column-move="${index}" data-step="-1" aria-label="تحريك العمود لليمين"${index === 0 ? ' disabled' : ''}>↑</button><button class="icon-button" data-column-move="${index}" data-step="1" aria-label="تحريك العمود لليسار"${index === state.columns.length - 1 ? ' disabled' : ''}>↓</button><button class="icon-button danger" data-column-remove="${index}" aria-label="حذف العمود"${state.columns.length === 1 ? ' disabled' : ''}>×</button></div>`).join('');
}
function renderSignatures() {
  $('report-signatures').innerHTML = state.signatures.map((signature, index) => `<div class="signature-editor"><label for="signature-label-${index}">مسمى التوقيع ${index + 1}</label><div class="signature-title-row"><input id="signature-label-${index}" data-signature-label="${index}" value="${escape(signature.label)}" maxlength="120" placeholder="مثال: وكيل شؤون التعليم"><button type="button" class="icon-button danger" data-remove-signature="${index}" aria-label="حذف التوقيع ${index + 1}">×</button></div><label class="sr-only" for="footer-${index + 1}">اسم صاحب التوقيع ${index + 1}</label><input id="footer-${index + 1}" data-signature-name="${index}" value="${escape(signature.name)}" maxlength="180" placeholder="الاسم تحت المسمى"></div>`).join('');
  $('add-signature').disabled = state.signatures.length >= 9;
}
function editManualColumn(index) {
  const column = state.columns[index];
  const employees = selectedEmployees();
  modal('بيانات كل موظف في العمود اليدوي', `<form id="manual-column-form"><div class="modal-body"><label for="manual-column-title">عنوان العمود</label><input id="manual-column-title" required maxlength="120" value="${escape(column.label)}"><p class="muted">اكتب قيمة مختلفة أمام اسم كل موظف. عند اختيار ١٢٣، تتحول الأرقام الإنجليزية إلى عربية في الجدول والملف. هذه البيانات للكشف فقط.</p><div class="manual-column-values">${employees.map(employee => `<label>${escape(employeeName(employee))}<textarea name="${Number(employee.emp_code)}" rows="2" maxlength="500" placeholder="اكتب البيان لهذا الموظف">${escape(column.manualValues?.[String(employee.emp_code)] || '')}</textarea></label>`).join('') || '<p class="muted">لا يوجد موظفون حسب الاختيارات الحالية.</p>'}</div></div><div class="modal-footer"><button type="button" class="button secondary" data-close>إلغاء</button><button type="submit" class="button primary">حفظ بيانات العمود</button></div></form>`);
  $('manual-column-form').addEventListener('submit', event => {
    event.preventDefault(); column.label = $('manual-column-title').value.trim();
    column.manualValues = { ...column.manualValues };
    for (const [key, value] of new FormData(event.target)) { if (value) column.manualValues[key] = value; else delete column.manualValues[key]; }
    $('modal').close(); renderColumns(); renderReport(); savePreferences();
  });
}
const hourlyFields = [
  ['specialization', 'التخصص', 'مثال: لغة عربية'],
  ['educationalSubject', 'المادة التعليمية', 'مثال: اللغة العربية'],
  ['monthlySessions', 'الحصص الفعلية شهريا', 'مثال: ٤٨'],
  ['amount', 'المبلغ', 'مثال: ٣٦٠٠'],
  ['paymentDestination', 'الجهة المحول عليها أمر الدفع (البريد - البنك)', 'مثال: البنك'],
];
const hourlyHeaders = ['م', 'اسم المدرسة', 'اسم المعلم', 'الرقم القومي', 'المؤهل', 'التخصص', 'المادة التعليمية', 'الحصص الفعلية شهريا', 'المبلغ', 'الجهة المحول عليها أمر الدفع ( البريد - البنك )'];
function filterHourlyPeople() {
  const query = normalizeArabic($('hourly-person-search').value);
  $('hourly-people').querySelectorAll('.hourly-person').forEach(card => {
    card.hidden = !!query && !normalizeArabic(card.dataset.search).includes(query);
    if (query && !card.hidden) card.open = true;
  });
}
function renderHourlyPeople(employees) {
  $('hourly-people-count').textContent = `${employees.length} معلم`;
  $('hourly-people').innerHTML = employees.map((employee, index) => {
    const key = hourlyEmployeeKey(employee);
    const cells = hourlyRow(employee, state.school, state.hourlyOptions.rows[key] || {});
    return `<details class="hourly-person" data-hourly-employee-key="${escape(key)}" data-search="${escape(`${cells[2]} ${cells[3]}`)}"${index === 0 ? ' open' : ''}><summary><strong>${escape(cells[2] || 'بدون اسم')}</strong><small>${escape(cells[3] || 'بدون رقم قومي')}</small></summary><div class="hourly-person-body"><p class="muted">المدرسة: ${escape(cells[1] || '—')} · المؤهل: ${escape(cells[4] || '—')}</p><div class="hourly-person-fields">${hourlyFields.map(([field, label, placeholder], fieldIndex) => `<div><label for="hourly-${index}-${field}">${label}</label><input id="hourly-${index}-${field}" data-hourly-field="${field}" value="${escape(cells[fieldIndex + 5])}" maxlength="120"${['monthlySessions', 'amount'].includes(field) ? ' inputmode="decimal"' : ''} placeholder="${escape(placeholder)}"></div>`).join('')}</div></div></details>`;
  }).join('') || '<p class="muted hourly-empty">لا يوجد معلمون في النطاق الحالي. يمكنك تحميل النموذج فارغًا أو اختيار قائمة أخرى من سجل العاملين.</p>';
  filterHourlyPeople();
}
function renderHourlyPreview(employees) {
  const school = state.school || {};
  $('hourly-paper-school').innerHTML = ['وزارة التربية والتعليم والتعليم الفني', `محافظة ${school.mudriaName || 'بورسعيد'}`, 'مديرية التربية والتعليم', school.edaraName || 'إدارة بورفؤاد التعليمية', `مدرسة ${school.schoolName || ''}`].map(line => `<div>${escape(line)}</div>`).join('');
  $('hourly-paper-subject').textContent = `مادة ( ${state.hourlyOptions.subject || '................'} )`;
  $('hourly-paper-period').textContent = `الفترة من ${formatDate(state.hourlyOptions.periodStart) || '.../.../...'} إلى ${formatDate(state.hourlyOptions.periodEnd) || '.../.../...'}`;
  const visible = employees.slice(0, 12);
  const rows = Array.from({ length: Math.max(12, visible.length) }, (_, index) => {
    const employee = visible[index];
    const cells = employee ? hourlyRow(employee, school, state.hourlyOptions.rows[hourlyEmployeeKey(employee)] || {}) : Array(10).fill('');
    cells[0] = String(index + 1);
    return `<tr>${cells.map((cell, column) => `<td${[0, 3, 7, 8].includes(column) ? ' class="numeric-cell"' : ''}>${escape(cell)}</td>`).join('')}</tr>`;
  }).join('');
  $('hourly-paper-table').innerHTML = `<thead><tr>${hourlyHeaders.map(label => `<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>`;
  $('hourly-paper-signatures').innerHTML = ['مسئول شئون العاملين', 'مدير المدرسة', 'موجه المادة - موجه أول المادة', 'الموجه المالي والإداري', 'مدير الإدارة التعليمية'].map(label => `<span>${escape(label)}</span>`).join('');
  const format = exportFormatInfo(state.exportFormat).label;
  $('report-preview-note').textContent = employees.length > 12 ? `المعاينة تعرض أول 12 معلمًا من ${employees.length}. ملف ${format} يشمل كل المختارين.` : `المعاينة تعرض 12 صفًا مثل النموذج المرفق. ملف ${format} يشمل بيانات النموذج ${state.exportFormat === 'pdf' ? 'وجاهز للطباعة' : 'ويقبل التعديل'}.`;
}
function renderHourlyReport(employees) {
  $('hourly-period-start').value = state.hourlyOptions.periodStart;
  $('hourly-period-end').value = state.hourlyOptions.periodEnd;
  $('hourly-subject').value = state.hourlyOptions.subject;
  renderHourlyPeople(employees);
  renderHourlyPreview(employees);
}
function renderReport() {
  const employees = selectedEmployees(), hourly = state.reportModel === 'hourly-contract-period-1';
  renderExportChoice();
  $('report-model').value = state.reportModel;
  $('report-count').textContent = employees.length;
  $('report-list-name').textContent = selectedCustomList()?.name || 'كل العاملين بالمدرسة';
  $('staff-report-controls').hidden = hourly; $('hourly-report-controls').hidden = !hourly;
  $('staff-paper').hidden = hourly; $('hourly-paper').hidden = !hourly;
  if (hourly) { renderHourlyReport(employees); return; }
  const config = exportOptions(); $('paper-title').textContent = config.title;
  $('staff-paper').classList.toggle('portrait', config.orientation === 'portrait');
  $('paper-school').innerHTML = [state.school.mudriaName ? `محافظة ${state.school.mudriaName}` : 'المحافظة', state.school.edaraName ? `إدارة ${state.school.edaraName}` : 'الإدارة التعليمية', state.school.schoolName || 'اسم المدرسة'].map(text => `<div>${escape(text)}</div>`).join('');
  const totalWidth = state.columns.reduce((sum, col) => sum + (col.width || 12), 0);
  $('paper-table').innerHTML = `<colgroup>${state.columns.map(col => `<col style="width:${(col.width || 12) / totalWidth * 100}%">`).join('')}</colgroup><thead><tr>${state.columns.map(col => `<th>${escape(col.label)}</th>`).join('')}</tr></thead><tbody>${employees.slice(0, 12).map((emp, i) => `<tr>${state.columns.map(col => { const text = columnText(emp, col, i, config); return `<td${/^[\d٠-٩/\s-]+$/.test(text) ? ' class="numeric-cell"' : ''}>${escape(text)}</td>`; }).join('')}</tr>`).join('') || `<tr><td colspan="${state.columns.length}" style="text-align:center;padding:20px">لا توجد بيانات مطابقة</td></tr>`}</tbody>`;
  $('paper-footer').innerHTML = config.footer.map(signature => `<span><strong>${escape(signature.label)}</strong><span>${escape(signature.name)}</span></span>`).join('');
  $('report-preview-note').textContent = state.exportFormat === 'excel'
    ? 'المعاينة تعرض أول 12 موظفًا. ملف Excel يشمل كل النتائج بنفس الأعمدة والتصفية والترتيب، مع الترويسة والتوقيعات.'
    : `المعاينة تعرض أول 12 موظفًا. ملف ${exportFormatInfo(state.exportFormat).label} يشمل كل النتائج، ويكرر رأس الجدول والتوقيعات عند تعدد الصفحات.`;
}
function addColumn(merged = false) {
  const choices = merged ? allFields : [{ path: 'index', label: 'م — ترقيم تلقائي', group: '', type: 'index' }, ...allFields];
  modal(merged ? 'دمج حقول في عمود واحد' : 'إضافة أعمدة للكشف', `<form id="column-form"><div class="modal-body">${merged ? '<label for="merged-label">عنوان العمود</label><input id="merged-label" name="label" required maxlength="120" placeholder="مثال: المؤهل وتاريخه"><label for="merged-separator" style="margin-top:14px">الفاصل بين القيم</label><select id="merged-separator" name="separator"><option value="newline">سطر جديد</option><option value="space">مسافة</option><option value="dash">شرطة</option></select>' : '<p class="muted">اختر الحقول التي تريد إظهارها في الكشف.</p>'}<div class="report-field-search"><label for="report-field-search">ابحث عن البيان المطلوب</label><input id="report-field-search" type="search" placeholder="مثال: الهاتف، جهة التخرج، بيانات إضافية…" autocomplete="off"></div><div class="field-options">${choices.map(field => `<label data-report-field-search="${escape(`${field.label} ${field.group} ${field.path}`)}"><input type="checkbox" name="field" value="${escape(field.path)}">${escape(field.label)}<small class="muted">${escape(field.group)}</small></label>`).join('')}</div><p id="report-field-empty" class="muted" hidden>لا توجد حقول بهذا الاسم. جرّب البحث باسم آخر.</p></div><div class="modal-footer"><button type="button" class="button secondary" data-close>إلغاء</button><button type="submit" class="button primary">إضافة للكشف</button></div></form>`);
  $('report-field-search').addEventListener('input', event => {
    const query = normalizeArabic(event.target.value);
    let visible = 0;
    $('column-form').querySelectorAll('[data-report-field-search]').forEach(label => {
      label.hidden = !normalizeArabic(label.dataset.reportFieldSearch).includes(query);
      if (!label.hidden) visible++;
    });
    $('report-field-empty').hidden = visible > 0;
  });
  $('column-form').addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.target), paths = data.getAll('field');
    if (paths.length < (merged ? 2 : 1)) return toast(merged ? 'اختر حقلين على الأقل للدمج.' : 'اختر حقلًا واحدًا على الأقل.', true);
    const addedPaths = paths.filter(path => !state.columns.some(col => col.path === path));
    if (!merged && !addedPaths.length) return toast('الأعمدة المختارة موجودة بالفعل في الكشف.', true);
    if (state.columns.length + (merged ? 1 : addedPaths.length) > 30) return toast('الحد الأقصى للكشف 30 عمودًا.', true);
    if (merged) state.columns.push({ id: uiId(), label: data.get('label'), isMerged: true, type: 'merged', fields: paths, separator: data.get('separator') });
    else for (const path of addedPaths) state.columns.push({ id: uiId(), path, label: path === 'index' ? 'م' : fieldInfo(path).label, type: fieldInfo(path).type, isIndex: path === 'index' });
    $('modal').close(); renderColumns(); renderReport(); savePreferences();
  });
}
$('report-columns').addEventListener('input', event => { const i = event.target.dataset.columnLabel; if (i === undefined) return; state.columns[Number(i)].label = event.target.value; clearTimeout(reportTimer); reportTimer = setTimeout(() => { renderReport(); savePreferences(); }, 150); });
$('report-columns').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.manualColumn !== undefined) { editManualColumn(Number(button.dataset.manualColumn)); return; }
  if (button.dataset.columnRemove !== undefined && state.columns.length > 1) state.columns.splice(Number(button.dataset.columnRemove), 1);
  else if (button.dataset.columnMove !== undefined) { const i = Number(button.dataset.columnMove), to = i + Number(button.dataset.step); [state.columns[to], state.columns[i]] = [state.columns[i], state.columns[to]]; }
  renderColumns(); renderReport(); savePreferences();
});
function renderConfigs() { $('saved-config').innerHTML = '<option value="">اختر قالبًا محفوظًا</option>' + state.configs.map(config => `<option value="${Number(config.id)}">${escape(config.name)}</option>`).join(''); }
$('save-config').addEventListener('click', () => {
  modal('حفظ قالب الكشف', '<form id="config-form"><div class="modal-body"><label for="config-name">اسم القالب</label><input id="config-name" required maxlength="120" placeholder="مثال: كشف العاملين السنوي"><p class="muted">يحفظ الأعمدة وترتيب النتائج والعنوان والتوقيعات. نطاق البحث والتصفية يظل حسب اختيارك الحالي.</p></div><div class="modal-footer"><button type="button" class="button secondary" data-close>إلغاء</button><button class="button primary" type="submit">حفظ القالب</button></div></form>');
  $('config-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { const result = await send('/table-config', 'POST', { ...exportOptions(), name: $('config-name').value }); $('modal').close(); state.configs = await request('/table-config'); renderConfigs(); $('saved-config').value = result.id; toast('تم حفظ القالب.'); }); });
});
$('saved-config').addEventListener('change', async event => {
  if (!event.target.value) return;
  try {
    const config = await request(`/table-config/${event.target.value}`);
    state.columns = config.columns; state.sorting = config.sorting || [];
    $('report-title').value = config.title || '';
    $('orientation').value = config.orientation === 'portrait' ? 'portrait' : 'landscape';
    $('numerals').value = config.useArabicNumerals ? 'arabic' : 'western';
    state.exportFormat = ['word', 'excel', 'pdf'].includes(config.exportFormat) ? config.exportFormat : 'word';
    state.signatures = normalizeSignatures(config.footer); renderSignatures();
    renderColumns(); renderSortRules(); updateSelection(); savePreferences();
  }
  catch (error) { toast(error.message, true); }
});
$('delete-config').addEventListener('click', () => {
  const id = $('saved-config').value; if (!id) return toast('اختر القالب الذي تريد حذفه أولًا.', true);
  modal('حذف القالب المحفوظ', '<div class="modal-body"><p>سيتم حذف القالب. بيانات الموظفين لن تتأثر.</p></div>', { footer: '<button class="button secondary" data-close>إلغاء</button><button class="button danger-button" id="confirm-delete-config">حذف القالب</button>' });
  $('confirm-delete-config').addEventListener('click', event => busy(event.currentTarget, async () => { await send(`/table-config/${id}`, 'DELETE'); state.configs = await request('/table-config'); renderConfigs(); $('modal').close(); toast('تم حذف القالب.'); }));
});
async function download(url, options, filename, inferExtension = false) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'تعذر تحميل الملف.'); }
  const type = response.headers.get('content-type') || '';
  if (inferExtension) filename += type.includes('pdf') ? '.pdf' : type.includes('json') ? '.json' : type.includes('sheet') ? '.xlsx' : '.bin';
  const blob = await response.blob(), objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
$('export-word').addEventListener('click', async event => {
  if (state.exporting) return;
  const button = event.currentTarget;
  const format = state.exportFormat;
  const hourly = state.reportModel === 'hourly-contract-period-1';
  const config = structuredClone(hourly ? hourlyExportOptions(normalizeHourlyOptions(state.hourlyOptions)) : exportOptions());
  state.exporting = true; renderExportChoice();
  try {
    await busy(button, async () => {
      if (!hourly && !selectedEmployees().length) throw new Error('لا توجد بيانات في الكشف. أضف موظفين أو غيّر التصفية أولًا.');
      await verifyAppVersion();
      if (hourly && state.hourlyOptionsDirty) await saveHourlyOptions();
      const report = createReportExport(config, format);
      await download(report.url, report.options, report.filename);
      toast(`تم تجهيز ملف ${exportFormatInfo(format).label} وتحميله.`);
    }, 'جارٍ تجهيز الكشف…');
  } finally { state.exporting = false; renderExportChoice(); }
});

async function refreshAuth() {
  const before = state.auth?.ministry?.connected; const wasAuthenticated = state.auth?.authenticated; state.auth = await request('/auth/status'); const { ministry, localAccess, authenticated } = state.auth;
  if (!authenticated) { if (wasAuthenticated) assistantChat.clearHistory(); state.employees = []; state.school = {}; state.configs = []; state.customLists = []; state.customListId = null; state.hourlyOptions = structuredClone(DEFAULT_HOURLY_OPTIONS); state.hourlyOptionsDirty = false; renderCustomLists(); renderEmployees(); renderReport(); renderConfigs(); for (const id of ['stat-total','stat-core','stat-seconded','stat-manual','nav-count','tab-count']) $(id).textContent = '—'; showPairing(); return; }
  $('auth-badge').textContent = ministry?.connected ? 'متصل بالوزارة' : 'غير متصل'; $('auth-badge').classList.toggle('connected', !!ministry?.connected);
  $('auth-message').textContent = ministry?.message || 'يمكنك استخدام البيانات المحفوظة وإضافة الموظفين يدويًا.';
  $('sidebar-connection').textContent = ministry?.connected ? 'حساب الوزارة متصل' : 'بيانات محفوظة على جهازك';
  $('microsoft-login').hidden = !localAccess; $('pair-device').hidden = !localAccess;
  $('microsoft-login').disabled = !state.auth.browserAvailable || ['opening', 'waiting'].includes(ministry?.status);
  if (localAccess && !state.auth.browserAvailable) $('auth-message').textContent = 'ثبّت Chrome أو Edge أو Chromium على الكمبيوتر، ثم أعد تشغيل البرنامج للربط بموقع الوزارة.';
  $('logout').hidden = false;
  $('logout').textContent = localAccess ? 'فصل الحساب والأجهزة' : 'تسجيل خروج هذا الجهاز';
  $('pair-device').disabled = !state.auth.pairingAvailable;
  $('phone-addresses').innerHTML = state.auth.phoneUrl ? `عنوان الدخول من نفس الشبكة:<a class="phone-address" href="${escape(state.auth.phoneUrl)}" target="_blank" rel="noopener">${escape(state.auth.phoneUrl)}</a>` : localAccess ? 'لتفعيل الموبايل: شغّل البرنامج بالأمر npm run start:lan، ثم افتح العنوان الظاهر هنا.' : 'هذا الجهاز مرتبط بالكمبيوتر. تُدار إعدادات الربط من الكمبيوتر الرئيسي.';
  if (before === false && ministry?.connected) { toast('تم ربط حساب الوزارة. يمكنك مزامنة العاملين الآن.'); }
}
function showPairing() {
  if ($('pair-form')) return;
  modal('ربط هذا الجهاز بالمدرسة', '<form id="pair-form"><div class="modal-body"><p>من الكمبيوتر الرئيسي، افتح «الربط والإعدادات» ثم «إنشاء رمز ربط جهاز».</p><label for="pair-input" style="margin-top:20px">رمز الربط المؤقت</label><input id="pair-input" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="8" minlength="8" dir="ltr"><p id="pair-error" class="danger" role="alert"></p></div><div class="modal-footer"><button type="submit" class="button primary">ربط الجهاز والدخول</button></div></form>', { required: true });
  $('pair-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true;
    try { await send('/auth/pairing/complete', 'POST', { code: westernDigits($('pair-input').value).trim() }); $('modal').close(); $('modal-content').innerHTML = ''; await refreshAuth(); await loadData(); toast('تم ربط الجهاز.'); }
    catch (error) { $('pair-error').textContent = error.message; } finally { button.disabled = false; }
  });
}
$('microsoft-login').addEventListener('click', event => busy(event.currentTarget, async () => { await send('/auth/microsoft/start', 'POST'); await refreshAuth(); toast('أكمل الدخول في نافذة الوزارة ثم افتح قائمة العاملين.'); }));
$('logout').addEventListener('click', () => {
  modal(state.auth?.localAccess ? 'فصل حساب الوزارة' : 'تسجيل خروج الجهاز', `<div class="modal-body"><p>${state.auth?.localAccess ? 'سيتم مسح جلسة الوزارة المحفوظة وإلغاء ربط الأجهزة. بيانات العاملين في قاعدة المدرسة ستبقى محفوظة.' : 'ستحتاج إلى رمز ربط جديد للدخول من هذا الجهاز.'}</p></div>`, { footer: '<button class="button secondary" data-close>إلغاء</button><button class="button danger-button" id="confirm-logout">تسجيل الخروج</button>' });
  $('confirm-logout').addEventListener('click', event => busy(event.currentTarget, async () => { await send('/auth/logout', 'POST'); assistantChat.clearHistory(); $('modal').close(); $('modal-content').innerHTML = ''; await refreshAuth(); toast('تم تسجيل الخروج.'); }));
});
$('pair-device').addEventListener('click', event => busy(event.currentTarget, async () => { const result = await send('/auth/pairing/start', 'POST'); $('pair-code').textContent = result.code; $('pair-code').hidden = false; setTimeout(() => { $('pair-code').hidden = true; $('pair-code').textContent = ''; }, Math.max(0, result.expiresAt - Date.now())); }));
$('school-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { const result = await send('/school-info', 'PUT', Object.fromEntries(new FormData(event.target))); state.school = result.schoolInfo; $('sidebar-school').textContent = state.school.schoolName || 'إدارة بيانات المدرسة'; renderReport(); toast('تم حفظ بيانات المدرسة.'); }); });
$('logo-input').addEventListener('change', event => busy(event.target, async () => { const file = event.target.files[0]; if (!file) return; if (file.type !== 'image/png' || file.size > 2 * 1024 * 1024) throw new Error('اختر صورة PNG بحجم لا يتجاوز 2 ميجابايت.'); const data = new FormData(); data.append('logo', file); await request('/upload-logo', { method: 'POST', body: data }); for (const id of ['settings-logo', 'paper-logo']) $(id).src = `/assets/logo.png?v=${Date.now()}`; toast('تم حفظ الشعار.'); }));
function renderSyncFailures(failures) {
  $('sync-failure-details').hidden = !failures?.length;
  $('sync-failure-list').innerHTML = (failures || []).map(failure => `<li><strong>${failure.empCode ? `كود الموظف ${escape(failure.empCode)}` : 'موظف بلا كود صالح'}</strong>: ${escape(failure.reason || 'لم تتوفر بياناته من الوزارة.')}</li>`).join('');
}
async function startSync(mode = 'normal', confirmReset = false) {
  if (state.syncing) return;
  state.syncing = true; $('sync-button').disabled = true; $('sync-progress').hidden = false; $('sync-progress').classList.remove('sync-outcome', 'sync-warning'); $('sync-message').textContent = 'جارٍ التحقق من اتصال الوزارة…';
  renderSyncFailures([]);
  try {
    await verifyAppVersion();
    const response = await fetch('/api/sync/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, ...(mode === 'full' ? { confirmReset } : {}) }) });
    await consumeSyncStream(response, async data => {
      $('sync-message').textContent = data.message || 'جارٍ المزامنة…';
      if (data.failedEmployees) renderSyncFailures(data.failedEmployees);
      if (data.step === 'done' || data.step === 'error') {
        $('sync-progress').classList.add('sync-outcome');
        $('sync-progress').classList.toggle('sync-warning', data.step === 'error' || !!data.partial);
        await loadData().catch(error => toast(error.message, true));
        toast(data.message || 'انتهت المزامنة.', data.step === 'error');
        refreshAuth().catch(() => {});
      }
    });
  } catch (error) {
    $('sync-progress').classList.add('sync-outcome', 'sync-warning');
    $('sync-message').textContent = `${error.message} راجع السجل الحالي قبل إعادة المحاولة.`;
    toast(error.message, true); await loadData().catch(() => {});
  } finally { state.syncing = false; $('sync-button').disabled = false; }
}
function chooseSyncMode() {
  const manual = state.employees.filter(employee => employee.source === 'manual').length;
  const edited = state.employees.filter(employee => employee.source !== 'manual' && employee.has_local_changes).length;
  modal('اختر طريقة المزامنة', `<form id="sync-mode-form"><div class="modal-body"><label class="sync-mode-choice"><input type="radio" name="syncMode" value="normal" checked><span><strong>مزامنة عادية — الحفاظ على عملي</strong><small>تضيف موظفي الوزارة وتحدّث السجلات التي لم تعدّلها. تحتفظ بكل موظف أضفته أو عدّلته يدويًا، وبالبيانات السابقة عند تعذر جلب موظف.</small></span></label><label class="sync-mode-choice"><input type="radio" name="syncMode" value="full"><span><strong>مزامنة كلية — البدء من جديد</strong><small>تمسح جميع الموظفين، بما فيهم الإضافات والتعديلات اليدوية، ثم تعيد السجل من الوزارة. إذا تعذر جلب بعض الموظفين، تُحفظ البيانات الناجحة ولا تبقى سجلات المتعذر جلبهم القديمة.</small></span></label><p class="muted">السجل الحالي: ${state.employees.length} موظف، منهم ${manual} إضافة يدوية و${edited} سجل معدّل يدويًا.</p><div id="full-sync-confirmation" class="full-sync-confirmation" hidden><p>المزامنة الكلية ستزيل الإضافات والتعديلات اليدوية. القوائم المخصصة وإعدادات المدرسة تبقى محفوظة.</p><label><input type="checkbox" id="confirm-full-sync">أوافق على مسح جميع سجلات الموظفين وحفظ ما ينجح جلبه من الوزارة، حتى لو تعذر جلب بعض الموظفين.</label></div></div><div class="modal-footer"><button type="button" class="button secondary" data-close>إلغاء</button><button type="submit" class="button primary" id="confirm-sync-mode">بدء المزامنة العادية</button></div></form>`);
  const form = $('sync-mode-form');
  const update = () => { const full = form.elements.syncMode.value === 'full'; $('full-sync-confirmation').hidden = !full; $('confirm-sync-mode').disabled = full && !$('confirm-full-sync').checked; $('confirm-sync-mode').textContent = full ? 'مسح السجل والمزامنة الكلية' : 'بدء المزامنة العادية'; $('confirm-sync-mode').classList.toggle('danger-button', full); };
  form.addEventListener('change', update);
  form.addEventListener('submit', event => { event.preventDefault(); const mode = form.elements.syncMode.value; const confirmed = $('confirm-full-sync').checked; if (mode === 'full' && !confirmed) return; $('modal').close(); startSync(mode, confirmed); });
}
$('sync-button').addEventListener('click', () => { if (!state.auth?.ministry?.connected) { location.hash = 'settings'; toast('اربط حساب الوزارة أولًا، أو افتح تسجيل الدخول لتجديد الجلسة.'); } else chooseSyncMode(); });
const assistantChat = mountAssistantChat({ request, send, isLocalAccess: () => Boolean(state.auth?.localAccess), getExportFormat: () => state.exportFormat, onDataChanged: loadData, toast });
function navigate() {
  const view = ['employees', 'reports', 'settings', 'assistant'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'employees';
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(link => { link.classList.toggle('active', link.dataset.view === view); if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('breadcrumb-view').textContent = { employees: 'سجل العاملين', reports: 'الكشوف والتصدير', settings: 'الربط والإعدادات', assistant: 'المساعد الذكي' }[view];
  if (view === 'reports') renderReport(); window.scrollTo(0, 0);
  if (view === 'assistant' && state.auth?.authenticated) assistantChat.refreshStatus();
}
window.addEventListener('hashchange', navigate);
$('add-employee').addEventListener('click', () => editEmployee());
$('goto-report').addEventListener('click', () => { location.hash = 'reports'; });
$('search').addEventListener('input', event => { state.search = event.target.value; updateSelection(); });
$('source-filter').addEventListener('change', event => { state.source = event.target.value; updateSelection(); });
$('previous-page').addEventListener('click', () => { state.page--; renderEmployees(); });
$('next-page').addEventListener('click', () => { state.page++; renderEmployees(); });
document.querySelectorAll('[data-staff]').forEach(button => button.addEventListener('click', () => { state.staffType = button.dataset.staff; document.querySelectorAll('[data-staff]').forEach(tab => tab.classList.toggle('active', tab === button)); updateSelection(); }));
$('open-filters').addEventListener('click', () => { $('filter-panel').hidden = !$('filter-panel').hidden; $('open-filters').setAttribute('aria-expanded', String(!$('filter-panel').hidden)); });
$('add-filter').addEventListener('click', () => { state.filters.push({ path: 'job.jobDesc', mode: 'include', values: [] }); renderFilterRules(); });
$('add-sort').addEventListener('click', () => { state.sorting.push({ path: 'basicInfo.empHiredate', type: 'date', direction: 'asc' }); renderSortRules(); updateSelection(); });
$('clear-filters').addEventListener('click', resetFilters);
$('report-model').innerHTML = REPORT_MODELS.map(model => `<option value="${escape(model.id)}">${escape(model.label)}</option>`).join('');
$('report-model').addEventListener('change', event => {
  if (!getReportModel(event.target.value)) { event.target.value = state.reportModel; return; }
  state.reportModel = event.target.value;
  renderReport(); savePreferences();
});
for (const id of ['export-format', 'assistant-export-format']) $(id).addEventListener('change', event => {
  if (!['word', 'excel', 'pdf'].includes(event.target.value) || state.exporting) return;
  state.exportFormat = event.target.value;
  renderReport(); savePreferences();
});
$('hourly-person-search').addEventListener('input', filterHourlyPeople);
for (const [id, field] of [['hourly-period-start', 'periodStart'], ['hourly-period-end', 'periodEnd'], ['hourly-subject', 'subject']]) {
  $(id).addEventListener('input', event => {
    state.hourlyOptions[field] = event.target.value;
    state.hourlyOptionsDirty = true;
    state.hourlyRevision = (state.hourlyRevision || 0) + 1;
    renderHourlyPreview(selectedEmployees());
  });
}
$('hourly-people').addEventListener('input', event => {
  const field = event.target.dataset.hourlyField;
  const key = event.target.closest('[data-hourly-employee-key]')?.dataset.hourlyEmployeeKey;
  if (!field || !key || !hourlyFields.some(([name]) => name === field)) return;
  state.hourlyOptions.rows[key] ||= {};
  state.hourlyOptions.rows[key][field] = event.target.value;
  state.hourlyOptionsDirty = true;
  state.hourlyRevision = (state.hourlyRevision || 0) + 1;
  renderHourlyPreview(selectedEmployees());
});
$('save-hourly-options').addEventListener('click', event => busy(event.currentTarget, async () => {
  await saveHourlyOptions();
  toast('تم حفظ بيانات النموذج.');
}, 'جارٍ الحفظ…'));
$('reset-columns').addEventListener('click', () => { state.columns = structuredClone(DEFAULT_COLUMNS); renderColumns(); renderReport(); savePreferences(); });
$('add-column').addEventListener('click', () => addColumn()); $('merge-column').addEventListener('click', () => addColumn(true));
$('add-manual-column').addEventListener('click', () => {
  if (state.columns.length >= 30) return toast('الحد الأقصى للكشف 30 عمودًا.', true);
  state.columns.push({ id: uiId(), type: 'manual', label: 'بيان إضافي', manualValues: {} });
  renderColumns(); renderReport(); savePreferences(); editManualColumn(state.columns.length - 1);
});
$('add-signature').addEventListener('click', () => {
  if (state.signatures.length >= 9) return;
  state.signatures.push({ label: 'توقيع إضافي', name: '' }); renderSignatures(); renderReport(); savePreferences();
});
$('report-signatures').addEventListener('input', event => {
  const { signatureLabel, signatureName } = event.target.dataset;
  const index = signatureLabel ?? signatureName;
  if (index === undefined) return;
  state.signatures[Number(index)][signatureLabel !== undefined ? 'label' : 'name'] = event.target.value;
  renderReport(); savePreferences();
});
$('report-signatures').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-signature]'); if (!button) return;
  state.signatures.splice(Number(button.dataset.removeSignature), 1); renderSignatures(); renderReport(); savePreferences();
});
for (const id of ['report-title', 'orientation', 'numerals']) $(id).addEventListener('input', () => { renderReport(); savePreferences(); });
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !$('modal').open) { event.preventDefault(); location.hash = 'employees'; $('search').focus(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAuth().catch(() => {}); });
$('today').textContent = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
restorePreferences(); renderSignatures(); renderExportChoice(); renderColumns(); renderFilterRules(); renderSortRules(); navigate();
try { await verifyAppVersion(); await refreshAuth(); if (state.auth?.authenticated) { await loadData(); if (location.hash === '#assistant') await assistantChat.refreshStatus(); } }
catch (error) { $('global-error').textContent = `${error.message} أعد تحميل الصفحة بعد التأكد من تشغيل البرنامج.`; $('global-error').hidden = false; }
authPoll = setInterval(() => { if (!document.hidden && !$('pair-form')) refreshAuth().catch(() => {}); }, 5000);
window.addEventListener('pagehide', () => clearInterval(authPoll));
