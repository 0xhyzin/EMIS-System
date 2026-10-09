import { westernDigits } from './dataModel.js';

const fields = ['altEmail', 'mobile'];
const labels = { altEmail: 'البريد الإلكتروني البديل', mobile: 'رقم المحمول' };

export function normalizeUnifiedEmailValue(field, value) {
  const text = String(value ?? '').trim();
  return field === 'mobile' ? westernDigits(text) : text;
}

export function validateUnifiedEmailValue(field, value) {
  const normalized = normalizeUnifiedEmailValue(field, value);
  if (field === 'altEmail') {
    if (!normalized || normalized.length > 254 || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(normalized)) return 'اكتب بريدًا إلكترونيًا بديلًا صحيحًا، مثل name@example.com. لا يمكن تركه فارغًا.';
  } else if (field === 'mobile') {
    if (!/^01[0125]\d{8}$/.test(normalized)) return 'اكتب رقم محمول مصري صحيحًا من 11 رقمًا يبدأ بـ 010 أو 011 أو 012 أو 015.';
  } else return 'البيان المطلوب غير متاح للتغيير.';
  return '';
}

// The caller supplies a modal identity check so late requests cannot update a different dialog.
export function mountUnifiedEmailEditor(root, { employeeId, request, send, isCurrent }) {
  root.innerHTML = `<p class="unified-email-notice">الحفظ هنا يغيّر بيانات البريد في موقع الوزارة. راجع اسم الموظف والبريد الموحد قبل الحفظ.</p>
    <p id="unified-email-loading" class="unified-email-loading" role="status"><span class="spinner" aria-hidden="true"></span>جارٍ جلب بيانات البريد من الوزارة…</p>
    <div id="unified-email-error" class="alert error" role="alert" tabindex="-1" hidden></div>
    <div id="unified-email-success" class="alert" role="status" hidden></div>
    <div id="unified-email-content" hidden>
      <dl class="unified-email-summary">
        ${[['empCode', 'كود الموظف'], ['empName', 'اسم الموظف'], ['empEmail', 'البريد الموحد'], ['jobTitle', 'الوظيفة'], ['altEmail', labels.altEmail], ['mobile', labels.mobile]].map(([key, label]) => `<div><dt>${label}</dt><dd id="unified-email-${key}"${['empCode', 'empEmail', 'altEmail', 'mobile'].includes(key) ? ' dir="ltr"' : ''}>—</dd></div>`).join('')}
      </dl>
      <p id="unified-email-activation" class="unified-email-advisory" hidden>البريد الموحد غير مفعّل حاليًا حسب بيانات الوزارة. يمكنك مراجعة البريد البديل ورقم المحمول وتحديثهما.</p>
      <div class="unified-email-forms">
        <form id="unified-email-form-altEmail" class="unified-email-field-form" novalidate>
          <label for="unified-email-input-altEmail">${labels.altEmail}</label>
          <input id="unified-email-input-altEmail" name="altEmail" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" dir="ltr" placeholder="name@example.com" required>
          <button type="submit" id="unified-email-save-altEmail" class="button email-button" disabled>حفظ البريد في الوزارة</button>
        </form>
        <form id="unified-email-form-mobile" class="unified-email-field-form" novalidate>
          <label for="unified-email-input-mobile">${labels.mobile}</label>
          <input id="unified-email-input-mobile" name="mobile" type="tel" inputmode="tel" autocomplete="off" maxlength="20" dir="ltr" placeholder="01012345678" required>
          <button type="submit" id="unified-email-save-mobile" class="button email-button" disabled>حفظ المحمول في الوزارة</button>
        </form>
      </div>
      <p class="muted unified-email-save-note">كل زر يحفظ البيان الخاص به فقط. البيانات المعروضة أعلى النافذة هي آخر بيانات تم التحقق منها في الوزارة.</p>
    </div>
    <div class="unified-email-reload-row"><button type="button" id="unified-email-reload" class="button secondary">إعادة تحميل بيانات الوزارة</button><span id="unified-email-pending" class="muted" role="status"></span></div>`;

  const element = id => root.querySelector(`#unified-email-${id}`);
  const input = field => element(`input-${field}`);
  const endpoint = `/employees/${encodeURIComponent(employeeId)}/unified-email`;
  let current = null;
  let busy = false;
  let requiresRefresh = false;
  let readSequence = 0;

  function updateControls() {
    for (const field of fields) {
      input(field).disabled = busy || !current;
      element(`save-${field}`).disabled = busy || !current || requiresRefresh || normalizeUnifiedEmailValue(field, input(field).value) === normalizeUnifiedEmailValue(field, current[field]);
    }
    element('reload').disabled = busy;
    root.setAttribute('aria-busy', String(busy));
  }

  function showError(message) {
    element('success').hidden = true;
    element('error').textContent = message;
    element('error').hidden = false;
    element('error').focus();
  }

  function acceptEmployee(employee, { savedField = null, preserveDrafts = false } = {}) {
    if (!employee || typeof employee !== 'object' || !String(employee.empCode ?? '').trim()) throw new Error('لم تُرجع الوزارة بيانات موظف مكتملة. أعد تحميل البيانات قبل الحفظ.');
    if (current && String(employee.empCode) !== String(current.empCode)) throw new Error('تغيّرت هوية الموظف في الرد. أغلِق النافذة وافتح بيانات الموظف من جديد.');
    for (const field of fields) {
      const wasChanged = current && normalizeUnifiedEmailValue(field, input(field).value) !== normalizeUnifiedEmailValue(field, current[field]);
      if (field === savedField || !preserveDrafts || !wasChanged) input(field).value = String(employee[field] ?? '');
    }
    current = { ...employee };
    for (const key of ['empCode', 'empName', 'empEmail', 'jobTitle', 'altEmail', 'mobile']) element(key).textContent = String(current[key] ?? '') || 'لم يُسجّل';
    element('activation').hidden = current.isEmailActivated !== false;
    element('content').hidden = false;
    requiresRefresh = false;
  }

  async function load() {
    if (busy || !isCurrent()) return;
    const sequence = ++readSequence;
    busy = true;
    element('loading').hidden = false;
    element('error').hidden = true;
    element('success').hidden = true;
    element('pending').textContent = '';
    updateControls();
    try {
      const response = await request(endpoint, { cache: 'no-store' });
      if (!isCurrent() || sequence !== readSequence) return;
      acceptEmployee(response.employee, { preserveDrafts: true });
    } catch (error) {
      if (!isCurrent() || sequence !== readSequence) return;
      requiresRefresh = true;
      showError(error.message || 'تعذر جلب بيانات البريد من الوزارة.');
    } finally {
      if (isCurrent() && sequence === readSequence) {
        busy = false;
        element('loading').hidden = true;
        updateControls();
      }
    }
  }

  async function save(field) {
    if (busy || !current || requiresRefresh || !isCurrent()) return;
    const value = normalizeUnifiedEmailValue(field, input(field).value);
    const validationError = validateUnifiedEmailValue(field, value);
    if (validationError) { showError(validationError); input(field).focus(); return; }
    const previousValue = String(current[field] ?? '');
    if (value === normalizeUnifiedEmailValue(field, previousValue)) return;
    busy = true;
    element('error').hidden = true;
    element('success').hidden = true;
    element('pending').textContent = 'جارٍ الحفظ والتحقق من بيانات الوزارة…';
    updateControls();
    try {
      const result = await send(endpoint, 'PATCH', { field, value, previousValue, expectedEmpCode: current.empCode });
      if (!isCurrent()) return;
      if (!result.success || normalizeUnifiedEmailValue(field, result.employee?.[field]) !== value) throw new Error('لم يمكن تأكيد التغيير من بيانات الوزارة. أعد تحميل البيانات لمعرفة الحالة الحالية.');
      acceptEmployee(result.employee, { savedField: field, preserveDrafts: true });
      element('success').textContent = result.message || `تم حفظ ${labels[field]} والتحقق منه في الوزارة.`;
      element('success').hidden = false;
    } catch (error) {
      if (!isCurrent()) return;
      requiresRefresh = true;
      showError(`${error.message || 'تعذر تأكيد الحفظ في الوزارة.'} أعد تحميل بيانات الوزارة قبل محاولة الحفظ مرة أخرى.`);
    } finally {
      if (isCurrent()) {
        busy = false;
        element('pending').textContent = '';
        updateControls();
      }
    }
  }

  for (const field of fields) {
    element(`form-${field}`).addEventListener('submit', event => { event.preventDefault(); save(field); });
    input(field).addEventListener('input', updateControls);
  }
  element('reload').addEventListener('click', load);
  updateControls();
  return load();
}
