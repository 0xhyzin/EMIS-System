import express from 'express';
import { 
    Document, Packer, Paragraph, Table, TableRow, TableCell, 
    TextRun, AlignmentType, BorderStyle, WidthType, ImageRun,
    PageOrientation, Header, Footer, ShadingType, TableLayoutType,
    TextDirection,
} from 'docx';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Convert Western digits to Arabic-Indic digits
function toArabicNumerals(str) {
    if (!str) return '';
    const map = {'0':'٠','1':'١','2':'٢','3':'٣','4':'٤','5':'٥','6':'٦','7':'٧','8':'٨','9':'٩'};
    return String(str).replace(/[0-9]/g, d => map[d]);
}

function getNestedValue(obj, path) {
    if (!path) return '';
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return '';
        if (Array.isArray(current) && current.length > 0) {
            current = current[0][part] !== undefined ? current[0][part] : current[part];
        } else {
            current = current[part];
        }
    }
    return current || '';
}

function formatDate(dateStr, useArabicNums) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime()) || date.getFullYear() < 1900) return dateStr;
    const d = String(date.getDate()).padStart(2,'0');
    const m = String(date.getMonth()+1).padStart(2,'0');
    const y = date.getFullYear();
    
    // For Arabic, reverse to YYYY/MM/DD so Word RTL renders it as DD/MM/YYYY visually
    const result = useArabicNums ? `${y}/${m}/${d}` : `${d}/${m}/${y}`;
    return useArabicNums ? toArabicNumerals(result) : result;
}

function isDateValue(val) {
    return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val);
}

function processText(text, useArabicNums) {
    if (!text) return '';
    let result = String(text);
    if (useArabicNums) result = toArabicNumerals(result);
    return result;
}

// ============================================
// HEADER - repeats every page
// ============================================
function buildPageHeader(schoolInfo, logoPath, title) {
    const hasLogo = fs.existsSync(logoPath);

    // School info - RIGHT side, size 8pt
    const makeSchoolLine = (text, isLast = false) => new Paragraph({
        children: [new TextRun({
            text: text,
            size: 16, // 8pt
            font: 'Traditional Arabic',
        })],
        alignment: AlignmentType.RIGHT,
        rightToLeft: true,
        spacing: { after: isLast ? 0 : 30 },
    });

    // 3-column layout: info RIGHT | spacer | logo LEFT
    const infoCell = new TableCell({
        children: [
            makeSchoolLine(`محافظة ${schoolInfo.mudriaName || ''}`),
            makeSchoolLine(`ادارة ${schoolInfo.edaraName || ''} التعليمية`),
            makeSchoolLine(`مدرسة ${schoolInfo.schoolName || ''}`, true),
        ],
        width: { size: 35, type: WidthType.PERCENTAGE },
        verticalAlign: 'center',
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
    });

    const spacerCell = new TableCell({
        children: [new Paragraph('')],
        width: { size: 50, type: WidthType.PERCENTAGE },
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
    });

    const logoCell = new TableCell({
        children: hasLogo ? [new Paragraph({
            children: [new ImageRun({
                data: fs.readFileSync(logoPath),
                transformation: { width: 65, height: 65 }
            })],
            alignment: AlignmentType.CENTER,
        })] : [new Paragraph('')],
        width: { size: 15, type: WidthType.PERCENTAGE },
        verticalAlign: 'center',
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
    });

    const headerTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
            left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
            insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
        },
        // RTL row: info(right) | spacer | logo(left)
        rows: [new TableRow({ children: [infoCell, spacerCell, logoCell] })]
    });

    // Title - centered, bold, underlined
    const titlePara = new Paragraph({
        children: [new TextRun({
            text: title || '',
            bold: true,
            size: 28, // 14pt
            underline: {},
            font: 'Traditional Arabic',
        })],
        alignment: AlignmentType.CENTER,
        rightToLeft: true,
        spacing: { before: 80, after: 60 },
    });

    return new Header({
        children: [headerTable, titlePara],
    });
}

