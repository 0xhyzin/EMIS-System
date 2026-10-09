import { DatabaseSync } from 'node:sqlite';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getAllFields } from '../public/js/fieldMappings.js';
import { buildEmployeeSchema, getSchemaAtPath, REPEATABLE_SECTIONS } from '../public/js/employeeSchema.js';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let db;
let databasePath;
const editableFields = new Set(['fullName', 'nationalId', 'empCode', 'staffType', 'jobTitle', 'jobDate', 'qualification', 'qualificationDate', 'appointmentDate', 'startDate', 'address', 'notes']);
const paths = {
    nationalId: ['basicInfo', 'nationalIdNum'], empCode: ['basicInfo', 'empCode'],
    jobTitle: ['job', 'jobDesc'], jobDate: ['job', 'kadrJobStartDate'],
    qualification: ['qlf', 'qlfName'], qualificationDate: ['qlf', 'empQlfDate'],
    appointmentDate: ['basicInfo', 'empHiredate'], startDate: ['basicInfo', 'empStartDate'],
    address: ['basicInfo', 'addressDesc']
};
const detailFields = new Map(getAllFields().map(field => [field.path, field]));
const nameFields = ['empFirstName', 'empFatherName', 'empGrandFatherName', 'empFamilyName'];
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => value != null && Object.hasOwn(value, key);
const plainObject = value => value != null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class DataError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
export function normalizeDigits(value) {
    return String(value ?? '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).trim();
}
function parseJSON(value, fallback = {}) { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } }
function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function initDatabase(options = {}) {
    if (db) db.close();
    const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(projectDir, 'data'));
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    databasePath = join(dataDir, 'school.db');
    const exists = fs.existsSync(databasePath);
    db = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    for (const sidecar of ['-wal', '-shm']) if (fs.existsSync(databasePath + sidecar)) fs.chmodSync(databasePath + sidecar, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const columns = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
    if (exists && columns.length && !columns.includes('source')) {
        const backupPath = join(dataDir, 'school.before-v2.db');
        if (!fs.existsSync(backupPath)) db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
        fs.chmodSync(backupPath, 0o600);
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
            emp_code INTEGER PRIMARY KEY, national_id TEXT, full_name TEXT, raw_data TEXT,
            staff_type TEXT DEFAULT 'core', last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            source TEXT NOT NULL DEFAULT 'ministry', source_emp_code TEXT, local_overrides TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS reference_values (
            id INTEGER PRIMARY KEY AUTOINCREMENT, field_key TEXT NOT NULL, field_label TEXT NOT NULL,
            field_value TEXT NOT NULL, sort_order INTEGER DEFAULT 0, UNIQUE(field_key, field_value)
        );
        CREATE TABLE IF NOT EXISTS table_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, columns TEXT, sorting TEXT, footer TEXT, title TEXT,
            orientation TEXT NOT NULL DEFAULT 'landscape', use_arabic_numerals INTEGER NOT NULL DEFAULT 0,
            export_format TEXT NOT NULL DEFAULT 'word',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS employee_suppressions (
            identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(identity_type, identity_value)
        );
        CREATE TABLE IF NOT EXISTS custom_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS custom_list_members (
            list_id INTEGER NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL, position INTEGER NOT NULL,
            PRIMARY KEY(list_id, employee_id)
        );
    `);
    const actualColumns = new Set(db.prepare('PRAGMA table_info(employees)').all().map(c => c.name));
    for (const [name, definition] of [['staff_type', "TEXT DEFAULT 'core'"], ['source', "TEXT NOT NULL DEFAULT 'ministry'"], ['source_emp_code', 'TEXT'], ['local_overrides', "TEXT NOT NULL DEFAULT '{}'"]]) {
        if (!actualColumns.has(name)) db.exec(`ALTER TABLE employees ADD COLUMN ${name} ${definition}`);
    }
    const tableColumns = new Set(db.prepare('PRAGMA table_info(table_configs)').all().map(column => column.name));
    for (const [name, definition] of [['orientation', "TEXT NOT NULL DEFAULT 'landscape'"], ['use_arabic_numerals', 'INTEGER NOT NULL DEFAULT 0'], ['export_format', "TEXT NOT NULL DEFAULT 'word'"]]) {
        if (!tableColumns.has(name)) db.exec(`ALTER TABLE table_configs ADD COLUMN ${name} ${definition}`);
    }
    db.exec("UPDATE employees SET source_emp_code = CAST(emp_code AS TEXT) WHERE source = 'ministry' AND source_emp_code IS NULL; PRAGMA journal_mode = WAL;");
    // Old releases stored access credentials as plaintext settings. New authentication uses its encrypted store.
    db.exec("DELETE FROM settings WHERE key IN ('bearerToken','utToken')");
    fs.chmodSync(databasePath, 0o600);
    return databasePath;
}
export function closeDatabase() { if (db) { db.close(); db = undefined; } }
export function getDatabasePath() { return databasePath; }
export function saveSetting(key, value) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
}
export function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? parseJSON(row.value, row.value) : null;
}
export function deleteSetting(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }

function shape(row) {
    if (!row) return null;
    const { local_overrides, ...publicRow } = row;
    return { ...publicRow, raw_data: parseJSON(row.raw_data), has_local_changes: Object.keys(parseJSON(local_overrides)).length > 0 };
}
export function getAllEmployees(staffType) {
    const rows = ['core', 'seconded'].includes(staffType)
        ? db.prepare('SELECT * FROM employees WHERE staff_type=? ORDER BY full_name,emp_code').all(staffType)
        : db.prepare('SELECT * FROM employees ORDER BY full_name,emp_code').all();
    return rows.map(shape);
}
export function getEmployee(empCode) { return shape(db.prepare('SELECT * FROM employees WHERE emp_code=?').get(Number(empCode))); }
export function getEmployeeCount() {
    const row = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(staff_type='core'),0) core, COALESCE(SUM(staff_type='seconded'),0) seconded, COALESCE(SUM(source='manual'),0) manual, MAX(last_updated) lastUpdated FROM employees").get();
    return { ...row, lastSync: getSetting('lastSync') };
}
function identityCode(value) {
    const normalized = normalizeDigits(value).replace(/\s/g, '');
    return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, '') : normalized;
}
function identityNationalId(value) {
    const normalized = normalizeDigits(value).replace(/\s/g, '');
    // Missing/invalid ministry placeholders must not merge unrelated employees.
    return /^\d{14}$/.test(normalized) && !/^0+$/.test(normalized) ? normalized : '';
}
function normalizeDate(text) {
    if (!text) return '';
    let value = normalizeDigits(text);
    const dayFirst = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dayFirst) value = `${dayFirst[3]}-${dayFirst[2].padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new DataError('اكتب تاريخًا صحيحًا.');
    return value;
}
function normalizeDetailValue(path, value) {
    if (value !== null && (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new DataError('قيمة أحد الحقول غير صحيحة.');
    let text = String(value ?? '').trim();
    if (text.length > 500) throw new DataError('أحد الحقول أطول من الحد المسموح.');
    const basePath = path.replace(/\.\d+\./, '.');
    if (detailFields.get(basePath).type === 'date') return normalizeDate(text);
    if (basePath === 'basicInfo.nationalIdNum') {
        text = normalizeDigits(text).replace(/\s/g, '');
        if (text && !/^\d{14}$/.test(text)) throw new DataError('الرقم القومي يجب أن يتكون من ١٤ رقمًا.');
    } else if (basePath === 'basicInfo.empCode') {
        text = identityCode(text);
        if (text && (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0)) throw new DataError('كود الموظف يجب أن يكون رقمًا موجبًا.');
    } else if (detailFields.get(basePath).type === 'number') text = normalizeDigits(text);
    return text;
}
function detailPath(path, raw) {
    const parts = path.split('.');
    if (parts.length !== 2 && parts.length !== 3) throw new DataError('أحد حقول الموظف غير معروف.');
    const [section] = parts;
    const prop = parts.at(-1);
    if (!detailFields.has(`${section}.${prop}`)) throw new DataError('أحد حقول الموظف غير معروف.');
    if (parts.length === 3) {
        if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) throw new DataError('رقم سجل بيانات الموظف غير صحيح.');
        const index = Number(parts[1]);
        if (!Array.isArray(raw?.[section]) || index >= raw[section].length || !raw[section][index] || typeof raw[section][index] !== 'object' || Array.isArray(raw[section][index])) throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
        if (index) return `${section}.${index}.${prop}`;
    }
    return `${section}.${prop}`;
}
// Persist edits in one path map so a later edit always supersedes older aliases,
// including a legacy fullName edit followed by individual name corrections.
function inputDetails(input) {
    const details = {};
    if ('fullName' in input) {
        const names = input.fullName.split(/\s+/);
        for (let i = 0; i < nameFields.length; i++) details[`basicInfo.${nameFields[i]}`] = i === 3 ? names.slice(3).join(' ') : names[i] || '';
    }
    for (const [field, parts] of Object.entries(paths)) if (field in input) details[parts.join('.')] = input[field];
    for (const [path, value] of Object.entries(input.details || {})) details[path.replace(/\.0\./, '.')] = value;
    return details;
}
function patchPath(path) {
    if (!Array.isArray(path) || !path.length || path.length > 16 || typeof path[0] !== 'string') throw new DataError('مسار الحقل غير صحيح.');
    for (const key of path) {
        if (typeof key === 'number') {
            if (!Number.isSafeInteger(key) || key < 0 || key >= 500) throw new DataError('رقم سجل البيانات غير صحيح.');
        } else if (typeof key !== 'string' || !key || key.length > 200 || unsafeKeys.has(key)) throw new DataError('اسم أحد الحقول غير مسموح.');
    }
    return path;
}
function rawScalar(path, value, schema) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new DataError('قيمة الحقل يجب أن تكون نصًا أو رقمًا أو اختيارًا.');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new DataError('قيمة رقمية غير صحيحة.');
    if (typeof value === 'string' && value.length > 4000) throw new DataError('أحد الحقول أطول من الحد المسموح.');
    const mappedPath = path.filter(key => typeof key === 'string').join('.');
    if (detailFields.has(mappedPath)) return normalizeDetailValue(mappedPath, value);
    if (schema?.type === 'date' && value !== null) return normalizeDate(value);
    return value;
}
function recordValue(value, schema, path, depth = 0) {
    if (!schema || depth > 16) throw new DataError('أحد حقول السجل غير معروف أو متداخل أكثر من اللازم.');
    if (schema.kind === 'scalar') return rawScalar(path, value, schema);
    if (value === null) return null;
    if (schema.kind === 'array') {
        if (!Array.isArray(value)) {
            if (!schema.repeatable || !plainObject(value)) throw new DataError('تنسيق سجل البيانات غير صحيح.');
            return recordValue(value, schema.item, path, depth + 1);
        }
        if (value.length > 500) throw new DataError('عدد السجلات أكبر من الحد المسموح.');
        return value.map((entry, index) => recordValue(entry, schema.item, [...path, index], depth + 1));
    }
    if (schema.kind !== 'object' || !plainObject(value)) throw new DataError('تنسيق سجل البيانات غير صحيح.');
    const result = {};
    if (Object.keys(value).length > 500) throw new DataError('عدد حقول السجل أكبر من الحد المسموح.');
    for (const [key, fieldValue] of Object.entries(value)) {
        if (unsafeKeys.has(key) || !own(schema.fields, key)) throw new DataError('أحد حقول السجل غير معروف.');
        result[key] = recordValue(fieldValue, schema.fields[key], [...path, key], depth + 1);
    }
    return result;
}
function rawLocation(raw, path, create = false) {
    let container = raw;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i], next = path[i + 1];
        if (typeof key === 'number') {
            if (!Array.isArray(container) || key >= container.length) throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
        } else if (!plainObject(container)) throw new DataError('مسار سجل البيانات لا يطابق البيانات المحفوظة.');
        if (!own(container, key) || container[key] === null) {
            if (!create || typeof next === 'number') throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
            container[key] = {};
        }
        container = container[key];
    }
    const key = path.at(-1);
    if (typeof key === 'number') {
        if (!Array.isArray(container) || key >= container.length) throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
    } else if (!plainObject(container)) throw new DataError('مسار سجل البيانات لا يطابق البيانات المحفوظة.');
    return { container, key };
}
function validateRawPatch(raw, operations, schema) {
    if (!Array.isArray(operations) || operations.length > 2000) throw new DataError('تعديلات بيانات الموظف غير صحيحة.');
    let bytes;
    try { bytes = JSON.stringify(operations).length; } catch { throw new DataError('تعديلات بيانات الموظف غير صحيحة.'); }
    if (bytes > 500000) throw new DataError('حجم التعديلات أكبر من الحد المسموح.');
    const result = structuredClone(raw), touched = new Set();
    let nameEdited = false;
    for (const operation of operations) {
        if (!plainObject(operation) || !['set', 'append', 'remove'].includes(operation.op)) throw new DataError('نوع تعديل البيانات غير صحيح.');
        const path = patchPath(operation.path), node = getSchemaAtPath(schema, path);
        const expectedKeys = new Set(operation.op === 'remove' ? ['op', 'path', 'index'] : ['op', 'path', 'value']);
        if (Object.keys(operation).some(key => !expectedKeys.has(key)) || !node) throw new DataError('أحد حقول الموظف غير معروف.');
        const { container, key } = rawLocation(result, path, operation.op !== 'remove');
        const current = own(container, key) ? container[key] : undefined;
        if (operation.op === 'set') {
            // Some ministry fields are scalars for one person and structured data
            // for another. Their current scalar remains editable without replacing
            // any existing object or array with a scalar.
            const existingScalar = current !== null && ['string', 'number', 'boolean'].includes(typeof current);
            if (!own(operation, 'value') || (node.kind !== 'scalar' && !existingScalar) || (current !== null && typeof current === 'object')) throw new DataError('اختر حقلًا واحدًا داخل السجل لتعديله.');
            container[key] = rawScalar(path, operation.value, node);
            if (path[0] === 'basicInfo' && nameFields.includes(path.at(-1))) nameEdited = true;
        } else {
            // The primary identity object cannot be added/removed as a history record.
            if (path[0] === 'basicInfo' && path.length === 1) throw new DataError('لا يمكن حذف أو تكرار البيانات الأساسية للموظف.');
            const repeatableObject = path.length === 1 && REPEATABLE_SECTIONS.includes(path[0]);
            if (node.kind !== 'array' && !repeatableObject) throw new DataError('هذا القسم لا يدعم سجلات متعددة.');
            if (operation.op === 'append') {
                if (!own(operation, 'value')) throw new DataError('بيانات السجل الجديد غير صحيحة.');
                const itemSchema = node.kind === 'array' ? node.item : node;
                const entry = recordValue(operation.value, itemSchema, [...path, 0]);
                let entries;
                if (Array.isArray(current)) entries = current;
                else if (current == null) entries = [];
                else if (repeatableObject && plainObject(current)) entries = [current];
                else throw new DataError('تنسيق القسم لا يسمح بإضافة سجل.');
                if (entries.length >= 500) throw new DataError('عدد السجلات أكبر من الحد المسموح.');
                container[key] = [...entries, entry];
            } else {
                if (!Number.isSafeInteger(operation.index) || operation.index < 0) throw new DataError('رقم السجل المطلوب حذفه غير صحيح.');
                const entries = Array.isArray(current) ? current : repeatableObject && plainObject(current) ? [current] : null;
                if (!entries || operation.index >= entries.length) throw new DataError('السجل المطلوب حذفه غير موجود.');
                container[key] = entries.filter((_, index) => index !== operation.index);
            }
        }
        touched.add(path[0]);
    }
    const rawSections = Object.fromEntries([...touched].map(key => [key, result[key]]));
    return { rawSections, ...(nameEdited ? { nameEdited: true } : {}) };
}
function validateInput(input, raw = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataError('بيانات الموظف غير صحيحة.');
    const result = {};
    for (const [key, value] of Object.entries(input)) {
        if (!editableFields.has(key)) continue;
        if (value !== null && (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new DataError('قيمة أحد الحقول غير صحيحة.');
        const text = String(value ?? '').trim();
        if (text.length > (key === 'notes' ? 4000 : 500)) throw new DataError('أحد الحقول أطول من الحد المسموح.');
        result[key] = text;
    }
    if ('fullName' in result && !result.fullName) throw new DataError('اكتب اسم الموظف بالكامل.');
    if ('staffType' in result && !['core', 'seconded'].includes(result.staffType)) throw new DataError('اختر القوة الأساسية أو المنتدبين.');
    if ('details' in input) {
        if (!input.details || typeof input.details !== 'object' || Array.isArray(input.details) || ![Object.prototype, null].includes(Object.getPrototypeOf(input.details))) throw new DataError('تفاصيل الموظف غير صحيحة.');
        result.details = {};
        for (const [path, value] of Object.entries(input.details)) {
            const normalized = detailPath(path, raw);
            if (Object.hasOwn(result.details, normalized)) throw new DataError('تم إرسال نفس الحقل أكثر من مرة.');
            result.details[normalized] = normalizeDetailValue(normalized, value);
        }
    }
    const details = inputDetails(result);
    for (const [path, value] of Object.entries(details)) details[path] = normalizeDetailValue(path, value);
    let complete = {};
    if ('rawPatch' in input || 'customFields' in input) {
        if ('rawPatch' in input && ('details' in input || Object.keys(result).some(key => !['staffType', 'notes', 'details'].includes(key)))) throw new DataError('أرسل التعديلات بطريقة واحدة فقط.');
        const records = db.prepare('SELECT raw_data FROM employees').all().map(row => parseJSON(row.raw_data));
        const schema = buildEmployeeSchema([...records, raw]);
        if ('rawPatch' in input) complete = validateRawPatch(raw, input.rawPatch, schema);
        if ('customFields' in input) {
            if ('rawPatch' in input && input.rawPatch.some(operation => operation.path?.[0] === 'customFields')) throw new DataError('تم إرسال الحقول الإضافية أكثر من مرة.');
            if (!Array.isArray(input.customFields)) throw new DataError('الحقول الإضافية غير صحيحة.');
            complete.rawSections = { ...complete.rawSections, customFields: recordValue(input.customFields, getSchemaAtPath(schema, ['customFields']), ['customFields']) };
        }
        if (complete.rawSections?.customFields) for (const field of complete.rawSections.customFields) {
            if (!plainObject(field) || typeof field.label !== 'string' || !field.label.trim() || field.label.trim().length > 150 || !own(field, 'value')) throw new DataError('اكتب اسمًا وقيمة لكل حقل إضافي.');
            field.label = field.label.trim();
        }
    }
    return { ...('staffType' in result ? { staffType: result.staffType } : {}), ...('notes' in result ? { notes: result.notes } : {}), details, ...complete };
}
function applyInput(raw, input) {
    const result = structuredClone(raw || {});
    for (const [section, value] of Object.entries(input.rawSections || {})) result[section] = structuredClone(value);
    for (const [path, value] of Object.entries(inputDetails(input))) {
        const parts = path.split('.');
        const section = parts[0], prop = parts.at(-1), index = parts.length === 3 ? Number(parts[1]) : 0;
        if (Array.isArray(result[section])) {
            if (parts.length === 3 && !result[section][index]) throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
            if (!result[section][index] || typeof result[section][index] !== 'object' || Array.isArray(result[section][index])) result[section][index] = {};
            result[section][index][prop] = value;
        } else {
            if (parts.length === 3) throw new DataError('سجل البيانات المطلوب تعديله غير موجود.');
            result[section] = { ...(result[section] && typeof result[section] === 'object' ? result[section] : {}), [prop]: value };
        }
    }
    if ('notes' in input) result.notes = input.notes;
    return result;
}
function basicData(raw) { return Array.isArray(raw.basicInfo) ? raw.basicInfo[0] || {} : raw.basicInfo || {}; }
function editedName(raw, fields, previous = '') {
    const changed = fields.nameEdited || nameFields.some(field => Object.hasOwn(fields.details || {}, `basicInfo.${field}`));
    if (!changed && previous) return previous;
    const basic = basicData(raw);
    const name = nameFields.map(field => String(basic[field] ?? '').trim()).filter(Boolean).join(' ');
    if (!name) throw new DataError('اكتب اسم الموظف بالكامل.');
    return name;
}
function duplicate(nationalId, sourceCode, exceptId) {
    const nationalIdentity = identityNationalId(nationalId);
    const codeIdentity = identityCode(sourceCode);
    return db.prepare('SELECT emp_code,national_id,source_emp_code,raw_data FROM employees').all().find(row => row.emp_code !== exceptId && (
        (nationalIdentity && identityNationalId(row.national_id) === nationalIdentity) ||
        (codeIdentity && (identityCode(row.source_emp_code) === codeIdentity || identityCode(basicData(parseJSON(row.raw_data)).empCode) === codeIdentity))
    ));
}
function ensureUnique(nationalId, sourceCode, exceptId) {
    if (duplicate(nationalId, sourceCode, exceptId)) throw new DataError('الموظف موجود بالفعل بنفس الرقم القومي أو كود الموظف.', 409);
}
function clearSuppression(nationalId, sourceCode) {
    const stmt = db.prepare('DELETE FROM employee_suppressions WHERE identity_type=? AND identity_value=?');
    if (nationalId) stmt.run('nationalId', nationalId);
    if (sourceCode) stmt.run('empCode', sourceCode);
}
export function createEmployee(input) {
    const fields = validateInput(input);
    return transaction(() => {
        const raw = applyInput({ basicInfo: { nationalIdNum: '', empCode: '' } }, fields);
        const nationalId = basicData(raw).nationalIdNum || '';
        const sourceCode = basicData(raw).empCode || '';
        const fullName = editedName(raw, fields);
        ensureUnique(nationalId, sourceCode);
        const id = Number(db.prepare('SELECT MIN(emp_code) minimum FROM employees').get().minimum || 0);
        const internalId = Math.min(0, id, Number(getSetting('manualIdSequence') || 0)) - 1;
        saveSetting('manualIdSequence', internalId);
        db.prepare("INSERT INTO employees (emp_code,national_id,full_name,raw_data,staff_type,source,source_emp_code) VALUES (?,?,?,?,?,'manual',?)")
            .run(internalId, nationalId, fullName, JSON.stringify(raw), fields.staffType || 'core', sourceCode);
        clearSuppression(nationalId, sourceCode);
        return getEmployee(internalId);
    });
}
export function updateEmployee(empCode, input) {
    return transaction(() => {
        const row = db.prepare('SELECT * FROM employees WHERE emp_code=?').get(Number(empCode));
        if (!row) throw new DataError('الموظف غير موجود.', 404);
        const originalRaw = parseJSON(row.raw_data);
        const fields = validateInput(input, originalRaw);
        const raw = applyInput(originalRaw, fields);
        const nationalId = fields.details['basicInfo.nationalIdNum'] ?? (own(fields.rawSections, 'basicInfo') ? basicData(raw).nationalIdNum ?? row.national_id : row.national_id);
        const displayedCode = fields.details['basicInfo.empCode'] ?? basicData(raw).empCode ?? row.source_emp_code;
        // Imported identity remains stable for fetching, deletion and saved-list membership.
        const sourceCode = row.source === 'ministry' ? row.source_emp_code : displayedCode;
        ensureUnique(nationalId, displayedCode, row.emp_code);
        const fullName = editedName(raw, fields, row.full_name);
        // A reverted form edit must not freeze an otherwise untouched imported row
        // during normal sync or change the timestamp used by confirmation previews.
        if (JSON.stringify(raw) === JSON.stringify(originalRaw) && nationalId === row.national_id
            && fullName === row.full_name && (fields.staffType ?? row.staff_type) === row.staff_type && sourceCode === row.source_emp_code) return shape(row);
        const previous = parseJSON(row.local_overrides);
        const previousDetails = Object.fromEntries(Object.entries(inputDetails(previous)).filter(([path]) => !own(fields.rawSections, path.split('.')[0])));
        const rawSections = { ...previous.rawSections, ...fields.rawSections };
        const overrides = {
            ...('staffType' in previous ? { staffType: previous.staffType } : {}),
            ...('notes' in previous && !own(fields.rawSections, 'notes') ? { notes: previous.notes } : {}),
            ...(previous.nameEdited ? { nameEdited: true } : {}), ...fields,
            details: { ...previousDetails, ...fields.details },
            ...(Object.keys(rawSections).length ? { rawSections } : {})
        };
        db.prepare('UPDATE employees SET national_id=?,full_name=?,raw_data=?,staff_type=?,source_emp_code=?,local_overrides=?,last_updated=CURRENT_TIMESTAMP WHERE emp_code=?')
            .run(nationalId, fullName, JSON.stringify(raw), fields.staffType ?? row.staff_type, sourceCode, JSON.stringify(overrides), row.emp_code);
        return getEmployee(row.emp_code);
    });
}
export function deleteEmployee(empCode) {
    return transaction(() => {
        const row = db.prepare('SELECT * FROM employees WHERE emp_code=?').get(Number(empCode));
        if (!row) throw new DataError('الموظف غير موجود.', 404);
        // Suppress a deleted person locally, including manual people who also appear in a future ministry import.
        const insert = db.prepare('INSERT OR IGNORE INTO employee_suppressions (identity_type,identity_value) VALUES (?,?)');
        const nationalIdentity = identityNationalId(row.national_id);
        if (nationalIdentity) insert.run('nationalId', nationalIdentity);
        if (row.source_emp_code) insert.run('empCode', identityCode(row.source_emp_code));
        db.prepare('DELETE FROM employees WHERE emp_code=?').run(row.emp_code);
        return true;
    });
}
export function upsertEmployee(empCode, nationalId, fullName, rawData, staffType = 'core') {
    const code = identityCode(empCode);
    if (!/^\d+$/.test(code) || !Number.isSafeInteger(Number(code)) || Number(code) <= 0) throw new DataError('كود موظف غير صحيح في بيانات الوزارة.');
    const national = normalizeDigits(nationalId).replace(/\s/g, '');
    const blocked = db.prepare("SELECT 1 FROM employee_suppressions WHERE (identity_type='empCode' AND identity_value=?) OR (identity_type='nationalId' AND identity_value=?)").get(code, identityNationalId(national) || '__none__');
    if (blocked) return { status: 'suppressed' };
    const existing = db.prepare('SELECT * FROM employees WHERE emp_code=?').get(Number(code));
    if (existing?.source === 'manual') return { status: 'duplicate' };
    const overrides = existing ? parseJSON(existing.local_overrides) : {};
    const details = inputDetails(overrides);
    const currentOverrides = { ...overrides, details };
    const updatedNational = details['basicInfo.nationalIdNum'] ?? (own(overrides.rawSections, 'basicInfo') ? basicData(overrides.rawSections).nationalIdNum ?? national : national);
    const displayedCode = details['basicInfo.empCode'] ?? (own(overrides.rawSections, 'basicInfo') ? basicData(overrides.rawSections).empCode ?? code : code);
    // A local correction is authoritative, including for duplicate detection.
    if (duplicate(updatedNational, code, Number(code)) || duplicate(updatedNational, displayedCode, Number(code))) return { status: 'duplicate' };
    const raw = applyInput(typeof rawData === 'string' ? parseJSON(rawData) : rawData, currentOverrides);
    db.prepare(`INSERT INTO employees (emp_code,national_id,full_name,raw_data,staff_type,source,source_emp_code,last_updated)
        VALUES (?,?,?,?,?,'ministry',?,CURRENT_TIMESTAMP)
        ON CONFLICT(emp_code) DO UPDATE SET national_id=excluded.national_id,full_name=excluded.full_name,
        raw_data=excluded.raw_data,staff_type=excluded.staff_type,source_emp_code=excluded.source_emp_code,last_updated=CURRENT_TIMESTAMP`)
        .run(Number(code), updatedNational, editedName(raw, currentOverrides, fullName), JSON.stringify(raw), overrides.staffType ?? staffType, code);
    return { status: 'saved' };
}

// Fetching finishes before this transaction begins. Memberships intentionally have no
// employee foreign key: the same ministry code reappears in its lists after replacement.
export function replaceMinistryEmployees(snapshot) {
    if (!Array.isArray(snapshot)) throw new DataError('قائمة بيانات الوزارة غير صحيحة.');
    for (const employee of snapshot) {
        if (!employee || typeof employee !== 'object' || typeof employee.fullName !== 'string' || !employee.fullName.trim() || !employee.rawData || typeof employee.rawData !== 'object' || Array.isArray(employee.rawData) || !['core', 'seconded'].includes(employee.staffType || 'core')) throw new DataError('بيانات أحد موظفي الوزارة غير صحيحة.');
        const code = identityCode(employee.empCode);
        if (!/^\d+$/.test(code) || !Number.isSafeInteger(Number(code)) || Number(code) <= 0) throw new DataError('كود موظف غير صحيح في بيانات الوزارة.');
    }
    return transaction(() => {
        const removed = Number(db.prepare("DELETE FROM employees WHERE source='ministry'").run().changes);
        // A new import reflects the current ministry snapshot, including locally deleted people.
        db.prepare('DELETE FROM employee_suppressions').run();
        let saved = 0, skipped = 0;
        for (const employee of snapshot) {
            const result = upsertEmployee(employee.empCode, employee.nationalId, employee.fullName, employee.rawData, employee.staffType || 'core');
            if (result.status === 'saved') saved++; else skipped++;
        }
        return { saved, skipped, removed };
    });
}

// Both modes stage network results before entering this transaction. Protection
// is evaluated here so manual changes made while fetching are also respected.
export function synchronizeEmployees(snapshot, { mode = 'normal' } = {}) {
    if (!['normal', 'full'].includes(mode)) throw new DataError('نوع المزامنة غير صحيح.');
    if (!Array.isArray(snapshot)) throw new DataError('قائمة بيانات الوزارة غير صحيحة.');
    const codes = new Set();
    for (const employee of snapshot) {
        if (!employee || typeof employee !== 'object' || typeof employee.fullName !== 'string' || !employee.fullName.trim() || !plainObject(employee.rawData) || !['core', 'seconded'].includes(employee.staffType || 'core')) throw new DataError('بيانات أحد موظفي الوزارة غير صحيحة.');
        const code = identityCode(employee.empCode);
        if (!/^\d+$/.test(code) || !Number.isSafeInteger(Number(code)) || Number(code) <= 0 || codes.has(code)) throw new DataError('كود موظف غير صحيح أو مكرر في بيانات الوزارة.');
        codes.add(code);
    }
    return transaction(() => {
        const previousRows = db.prepare('SELECT * FROM employees').all();
        const protectedRows = mode === 'normal' ? previousRows.filter(row => row.source === 'manual' || Object.keys(parseJSON(row.local_overrides)).length > 0) : [];
        const result = {
            mode, saved: 0, added: 0, updated: 0, skipped: 0, removed: 0,
            protectedManual: protectedRows.filter(row => row.source === 'manual').length,
            protectedEdited: protectedRows.filter(row => row.source !== 'manual').length,
            retained: 0
        };
        if (mode === 'full') {
            result.removed = Number(db.prepare('DELETE FROM employees').run().changes);
            db.prepare('DELETE FROM employee_suppressions').run();
        }
        const protectedIdentity = protectedRows.map(row => ({
            id: row.emp_code, nationalId: identityNationalId(row.national_id),
            codes: new Set([identityCode(row.emp_code), identityCode(row.source_emp_code), identityCode(basicData(parseJSON(row.raw_data)).empCode)].filter(Boolean))
        }));
        for (const employee of snapshot) {
            const code = identityCode(employee.empCode), nationalId = identityNationalId(employee.nationalId);
            if (protectedIdentity.some(row => row.codes.has(code) || (nationalId && row.nationalId === nationalId))) {
                result.skipped++;
                continue;
            }
            const existing = mode === 'normal' && db.prepare('SELECT 1 FROM employees WHERE emp_code=?').get(Number(code));
            const change = upsertEmployee(code, employee.nationalId, employee.fullName, employee.rawData, employee.staffType || 'core');
            if (change.status === 'saved') {
                result.saved++;
                if (existing) result.updated++; else result.added++;
            } else result.skipped++;
        }
        result.retained = mode === 'normal' ? previousRows.length - result.updated : 0;
        return result;
    });
}

function validListId(id) {
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new DataError('معرّف القائمة غير صحيح.');
    return Number(id);
}
export function getCustomList(id) {
    const row = db.prepare('SELECT id,name,created_at,updated_at FROM custom_lists WHERE id=?').get(validListId(id));
    if (!row) return null;
    const members = db.prepare('SELECT m.employee_id, e.emp_code AS available_id FROM custom_list_members m LEFT JOIN employees e ON e.emp_code=m.employee_id WHERE m.list_id=? ORDER BY m.position,m.employee_id').all(row.id);
    const availableCount = members.filter(member => member.available_id != null).length;
    return { ...row, memberIds: members.map(member => member.employee_id), memberCount: members.length, availableCount, missingCount: members.length - availableCount };
}
export function getCustomLists() {
    return db.prepare('SELECT id FROM custom_lists ORDER BY id DESC').all().map(row => getCustomList(row.id));
}
function validateCustomList(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 150) throw new DataError('اكتب اسمًا للقائمة لا يزيد على ١٥٠ حرفًا.');
    if (!Array.isArray(input.memberIds) || input.memberIds.length > 50000 || input.memberIds.some(id => !Number.isSafeInteger(id) || id === 0)) throw new DataError('أعضاء القائمة غير صحيحين. اختر الموظفين من السجل.');
    const name = input.name.trim();
    const duplicateName = db.prepare('SELECT id FROM custom_lists WHERE name=? COLLATE NOCASE').get(name);
    if (duplicateName && duplicateName.id !== previous?.id) throw new DataError('توجد قائمة بهذا الاسم بالفعل. اختر اسمًا آخر.', 409);
    const memberIds = [...new Set(input.memberIds)];
    const allowedIds = new Set(db.prepare('SELECT emp_code FROM employees').all().map(row => row.emp_code));
    for (const id of previous?.memberIds || []) allowedIds.add(id);
    if (memberIds.some(id => !allowedIds.has(id))) throw new DataError('بعض الموظفين لم يعودوا موجودين. حدّث السجل ثم أعد الاختيار.');
    return { name, memberIds };
}
function writeCustomListMembers(id, memberIds) {
    db.prepare('DELETE FROM custom_list_members WHERE list_id=?').run(id);
    const insert = db.prepare('INSERT INTO custom_list_members (list_id,employee_id,position) VALUES (?,?,?)');
    memberIds.forEach((employeeId, position) => insert.run(id, employeeId, position));
}
export function createCustomList(input) {
    return transaction(() => {
        const { name, memberIds } = validateCustomList(input);
        const id = Number(db.prepare('INSERT INTO custom_lists (name) VALUES (?)').run(name).lastInsertRowid);
        writeCustomListMembers(id, memberIds);
        return getCustomList(id);
    });
}
export function updateCustomList(id, input) {
    return transaction(() => {
        const previous = getCustomList(id);
        if (!previous) throw new DataError('القائمة غير موجودة.', 404);
        const { name, memberIds } = validateCustomList(input, previous);
        db.prepare('UPDATE custom_lists SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, previous.id);
        writeCustomListMembers(previous.id, memberIds);
        return getCustomList(previous.id);
    });
}
export function deleteCustomList(id) {
    const result = db.prepare('DELETE FROM custom_lists WHERE id=?').run(validListId(id));
    if (!result.changes) throw new DataError('القائمة غير موجودة.', 404);
}

export function clearReferenceValues() { db.prepare('DELETE FROM reference_values').run(); }
export function addReferenceValue(fieldKey, fieldLabel, fieldValue) {
    db.prepare('INSERT OR IGNORE INTO reference_values (field_key,field_label,field_value,sort_order) SELECT ?,?,?,COALESCE(MAX(sort_order),-1)+1 FROM reference_values WHERE field_key=?').run(fieldKey, fieldLabel, fieldValue, fieldKey);
}
export function getReferenceValues(fieldKey) { return db.prepare('SELECT * FROM reference_values WHERE field_key=? ORDER BY sort_order,id').all(fieldKey); }
export function getAllReferenceFields() { return db.prepare('SELECT DISTINCT field_key,field_label FROM reference_values ORDER BY field_key').all(); }
export function updateReferenceOrder(fieldKey, orderedValues) {
    transaction(() => { const stmt = db.prepare('UPDATE reference_values SET sort_order=? WHERE field_key=? AND field_value=?'); orderedValues.forEach((value, index) => stmt.run(index, fieldKey, value)); });
}
export function rebuildReferenceValues() {
    const fields = [
        ['basicInfo.genderDesc', 'النوع'], ['basicInfo.empReligion', 'الديانة'], ['basicInfo.martStatDesc', 'الحالة الاجتماعية'],
        ['basicInfo.recruitmentTypeDesc', 'نوع التعيين'], ['basicInfo.stageName', 'المرحلة'], ['qlf.qlfName', 'المؤهل'],
        ['qlf.qlfTypeName', 'نوع المؤهل'], ['qlf.qlfEntityName', 'جهة التخرج'], ['qlf.qlfGradDesc', 'تقدير المؤهل'],
        ['job.degreeDesc', 'الدرجة الوظيفية'], ['job.jobClassDesc', 'المجموعة النوعية'], ['job.jobDesc', 'الوظيفة على الكادر'],
        ['job.subjectDesc', 'المادة/التخصص'], ['job.stageDesc', 'المرحلة الدراسية']
    ];
    transaction(() => {
        const active = new Set();
        for (const employee of getAllEmployees()) for (const [path, label] of fields) {
            const [section, prop] = path.split('.');
            const sectionData = employee.raw_data[section];
            const value = String((Array.isArray(sectionData) ? sectionData[0] : sectionData)?.[prop] ?? '').trim();
            if (value) { active.add(JSON.stringify([path, value])); addReferenceValue(path, label, value); }
        }
        const remove = db.prepare('DELETE FROM reference_values WHERE id=?');
        for (const row of db.prepare('SELECT id,field_key,field_value FROM reference_values').all()) {
            if (!active.has(JSON.stringify([row.field_key, row.field_value]))) remove.run(row.id);
        }
    });
}
export function saveTableConfig(name, columns, sorting, footer, title, { orientation = 'landscape', useArabicNumerals = false, exportFormat = 'word' } = {}) {
    return db.prepare('INSERT INTO table_configs (name,columns,sorting,footer,title,orientation,use_arabic_numerals,export_format) VALUES (?,?,?,?,?,?,?,?)')
        .run(name, JSON.stringify(columns), JSON.stringify(sorting), JSON.stringify(footer), title, orientation, useArabicNumerals ? 1 : 0, exportFormat).lastInsertRowid;
}
export function getTableConfigs() { return db.prepare('SELECT id,name,title,created_at,updated_at FROM table_configs ORDER BY id DESC').all(); }
export function getTableConfig(id) {
    const row = db.prepare('SELECT * FROM table_configs WHERE id=?').get(id);
    if (!row) return null;
    const { use_arabic_numerals, export_format, ...config } = row;
    return { ...config, columns: parseJSON(row.columns, []), sorting: parseJSON(row.sorting, []), footer: parseJSON(row.footer, []), useArabicNumerals: !!use_arabic_numerals, exportFormat: export_format };
}
export function deleteTableConfig(id) { db.prepare('DELETE FROM table_configs WHERE id=?').run(id); }
export function getLastUpdateTime() { return db.prepare('SELECT MAX(last_updated) last_updated FROM employees').get().last_updated; }
