import express from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as db from '../db/database.js';
import { selectEmployees } from '../public/js/dataModel.js';
import { buildWordExport } from '../utils/exportWord.js';
import { buildHourlyModelWord } from '../utils/exportHourlyModel.js';
import { buildExcelExport, EXCEL_MIME } from '../utils/exportExcel.js';
import { convertWordToPdf, PDF_MIME } from '../utils/exportPdf.js';
import { DEFAULT_HOURLY_OPTIONS, getReportModel, normalizeHourlyOptions } from '../public/js/reportModels.js';

const bundledLogoPath = fileURLToPath(new URL('../public/assets/logo.png', import.meta.url));

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bad = message => new db.DataError(message, 400);
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
function validPath(path) {
    if (!safeText(path, 1800) || !path.trim() || /[\r\n\t]/.test(path)) return false;
    if (path.startsWith('customField:')) {
        try { const label = decodeURIComponent(path.slice(12)); return safeText(label, 150) && !!label.trim(); }
        catch { return false; }
    }
    return path.length <= 500 && !path.split('.').some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part));
}
function optionalChoice(options, key, choices) {
    if (options[key] !== undefined && !choices.includes(options[key])) throw bad('أحد اختيارات إعداد الكشف غير صحيح.');
}

/** One request contract for all formats; malformed choices never become 500s. */
export function normalizeExportOptions(input = {}) {
    if (!plainObject(input)) throw bad('إعدادات الكشف غير صحيحة.');
    const options = { ...input };
    if (options.title !== undefined && (!safeText(options.title, 120) || !options.title.trim() || /[\r\n\t]/.test(options.title))) throw bad('اكتب عنوانًا للكشف لا يزيد على ١٢٠ حرفًا.');
    optionalChoice(options, 'orientation', ['landscape', 'portrait']);
    optionalChoice(options, 'staffType', ['all', 'core', 'seconded']);
    optionalChoice(options, 'source', ['all', 'manual', 'ministry']);
    if (options.search !== undefined && !safeText(options.search, 500)) throw bad('نص البحث غير صحيح أو أطول من الحد المسموح.');
    if (options.useArabicNumerals !== undefined && typeof options.useArabicNumerals !== 'boolean') throw bad('اختيار شكل الأرقام غير صحيح.');
    const modelId = options.modelId ?? 'staff-register';
    if (typeof modelId !== 'string' || !getReportModel(modelId)) throw bad('نوع النموذج غير معروف. حدّث الصفحة واختر نموذجًا متاحًا.');
    options.modelId = modelId;
    if (options.columns !== undefined) {
        if (!Array.isArray(options.columns) || !options.columns.length || options.columns.length > 30) throw bad('اختر من عمود واحد إلى ٣٠ عمودًا لإنشاء الكشف.');
        for (const column of options.columns) {
            if (!plainObject(column)) throw bad('إعدادات أحد أعمدة الكشف غير صحيحة.');
            if (column.label !== undefined && !safeText(column.label, 180)) throw bad('عنوان أحد الأعمدة غير صحيح أو أطول من الحد المسموح.');
            if (column.type !== undefined && !['text', 'number', 'date', 'enum', 'index', 'boolean', 'merged', 'manual'].includes(column.type)) throw bad('نوع أحد الأعمدة غير صحيح.');
            if (column.width !== undefined && (!Number.isFinite(column.width) || column.width <= 0 || column.width > 200)) throw bad('عرض أحد الأعمدة غير صحيح.');
            for (const key of ['isMerged', 'isIndex']) if (column[key] !== undefined && typeof column[key] !== 'boolean') throw bad('إعدادات أحد أعمدة الكشف غير صحيحة.');
            if (column.type === 'manual') {
                if (column.isMerged || column.isIndex) throw bad('العمود اليدوي لا يمكن دمجه أو ترقيمه تلقائيًا.');
                if (column.manualValues !== undefined && (!plainObject(column.manualValues) || Object.keys(column.manualValues).length > 5000
                    || Object.entries(column.manualValues).some(([key, value]) => !/^-?[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key)) || !safeText(value, 500)))) throw bad('راجع القيم المكتوبة في العمود اليدوي.');
            } else if (column.isMerged || column.type === 'merged') {
                const fields = column.parts === undefined ? column.fields : Array.isArray(column.parts) ? column.parts.map(part => plainObject(part) ? part.path : null) : null;
                if (!Array.isArray(fields) || !fields.length || fields.length > 30 || fields.some(path => !validPath(path))) throw bad('اختر الحقول الصحيحة للعمود المدمج.');
                if (column.separator !== undefined && !safeText(column.separator, 30)) throw bad('الفاصل بين حقول العمود المدمج غير صحيح.');
            } else if (!column.isIndex && column.type !== 'index' && !validPath(column.path || column.field)) throw bad('اختر حقلًا صحيحًا لكل عمود في الكشف.');
        }
    }
    if (options.filters !== undefined) {
        if (!Array.isArray(options.filters) || options.filters.length > 50) throw bad('قواعد الفلترة غير صحيحة.');
        for (const filter of options.filters) {
            if (!plainObject(filter) || !validPath(filter.path) || !Array.isArray(filter.values) || filter.values.length > 5000
                || filter.values.some(value => !['string', 'number', 'boolean'].includes(typeof value) || !safeText(String(value), 500))
                || (filter.mode !== undefined && !['include', 'exclude'].includes(filter.mode))) throw bad('راجع حقول وقيم قواعد الفلترة.');
        }
    }
    if (options.sorting !== undefined) {
        if (!Array.isArray(options.sorting) || options.sorting.length > 50) throw bad('قواعد الترتيب غير صحيحة.');
        for (const rule of options.sorting) {
            if (!plainObject(rule) || !validPath(rule.path || rule.field) || (rule.direction !== undefined && !['asc', 'desc', 'custom'].includes(rule.direction))
                || (rule.type !== undefined && !['text', 'number', 'date', 'enum', 'boolean'].includes(rule.type))
                || (rule.customOrder !== undefined && (!Array.isArray(rule.customOrder) || rule.customOrder.length > 5000 || rule.customOrder.some(value => !safeText(value, 500))))) throw bad('راجع حقول واتجاه قواعد الترتيب.');
        }
    }
    if (options.footer !== undefined) {
        const values = Array.isArray(options.footer) ? options.footer : plainObject(options.footer) ? [options.footer.stats, options.footer.review, options.footer.principal] : null;
        if (!values || values.length > 9 || values.some(value => value != null && (plainObject(value)
            ? Object.keys(value).some(key => !['label', 'name'].includes(key)) || !safeText(value.label, 120) || !safeText(value.name ?? '', 180)
            : !safeText(value, 180)))) throw bad('راجع مسميات وأسماء التوقيعات. الحد الأقصى ٩ توقيعات.');
    }
    if (modelId === 'hourly-contract-period-1') {
        if (options.modelOptions !== undefined && !plainObject(options.modelOptions)) throw bad('إعدادات نموذج الحصة غير صحيحة.');
        try { options.modelOptions = normalizeHourlyOptions({ ...DEFAULT_HOURLY_OPTIONS, ...options.modelOptions }); }
        catch (error) { throw bad(error.message || 'إعدادات نموذج الحصة غير صحيحة.'); }
    }
    return options;
}