// ============================================
// FOOTER - repeats every page
// RTL order: إحصاء (right) → تقويم (center) → مدير المدرسة (left)
// ============================================
function buildPageFooter(footerArr) {
    const [sig1, sig2, sig3] = footerArr; // [احصاء, تقويم, مدير]

    const makeCell = (text, align) => new TableCell({
        children: [new Paragraph({
            children: [new TextRun({
                text: text || '',
                bold: true,
                size: 20, // 10pt
                font: 'Traditional Arabic',
            })],
            alignment: align,
            rightToLeft: true,
        })],
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
    });

    return new Footer({
        children: [
            new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 4, space: 4, color: '555555' } },
                spacing: { after: 60 },
            }),
            new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                borders: {
                    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
                    insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
                },
                rows: [new TableRow({
                    children: [
                        // RTL: Right = احصاء, Center = تقويم, Left = مدير
                        makeCell(sig1 ? `احصاء: ${sig1}` : '', AlignmentType.RIGHT),
                        makeCell(sig2 ? `تقويم: ${sig2}` : '', AlignmentType.CENTER),
                        makeCell(sig3 ? `مدير المدرسة: ${sig3}` : '', AlignmentType.LEFT),
                    ]
                })]
            })
        ]
    });
}

// ============================================
// MAIN EXPORT ROUTE
// ============================================
router.post('/export/word', async (req, res) => {
    try {
        const { 
            title, columns, sorting, footer, 
            orientation = 'portrait', filters,
            useArabicNumerals = false
        } = req.body;
        const staffType = req.body.staffType;
        let allEmployees = db.getAllEmployees(staffType);
        let data = allEmployees.map(emp => emp.raw_data);

        // Apply filters
        if (filters && Array.isArray(filters)) {
            for (const filter of filters) {
                if (!filter.path || !filter.values || filter.values.length === 0) continue;
                data = data.filter(item => {
                    const val = String(getNestedValue(item, filter.path)).trim();
                    return filter.mode === 'exclude' ? !filter.values.includes(val) : filter.values.includes(val);
                });
            }
        }

        // Apply sorting
        if (sorting && Array.isArray(sorting) && sorting.length > 0) {
            for (let i = sorting.length - 1; i >= 0; i--) {
                const rule = sorting[i];
                const fieldPath = rule.path || rule.field;
                if (!fieldPath) continue;
                data.sort((a, b) => {
                    let valA = String(getNestedValue(a, fieldPath)).trim();
                    let valB = String(getNestedValue(b, fieldPath)).trim();
                    if (rule.direction === 'custom' && rule.customOrder) {
                        const iA = rule.customOrder.indexOf(valA);
                        const iB = rule.customOrder.indexOf(valB);
                        return (iA === -1 ? 999999 : iA) - (iB === -1 ? 999999 : iB);
                    }
                    if (valA === 'undefined' || valA === 'null') valA = ''; 
                    if (valB === 'undefined' || valB === 'null') valB = '';
                    if (isDateValue(valA) || isDateValue(valB) || rule.type === 'date') {
                        const dA = new Date(valA).getTime() || 0;
                        const dB = new Date(valB).getTime() || 0;
                        return rule.direction === 'desc' ? dB - dA : dA - dB;
                    }
                    return rule.direction === 'desc'
                        ? String(valB).localeCompare(String(valA), 'ar')
                        : String(valA).localeCompare(String(valB), 'ar');
                });
            }
        }

        const schoolInfo = db.getSetting('schoolInfo') || {};
        const logoPath = join(__dirname, '..', 'public', 'assets', 'logo.png');

        // ---- BUILD DATA TABLE (RTL) ----
        // For RTL: we reverse column order so Word renders them right-to-left
        const colsForTable = [...(columns || [])].reverse();

        const headerRow = new TableRow({
            tableHeader: true,
            children: colsForTable.map(col => new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text: col.label || '', bold: true, color: 'FFFFFF', size: 20, font: 'Traditional Arabic' })],
                    alignment: AlignmentType.CENTER,
                    rightToLeft: true,
                })],
                shading: { fill: '1a1a2e', type: ShadingType.CLEAR },
                verticalAlign: 'center',
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
            }))
        });

        const dataRows = data.map((item, idx) => new TableRow({
            children: colsForTable.map(col => {
                let cellChildren = [];
                if (col.isIndex || col.type === 'index' || col.path === 'index') {
                    const num = useArabicNumerals ? toArabicNumerals(idx + 1) : String(idx + 1);
                    cellChildren = [new Paragraph({
                        children: [new TextRun({ text: num, size: 18, font: 'Traditional Arabic' })],
                        alignment: AlignmentType.CENTER, rightToLeft: true,
                    })];
                } else if (col.isMerged || col.type === 'merged') {
                    const fieldPaths = col.parts ? col.parts.map(p => p.path) : (col.fields || []);
                    // col.separator comes from frontend: 'newline', 'space', 'dash', 'none', or custom string
                    const sep = col.separator || 'newline';
                    
                    if (sep === 'newline') {
                        // Each value on its own line
                        cellChildren = fieldPaths.map(f => {
                            let val = getNestedValue(item, f);
                            if (isDateValue(String(val))) val = formatDate(String(val), useArabicNumerals);
                            else val = processText(val, useArabicNumerals);
                            if (!val) return null;
                            return new Paragraph({
                                children: [new TextRun({ text: val, size: 18, font: 'Traditional Arabic' })],
                                alignment: AlignmentType.CENTER, rightToLeft: true,
                            });
                        }).filter(Boolean);
                        if (cellChildren.length === 0) cellChildren = [new Paragraph('')];
                    } else {
                        // All on same line with specific separator
                        let sepStr = sep;
                        if (sep === 'space') sepStr = ' ';
                        if (sep === 'dash') sepStr = ' - ';
                        if (sep === 'none') sepStr = '';
                        
                        const parts = fieldPaths.map(f => {
                            let val = getNestedValue(item, f);
                            if (isDateValue(String(val))) val = formatDate(String(val), useArabicNumerals);
                            else val = processText(val, useArabicNumerals);
                            return val;
                        }).filter(Boolean);
                        
                        cellChildren = [new Paragraph({
                            children: [new TextRun({ text: parts.join(sepStr), size: 18, font: 'Traditional Arabic' })],
                            alignment: AlignmentType.CENTER, rightToLeft: true,
                        })];
                    }
                } else {
                    const fieldPath = col.path || col.field || '';
                    let val = getNestedValue(item, fieldPath);
                    if (isDateValue(String(val))) {
                        val = formatDate(String(val), useArabicNumerals);
                    } else {
                        val = processText(val, useArabicNumerals);
                    }
                    cellChildren = [new Paragraph({
                        children: [new TextRun({ text: val || '', size: 18, font: 'Traditional Arabic' })],
                        alignment: AlignmentType.CENTER, rightToLeft: true,
                    })];
                }
                return new TableCell({
                    children: cellChildren,
                    shading: { fill: idx % 2 === 0 ? 'FFFFFF' : 'F5F5FA', type: ShadingType.CLEAR },
                    verticalAlign: 'center',
                    margins: { top: 50, bottom: 50, left: 50, right: 50 },
                });
            })
        }));

        const dataTable = new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [headerRow, ...dataRows],
            layout: TableLayoutType.AUTOFIT,
            borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: '444466' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: '444466' },
                left: { style: BorderStyle.SINGLE, size: 4, color: '444466' },
                right: { style: BorderStyle.SINGLE, size: 4, color: '444466' },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'bbbbcc' },
                insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'bbbbcc' },
            },
        });

        // Footer
        let footerArr = ['', '', ''];
        if (Array.isArray(footer)) footerArr = footer;
        else if (footer) footerArr = [footer.stats || '', footer.review || '', footer.principal || ''];

        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        size: { orientation: orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
                        margin: { top: 1400, right: 800, bottom: 1400, left: 800 },
                        borders: {
                            pageBorderTop: { style: BorderStyle.SINGLE, size: 20, space: 20, color: '333355' },
                            pageBorderBottom: { style: BorderStyle.SINGLE, size: 20, space: 20, color: '333355' },
                            pageBorderLeft: { style: BorderStyle.SINGLE, size: 20, space: 20, color: '333355' },
                            pageBorderRight: { style: BorderStyle.SINGLE, size: 20, space: 20, color: '333355' },
                        }
                    },
                    titlePage: false,
                },
                headers: { default: buildPageHeader(schoolInfo, logoPath, title) },
                footers: { default: buildPageFooter(footerArr) },
                children: [dataTable],
            }]
        });

        const buffer = await Packer.toBuffer(doc);
        const fileName = `${title || 'export'}_${Date.now()}.docx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.send(buffer);

    } catch (error) {
        console.error("Export Error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
