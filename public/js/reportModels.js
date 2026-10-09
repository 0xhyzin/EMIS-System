import { getValue, normalizeArabic, westernDigits } from './dataModel.js';

// A model describes a complete document. Saved table configurations remain
// separate: they only change the columns of the ordinary staff register.
export const REPORT_MODELS = Object.freeze([
  Object.freeze({ id: 'staff-register', label: 'كشف العاملين بالمدرسة', kind: 'staff-register' }),
  Object.freeze({
    id: 'hourly-contract-period-1',
    label: 'نموذج (2) — بالحصة دون سن الستين — الفترة الأولى',
    kind: 'hourly-contract',
  }),
]);

export const getReportModel = id => REPORT_MODELS.find(model => model.id === id) || null;

export const DEFAULT_HOURLY_OPTIONS = Object.freeze({
  periodStart: '2026-09-12',
  periodEnd: '2026-09-30',
  subject: '',
  rows: Object.freeze({}),
});

export const HOURLY_OVERRIDE_FIELDS = Object.freeze([
  'specialization', 'educationalSubject', 'monthlySessions', 'amount', 'paymentDestination',
]);

// This key travels between the browser and server, but contains no readable
// national ID or name. Including both prevents stale row notes attaching to a
// different person if a ministry code is reused after deletion/import.
export function hourlyEmployeeKey(employee) {
  const id = Number(employee?.emp_code);
  if (!Number.isSafeInteger(id) || id === 0) throw new TypeError('رقم الموظف غير صحيح.');
  const nationalId = westernDigits(getValue(employee, 'basicInfo.nationalIdNum')).trim();
  // A corrected spelling must not detach saved form entries. Prefer the
  // national ID when present; names protect records that have no ID.
  const identity = [employee?.source || 'ministry', nationalId ? `id:${nationalId}`
    : `name:${normalizeArabic(getValue(employee, 'fullName'))}`].join('\u001f');
  let hash = 0xcbf29ce484222325n;
  for (const character of identity) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${id}:${hash.toString(16).padStart(16, '0')}`;
}

// Ordered from the right side of the source form. The caller inserts the
// serial number into the first cell because it depends on the selected list.
export function hourlyRow(employee, schoolInfo = {}, overrides = {}) {
  const value = key => String(overrides?.[key] ?? '').trim();
  const explicit = key => overrides != null && Object.hasOwn(overrides, key);
  return [
    '',
    String(schoolInfo?.schoolName || getValue(employee, 'basicInfo.schoolName') || '').trim(),
    getValue(employee, 'fullName').trim(),
    getValue(employee, 'basicInfo.nationalIdNum').trim(),
    getValue(employee, 'qlf.qlfName').trim(),
    explicit('specialization') ? value('specialization') : getValue(employee, 'basicInfo.brchDesc').trim() || getValue(employee, 'job.subjectDesc').trim(),
    explicit('educationalSubject') ? value('educationalSubject') : getValue(employee, 'job.subjectDesc').trim(),
    value('monthlySessions'),
    value('amount'),
    value('paymentDestination'),
  ];
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function realDate(value) {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Validate and normalize persisted per-form inputs; no employee data is changed. */
export function normalizeHourlyOptions(input) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !['periodStart', 'periodEnd', 'subject', 'rows'].includes(key))) {
    throw new TypeError('إعدادات النموذج غير صحيحة.');
  }
  const periodStart = input.periodStart ?? DEFAULT_HOURLY_OPTIONS.periodStart;
  const periodEnd = input.periodEnd ?? DEFAULT_HOURLY_OPTIONS.periodEnd;
  const subject = input.subject ?? '';
  const sourceRows = input.rows ?? {};
  if (typeof periodStart !== 'string' || !realDate(periodStart) || typeof periodEnd !== 'string' || !realDate(periodEnd)
    || (periodStart && periodEnd && periodStart > periodEnd)) throw new TypeError('راجع تاريخ بداية الفترة ونهايتها.');
  if (typeof subject !== 'string' || subject.length > 120 || /[\u0000-\u001f\u007f]/.test(subject)) throw new TypeError('اسم المادة غير صحيح.');
  if (!isPlainObject(sourceRows) || Object.keys(sourceRows).length > 1000) throw new TypeError('بيانات صفوف النموذج غير صحيحة.');
  const rows = {};
  for (const [key, rawRow] of Object.entries(sourceRows)) {
    if (!/^-?[1-9]\d*:[0-9a-f]{16}$/.test(key) || !Number.isSafeInteger(Number(key.slice(0, key.indexOf(':'))))
      || !isPlainObject(rawRow) || Object.keys(rawRow).some(field => !HOURLY_OVERRIDE_FIELDS.includes(field))) {
      throw new TypeError('بيانات أحد العاملين في النموذج غير صحيحة.');
    }
    const row = {};
    for (const [field, rawValue] of Object.entries(rawRow)) {
      if (typeof rawValue !== 'string' || rawValue.length > 120 || /[\u0000-\u001f\u007f]/.test(rawValue)) throw new TypeError('قيمة أحد حقول النموذج غير صحيحة.');
      const value = westernDigits(rawValue.trim()).replaceAll('٫', '.');
      if (['monthlySessions', 'amount'].includes(field)) {
        const maxDigits = field === 'monthlySessions' ? 5 : 7;
        if (value && !new RegExp(`^\\d{1,${maxDigits}}(?:\\.\\d{1,2})?$`).test(value)) {
          throw new TypeError('عدد الحصص والمبلغ يجب أن يكونا أرقامًا موجبة بحد أقصى منزلتين عشريتين.');
        }
      }
      row[field] = value;
    }
    if (Object.keys(row).length) rows[key] = row;
  }
  return { periodStart, periodEnd, subject: subject.trim(), rows };
}
