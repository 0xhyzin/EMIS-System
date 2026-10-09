import {
    AlignmentType, BorderStyle, Document, HeightRule, Packer, PageOrientation,
    Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun,
    VerticalAlign, WidthType,
} from 'docx';
import { hourlyEmployeeKey, hourlyRow, DEFAULT_HOURLY_OPTIONS, normalizeHourlyOptions } from '../public/js/reportModels.js';

// The official blank XLS has one A4 landscape page, 10 columns and 12 numbered
// rows. Keep each set of 12 on its own page so the approval signatures stay with it.
const FONT = 'Arial';
const PAGE_WIDTH = 16838;
const TABLE_WIDTH = 14400;
const COLUMN_WEIGHTS = [2.5, 13.7, 13.9, 20, 15, 6.6, 6.6, 8.5, 4.2, 9];
const COLUMN_TITLES = ['م', 'اسم المدرسة', 'اسم المعلم', 'الرقم القومي', 'المؤهل', 'التخصص', 'المادة التعليمية', 'الحصص الفعلية شهريا', 'المبلغ', 'الجهة المحول عليها أمر الدفع ( البريد - البنك )'];
const SIGNATURES = ['مسئول شئون العاملين', 'مدير المدرسة', 'موجه المادة - موجه أول المادة', 'الموجه المالي والإداري', 'مدير الإدارة التعليمية'];
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const BORDERS = Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(side => [side, BORDER]));
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(side => [side, NO_BORDER]));