function resolveExport(input) {
    const options = normalizeExportOptions(input);
    // Resolve list membership from the saved list, never from client-supplied IDs.
    delete options.memberIds;
    if (options.listId !== undefined && options.listId !== null) {
        const list = db.getCustomList(options.listId);
        if (!list) throw new db.DataError('القائمة المختارة لم تعد موجودة. حدّث الصفحة واختر قائمة أخرى.', 404);
        options.memberIds = list.memberIds;
    }
    const savedLogoPath = join(dirname(db.getDatabasePath()), 'assets', 'logo.png');
    // Use the exact selector used by the preview, including search and local records.
    const employees = selectEmployees(db.getAllEmployees(), options);
    const context = {
        schoolInfo: db.getSetting('schoolInfo') || {},
        logoPath: existsSync(savedLogoPath) ? savedLogoPath : bundledLogoPath,
    };
    return { options, employees, context };
}

function downloadExport(format, pdfConverter = convertWordToPdf) {
    return async (req, res) => {
      try {
        const { options, employees, context } = resolveExport(req.body === undefined ? {} : req.body);
        let buffer = format === 'excel' ? await buildExcelExport(employees, options, context)
            : options.modelId === 'hourly-contract-period-1'
                ? await buildHourlyModelWord(employees, options.modelOptions, context)
                : await buildWordExport(employees, options, context);
        if (format === 'pdf') buffer = await pdfConverter(buffer);
        const title = options.modelId === 'hourly-contract-period-1'
            ? 'نموذج 2 بالحصة دون سن الستين - الفترة الأولى'
            : String(options.title || 'أسماء العاملين بالمدرسة').slice(0, 120);
        const extension = format === 'excel' ? 'xlsx' : format === 'pdf' ? 'pdf' : 'docx';
        const filename = `${title.replace(/[\r\n\\/"\u0000-\u001f]/g, '').trim() || 'employees'}.${extension}`;
        res.setHeader('Content-Type', format === 'excel' ? EXCEL_MIME : format === 'pdf' ? PDF_MIME : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="employees.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(buffer);
      } catch (error) {
        const label = format === 'excel' ? 'Excel' : format === 'pdf' ? 'PDF' : 'Word';
        if (!error.status || error.status >= 500) console.error(`${label} export failed:`, error.message);
        res.status(error.status || 500).json({ error: (error.status >= 400 && error.status < 500) || error.expose === true ? error.message : `تعذّر إنشاء ملف ${label}. راجع إعدادات الكشف وحاول مرة أخرى.` });
      }
    };
}

export function createExportRouter({ pdfConverter = convertWordToPdf } = {}) {
    const router = express.Router();
    router.post('/export/word', downloadExport('word'));
    router.post('/export/excel', downloadExport('excel'));
    router.post('/export/pdf', downloadExport('pdf', pdfConverter));
    return router;
}

export default createExportRouter();
