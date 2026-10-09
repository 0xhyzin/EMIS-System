import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildWordExport } from '../utils/exportWord.js';
import { DEFAULT_COLUMNS, selectEmployees } from '../public/js/dataModel.js';
import exportRouter from '../routes/export.js';
import * as db from '../db/database.js';

// Read the generated OOXML without adding a test-only ZIP dependency.
function xmlParts(buffer) {
    const files = {};
    for (let offset = 0; offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
        const method = buffer.readUInt16LE(offset + 8);
        const length = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
        const start = offset + 30 + nameLength + extraLength;
        const data = buffer.subarray(start, start + length);
        if (name.endsWith('.xml')) files[name] = (method === 8 ? inflateRawSync(data) : data).toString();
        offset = start + length;
    }
    return files;
}

const employee = {
    full_name: 'موظف تجريبي', staff_type: 'core', source: 'manual',
    raw_data: {
        basicInfo: { nationalIdNum: '00000000000001', empStartDate: '2020-04-17', empHiredate: '2019-12-01T00:00:00Z', addressDesc: 'عنوان تجريبي' },
        qlf: [{ qlfName: 'بكالوريوس التربية', empQlfDate: '2018-07-01' }],
        job: { jobDesc: 'معلم', kadrJobStartDate: '2021-01-01' }, notes: 'سجل محلي',
    },
};

test('reference register has RTL columns, repeated headers, unsplit rows and black double frame', async () => {
    const files = xmlParts(await buildWordExport([employee], {}, { schoolInfo: { schoolName: 'تجريبية', edaraName: 'تعليمية', mudriaName: 'تجريبية' } }));
    const body = files['word/document.xml'];
    assert.match(body, /w:orient="landscape"/);
    assert.match(body, /w:bidiVisual/);
    assert.match(body, /w:tblHeader/);
    assert.match(body, /w:cantSplit/);
    assert.match(body, /w:val="double"/);
    const [tableHeader, employeeRow] = [...body.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(match => match[0]);
    const headerCells = [...tableHeader.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
    assert.equal(headerCells.length, DEFAULT_COLUMNS.length);
    for (const cell of headerCells) {
        assert.match(cell, /w:fill="D9D9D9"/);
        assert.match(cell, /<w:color w:val="000000"\/>/);
    }
    for (const row of [tableHeader, employeeRow]) {
        for (const run of row.match(/<w:r>[\s\S]*?<\/w:r>/g)) {
            assert.match(run, /<w:b\/>/);
            assert.match(run, /<w:bCs\/>/);
        }
    }
    assert.doesNotMatch(employeeRow, /<w:color w:val="FFFFFF"\/>/);
    assert.doesNotMatch(body, /w:hRule="exact"/);
    assert.ok(body.indexOf('>م<') < body.indexOf('>الاسم<'), 'Logical RTL columns must not be reversed twice');
    assert.match(body, /00000000000001/);
    assert.match(body, /17\/04\/2020/);
    assert.match(body, /01\/12\/2019/);
    assert.match(body, /بكالوريوس التربية/);
    assert.match(body, /01\/07\/2018/);
    const header = files['word/header1.xml'];
    assert.match(header, /أسماء العاملين بالمدرسة/);
    assert.match(header, /w:pStyle w:val="Title"/);
    assert.match(header, /w:bidiVisual/);
    assert.match(header, /w:jc w:val="start"/); // School details stay at the physical right in RTL.
    assert.doesNotMatch(header, /<w:u /);
    const footer = files['word/footer1.xml'];
    assert.match(footer, /إحصاء/);
    assert.match(footer, /شؤون العاملين/);
    assert.match(footer, /مدير المدرسة/);
    assert.match(footer, /w:jc w:val="center"/);
    const widths = [...body.matchAll(/<w:gridCol w:w="(\d+)"/g)].map(match => Number(match[1]));
    assert.equal(widths.length, DEFAULT_COLUMNS.length);
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 16838 - 1440);
});

test('manual report values and custom signatures stay editable with names below roles', async () => {
    const columns = [{ type: 'manual', label: 'بيان إضافي', manualValues: { 101: '00123\nقيمة مكتوبة' } }];
    const footer = [{ label: 'مسؤول الإحصاء', name: 'اسم أول' }, { label: 'الوكيلة', name: 'اسم ثان' }, { label: 'المديرة', name: 'اسم ثالث' }, { label: 'وكيل شؤون التعليم', name: 'اسم إضافي' }];
    const files = xmlParts(await buildWordExport([{ ...employee, emp_code: 101 }], { columns, footer }));
    assert.match(files['word/document.xml'], /00123/);
    assert.match(files['word/document.xml'], /قيمة مكتوبة/);
    const arabicColumns = [{ ...columns[0], manualValues: { 101: '00123', 102: '45' } }];
    const arabic = xmlParts(await buildWordExport([{ ...employee, emp_code: 101 }, { ...employee, emp_code: 102 }], { columns: arabicColumns, useArabicNumerals: true }))['word/document.xml'];
    assert.match(arabic, />٠٠١٢٣</);
    assert.match(arabic, />٤٥</);
    assert.equal(arabicColumns[0].manualValues[101], '00123');
    assert.match(files['word/document.xml'], /w:bottom="2620"/);
    const rows = [...files['word/footer1.xml'].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)];
    assert.equal(rows.length, 2);
    const firstCell = /<w:tc>[\s\S]*?<\/w:tc>/.exec(rows[0][0])[0];
    const paragraphs = [...firstCell.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => match[0]);
    assert.equal(paragraphs.length, 2);
    assert.match(paragraphs[0], /مسؤول الإحصاء/);
    assert.doesNotMatch(paragraphs[0], /اسم أول/);
    assert.match(paragraphs[1], /اسم أول/);
    assert.match(rows[1][0], /وكيل شؤون التعليم/);
    assert.equal([...rows[1][0].matchAll(/<w:tc>/g)].length, 3);
});

