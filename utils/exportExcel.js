import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { columnText, DEFAULT_COLUMNS, getValue, westernDigits } from '../public/js/dataModel.js';
import { DEFAULT_HOURLY_OPTIONS, hourlyEmployeeKey, hourlyRow, normalizeHourlyOptions } from '../public/js/reportModels.js';
import { normalizeSignatures } from '../public/js/reportLayout.js';

export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FONT = 'Arial';
const DATE_FORMAT = 'dd/mm/yyyy';
const GRID = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, { style: 'thin', color: { argb: 'FF888888' } }]));
const HOURLY_HEADINGS = ['م', 'اسم المدرسة', 'اسم المعلم', 'الرقم القومي', 'المؤهل', 'التخصص', 'المادة التعليمية', 'الحصص الفعلية شهريا', 'المبلغ', 'الجهة المحول عليها أمر الدفع ( البريد - البنك )'];
const HOURLY_WIDTHS = [4, 20, 22, 20, 23, 12, 13, 13, 12, 24];
const HOURLY_SIGNATURES = ['مسئول شئون العاملين', 'مدير المدرسة', 'موجه المادة - موجه أول المادة', 'الموجه المالي والإداري', 'مدير الإدارة التعليمية'];
const bad = message => Object.assign(new Error(message), { status: 400 });

function workbook(title) {
    const book = new ExcelJS.Workbook();
    book.creator = 'سجل المدرسة';
    book.title = title;
    book.subject = title;
    book.description = 'كشف عربي قابل للتعديل';
    return book;
}

function worksheet(book, name, columnWidths, options = {}, headerRow = 7) {
    const sheet = book.addWorksheet(name, {
        views: [{ rightToLeft: true, state: 'frozen', ySplit: headerRow, activeCell: `A${headerRow + 1}`, showGridLines: false }],
        pageSetup: {
            paperSize: 9, orientation: options.orientation === 'portrait' ? 'portrait' : 'landscape',
            fitToPage: true, fitToWidth: 1, fitToHeight: 0,
            margins: { left: 0.3, right: 0.3, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 },
            horizontalCentered: true,
        },
        properties: { defaultRowHeight: 24 },
    });
    sheet.columns = columnWidths.map(width => ({ width }));
    return sheet;
}

function textCell(sheet, row, column, value, { bold = false, size = 11, align = 'right', grid = false, header = false } = {}) {
    const cell = sheet.getCell(row, column);
    // A string assigned to an XLSX cell is literal text, including =,+,-,@.
    // Never construct a formula or hyperlink object from employee data.
    cell.value = value == null ? '' : String(value);
    cell.numFmt = '@';
    cell.font = { name: FONT, size, bold, color: { argb: 'FF000000' } };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true, readingOrder: 2 };
    if (grid) cell.border = GRID;
    if (header) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    return cell;
}

function mergedText(sheet, row, start, end, value, options = {}) {
    if (end > start) sheet.mergeCells(row, start, row, end);
    return textCell(sheet, row, start, value, options);
}

function prefixed(value, prefix, suffix = '') {
    const text = String(value ?? '').trim();
    return text ? text.startsWith(prefix) ? text : `${prefix} ${text}${suffix}` : '';
}

function addLogo(book, sheet, logoPath, split, count) {
    if (!logoPath || count < 3 || !existsSync(logoPath)) return;
    const data = readFileSync(logoPath);
    const png = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = data.length >= 4 && data[0] === 0xff && data[1] === 0xd8;
    if (!png && !jpeg) return;
    let width = 80, height = 55;
    if (png) {
        const ratio = Math.min(90 / Math.max(1, data.readUInt32BE(16)), 55 / Math.max(1, data.readUInt32BE(20)));
        width = data.readUInt32BE(16) * ratio;
        height = data.readUInt32BE(20) * ratio;
    }
    const imageId = book.addImage({ buffer: data, extension: png ? 'png' : 'jpeg' });
    sheet.addImage(imageId, { tl: { col: split, row: 0.15 }, ext: { width, height }, editAs: 'oneCell' });
}

