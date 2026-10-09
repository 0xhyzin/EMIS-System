import express from 'express';
import * as db from '../db/database.js';
import { createUnifiedEmailService } from '../utils/unifiedEmail.js';
import { DEFAULT_HOURLY_OPTIONS, getReportModel, normalizeHourlyOptions } from '../public/js/reportModels.js';

const MINISTRY_API = 'https://professopi.emis.gov.eg/api/Employee/';
const numericId = value => /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) !== 0;
const ministryCode = value => db.normalizeDigits(value).replace(/\s/g, '').replace(/^0+(?=\d)/, '');
const ministryFailure = value => !value || value.success === false || value.isSuccess === false || value.succeeded === false
    || value.error || (Array.isArray(value.errors) && value.errors.length > 0);
const messageForStatus = status => status === 401 || status === 403
    ? 'انتهت جلسة الوزارة أو لا توجد صلاحية للوصول. أعد تسجيل الدخول ثم حاول مرة أخرى.'
    : `تعذر الاتصال بخدمة الوزارة (رمز ${status}).`;
function errorResponse(res, error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: status < 500 ? error.message : 'تعذر إتمام العملية. حاول مرة أخرى.' });
}
function schoolInfo() { return db.getSetting('schoolInfo') || {}; }

export function createApiRouter({ getMinistryCredentials, invalidateMinistryCredentials = () => {}, fetchImpl = (...args) => fetch(...args), requestTimeout = 25000 } = {}) {
    const router = express.Router();
    let syncActive = false;
    async function credentials() {
        if (!getMinistryCredentials) throw new db.DataError('سجّل الدخول إلى حساب الوزارة أولًا.', 401);
        const result = await getMinistryCredentials();
        const info = result?.schoolInfo;
        if (!result?.bearerToken || !result?.utToken || !info || info.sc == null || info.ed == null || info.ty == null) throw new db.DataError('جلسة الوزارة غير مكتملة. افتح تسجيل الدخول واختر المدرسة أولًا.', 401);
        const savedSchool = schoolInfo();
        if (['sc', 'ed'].some(key => savedSchool[key] != null && ministryCode(savedSchool[key]) !== ministryCode(info[key])) && db.getEmployeeCount().total > 0) throw new db.DataError('الحساب الحالي يتبع مدرسة مختلفة عن قاعدة البيانات. اختر المدرسة الأصلية في موقع الوزارة لحماية بيانات العاملين.', 409);
        db.saveSetting('schoolInfo', { ...savedSchool, ...info, schoolName: savedSchool.schoolName || info.schoolName || '', edaraName: savedSchool.edaraName || info.edaraName || '', mudriaName: savedSchool.mudriaName || info.mudriaName || '' });
        return {
            school: info,
            headers: {
                Authorization: `Bearer ${result.bearerToken.replace(/^Bearer\s+/i, '').trim()}`,
                Ut: result.utToken, Ty: String(info.ty), Sc: String(info.sc), Ed: String(info.ed), Md: '0',
                'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
                Origin: 'https://teacher.emis.gov.eg', Referer: 'https://teacher.emis.gov.eg/'
            }
        };
    }
    async function ministryRequest(path, headers, body, signal) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetchImpl(MINISTRY_API + path, {
                    method: body === undefined ? 'GET' : 'POST', headers,
                    redirect: 'error',
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout)
                });
                if (!response.ok) {
                    if ([401, 403].includes(response.status)) invalidateMinistryCredentials();
                    if (attempt === 0 && (response.status >= 500 || [408, 429].includes(response.status))) { await response.body?.cancel(); continue; }
                    const error = new db.DataError(messageForStatus(response.status), [401, 403].includes(response.status) ? 401 : 502);
                    throw error;
                }
                return response;
            } catch (error) {
                if (signal?.aborted) throw new db.DataError('توقفت المزامنة بعد إغلاق الاتصال. لم تتغير بيانات العاملين السابقة.', 499);
                if (error instanceof db.DataError) throw error;
                if (attempt === 0) continue;
                throw new db.DataError(error.name === 'TimeoutError' ? 'انتهت مهلة استجابة الوزارة. حاول مرة أخرى لاحقًا.' : 'تعذر الاتصال بالوزارة. تحقق من اتصال الإنترنت وحاول مرة أخرى.', 502);
            }
        }
    }
    async function fetchList(path, headers, body, signal) {
        const collected = [];
        const seenPages = new Set();
        for (let page = 0; page < 100; page++) {
            const response = await ministryRequest(path, headers, { draw: page + 1, columns: [], order: [], start: collected.length, length: 500, search: { value: '', regex: false }, ...body }, signal);
            const payload = await response.json().catch(() => null);
            if (ministryFailure(payload) || !Array.isArray(payload.data) || payload.data.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new db.DataError('استجابة قائمة العاملين من الوزارة غير صحيحة. لم تُحذف بياناتك السابقة.', 502);
            const signature = JSON.stringify(payload.data.map(item => item.empCode));
            if (payload.data.length && seenPages.has(signature)) throw new db.DataError('خدمة الوزارة أعادت الصفحة نفسها. أعد المحاولة لاحقًا.', 502);
            seenPages.add(signature);
            collected.push(...payload.data);
            const count = payload.recordsFiltered ?? payload.recordsTotal;
            const declared = count == null || String(count).trim() === '' ? NaN : Number(count);
            const hasTotal = Number.isSafeInteger(declared) && declared >= 0;
            if (!payload.data.length && hasTotal && collected.length < declared) throw new db.DataError('قائمة العاملين من الوزارة غير مكتملة. أعد المحاولة لاحقًا؛ بياناتك السابقة محفوظة.', 502);
            if (!payload.data.length || (hasTotal ? collected.length >= declared : payload.data.length < 500)) return collected;
        }
        throw new db.DataError('قائمة الوزارة تجاوزت الحد المتوقع. لم تُحذف البيانات السابقة.', 502);
    }

    router.get('/school-info', (req, res) => res.json(schoolInfo()));
    router.put('/school-info', (req, res) => {
        try {
            const update = {};
            for (const field of ['schoolName', 'edaraName', 'mudriaName']) {
                if (field in (req.body || {})) {
                    if (typeof req.body[field] !== 'string' || req.body[field].trim().length > 200) throw new db.DataError('بيانات المدرسة غير صحيحة.');
                    update[field] = req.body[field].trim();
                }
            }
            const value = { ...schoolInfo(), ...update };
            db.saveSetting('schoolInfo', value);
            res.json({ success: true, schoolInfo: value });
        } catch (error) { errorResponse(res, error); }
    });

    const syncHandler = async (req, res) => {
        const mode = (req.method === 'POST' ? req.body?.mode : undefined) ?? req.query?.mode ?? 'normal';
        if (!['normal', 'full'].includes(mode)) return res.status(400).json({ error: 'اختر المزامنة العادية أو المزامنة الكاملة.' });
        if (mode === 'full' && (req.method !== 'POST' || req.body?.mode !== 'full' || req.body?.confirmReset !== true)) {
            return res.status(400).json({ error: 'المزامنة الكاملة تحذف كل الموظفين والإضافات والتعديلات اليدوية. يلزم تأكيد الحذف قبل البدء.' });
        }
        if (syncActive) return res.status(409).json({ error: 'توجد مزامنة قيد التنفيذ بالفعل. انتظر اكتمالها.' });
        syncActive = true;
        const controller = new AbortController();
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const emit = data => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        let saved = 0, failed = 0, committed = false;
        let change = { added: 0, updated: 0, skipped: 0, removed: 0, protectedManual: 0, protectedEdited: 0, retained: 0 };
        const failedEmployees = [];
        try {
            const { school, headers } = await credentials();
            emit({ step: 'fetching_list', mode, message: 'جاري جلب قائمة القوة الأساسية…' });
            const core = await fetchList('GetEmployeeByEmpFlag', headers, { empFlagCode: 1, EdaraCode: Number(school.ed), schoolCode: Number(school.sc) }, controller.signal);
            emit({ step: 'fetching_list_seconded', mode, message: 'جاري جلب قائمة المنتدبين…' });
            const seconded = await fetchList('EmployeesNadb', headers, { userType: 4, GehaCode: Number(school.sc) }, controller.signal);
            const employees = new Map();
            for (const item of core) employees.set(ministryCode(item.empCode), { ...item, empCode: ministryCode(item.empCode), _staffType: 'core' });
            for (const item of seconded) employees.set(ministryCode(item.empCode), { ...item, empCode: ministryCode(item.empCode), _staffType: 'seconded' });
            const all = [...employees.values()];
            const snapshot = [];
            let current = 0;
            for (const item of all) {
                if (controller.signal.aborted) throw new db.DataError('توقفت المزامنة. لم تتغير بيانات العاملين السابقة.', 499);
                current++;
                emit({ step: 'fetching_details', mode, current, total: all.length, fetched: snapshot.length, saved, failed, message: `جاري جلب بيانات الموظف ${current} من ${all.length}…` });
                try {
                    if (!numericId(item.empCode) || Number(item.empCode) <= 0) throw new db.DataError('كود موظف غير صالح من الوزارة.', 502);
                    const response = await ministryRequest('GetEmployeeFullData', headers, { empCode: Number(item.empCode) }, controller.signal);
                    const full = await response.json().catch(() => null);
                    const basic = full?.basicInfo;
                    const name = basic && [basic.empFirstName, basic.empFatherName, basic.empGrandFatherName, basic.empFamilyName].filter(Boolean).join(' ').trim();
                    if (ministryFailure(full) || !basic || typeof basic !== 'object' || Array.isArray(basic) || !name) throw new db.DataError('بيانات الموظف غير مكتملة من الوزارة.', 502);
                    if (basic.empCode != null && ministryCode(basic.empCode) !== ministryCode(item.empCode)) throw new db.DataError('بيانات الموظف لا تتطابق مع القائمة.', 502);
                    if (item._staffType === 'seconded') full.secondment = Object.fromEntries(['empFlag', 'fromMudriaName', 'fromEdaraName', 'fromGehaName', 'toMudriaName', 'toEdaraName', 'toGehaName', 'jobName'].map(key => [key, item[key] || '']));
                    snapshot.push({ empCode: item.empCode, nationalId: basic.nationalIdNum || '', fullName: name, rawData: full, staffType: item._staffType });
                } catch (error) {
                    failed++;
                    const failure = {
                        empCode: numericId(item.empCode) && Number(item.empCode) > 0 ? String(item.empCode) : null,
                        reason: error instanceof db.DataError ? error.message : 'تعذر قراءة بيانات الموظف من استجابة الوزارة.'
                    };
                    failedEmployees.push(failure);
                    if (error.status === 401 || controller.signal.aborted) throw error;
                    emit({ step: 'warning', mode, current, total: all.length, failed, failedEmployee: failure, message: `تعذر جلب بيانات الموظف${failure.empCode ? ` صاحب الكود ${failure.empCode}` : ''}: ${failure.reason} ${mode === 'full' ? 'ستستمر المزامنة بباقي الموظفين؛ عند حفظ النتائج لن يُحتفظ بسجله القديم.' : 'بياناته السابقة ستظل محفوظة، إن وُجدت.'}` });
                }
            }
            if (controller.signal.aborted) throw new db.DataError('توقفت المزامنة. لم تتغير بيانات العاملين السابقة.', 499);
            if (all.length && !snapshot.length) throw new db.DataError('تعذر جلب بيانات جميع العاملين. لم تتغير أي بيانات سابقة؛ راجع أسباب التعذر ثم أعد المحاولة لاحقًا.', 502);
            change = db.synchronizeEmployees(snapshot, { mode });
            saved = change.saved;
            committed = true;
            const result = { ...change, mode, at: new Date().toISOString(), saved, failed, failedEmployees, total: all.length, partial: failed > 0, replaced: mode === 'full' };
            db.saveSetting('lastSync', result);
            try { db.rebuildReferenceValues(); }
            catch { emit({ step: 'warning', message: 'تم حفظ البيانات الجديدة. تعذر تحديث بعض اختيارات الفلترة؛ أعد تحميل الصفحة.' }); }
            const message = mode === 'full'
                ? `اكتملت المزامنة الكاملة${failed ? ' جزئيًا' : ''}: حُذفت السجلات السابقة بما فيها الإضافات والتعديلات اليدوية، وتم تحميل ${saved} موظف من الوزارة${change.skipped ? ` وتجاهل ${change.skipped} سجل مكرر` : ''}.${failed ? ` تعذر جلب ${failed} موظف ولم يُحتفظ بسجلاتهم القديمة؛ أسباب التعذر موضحة أدناه. يمكنك إعادة المحاولة بالمزامنة العادية لإضافتهم عند نجاح الجلب.` : ''}`
                : `اكتملت المزامنة العادية: أُضيف ${change.added} موظف وحُدث ${change.updated}. احتُفظ بـ${change.protectedManual} إضافة يدوية و${change.protectedEdited} سجل معدل يدويًا.${failed ? ` تعذر جلب ${failed} موظف؛ بياناتهم السابقة محفوظة، إن وُجدت، وأسباب التعذر موضحة أدناه.` : ''}`;
            emit({ step: 'done', ...result, totalEmployees: db.getEmployeeCount().total, message });
        } catch (error) {
            if (!committed) {
                const retained = db.getAllEmployees();
                change = { ...change, retained: retained.length, protectedManual: retained.filter(employee => employee.source === 'manual').length, protectedEdited: retained.filter(employee => employee.source !== 'manual' && employee.has_local_changes).length };
            }
            emit({ step: 'error', ...change, mode, saved, failed, failedEmployees, committed, aborted: !committed, message: error instanceof db.DataError || error.statusCode ? error.message : committed ? 'حُفظت بيانات الوزارة الجديدة، لكن تعذر إكمال تحديث معلومات المزامنة.' : 'تعذر إتمام المزامنة. لم تتغير بيانات العاملين السابقة.' });
        } finally {
            clearInterval(heartbeat);
            syncActive = false;
            if (!res.writableEnded) res.end();
        }
    };
    // Same-origin and access middleware also guard EventSource GET requests.
    router.get('/sync/start', syncHandler);
    router.post('/sync/start', syncHandler);

    router.get('/employees', (req, res) => {
        try {
            let employees = db.getAllEmployees(req.query.staffType);
            if (req.query.listId !== undefined) {
                const list = db.getCustomList(req.query.listId);
                if (!list) throw new db.DataError('القائمة غير موجودة.', 404);
                const memberIds = new Set(list.memberIds);
                employees = employees.filter(employee => memberIds.has(employee.emp_code));
            }
            if (typeof req.query.fields === 'string') {
                const fields = req.query.fields.split(',');
                return res.json(employees.map(emp => Object.fromEntries([['empCode', emp.emp_code], ['fullName', emp.full_name], ['nationalId', emp.national_id]].filter(([key]) => fields.includes(key)))));
            }
            res.json(employees);
        } catch (error) { errorResponse(res, error); }
    });
    router.get('/employees/count', (req, res) => res.json(db.getEmployeeCount()));
    router.param('empCode', (req, res, next, value) => numericId(value) ? next() : res.status(400).json({ error: 'معرّف الموظف غير صحيح.' }));
    const unifiedEmail = createUnifiedEmailService({ credentials, invalidateMinistryCredentials, fetchImpl, requestTimeout });
    // Reuse the exact same authenticated, school-scoped service from the assistant.
    // Its update method re-reads the old value before any ministry mutation.
    router.unifiedEmailService = unifiedEmail;
    const emailError = (res, error) => {
        const known = error instanceof db.DataError || Number.isInteger(error.statusCode);
        const status = known ? (error.status || error.statusCode) : 500;
        res.status(status >= 400 && status < 600 ? status : 500).json({ error: known ? error.message : 'تعذر إكمال عملية البريد. أعد جلب بيانات البريد قبل المحاولة مرة أخرى.' });
    };
    router.get('/employees/:empCode/unified-email', async (req, res) => {
        try { res.json({ employee: await unifiedEmail.get(req.params.empCode) }); }
        catch (error) { emailError(res, error); }
    });
    router.patch('/employees/:empCode/unified-email', async (req, res) => {
        try { res.json(await unifiedEmail.update(req.params.empCode, req.body)); }
        catch (error) { emailError(res, error); }
    });
    router.get('/employees/:empCode', (req, res) => {
        const employee = db.getEmployee(req.params.empCode);
        if (!employee) return res.status(404).json({ error: 'الموظف غير موجود.' });
        res.json(employee);
    });
    router.post('/employees', (req, res) => {
        try { const employee = db.createEmployee(req.body); db.rebuildReferenceValues(); res.status(201).json({ success: true, employee }); }
        catch (error) { errorResponse(res, error); }
    });
    router.put('/employees/:empCode', (req, res) => {
        try { const employee = db.updateEmployee(req.params.empCode, req.body); db.rebuildReferenceValues(); res.json({ success: true, employee }); }
        catch (error) { errorResponse(res, error); }
    });
    router.delete('/employees/:empCode', (req, res) => {
        try { db.deleteEmployee(req.params.empCode); db.rebuildReferenceValues(); res.json({ success: true }); }
        catch (error) { errorResponse(res, error); }
    });
    router.get('/custom-lists', (req, res) => {
        try { res.json(db.getCustomLists()); } catch (error) { errorResponse(res, error); }
    });
    router.get('/custom-lists/:listId', (req, res) => {
        try {
            const list = db.getCustomList(req.params.listId);
            if (!list) throw new db.DataError('القائمة غير موجودة.', 404);
            res.json(list);
        } catch (error) { errorResponse(res, error); }
    });
    router.post('/custom-lists', (req, res) => {
        try { res.status(201).json({ success: true, list: db.createCustomList(req.body) }); }
        catch (error) { errorResponse(res, error); }
    });
    router.put('/custom-lists/:listId', (req, res) => {
        try { res.json({ success: true, list: db.updateCustomList(req.params.listId, req.body) }); }
        catch (error) { errorResponse(res, error); }
    });
    router.delete('/custom-lists/:listId', (req, res) => {
        try { db.deleteCustomList(req.params.listId); res.json({ success: true }); }
        catch (error) { errorResponse(res, error); }
    });
    router.get('/reference', (req, res) => res.json(db.getAllReferenceFields().map(field => ({ key: field.field_key, label: field.field_label, values: db.getReferenceValues(field.field_key) }))));
    router.get('/reference/:fieldKey', (req, res) => res.json(db.getReferenceValues(req.params.fieldKey)));
    router.put('/reference/:fieldKey/order', (req, res) => {
        try {
            const values = req.body?.values;
            if (!Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== 'string' || value.length > 500)) throw new db.DataError('قيم الترتيب غير صحيحة.');
            db.updateReferenceOrder(req.params.fieldKey, values);
            res.json({ success: true });
        } catch (error) { errorResponse(res, error); }
    });
    const hourlySettingsKey = 'reportModel.hourly-contract-period-1.settings';
    const hourlySettingsModel = id => getReportModel(id)?.kind === 'hourly-contract';
    router.get('/report-models/:modelId/settings', (req, res) => {
        try {
            if (!hourlySettingsModel(req.params.modelId)) throw new db.DataError('النموذج غير موجود.', 404);
            const saved = db.getSetting(hourlySettingsKey);
            res.json(normalizeHourlyOptions(saved || DEFAULT_HOURLY_OPTIONS));
        } catch (error) { errorResponse(res, error); }
    });
    router.put('/report-models/:modelId/settings', (req, res) => {
        try {
            if (!hourlySettingsModel(req.params.modelId)) throw new db.DataError('النموذج غير موجود.', 404);
            let settings;
            try { settings = normalizeHourlyOptions(req.body); }
            catch (error) { throw new db.DataError(error.message); }
            db.saveSetting(hourlySettingsKey, settings);
            res.json(settings);
        } catch (error) { errorResponse(res, error); }
    });
    router.post('/table-config', (req, res) => {
        try {
            const { name, columns, sorting = [], footer = [], title = '', orientation = 'landscape', useArabicNumerals = false, exportFormat = 'word' } = req.body || {};
            if (typeof name !== 'string' || !name.trim() || name.length > 150 || !Array.isArray(columns) || !columns.length || columns.length > 50 || !Array.isArray(sorting) || sorting.length > 50 || typeof title !== 'string' || title.length > 300) throw new db.DataError('راجع اسم القالب والأعمدة المحددة.');
            if (!['landscape', 'portrait'].includes(orientation) || typeof useArabicNumerals !== 'boolean' || !['word', 'excel', 'pdf'].includes(exportFormat)) throw new db.DataError('راجع اتجاه الصفحة وصيغة التصدير ونوع الأرقام.');
            const id = db.saveTableConfig(name.trim(), columns, sorting, footer, title, { orientation, useArabicNumerals, exportFormat });
            res.status(201).json({ success: true, id: Number(id) });
        } catch (error) { errorResponse(res, error); }
    });
    router.get('/table-config', (req, res) => res.json(db.getTableConfigs()));
    router.get('/table-config/:id', (req, res) => {
        const config = db.getTableConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'القالب غير موجود.' });
        res.json(config);
    });
    router.delete('/table-config/:id', (req, res) => { db.deleteTableConfig(req.params.id); res.json({ success: true }); });
    router.get('/certificate/:empCode', async (req, res) => {
        try {
            const employee = db.getEmployee(req.params.empCode);
            if (!employee) throw new db.DataError('الموظف غير موجود.', 404);
            if (employee.source === 'manual') throw new db.DataError('صحيفة الأحوال متاحة لموظفي الوزارة فقط.');
            const { headers } = await credentials();
            const response = await ministryRequest(`CRevisionNew01?EmpCode=${encodeURIComponent(req.params.empCode)}`, headers);
            const type = response.headers.get('content-type') || 'application/octet-stream';
            const name = `${employee.full_name}_صحيفة_${new Date().toISOString().slice(0, 10)}`;
            if (type.includes('application/json')) return res.json({ data: await response.json(), fileName: name });
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + (type.includes('pdf') ? '.pdf' : '.xlsx'))}`);
            res.setHeader('Content-Type', type);
            res.send(Buffer.from(await response.arrayBuffer()));
        } catch (error) { errorResponse(res, error); }
    });
    return router;
}
export default createApiRouter();
