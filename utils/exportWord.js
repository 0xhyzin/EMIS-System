import {
    AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel,
    ImageRun, Packer, PageBorderOffsetFrom, PageBorderZOrder, PageOrientation,
    Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow,
    TextRun, VerticalAlign, WidthType,
} from 'docx';
import fs from 'node:fs';
import { columnText, DEFAULT_COLUMNS } from '../public/js/dataModel.js';
import { normalizeSignatures } from '../public/js/reportLayout.js';

const FONT = 'Arial';
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const CLEAR_BORDERS = Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(side => [side, NO_BORDER]));
const GRID_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '333333' };
const GRID_BORDERS = Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(side => [side, GRID_BORDER]));

function run(text, size = 20, bold = false, color = '000000') {
    // Numeric runs must remain LTR. Reversing dates corrupts their stored values.
    return new TextRun({
        text: String(text), font: FONT, color, size,
        sizeComplexScript: size, bold, boldComplexScript: bold,
        rightToLeft: /[\u0621-\u064a]/.test(String(text)),
        language: { value: 'en-US', bidirectional: 'ar-EG' },
    });
}

function paragraph(text = '', { size = 20, bold = false, color = '000000', alignment = AlignmentType.RIGHT, before = 0, after = 0, keepNext = false } = {}) {
    const content = String(text);
    const numeric = /^[\d\u0660-\u0669\s/.:+()\-]+$/.test(content);
    const justification = !numeric && alignment === AlignmentType.RIGHT ? AlignmentType.START
        : !numeric && alignment === AlignmentType.LEFT ? AlignmentType.END : alignment;
    return new Paragraph({
        children: [run(content, size, bold, color)], bidirectional: !numeric,
        alignment: justification, keepNext, spacing: { before, after, line: 240 },
    });
}

function plainCell(children, width) {
    return new TableCell({
        width: { size: width, type: WidthType.DXA }, children,
        verticalAlign: VerticalAlign.CENTER, borders: CLEAR_BORDERS,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
}

function logoImage(logoPath) {
    if (!logoPath || !fs.existsSync(logoPath)) return null;
    const data = fs.readFileSync(logoPath);
    let type, width = 80, height = 60;
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        type = 'png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20);
    } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
        type = 'jpg';
        // Preserve the aspect ratio of uploaded JPEG school logos too.
        for (let offset = 2; offset + 8 < data.length;) {
            if (data[offset] !== 0xff) break;
            const marker = data[offset + 1];
            const length = data.readUInt16BE(offset + 2);
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                height = data.readUInt16BE(offset + 5); width = data.readUInt16BE(offset + 7); break;
            }
            if (length < 2) break;
            offset += 2 + length;
        }
    } else {
        return null;
    }
    const scale = Math.min(92 / Math.max(width, 1), 58 / Math.max(height, 1));
    return new ImageRun({ type, data, transformation: { width: width * scale, height: height * scale }, altText: { title: 'شعار المدرسة', description: 'شعار المدرسة', name: 'School logo' } });
}

function prefixed(value, prefix, suffix = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.startsWith(prefix) ? text : `${prefix} ${text}${suffix}`;
}

function header(schoolInfo, logoPath, title, pageWidth) {
    const logo = logoImage(logoPath);
    const widths = [Math.round(pageWidth * 0.70), pageWidth - Math.round(pageWidth * 0.70)];
    return new Header({ children: [
        new Table({
            width: { size: pageWidth, type: WidthType.DXA }, columnWidths: widths,
            visuallyRightToLeft: true, layout: TableLayoutType.FIXED, borders: CLEAR_BORDERS,
            rows: [new TableRow({ cantSplit: true, children: [
                plainCell([
                    paragraph(prefixed(schoolInfo.mudriaName || schoolInfo.orgMudriaName, 'محافظة'), { size: 17, bold: true, after: 35 }),
                    paragraph(prefixed(schoolInfo.edaraName, 'إدارة', ' التعليمية'), { size: 17, bold: true, after: 35 }),
                    paragraph(prefixed(schoolInfo.schoolName, 'مدرسة'), { size: 17, bold: true }),
                ], widths[0]),
                plainCell([new Paragraph({ children: logo ? [logo] : [], alignment: AlignmentType.LEFT, spacing: { after: 0 } })], widths[1]),
            ] })],
        }),
        // The reference puts a rule ABOVE its title, separating the school header.
        new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } }, spacing: { before: 70, after: 60, line: 20 }, children: [run('', 2)] }),
        new Paragraph({ heading: HeadingLevel.TITLE, children: [run(title, 32, true)], bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 20, after: 60, line: 280 } }),
    ] });
}

