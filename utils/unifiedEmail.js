import { DataError, getEmployee, normalizeDigits } from '../db/database.js';

// Official portal contract: /unified-emails, bundle 914.25abbe86c59a7e56.js.
// These endpoints edit the Ministry account, not the school's local employee row.
const BASE_URL = 'https://professopi.emis.gov.eg/api/EmployeeUnifiedEmails/';
const ALLOWED_FIELDS = new Set(['altEmail', 'mobile']);
const PATCH_KEYS = new Set(['field', 'value', 'previousValue', 'expectedEmpCode']);
const codeNumber = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const uncertain = () => new DataError('تعذر التأكد من نتيجة الحفظ في الوزارة. أعد جلب بيانات البريد للتأكد من القيمة الحالية قبل الحفظ مرة أخرى.', 502);

function employeeTarget(id) {
    const employee = getEmployee(id);
    if (!employee) throw new DataError('الموظف غير موجود في سجل المدرسة.', 404);
    const code = codeNumber(employee.source_emp_code);
    if (!code) throw new DataError('هذا الموظف ليس له كود وزارة محفوظ. أضف كود الموظف الصحيح من تعديل بياناته أولًا، ثم افتح بيانات البريد.', 400);
    return code;
}

function validatePatch(body) {
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !PATCH_KEYS.has(key))
        || !ALLOWED_FIELDS.has(body.field) || typeof body.value !== 'string' || typeof body.previousValue !== 'string'
        || body.previousValue.length > 1000 || !codeNumber(body.expectedEmpCode)) throw new DataError('بيانات تعديل البريد غير صحيحة.', 400);
    const value = body.field === 'mobile' ? normalizeDigits(body.value).trim() : body.value.trim();
    if (body.field === 'altEmail' && (value.length > 254 || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value))) {
        throw new DataError('اكتب بريدًا إلكترونيًا بديلًا صحيحًا مثل name@example.com.', 400);
    }
    if (body.field === 'mobile' && !/^01[0125]\d{8}$/.test(value)) throw new DataError('اكتب رقم محمول مصري صحيحًا من 11 رقمًا يبدأ بـ010 أو 011 أو 012 أو 015.', 400);
    return { ...body, value, expectedEmpCode: codeNumber(body.expectedEmpCode) };
}

function businessFailure(value) {
    return value === false || (value && typeof value === 'object' && (
        value.success === false || value.isSuccess === false || value.succeeded === false
        || value.error || (Array.isArray(value.errors) && value.errors.length > 0)
    ));
}

function shapeAccount(value, expectedCode) {
    if (value == null) throw new DataError('لم تجد الوزارة بيانات بريد لهذا الموظف ضمن جهة العمل الحالية.', 404);
    if (businessFailure(value) || Array.isArray(value) || typeof value !== 'object'
        || codeNumber(value.empCode) !== expectedCode || typeof value.empName !== 'string' || !value.empName.trim()
        || typeof value.empEmail !== 'string') throw new DataError('بيانات البريد الواردة من الوزارة غير مكتملة أو لا تخص الموظف المطلوب. أعد جلب البيانات.', 502);
    const result = { empCode: expectedCode };
    for (const key of ['empName', 'empEmail', 'jobTitle', 'altEmail', 'mobile']) {
        if (value[key] != null && (typeof value[key] !== 'string' || value[key].length > 1000)) throw new DataError('صيغة بيانات البريد الواردة من الوزارة غير صحيحة.', 502);
        result[key] = value[key] ?? '';
    }
    result.isEmailActivated = value.isEmailActivated == null ? null : value.isEmailActivated === true;
    return result;
}

function lookupScope(school, code) {
    // The official page omits these optional scope values when absent from its profile.
    const scope = { empCode: code, edaraCode: Number(school.ed), schoolCode: Number(school.sc) };
    for (const key of ['mudraiCode', 'gehaCode']) if (codeNumber(school[key])) scope[key] = Number(school[key]);
    return scope;
}

export function createUnifiedEmailService({ credentials, invalidateMinistryCredentials, fetchImpl, requestTimeout = 25000 }) {
    const writing = new Set();
    async function call(endpoint, headers, body, { mutation = false } = {}) {
        let response;
        try {
            // No automatic retry: even a timeout may mean a remote update was committed.
            response = await fetchImpl(BASE_URL + endpoint, {
                method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(requestTimeout),
            });
        } catch { throw mutation ? uncertain() : new DataError('تعذر الاتصال بخدمة البريد في الوزارة. أعد جلب البيانات بعد التأكد من الاتصال.', 502); }
        if ([401, 403].includes(response.status)) {
            invalidateMinistryCredentials();
            throw new DataError('انتهت جلسة الوزارة أو لا توجد صلاحية لتعديل بيانات البريد. جدّد تسجيل الدخول بحساب المدرسة.', 401);
        }
        if (!response.ok) throw mutation
            ? new DataError(`لم تؤكد الوزارة حفظ التغيير (رمز ${response.status}). أعد جلب بيانات البريد قبل المحاولة مرة أخرى.`, 502)
            : new DataError(`تعذر جلب بيانات البريد من الوزارة (رمز ${response.status}).`, 502);
        if (response.status === 204) return null;
        const value = await response.json().catch(() => undefined);
        if (businessFailure(value)) throw new DataError('لم تقبل الوزارة الطلب. راجع البيانات وصلاحية الحساب، ثم أعد جلب بيانات البريد.', 502);
        if (!mutation && value === undefined) throw new DataError('تعذر قراءة بيانات البريد من الوزارة. أعد جلب البيانات.', 502);
        return value;
    }
    const read = async (code, context) => shapeAccount(await call('GetEmployeeUnifiedEmailInfo', context.headers, lookupScope(context.school, code)), code);
    return {
        async get(id) {
            const code = employeeTarget(id);
            const context = await credentials();
            return read(code, context);
        },
        async update(id, body) {
            const patch = validatePatch(body);
            const code = employeeTarget(id);
            if (patch.expectedEmpCode !== code) throw new DataError('تغيّر كود الموظف منذ فتح النافذة. أعد جلب بيانات البريد قبل الحفظ.', 409);
            if (writing.has(code)) throw new DataError('يوجد حفظ جارٍ لبيانات هذا الموظف. انتظر اكتماله ثم أعد جلب البيانات.', 409);
            writing.add(code);
            try {
                const context = await credentials();
                const before = await read(code, context);
                if (before[patch.field] !== patch.previousValue) throw new DataError('تغيّرت هذه القيمة في الوزارة منذ فتح النافذة. أعد جلب البيانات قبل الحفظ.', 409);
                if (employeeTarget(id) !== code) throw new DataError('تغيّر الموظف المحلي أثناء جلب البيانات. أعد فتح بيانات البريد.', 409);
                if (before[patch.field] === patch.value) return { success: true, employee: before, message: 'القيمة محفوظة بالفعل في الوزارة.' };
                const endpoint = patch.field === 'altEmail' ? 'UpdateEmployeeAltEmail' : 'UpdateEmployeeMobile';
                await call(endpoint, context.headers, { empCode: code, [patch.field]: patch.value }, { mutation: true });
                let employee;
                try { employee = await read(code, context); }
                catch { throw uncertain(); }
                if (employee[patch.field] !== patch.value) throw uncertain();
                return { success: true, employee, message: patch.field === 'altEmail' ? 'تم حفظ البريد الإلكتروني البديل في الوزارة والتحقق منه.' : 'تم حفظ رقم المحمول في الوزارة والتحقق منه.' };
            } finally { writing.delete(code); }
        },
    };
}