test('custom merged fields, portrait and Arabic numerals preserve selected data only', async () => {
    const excluded = { ...employee, full_name: 'خارج الكشف', source: 'ministry' };
    const selected = selectEmployees([employee, excluded], { source: 'manual', search: 'تجريبي' });
    const columns = [
        { path: 'index', label: 'م' },
        { path: 'fullName', label: 'الاسم' },
        { label: 'المؤهل', type: 'merged', parts: [{ path: 'qlf.qlfName' }, { path: 'qlf.empQlfDate' }], separator: 'newline' },
        { path: 'basicInfo.nationalIdNum', label: 'الرقم القومي' },
    ];
    const body = xmlParts(await buildWordExport(selected, { columns, orientation: 'portrait', useArabicNumerals: true }))['word/document.xml'];
    assert.match(body, /w:orient="portrait"/);
    assert.match(body, /موظف تجريبي/);
    assert.doesNotMatch(body, /خارج الكشف/);
    assert.match(body, /٠١\/٠٧\/٢٠١٨/);
    assert.match(body, /٠٠٠٠٠٠٠٠٠٠٠٠٠١/);
    assert.match(body, /w:rtl w:val="false"/);
});

test('wide custom tables fit numeric body lines without shrinking employee names or headers', async () => {
    const columns = [...DEFAULT_COLUMNS, { path: 'basicInfo.tel', label: 'رقم الهاتف الأرضي' }, { path: 'notes', label: 'رقم الملف' }];
    for (const useArabicNumerals of [false, true]) {
        const body = xmlParts(await buildWordExport([employee], { columns, useArabicNumerals }))['word/document.xml'];
        const [header, data] = [...body.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(match => match[0]);
        const cells = [...data.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
        const size = cell => Number(/<w:sz w:val="(\d+)"/.exec(cell)[1]);
        assert.equal(size(cells[1]), 20, 'Employee names keep the original 10-point body font');
        for (const index of [2, 3, 4]) {
            assert.ok(size(cells[index]) >= 14 && size(cells[index]) < 20, 'Only crowded national IDs and dates receive a smaller readable font');
            assert.match(cells[index], /w:rtl w:val="false"/);
        }
        for (const headerCell of [...header.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]) assert.equal(size(headerCell[0]), 20);
        assert.match(cells[2], useArabicNumerals ? /٠٠٠٠٠٠٠٠٠٠٠٠٠١/ : /00000000000001/);
        assert.match(cells[3], useArabicNumerals ? /١٧\/٠٤\/٢٠٢٠/ : /17\/04\/2020/);
        assert.match(cells[4], useArabicNumerals ? /٠١\/١٢\/٢٠١٩/ : /01\/12\/2019/);
        assert.doesNotMatch(body, /w:noWrap|w:hRule="exact"/);
    }
});

test('empty selection produces an explanation and invalid column configurations fail clearly', async () => {
    assert.match(xmlParts(await buildWordExport([]))['word/document.xml'], /لا توجد بيانات مطابقة/);
    await assert.rejects(buildWordExport([], { columns: [] }), { status: 400 });
    await assert.rejects(buildWordExport([], { columns: [null] }), { status: 400 });
});

test('download route uses the saved school and exactly the filtered, sorted local records', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'emis-word-test-'));
    db.initDatabase({ dataDir });
    t.after(() => { db.closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });
    db.saveSetting('schoolInfo', { schoolName: 'مدرسة اختبار التصدير', edaraName: 'التجريبية', mudriaName: 'تجريبية' });
    db.createEmployee({ fullName: 'موظف تجريبي باء', jobTitle: 'معلم', staffType: 'core' });
    db.createEmployee({ fullName: 'موظف تجريبي ألف', jobTitle: 'معلم', staffType: 'core' });
    db.createEmployee({ fullName: 'خارج البحث', jobTitle: 'معلم', staffType: 'core' });
    db.createEmployee({ fullName: 'موظف تجريبي مستبعد', jobTitle: 'إداري', staffType: 'core' });
    db.upsertEmployee(9001, '', 'موظف تجريبي من الوزارة', { job: { jobDesc: 'معلم' } });
    const options = {
        title: 'كشف اختبار/محلي', search: 'تجريبي', source: 'manual', staffType: 'core',
        filters: [{ path: 'job.jobDesc', values: ['معلم'] }],
        sorting: [{ path: 'fullName', direction: 'asc' }],
        columns: [{ path: 'index', label: 'م' }, { path: 'fullName', label: 'الاسم' }],
    };
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/export/word', body: options, headers: {} });
    const result = await new Promise((resolve, reject) => {
        const res = {
            statusCode: 200, headers: {},
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            status(value) { this.statusCode = value; return this; },
            send(buffer) { resolve({ buffer, headers: this.headers, status: this.statusCode }); },
            json(value) { reject(new Error(JSON.stringify(value))); },
        };
        exportRouter.handle(req, res, error => reject(error || new Error('Export route not found')));
    });
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /wordprocessingml.document/);
    const filename = decodeURIComponent(result.headers['content-disposition'].split("filename*=UTF-8''")[1]);
    assert.equal(filename, 'كشف اختبارمحلي.docx');
    const files = xmlParts(result.buffer), body = files['word/document.xml'];
    assert.ok(body.indexOf('موظف تجريبي ألف') < body.indexOf('موظف تجريبي باء'));
    assert.match(body, /موظف تجريبي ألف/);
    assert.match(body, /موظف تجريبي باء/);
    assert.doesNotMatch(body, /خارج البحث|مستبعد|من الوزارة/);
    assert.match(files['word/header1.xml'], /مدرسة اختبار التصدير/);
});