function bad(message) { const error = new Error(message); error.status = 400; return error; }
function clean(value, max = 180) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw bad('بيانات نموذج الحصة أطول من الحد المسموح.');
    return value.trim();
}
function checkedOptions(input = {}) {
    try { return normalizeHourlyOptions({ ...DEFAULT_HOURLY_OPTIONS, ...input }); }
    catch (error) { throw bad(error.message || 'إعدادات نموذج الحصة غير صحيحة.'); }
}
function textRun(value, { size = 20, bold = false } = {}) {
    const content = String(value ?? '');
    return new TextRun({ text: content, font: FONT, size, sizeComplexScript: size,
        bold, boldComplexScript: bold, color: '000000', rightToLeft: /[\u0621-\u064a]/.test(content),
        language: { value: 'en-US', bidirectional: 'ar-EG' } });
}
function paragraph(value, { size = 20, bold = false, alignment = AlignmentType.CENTER, before = 0, after = 0, line = 250, pageBreakBefore = false } = {}) {
    return new Paragraph({ children: [textRun(value, { size, bold })], bidirectional: true,
        alignment, spacing: { before, after, line }, pageBreakBefore });
}
function cell(value, width, { size = 18, bold = false, alignment = AlignmentType.CENTER, borderless = false, margins = null, line = 250 } = {}) {
    return new TableCell({ width: { size: width, type: WidthType.DXA },
        borders: borderless ? NO_BORDERS : BORDERS, verticalAlign: VerticalAlign.CENTER,
        margins: margins || { top: 50, bottom: 50, left: 45, right: 45 },
        children: String(value ?? '').split('\n').map(valueLine => paragraph(valueLine, { size, bold, alignment, line })) });
}
function widthsFromWeights(weights, total) {
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(weight => Math.round(weight / sum * total));
    widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
    return widths;
}
function bareTable(rows, widths) {
    return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths,
        alignment: AlignmentType.CENTER, visuallyRightToLeft: true, layout: TableLayoutType.FIXED, borders: NO_BORDERS, rows });
}
function headerBlock(school, options, firstPage) {
    const right = [
        'وزارة التربية والتعليم والتعليم الفني',
        `محافظة ${clean(school.mudriaName || school.orgMudriaName || 'بورسعيد', 150)}`,
        'مديرية التربية والتعليم',
        clean(school.edaraName || 'إدارة بورفؤاد التعليمية', 150),
        `مدرسة ${clean(school.schoolName || '', 150)}`,
    ];
    const left = ['الفترة الأولى', 'نموذج (2)'];
    const w = [7200, TABLE_WIDTH - 7200];
    const heading = bareTable([new TableRow({ cantSplit: true, children: [
        cell(right.join('\n'), w[0], { size: 20, bold: true, alignment: AlignmentType.LEFT, borderless: true }),
        cell(left.join('\n'), w[1], { size: 23, bold: true, alignment: AlignmentType.CENTER, borderless: true }),
    ] })], w);
    const readableDate = iso => iso ? iso.split('-').reverse().map(Number).join(' / ') : '     /     /     ';
    return [
        ...(firstPage ? [] : [paragraph('', { pageBreakBefore: true, size: 2 })]),
        heading,
        paragraph(`مادة ( ${options.subject || '                         '} )`, { size: 20, bold: true, after: 15 }),
        paragraph(`الفترة من ${readableDate(options.periodStart)} إلى ${readableDate(options.periodEnd)}`, { size: 20, bold: true, after: 30 }),
    ];
}
function grid(employees, start, schoolInfo, options) {
    const widths = widthsFromWeights(COLUMN_WEIGHTS, TABLE_WIDTH);
    const title = new TableRow({ cantSplit: true, children: [new TableCell({
        columnSpan: widths.length, width: { size: TABLE_WIDTH, type: WidthType.DXA },
        borders: BORDERS, margins: { top: 40, bottom: 40, left: 40, right: 40 },
        children: [paragraph('المعلمين المستعان بهم من الخارج ( الحصة ) دون سن الستين', { size: 22, bold: true })],
    })] });
    const headings = new TableRow({ tableHeader: true, cantSplit: true,
        height: { value: 680, rule: HeightRule.ATLEAST },
        children: COLUMN_TITLES.map((label, index) => cell(label, widths[index], { size: 17 })) });
    const rows = [title, headings];
    for (let index = 0; index < 12; index++) {
        const employee = employees[index];
        const values = employee ? hourlyRow(employee, schoolInfo, options.rows[hourlyEmployeeKey(employee)] || {}) : Array(10).fill('');
        values[0] = String(start + index + 1);
        rows.push(new TableRow({ cantSplit: true, height: { value: 180, rule: HeightRule.ATLEAST },
            children: values.map((value, col) => cell(value, widths[col], {
                size: 17, line: 200, margins: { top: 20, bottom: 20, left: 30, right: 30 },
                alignment: col === 2 || col === 4 || col === 9 ? AlignmentType.RIGHT : AlignmentType.CENTER,
            })) }));
    }
    return bareTable(rows, widths);
}
function signatures() {
    const widths = widthsFromWeights([15, 15, 26, 21, 23], TABLE_WIDTH);
    return [paragraph('', { size: 6, before: 0, after: 90 }),
        bareTable([new TableRow({ cantSplit: true, children: SIGNATURES.map((label, index) =>
            cell(label, widths[index], { size: 18, bold: true, alignment: AlignmentType.CENTER, borderless: true,
                margins: { top: 20, bottom: 20, left: 60, right: 60 } })) })], widths)];
}

export async function buildHourlyModelWord(employees, modelOptions = {}, { schoolInfo = {} } = {}) {
    if (!Array.isArray(employees) || employees.length > 1000) throw bad('عدد العاملين في نموذج الحصة أكبر من الحد المسموح.');
    const options = checkedOptions(modelOptions);
    const children = [];
    const pages = Math.max(1, Math.ceil(employees.length / 12));
    for (let page = 0; page < pages; page++) {
        children.push(...headerBlock(schoolInfo, options, page === 0));
        children.push(grid(employees.slice(page * 12, (page + 1) * 12), page * 12, schoolInfo, options));
        children.push(...signatures());
    }
    const document = new Document({
        title: 'نموذج (2) بالحصة دون سن الستين - الفترة الأولى', creator: 'دفتر المدرسة',
        styles: { default: { document: { run: { font: FONT, size: 20, sizeComplexScript: 20, color: '000000' }, paragraph: { spacing: { after: 0 } } } } },
        sections: [{ properties: { page: { size: { width: 11906, height: PAGE_WIDTH, orientation: PageOrientation.LANDSCAPE },
            margin: { top: 1000, bottom: 800, left: 720, right: 720 } } }, children }],
    });
    return Packer.toBuffer(document);
}