function footer(signatures, pageWidth) {
    if (!signatures.length) return new Footer({ children: [paragraph('', { size: 2 })] });
    const widths = [Math.floor(pageWidth / 3), Math.floor(pageWidth / 3), pageWidth - 2 * Math.floor(pageWidth / 3)];
    const rows = [];
    for (let offset = 0; offset < signatures.length; offset += 3) {
        rows.push(new TableRow({ cantSplit: true, children: widths.map((width, index) => {
            const signature = signatures[offset + index];
            return plainCell([
                paragraph(signature?.label || '', { size: 18, bold: true, alignment: AlignmentType.CENTER }),
                paragraph(signature?.name || '', { size: 18, bold: true, alignment: AlignmentType.CENTER, after: 120 }),
            ], width);
        }) }));
    }
    return new Footer({ children: [new Table({
        width: { size: pageWidth, type: WidthType.DXA }, columnWidths: widths,
        visuallyRightToLeft: true, layout: TableLayoutType.FIXED, borders: CLEAR_BORDERS,
        rows,
    }), paragraph('', { size: 2 })] });
}

function columnFields(column) {
    return (column.parts?.map(part => part.path) || column.fields || [column.path || column.field || '']).join(' ');
}

function columnWeight(column) {
    if (Number.isFinite(column.width) && column.width > 0) return Math.min(column.width, 60);
    const paths = columnFields(column);
    if (column.isIndex || column.type === 'index' || column.path === 'index') return 4;
    if (/empFirstName|fullName/.test(paths) || /الاسم/.test(column.label || '')) return 15;
    if (/nationalIdNum/.test(paths)) return 12;
    if (/empStartDate|empHiredate/.test(paths)) return 8.5;
    if (/qlfName/.test(paths)) return 15;
    if (/jobDesc/.test(paths)) return 11;
    if (/addressDesc/.test(paths)) return 17;
    if (/notes|ملاحظات/.test(`${paths} ${column.label}`)) return 9;
    if (/date/i.test(paths) || column.type === 'date') return 9;
    return 12;
}

export function columnWidths(columns, pageWidth) {
    const weights = columns.map(columnWeight);
    const total = weights.reduce((sum, width) => sum + width, 0);
    const widths = weights.map(weight => Math.round(pageWidth * weight / total));
    widths[widths.length - 1] += pageWidth - widths.reduce((sum, width) => sum + width, 0);
    return widths;
}

function gridCell(text, column, width, { headerCell = false, fontSize = 20 } = {}) {
    const paths = columnFields(column);
    const centered = column.isIndex || column.type === 'index' || column.path === 'index' || /nationalIdNum|[Dd]ate|empHiredate/.test(paths);
    return new TableCell({
        width: { size: width, type: WidthType.DXA }, borders: GRID_BORDERS,
        verticalAlign: VerticalAlign.CENTER,
        shading: { fill: headerCell ? 'D9D9D9' : 'FFFFFF', type: ShadingType.CLEAR },
        margins: { top: headerCell ? 80 : 50, bottom: headerCell ? 80 : 50, left: 60, right: 60 },
        children: String(text ?? '').split('\n').map(line => paragraph(line, {
            size: headerCell ? fontSize : numericLineSize(line, width, fontSize), bold: true, color: '000000',
            alignment: headerCell || centered ? AlignmentType.CENTER : AlignmentType.RIGHT,
        })),
    });
}

