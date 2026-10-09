import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildExcelExport, buildHourlyModelExcel, EXCEL_MIME } from '../utils/exportExcel.js';
import { DEFAULT_COLUMNS } from '../public/js/dataModel.js';
import { hourlyEmployeeKey } from '../public/js/reportModels.js';
import exportRouter, { normalizeExportOptions } from '../routes/export.js';
import * as db from '../db/database.js';

function xmlParts(buffer) {
    const files = {};
    for (let offset = 0; offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
        const method = buffer.readUInt16LE(offset + 8), length = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
        const start = offset + 30 + nameLength + extraLength, data = buffer.subarray(start, start + length);
        if (name.endsWith('.xml')) files[name] = (method === 8 ? inflateRawSync(data) : data).toString();
        offset = start + length;
    }
    return files;
}

async function readWorkbook(buffer) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer);
    return book;
}

function employee(id = 101) {
    return {
        emp_code: id, national_id: String(id).padStart(14, '0'), full_name: `معلم تجريبي ${id}`, staff_type: 'core', source: 'manual',
        raw_data: {
            basicInfo: { empCode: '00123', nationalIdNum: String(id).padStart(14, '0'), empMobile: '01012345678', empStartDate: '2020-04-17', empHiredate: '2019-12-01T23:00:00-03:00', addressDesc: 'عنوان المدرسة', brchDesc: 'تخصص أصلي' },
            qlf: [{ qlfName: 'بكالوريوس التربية', empQlfDate: '2018-07-01' }],
            job: { jobDesc: 'معلم', kadrJobStartDate: '2021-01-01', subjectDesc: 'لغة عربية' },
            count: 0, notes: '=HYPERLINK("https://example.invalid","نص")',
        },
    };
}