function registerHeader(book, sheet, title, school, logoPath, count) {
    const split = Math.max(1, Math.ceil(count * 0.7));
    [prefixed(school.mudriaName || school.orgMudriaName, 'محافظة'), prefixed(school.edaraName, 'إدارة', ' التعليمية'), prefixed(school.schoolName, 'مدرسة')]
        .forEach((line, index) => {
            mergedText(sheet, index + 1, 1, split, line, { bold: true });
            sheet.getRow(index + 1).height = fittedHeight([line], [spanWidth(sheet, 1, split)], 20);
        });
    addLogo(book, sheet, logoPath, split, count);
    for (let column = 1; column <= count; column++) sheet.getCell(4, column).border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
    sheet.getRow(4).height = 7;
    mergedText(sheet, 5, 1, count, title, { size: 17, bold: true, align: 'center' });
    sheet.getRow(5).height = fittedHeight([title], [spanWidth(sheet, 1, count)], 30, 17);
    sheet.getRow(6).height = 8;
}

function columnPaths(column) {
    return column.parts?.map(part => part.path) || column.fields || [column.path || column.field || ''];
}

function columnWidth(column) {
    if (Number.isFinite(column.width) && column.width > 0) return Math.max(5, Math.min(60, column.width * 1.7));
    if (column.isIndex || column.type === 'index' || column.path === 'index') return 5;
    const paths = columnPaths(column).join(' ');
    if (/fullName|empFirstName|addressDesc|notes/.test(paths)) return 28;
    if (/nationalId|empMobile|passport|empCode/i.test(paths)) return 20;
    if (column.type === 'date' || /date/i.test(paths)) return column.isMerged || column.type === 'merged' ? 28 : 16;
    return 22;
}

function registerWidths(columns) {
    const widths = columns.map(columnWidth);
    // A one/two-column custom table still has a school header and report title.
    // Give it enough physical width for these, preserving relative column sizes.
    const minimum = columns.length === 1 ? 48 : columns.length === 2 ? 64 : 0;
    const total = widths.reduce((sum, width) => sum + width, 0);
    return total < minimum ? widths.map(width => width * minimum / total) : widths;
}

function spanWidth(sheet, start, end) {
    let width = 0;
    for (let column = start; column <= end; column++) width += sheet.getColumn(column).width;
    return width;
}

// Parse dates without timezone conversion or JavaScript's silent rollover of
// impossible dates. A source timestamp represents its stated calendar day.
function calendarDate(value) {
    const text = westernDigits(value).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(text);
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (!iso && !dmy) return null;
    const [year, month, day] = iso ? [iso[1], iso[2], iso[3]].map(Number) : [dmy[3], dmy[2], dmy[1]].map(Number);
    if (year < 1900 || year > 9999) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function employeeCell(sheet, row, col, employee, column, index, options) {
    const text = columnText(employee, column, index, options);
    const cell = textCell(sheet, row, col, text, { grid: true });
    const path = column.path || column.field || '';
    if (column.isMerged || column.type === 'merged' || column.type === 'manual') return text;
    if (column.isIndex || column.type === 'index' || path === 'index') {
        if (!options.useArabicNumerals) { cell.value = index + 1; cell.numFmt = '0'; }
        cell.alignment.horizontal = 'center';
        return text;
    }
    const identifier = /id|code|num(?:ber)?|mobile|phone|tel|passport/i.test(path);
    if (identifier) {
        cell.alignment.horizontal = 'center';
        cell.alignment.readingOrder = 1;
        return text;
    }
    // XLSX numeric/date cells let the spreadsheet app choose digit shapes.
    // Keep the preview's Arabic text when that display style was selected.
    if (options.useArabicNumerals) {
        if (column.type === 'date' || column.type === 'number' || /date$/i.test(path)) {
            cell.alignment.horizontal = 'center';
            cell.alignment.readingOrder = 1;
        }
        return text;
    }
    if (column.type === 'date' || /date$/i.test(path)) {
        const date = calendarDate(getValue(employee, path));
        if (date) { cell.value = date; cell.numFmt = DATE_FORMAT; }
        cell.alignment.horizontal = 'center';
        cell.alignment.readingOrder = 1;
    } else if (column.type === 'number') {
        const number = westernDigits(text).replaceAll('٫', '.');
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(number) && Number.isFinite(Number(number))) {
            cell.value = Number(number);
            cell.numFmt = '#,##0.########';
            cell.alignment.horizontal = 'center';
            cell.alignment.readingOrder = 1;
        }
    }
    return text;
}