function numericLineSize(line, width, size) {
    if (!line || !/^[\d\u0660-\u0669\u06f0-\u06f9\s/.:+()\-]+$/.test(line)) return size;
    // DXA widths are twips, font sizes are half-points. Arial bold digits use
    // about .556 em; a small allowance covers substitutions in Word/LibreOffice.
    // Fit each numeric line independently so merged descriptive text retains
    // its normal size, and IDs/dates do not lose their last digits to wrapping.
    let ems = 0;
    for (const character of line) ems += /[\d\u0660-\u0669\u06f0-\u06f9]/.test(character) ? 0.57 : /[+()]/.test(character) ? 0.4 : 0.3;
    const usablePoints = Math.max(1, (width - 120) / 20 - 1.5);
    return Math.max(14, Math.min(size, Math.floor(usablePoints * 2 / ems)));
}

/** Generate the same editable RTL staff register for routes, tests and previews. */
export async function buildWordExport(employees, options = {}, { schoolInfo = {}, logoPath } = {}) {
    const columns = options.columns === undefined ? DEFAULT_COLUMNS : options.columns;
    if (!Array.isArray(columns) || !columns.length || columns.length > 30 || columns.some(column => !column || typeof column !== 'object')) {
        const error = new Error('اختر من عمود واحد إلى ٣٠ عمودًا لإنشاء الكشف.');
        error.status = 400;
        throw error;
    }
    const landscape = options.orientation !== 'portrait';
    const paperWidth = landscape ? 16838 : 11906;
    const pageWidth = paperWidth - 1440;
    const widths = columnWidths(columns, pageWidth);
    const fontSize = columns.length > 11 || (!landscape && columns.length > 7) ? 18 : 20;
    const title = String(options.title || 'أسماء العاملين بالمدرسة').trim();
    const signatures = normalizeSignatures(options.footer);
    const signatureRows = Math.ceil(signatures.length / 3);
    const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: columns.map((column, index) =>
        gridCell(column.label || column.path || '', column, widths[index], { headerCell: true, fontSize }),
    ) })];
    employees.forEach((employee, employeeIndex) => rows.push(new TableRow({
        cantSplit: true,
        children: columns.map((column, index) => gridCell(
            columnText(employee, column, employeeIndex, { useArabicNumerals: Boolean(options.useArabicNumerals) }),
            column, widths[index], { fontSize },
        )),
    })));
    if (!employees.length) rows.push(new TableRow({ children: [new TableCell({
        columnSpan: columns.length, children: [paragraph('لا توجد بيانات مطابقة للفلاتر المحددة', { alignment: AlignmentType.CENTER, before: 120, after: 120 })],
        borders: GRID_BORDERS,
    })] }));
    const border = { style: BorderStyle.DOUBLE, size: 12, color: '000000', space: 28 };
    const document = new Document({
        title, creator: 'سجل المدرسة', description: 'كشف العاملين بالمدرسة',
        styles: { default: { document: { run: { font: FONT, size: 20, sizeComplexScript: 20, color: '000000' }, paragraph: { spacing: { after: 0 } } }, title: { run: { font: FONT, size: 32, sizeComplexScript: 32, bold: true, boldComplexScript: true, color: '000000' }, paragraph: { alignment: AlignmentType.CENTER } } } },
        sections: [{
            properties: { page: {
                size: { width: 11906, height: 16838, orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
                margin: { top: 2500, right: 720, bottom: 1900 + Math.max(0, signatureRows - 1) * 720, left: 720, header: 980, footer: 960 },
                borders: {
                    pageBorders: { offsetFrom: PageBorderOffsetFrom.PAGE, zOrder: PageBorderZOrder.BACK },
                    pageBorderTop: { ...border, space: 40 }, pageBorderBottom: { ...border, space: 40 },
                    pageBorderLeft: border, pageBorderRight: border,
                },
            } },
            headers: { default: header(schoolInfo, logoPath, title, pageWidth) },
            footers: { default: footer(signatures, pageWidth) },
            children: [new Table({
                width: { size: pageWidth, type: WidthType.DXA }, columnWidths: widths,
                visuallyRightToLeft: true, layout: TableLayoutType.FIXED,
                borders: GRID_BORDERS, rows,
            })],
        }],
    });
    return Packer.toBuffer(document);
}