function request(format, body) {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/export/${format}`, body, headers: {} });
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200, headers: {},
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            status(value) { this.statusCode = value; return this; },
            send(buffer) { resolve({ status: this.statusCode, headers: this.headers, buffer }); },
            json(value) { resolve({ status: this.statusCode, headers: this.headers, error: value.error }); },
        };
        exportRouter.handle(req, res, error => reject(error || new Error('Missing export route')));
    });
}

test('ordinary workbook preserves RTL custom table, literal IDs, typed dates, merged lines and styled headers', async () => {
    const selected = employee();
    const columns = [
        { path: 'index', label: 'ترتيب', isIndex: true },
        { path: 'fullName', label: 'اسم العامل' },
        { path: 'basicInfo.nationalIdNum', label: 'قومي', type: 'number' },
        { path: 'basicInfo.empCode', label: 'الكود', type: 'number' },
        { path: 'basicInfo.empMobile', label: 'الهاتف', type: 'number' },
        { path: 'basicInfo.empStartDate', label: 'البدء', type: 'date' },
        { path: 'basicInfo.empHiredate', label: 'تعيين', type: 'date' },
        { type: 'merged', parts: [{ path: 'qlf.qlfName' }, { path: 'qlf.empQlfDate' }], separator: 'newline', label: 'المؤهل وتاريخه' },
        { path: 'count', label: 'العدد', type: 'number' },
        { path: 'notes', label: '=العنوان نفسه نص' },
    ];
    const buffer = await buildExcelExport([selected], { title: 'كشف اختياري', columns, footer: ['مسؤول 1', 'مسؤول 2', 'مسؤول 3'] }, { schoolInfo: { schoolName: 'المدرسة التجريبية', edaraName: 'بورفؤاد' } });
    const book = await readWorkbook(buffer), sheet = book.worksheets[0];
    assert.equal(book.worksheets.length, 1);
    assert.equal(sheet.views[0].rightToLeft, true);
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 7);
    assert.equal(sheet.pageSetup.orientation, 'landscape');
    assert.equal(sheet.pageSetup.paperSize, 9);
    assert.equal(sheet.pageSetup.printTitlesRow, '1:7');
    assert.equal(sheet.getCell('A5').value, 'كشف اختياري');
    assert.equal(sheet.getCell('A3').value, 'مدرسة المدرسة التجريبية');
    assert.deepEqual(sheet.getRow(7).values.slice(1), columns.map(column => column.label));
    assert.equal(sheet.getCell('A8').value, 1);
    assert.equal(sheet.getCell('B8').value, selected.full_name);
    assert.equal(sheet.getCell('C8').value, '00000000000101');
    assert.equal(sheet.getCell('D8').value, '00123');
    assert.equal(sheet.getCell('E8').value, '01012345678');
    for (const column of ['C', 'D', 'E']) assert.equal(sheet.getCell(`${column}8`).numFmt, '@');
    assert.equal(sheet.getCell('F8').value.toISOString(), '2020-04-17T00:00:00.000Z');
    assert.equal(sheet.getCell('G8').value.toISOString(), '2019-12-01T00:00:00.000Z');
    assert.equal(sheet.getCell('F8').numFmt, 'dd/mm/yyyy');
    assert.equal(sheet.getCell('H8').value, 'بكالوريوس التربية\n01/07/2018');
    assert.equal(sheet.getCell('H8').alignment.wrapText, true);
    assert.ok(sheet.getRow(8).height >= 40);
    assert.equal(sheet.getCell('I8').value, 0);
    assert.equal(sheet.getCell('J8').value, selected.raw_data.notes);
    assert.equal(sheet.getCell('J8').type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell('J8').formula, undefined);
    assert.equal(sheet.getCell('A7').fill.fgColor.argb, 'FFD9D9D9');
    assert.equal(sheet.getCell('A7').font.color.argb, 'FF000000');
    assert.equal(sheet.getCell('A11').value, 'إحصاء\nمسؤول 1');
    assert.equal(sheet.getCell('D11').value, 'شؤون العاملين\nمسؤول 2');
    assert.equal(sheet.getCell('G11').value, 'مدير المدرسة\nمسؤول 3');
    const parts = xmlParts(buffer);
    assert.match(parts['xl/worksheets/sheet1.xml'], /rightToLeft="1"/);
    assert.match(parts['xl/worksheets/sheet1.xml'], /<autoFilter ref="A7:J8"/);
    assert.match(parts['xl/worksheets/sheet1.xml'], /<c r="F8" s="\d+"><v>[\d.]+<\/v><\/c>/);
    assert.doesNotMatch(parts['xl/worksheets/sheet1.xml'], /<f[ >]/);
});

test('default, empty, single-column and Arabic numeral workbooks are usable', async () => {
    const empty = (await readWorkbook(await buildExcelExport([]))).worksheets[0];
    assert.deepEqual(empty.getRow(7).values.slice(1), DEFAULT_COLUMNS.map(column => column.label));
    assert.match(empty.getCell('A8').value, /لا توجد بيانات مطابقة/);
    assert.equal(empty.autoFilter, undefined);
    const single = (await readWorkbook(await buildExcelExport([employee()], { columns: [{ path: 'basicInfo.nationalIdNum', label: 'الرقم القومي' }], useArabicNumerals: true, orientation: 'portrait' }))).worksheets[0];
    assert.equal(single.getCell('A8').value, '٠٠٠٠٠٠٠٠٠٠٠١٠١');
    assert.equal(single.pageSetup.orientation, 'portrait');
    assert.equal(single.getCell('A11').value, 'إحصاء\n');
    assert.equal(single.getCell('A13').value, 'مدير المدرسة\n');
    await assert.rejects(buildExcelExport([], { columns: [] }), { status: 400 });
});

test('manual columns keep literal values and added signature roles print with names below', async () => {
    const columns = [{ path: 'fullName', label: 'الاسم' }, { type: 'manual', label: 'بيان إضافي', manualValues: { 101: '00123', 102: '=1+1' } }, { path: 'index', label: 'م' }];
    const footer = [{ label: 'مسؤول الإحصاء', name: 'اسم أول' }, { label: 'الوكيلة', name: 'اسم ثان' }, { label: 'المديرة', name: 'اسم ثالث' }, { label: 'وكيل شؤون التعليم', name: 'اسم إضافي' }];
    const sheet = (await readWorkbook(await buildExcelExport([employee(101), employee(102)], { columns, footer }))).worksheets[0];
    assert.equal(sheet.getCell('B8').value, '00123');
    assert.equal(sheet.getCell('B9').value, '=1+1');
    assert.equal(sheet.getCell('B8').numFmt, '@');
    assert.equal(sheet.getCell('B9').formula, undefined);
    assert.equal(sheet.getCell('A12').value, 'مسؤول الإحصاء\nاسم أول');
    assert.equal(sheet.getCell('A13').value, 'وكيل شؤون التعليم\nاسم إضافي');
    assert.equal(sheet.getCell('A13').alignment.horizontal, 'center');
    assert.ok(sheet.getRow(13).height >= 42);
    assert.equal(sheet.pageSetup.printArea, 'A1:C13');
});

test('Arabic digits apply to distinct manual values, dates and numeric columns without changing stored input', async () => {
    const columns = [{ type: 'manual', label: 'رقم إضافي', manualValues: { 101: '00123', 102: '45' } },
        { path: 'basicInfo.empStartDate', type: 'date', label: 'التاريخ' }, { path: 'count', type: 'number', label: 'العدد' }];
    const employees = [employee(101), employee(102)];
    employees[0].raw_data.count = '12.5'; employees[1].raw_data.count = '0';
    const sheet = (await readWorkbook(await buildExcelExport(employees, { columns, useArabicNumerals: true }))).worksheets[0];
    assert.equal(sheet.getCell('A8').value, '٠٠١٢٣');
    assert.equal(sheet.getCell('A9').value, '٤٥');
    assert.equal(sheet.getCell('B8').value, '١٧/٠٤/٢٠٢٠');
    assert.equal(sheet.getCell('C8').value, '١٢.٥');
    assert.equal(sheet.getCell('C9').value, '٠');
    assert.equal(columns[0].manualValues[101], '00123');
});

test('one/two narrow custom columns fit long report and school headings and signature names', async () => {
    const title = 'كشف العاملين بالمدرسة مع جميع البيانات المطلوبة للمراجعة '.repeat(3).slice(0, 120);
    const schoolName = 'اسم مدرسة طويل يحتاج إلى أكثر من سطر للحفاظ على جميع تفاصيله '.repeat(3).slice(0, 150);
    const signature = 'اسم المسؤول وصفته بالكامل للتوقيع على الكشف ومراجعة البيانات '.repeat(4).slice(0, 180);
    for (const count of [1, 2]) {
        const columns = [{ path: 'index', label: 'م', width: 3.5 }, ...(count === 2 ? [{ path: 'basicInfo.empCode', label: 'كود الموظف', width: 4 }] : [])];
        const sheet = (await readWorkbook(await buildExcelExport([employee()], { title, columns, footer: [signature, signature, signature] }, { schoolInfo: { schoolName } }))).worksheets[0];
        const totalWidth = Array.from({ length: count }, (_, index) => sheet.getColumn(index + 1).width).reduce((sum, width) => sum + width, 0);
        assert.ok(totalWidth >= (count === 1 ? 48 : 64), 'A narrow custom table remains wide enough for report headings');
        assert.equal(sheet.getCell('A5').value, title);
        assert.equal(sheet.getCell('A3').value, `مدرسة ${schoolName}`);
        assert.ok(sheet.getRow(5).height >= 70, 'Title expands to fit wrapping at its larger font');
        assert.ok(sheet.getRow(3).height >= 55, 'Long school name is not clipped by a single-line height');
        const lastSignatureRow = count === 1 ? 13 : 12;
        for (let row = 11; row <= lastSignatureRow; row++) {
            assert.ok(sheet.getCell(row, 1).value.endsWith(signature));
            assert.ok(sheet.getRow(row).height >= 70, 'Each narrow signature receives its own fitted row');
            assert.equal(sheet.getCell(row, 1).alignment.wrapText, true);
        }
        assert.equal(sheet.getCell('A8').value, 1);
        if (count === 2) assert.equal(sheet.getCell('B8').value, '00123');
        assert.equal(sheet.pageSetup.printArea, `A1:${count === 1 ? 'A' : 'B'}${lastSignatureRow}`);
    }
});

test('non-date values and formula-like text remain literal; calendar dates never roll over', async () => {
    const selected = employee();
    selected.raw_data.basicInfo.empStartDate = '2020-02-31';
    selected.raw_data.customFields = ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '000000000000000000001'];
    const columns = [{ path: 'basicInfo.empStartDate', type: 'date', label: 'تاريخ' }, ...selected.raw_data.customFields.map((value, index) => ({ path: `customFields.${index}`, label: `نص ${index}` }))];
    const sheet = (await readWorkbook(await buildExcelExport([selected], { columns }))).worksheets[0];
    assert.equal(sheet.getCell('A8').value, '31/02/2020');
    assert.deepEqual(sheet.getRow(8).values.slice(2), selected.raw_data.customFields);
    for (let index = 2; index <= 6; index++) assert.equal(sheet.getCell(8, index).type, ExcelJS.ValueType.String);
});

test('extra fields use stable labels and keep historic record columns, missing values and zeros', async () => {
    const first = employee(101), second = employee(102);
    first.raw_data.customFields = [{ label: 'بيان إضافي', value: 'قيمة أولى' }, { label: 'عدد', value: 0 }];
    second.raw_data.customFields = [{ label: 'عدد', value: 0 }, { label: 'بيان إضافي', value: 'قيمة ثانية' }];
    first.raw_data.qlf.push({ qlfName: 'مؤهل لاحق', empQlfDate: '2021-07-15' });
    const columns = [
        { path: `customField:${encodeURIComponent('بيان إضافي')}`, label: 'اسم إضافي اختياري', type: 'text' },
        { path: `customField:${encodeURIComponent('عدد')}`, label: 'صفر إضافي', type: 'text' },
        { path: 'qlf.1.qlfName', label: 'المؤهل الثاني' },
        { path: 'qlf.1.empQlfDate', label: 'تاريخ المؤهل الثاني', type: 'date' },
    ];
    const sheet = (await readWorkbook(await buildExcelExport([first, second], { columns }))).worksheets[0];
    assert.equal(sheet.getCell('A8').value, 'قيمة أولى');
    assert.equal(sheet.getCell('A9').value, 'قيمة ثانية');
    assert.equal(sheet.getCell('B8').value, '0');
    assert.equal(sheet.getCell('B9').value, '0');
    assert.equal(sheet.getCell('C8').value, 'مؤهل لاحق');
    assert.equal(sheet.getCell('D8').value.toISOString(), '2021-07-15T00:00:00.000Z');
    assert.equal(sheet.getCell('C9').value, '');
    assert.equal(sheet.getCell('D9').value, '');
    const longLabel = 'س'.repeat(150);
    assert.doesNotThrow(() => normalizeExportOptions({ columns: [{ path: `customField:${encodeURIComponent(longLabel)}`, label: longLabel, type: 'text' }] }));
});

test('hourly form includes all twelve lines per sheet, saved row overrides and five approval signatures', async () => {
    const selected = Array.from({ length: 13 }, (_, index) => employee(101 + index));
    const rowKey = hourlyEmployeeKey(selected[0]);
    const options = { periodStart: '2026-09-12', periodEnd: '2026-09-30', subject: 'لغة عربية', rows: { [rowKey]: { specialization: 'تخصص اختياري', educationalSubject: '', monthlySessions: '0', amount: '300.50', paymentDestination: '=جهة كنص' } } };
    const book = await readWorkbook(await buildExcelExport(selected, { modelId: 'hourly-contract-period-1', modelOptions: options }, { schoolInfo: { schoolName: 'مدرسة التجربة' } }));
    assert.equal(book.worksheets.length, 2);
    const first = book.worksheets[0], second = book.worksheets[1];
    assert.equal(first.views[0].rightToLeft, true);
    assert.equal(first.pageSetup.fitToHeight, 1);
    assert.equal(first.pageSetup.printArea, 'A1:J24');
    assert.equal(first.getCell('A6').value, 'مادة ( لغة عربية )');
    assert.match(first.getCell('A7').value, /12 \/ 9 \/ 2026/);
    assert.match(first.getCell('A8').value, /دون سن الستين/);
    assert.equal(first.getRow(9).values.slice(1).length, 10);
    assert.deepEqual(first.getRow(10).values.slice(1), [1, 'مدرسة التجربة', 'معلم تجريبي 101', '00000000000101', 'بكالوريوس التربية', 'تخصص اختياري', '', 0, 300.5, '=جهة كنص']);
    assert.equal(first.getCell('D10').numFmt, '@');
    assert.equal(first.getCell('J10').type, ExcelJS.ValueType.String);
    assert.equal(first.getCell('I10').numFmt, '#,##0.00');
    assert.deepEqual(Array.from({ length: 12 }, (_, index) => second.getCell(index + 10, 1).value), Array.from({ length: 12 }, (_, index) => index + 13));
    assert.equal(second.getCell('C10').value, 'معلم تجريبي 113');
    for (let row = 11; row <= 21; row++) assert.equal(second.getCell(row, 3).value, '');
    assert.deepEqual([1, 3, 5, 7, 9].map(column => first.getCell(23, column).value), ['مسئول شئون العاملين', 'مدير المدرسة', 'موجه المادة - موجه أول المادة', 'الموجه المالي والإداري', 'مدير الإدارة التعليمية']);
    const blank = (await readWorkbook(await buildHourlyModelExcel([], { periodStart: '', periodEnd: '', rows: {} }))).worksheets[0];
    for (let row = 10; row <= 21; row++) { assert.equal(blank.getCell(row, 1).value, row - 9); assert.equal(blank.getCell(row, 3).value, ''); }
    await assert.rejects(buildHourlyModelExcel([], { periodStart: '2026-02-31' }), { status: 400 });
});

test('Excel endpoint uses saved list members plus exact search, filters, sort priorities and source', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'emis-excel-api-test-'));
    db.initDatabase({ dataDir });
    t.after(() => { db.closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });
    db.saveSetting('schoolInfo', { schoolName: 'مدرسة اختبار التصدير' });
    const b = db.createEmployee({ fullName: 'موظف تجريبي باء', nationalId: '00000000000001', jobTitle: 'معلم', staffType: 'seconded' });
    const a = db.createEmployee({ fullName: 'موظف تجريبي ألف', nationalId: '00000000000002', jobTitle: 'كبير معلمين', staffType: 'seconded' });
    const other = db.createEmployee({ fullName: 'موظف تجريبي مستبعد', jobTitle: 'إداري', staffType: 'seconded' });
    db.createEmployee({ fullName: 'موظف خارج البحث', jobTitle: 'معلم', staffType: 'seconded' });
    db.createEmployee({ fullName: 'موظف تجريبي أساسي', jobTitle: 'معلم', staffType: 'core' });
    db.upsertEmployee(9001, '', 'موظف تجريبي من الوزارة', { job: { jobDesc: 'معلم' } }, 'seconded');
    const list = db.createCustomList({ name: 'قائمة اختبار', memberIds: [b.emp_code, a.emp_code, other.emp_code, 9001] });
    const options = {
        title: 'كشف/اختبار', listId: list.id, memberIds: [other.emp_code], search: 'تجريبي', source: 'manual', staffType: 'seconded',
        filters: [{ path: 'job.jobDesc', values: ['معلم', 'كبير معلمين'], mode: 'include' }],
        sorting: [{ path: 'job.jobDesc', direction: 'custom', customOrder: ['كبير معلمين', 'معلم'] }, { path: 'fullName', direction: 'desc' }],
        columns: [{ path: 'index', label: 'م' }, { path: 'fullName', label: 'الاسم المخصص' }, { path: 'basicInfo.nationalIdNum', label: 'القومي' }],
    };
    const result = await request('excel', options);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], EXCEL_MIME);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(decodeURIComponent(result.headers['content-disposition'].split("filename*=UTF-8''")[1]), 'كشفاختبار.xlsx');
    const sheet = (await readWorkbook(result.buffer)).worksheets[0];
    assert.equal(sheet.getCell('B8').value, a.full_name);
    assert.equal(sheet.getCell('B9').value, b.full_name);
    assert.equal(sheet.getCell('C8').value, '00000000000002');
    assert.equal(sheet.autoFilter, 'A7:C9');
    assert.equal(sheet.getCell('A3').value, 'مدرسة اختبار التصدير');
    const xml = Object.values(xmlParts(result.buffer)).join('\n');
    assert.doesNotMatch(xml, /مستبعد|خارج البحث|من الوزارة|تجريبي أساسي/);
    db.updateCustomList(list.id, { name: list.name, memberIds: [] });
    const empty = await request('excel', { listId: list.id });
    assert.equal(empty.status, 200);
    assert.match((await readWorkbook(empty.buffer)).worksheets[0].getCell('A8').value, /لا توجد بيانات مطابقة/);
    db.deleteCustomList(list.id);
    assert.equal((await request('excel', { listId: list.id })).status, 404);
    assert.equal((await request('excel', { listId: 'invalid' })).status, 400);
    const all = (await readWorkbook((await request('excel', { memberIds: [a.emp_code] })).buffer)).worksheets[0];
    assert.equal(all.autoFilter, 'A7:I13', 'Client memberIds without a saved list do not change the selected school scope');
});

test('both export routes return friendly 400 for malformed selection, columns and form options', async () => {
    const malformed = [
        null, [], 'invalid', { columns: [] }, { columns: [null] }, { columns: [{ path: 'fullName', label: {} }] },
        { columns: [{ type: 'merged', parts: 'invalid' }] }, { columns: [{ type: 'merged', fields: ['fullName', null] }] },
        { columns: [{ path: '__proto__.value' }] }, { filters: {} }, { filters: [null] }, { sorting: {} }, { sorting: [null] },
        { sorting: [{ path: 'fullName', customOrder: [{}] }] }, { search: {} }, { source: 'invalid' }, { orientation: 'invalid' },
        { modelId: 'invalid' }, { footer: 'invalid' }, { modelId: 'hourly-contract-period-1', modelOptions: [] },
        { modelId: 'hourly-contract-period-1', modelOptions: { periodStart: '2026-02-31' } },
    ];
    for (const body of malformed) for (const format of ['word', 'excel']) {
        const result = await request(format, body);
        assert.equal(result.status, 400, `${format}: ${JSON.stringify(body)}`);
        assert.match(result.error, /[\u0621-\u064a]/);
        assert.doesNotMatch(result.error, /TypeError|undefined|is not/);
    }
});