function fittedHeight(values, widths, min = 26, size = 11) {
    const fontWidth = size > 11 ? 11 / size : 1;
    const lines = Math.max(1, ...values.map((value, index) => String(value ?? '').split('\n').reduce((total, line) =>
        total + Math.max(1, Math.ceil(line.length / Math.max(4, widths[index] * 0.8 * fontWidth))), 0)));
    return Math.min(409, Math.max(min, lines * (size + 5) + 8));
}

function registerSignatures(sheet, row, count, footer) {
    const signatures = normalizeSignatures(footer);
    const perRow = Math.min(3, count);
    for (let offset = 0; offset < signatures.length; offset += perRow) {
        const texts = [], widths = [];
        const signatureRow = row + Math.floor(offset / perRow);
        signatures.slice(offset, offset + perRow).forEach(({ label, name }, index) => {
            const start = Math.floor(index * count / perRow) + 1;
            const end = Math.floor((index + 1) * count / perRow);
            const text = `${label}\n${name}`;
            texts.push(text); widths.push(spanWidth(sheet, start, end));
            mergedText(sheet, signatureRow, start, end, text, { bold: true, align: 'center' });
        });
        sheet.getRow(signatureRow).height = fittedHeight(texts, widths, 42);
    }
    return row + Math.max(0, Math.ceil(signatures.length / perRow) - 1);
}