test('saved custom list controls Word membership, including empty and deleted lists', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'emis-list-word-test-'));
    db.initDatabase({ dataDir });
    t.after(() => { db.closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });
    const included = db.createEmployee({ fullName: 'عضو القائمة المحدد' });
    const excluded = db.createEmployee({ fullName: 'موظف خارج القائمة' });
    const list = db.createCustomList({ name: 'لجنة الاختبار', memberIds: [included.emp_code] });
    const requestExport = body => new Promise((resolve, reject) => {
        const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/export/word', body, headers: {} });
        const res = { statusCode: 200, setHeader() {}, status(value) { this.statusCode = value; return this; },
            send(buffer) { resolve({ status: this.statusCode, buffer }); },
            json(value) { resolve({ status: this.statusCode, error: value.error }); } };
        exportRouter.handle(req, res, error => reject(error || new Error('Missing export route')));
    });
    const selected = await requestExport({ listId: list.id, memberIds: [excluded.emp_code] });
    assert.equal(selected.status, 200);
    const xml = xmlParts(selected.buffer)['word/document.xml'];
    assert.match(xml, /عضو القائمة المحدد/);
    assert.doesNotMatch(xml, /موظف خارج القائمة/);
    db.updateCustomList(list.id, { name: list.name, memberIds: [] });
    const empty = await requestExport({ listId: list.id });
    assert.equal(empty.status, 200);
    assert.match(xmlParts(empty.buffer)['word/document.xml'], /لا توجد بيانات مطابقة/);
    assert.doesNotMatch(xmlParts(empty.buffer)['word/document.xml'], /عضو القائمة المحدد|موظف خارج القائمة/);
    db.deleteCustomList(list.id);
    assert.equal((await requestExport({ listId: list.id })).status, 404);
    assert.equal((await requestExport({ listId: 'invalid' })).status, 400);
});