/** Use the preview's selected columns and formatting, without changing data. */
export async function buildExcelExport(employees, options = {}, context = {}) {
    if (options.modelId === 'hourly-contract-period-1') return buildHourlyModelExcel(employees, options.modelOptions, context);
    if (!Array.isArray(employees)) throw bad('بيانات الكشف غير صحيحة.');
    const columns = options.columns === undefined ? DEFAULT_COLUMNS : options.columns;
    if (!Array.isArray(columns) || !columns.length || columns.length > 30 || columns.some(column => !column || typeof column !== 'object' || Array.isArray(column))) {
        throw bad('اختر من عمود واحد إلى ٣٠ عمودًا لإنشاء الكشف.');
    }
    const title = String(options.title || 'أسماء العاملين بالمدرسة').trim();
    const book = workbook(title);
    const widths = registerWidths(columns);
    const sheet = worksheet(book, 'كشف العاملين', widths, options);
    registerHeader(book, sheet, title, context.schoolInfo || {}, context.logoPath, columns.length);
    columns.forEach((column, index) => textCell(sheet, 7, index + 1, column.label || column.path || column.field || '', { bold: true, align: 'center', grid: true, header: true }));
    sheet.getRow(7).height = fittedHeight(columns.map(column => column.label || column.path || column.field || ''), widths, 32);
    employees.forEach((employee, index) => {
        const values = columns.map((column, col) => employeeCell(sheet, index + 8, col + 1, employee, column, index, options));
        sheet.getRow(index + 8).height = fittedHeight(values, widths);
    });
    const end = 7 + employees.length;
    if (employees.length) sheet.autoFilter = { from: { row: 7, column: 1 }, to: { row: end, column: columns.length } };
    else {
        mergedText(sheet, 8, 1, columns.length, 'لا توجد بيانات مطابقة للفلاتر المحددة', { align: 'center', grid: true });
        sheet.getRow(8).height = 34;
    }
    const last = registerSignatures(sheet, Math.max(8, end) + 3, columns.length, options.footer);
    sheet.pageSetup.printTitlesRow = '1:7';
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(columns.length).letter}${last}`;
    return Buffer.from(await book.xlsx.writeBuffer());
}

/** Preserve the official form's twelve numbered editable lines per page. */
export async function buildHourlyModelExcel(employees, modelOptions = {}, { schoolInfo = {} } = {}) {
    if (!Array.isArray(employees) || employees.length > 1000) throw bad('عدد العاملين في نموذج الحصة أكبر من الحد المسموح.');
    let options;
    try {
        if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) throw new TypeError('إعدادات النموذج غير صحيحة.');
        options = normalizeHourlyOptions({ ...DEFAULT_HOURLY_OPTIONS, ...modelOptions });
    } catch (error) { throw bad(error.message || 'إعدادات نموذج الحصة غير صحيحة.'); }
    const book = workbook('نموذج (2) بالحصة دون سن الستين - الفترة الأولى');
    const pages = Math.max(1, Math.ceil(employees.length / 12));
    for (let page = 0; page < pages; page++) {
        const sheet = worksheet(book, `نموذج الحصة ${page + 1}`, HOURLY_WIDTHS, {}, 9);
        sheet.pageSetup.fitToHeight = 1;
        sheet.pageSetup.printArea = 'A1:J24';
        const schoolLines = ['وزارة التربية والتعليم والتعليم الفني', prefixed(schoolInfo.mudriaName || schoolInfo.orgMudriaName || 'بورسعيد', 'محافظة'), 'مديرية التربية والتعليم', schoolInfo.edaraName || 'إدارة بورفؤاد التعليمية', prefixed(schoolInfo.schoolName, 'مدرسة')];
        schoolLines.forEach((line, index) => {
            mergedText(sheet, index + 1, 1, 6, line, { bold: true, size: 10 });
            sheet.getRow(index + 1).height = 17;
        });
        mergedText(sheet, 1, 7, 10, 'الفترة الأولى', { align: 'center', bold: true, size: 12 });
        mergedText(sheet, 3, 7, 10, 'نموذج (2)', { align: 'center', bold: true, size: 12 });
        mergedText(sheet, 6, 1, 10, `مادة ( ${options.subject || '                         '} )`, { align: 'center', bold: true });
        const readableDate = iso => iso ? iso.split('-').reverse().map(Number).join(' / ') : '     /     /     ';
        mergedText(sheet, 7, 1, 10, `الفترة من ${readableDate(options.periodStart)} إلى ${readableDate(options.periodEnd)}`, { align: 'center', bold: true });
        mergedText(sheet, 8, 1, 10, 'المعلمين المستعان بهم من الخارج ( الحصة ) دون سن الستين', { align: 'center', bold: true, grid: true, size: 12 });
        sheet.getRow(8).height = 27;
        HOURLY_HEADINGS.forEach((label, column) => textCell(sheet, 9, column + 1, label, { grid: true, align: 'center', size: 10, bold: true }));
        sheet.getRow(9).height = fittedHeight(HOURLY_HEADINGS, HOURLY_WIDTHS, 42, 10);
        for (let index = 0; index < 12; index++) {
            const position = page * 12 + index;
            const employee = employees[position];
            const values = employee ? hourlyRow(employee, schoolInfo, options.rows[hourlyEmployeeKey(employee)] || {}) : Array(10).fill('');
            values[0] = String(position + 1);
            values.forEach((value, col) => {
                const cell = textCell(sheet, index + 10, col + 1, value, { grid: true, align: [2, 4, 9].includes(col) ? 'right' : 'center', size: 10 });
                if (col === 0) { cell.value = position + 1; cell.numFmt = '0'; }
                if ([0, 3, 7, 8].includes(col)) cell.alignment.readingOrder = 1;
                if ([7, 8].includes(col) && value !== '') {
                    cell.value = Number(value);
                    cell.numFmt = col === 8 ? '#,##0.00' : '#,##0.##';
                }
            });
            sheet.getRow(index + 10).height = fittedHeight(values, HOURLY_WIDTHS, 24, 10);
        }
        sheet.getRow(22).height = 12;
        HOURLY_SIGNATURES.forEach((label, index) => mergedText(sheet, 23, index * 2 + 1, index * 2 + 2, label, { bold: true, align: 'center', size: 10 }));
        sheet.getRow(23).height = 43;
        sheet.getRow(24).height = 12;
    }
    return Buffer.from(await book.xlsx.writeBuffer());
}
