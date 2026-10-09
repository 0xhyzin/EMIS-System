import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildHourlyModelWord } from '../utils/exportHourlyModel.js';
import { buildWordExport } from '../utils/exportWord.js';
import { hourlyEmployeeKey } from '../public/js/reportModels.js';
import exportRouter from '../routes/export.js';
import * as db from '../db/database.js';

// The generated Word file is a ZIP archive. Inspect its actual document parts
// so these checks cover the downloaded document, not the source object tree.
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

function xmlText(fragment) {
  return [...fragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(match => match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')).join('');
}

function documentRows(xml) {
  return [...xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)]
    .map(match => [...match[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)]
      .map(cell => xmlText(cell[0])));
}

const headings = [
  'م', 'اسم المدرسة', 'اسم المعلم', 'الرقم القومي', 'المؤهل', 'التخصص',
  'المادة التعليمية', 'الحصص الفعلية شهريا', 'المبلغ',
  'الجهة المحول عليها أمر الدفع ( البريد - البنك )',
];
const signatures = [
  'مسئول شئون العاملين', 'مدير المدرسة', 'موجه المادة - موجه أول المادة',
  'الموجه المالي والإداري', 'مدير الإدارة التعليمية',
];

// The source spreadsheet differs in optional Arabic diacritics and spacing.
const sameLabel = value => value.normalize('NFKC').replace(/[\u064b-\u065f\u0670]/g, '')
  .replace(/\s+/g, ' ').replace(/\s*([()\-])\s*/g, '$1').trim();

function sampleEmployee(number) {
  return {
    emp_code: number,
    full_name: `معلم تجريبي ${number}`,
    national_id: String(number).padStart(14, '0'),
    source: 'manual',
    raw_data: {
      basicInfo: { schoolName: 'مدرسة التجربة', nationalIdNum: String(number).padStart(14, '0'), brchDesc: 'تربية ابتدائية' },
      qlf: [{ qlfName: 'بكالوريوس تربية' }],
      job: [{ subjectDesc: 'لغة عربية' }],
    },
  };
}

test('blank hourly form is an A4 landscape RTL Word page with the reference headings and twelve empty numbered lines', async () => {
  const parts = xmlParts(await buildHourlyModelWord([], {}, { schoolInfo: { schoolName: 'مدرسة التجربة' } }));
  const xml = parts['word/document.xml'];
  assert.ok(xml, 'A DOCX document part must exist');
  assert.match(xml, /w:orient="landscape"/);
  assert.match(xml, /w:bidiVisual/);
  assert.match(xml, /المعلمين المستعان بهم من الخارج \( الحصة \) دون سن الستين/);
  assert.match(xml, /الفترة الأولى/);
  assert.match(xml, /نموذج \(2\)/);
  assert.match(xml, /مدرسة التجربة/);
  const rows = documentRows(xml);
  const header = rows.find(row => row.length === 10 && row[0] === 'م');
  assert.ok(header, 'The ten-column grid header must exist');
  assert.deepEqual(header.map(sameLabel), headings.map(sameLabel));
  const data = rows.filter(row => row.length === 10 && /^\d+$/.test(row[0]));
  assert.equal(data.length, 12);
  assert.deepEqual(data.map(row => row[0]), Array.from({ length: 12 }, (_, index) => String(index + 1)));
  assert.ok(data.every(row => row.slice(1).every(value => value === '')));
  for (const label of signatures) assert.match(xml, new RegExp(label));
});

test('selected teacher fills all ten cells, including the form-only hours, amount and payment destination', async () => {
  const employee = sampleEmployee(101);
  const key = hourlyEmployeeKey(employee);
  const xml = xmlParts(await buildHourlyModelWord([employee], {
    subject: 'لغة عربية', periodStart: '2026-09-12', periodEnd: '2026-09-30',
    rows: { [key]: { specialization: 'تخصص اختياري', educationalSubject: 'القراءة', monthlySessions: '12', amount: '300.50', paymentDestination: 'البريد المصري' } },
  }, { schoolInfo: { schoolName: 'مدرسة التجربة' } }))['word/document.xml'];
  const data = documentRows(xml).find(row => row.length === 10 && row[0] === '1');
  assert.deepEqual(data, [
    '1', 'مدرسة التجربة', 'معلم تجريبي 101', '00000000000101', 'بكالوريوس تربية',
    'تخصص اختياري', 'القراءة', '12', '300.50', 'البريد المصري',
  ]);
  assert.match(xml, /الفترة من 12 \/ 9 \/ 2026 إلى 30 \/ 9 \/ 2026/);
  assert.match(xml, /مادة \( لغة عربية \)/);
});

test('thirteen teachers create two numbered pages with repeated column headings and approval signatures', async () => {
  const employees = Array.from({ length: 13 }, (_, index) => sampleEmployee(index + 101));
  const xml = xmlParts(await buildHourlyModelWord(employees))['word/document.xml'];
  const rows = documentRows(xml);
  const headers = rows.filter(row => row.length === 10 && row[0] === 'م');
  assert.equal(headers.length, 2);
  assert.deepEqual(headers.map(row => row.map(sameLabel)), [headings.map(sameLabel), headings.map(sameLabel)]);
  for (const label of signatures) assert.equal(xml.split(label).length - 1, 2, `${label} should appear on each page`);
  assert.equal(xml.split('المعلمين المستعان بهم من الخارج ( الحصة ) دون سن الستين').length - 1, 2);
  assert.match(xml, /w:pageBreakBefore/);
  const data = rows.filter(row => row.length === 10 && /^\d+$/.test(row[0]));
  assert.equal(data.length, 24);
  assert.deepEqual(data.map(row => row[0]), Array.from({ length: 24 }, (_, index) => String(index + 1)));
  assert.equal(data[12][2], 'معلم تجريبي 113');
  assert.ok(data.slice(13).every(row => row.slice(1).every(value => value === '')));
});

test('hourly download uses saved list membership and ordinary register generation remains available', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'emis-hourly-word-'));
  db.initDatabase({ dataDir });
  t.after(() => { db.closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });
  db.saveSetting('schoolInfo', { schoolName: 'مدرسة التجربة' });
  const included = db.createEmployee({ fullName: 'معلم مدرج', nationalId: '00000000000101' });
  const excluded = db.createEmployee({ fullName: 'معلم خارج القائمة', nationalId: '00000000000102' });
  const list = db.createCustomList({ name: 'نموذج بالحصة', memberIds: [included.emp_code] });
  const requestExport = body => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/export/word', body, headers: {} });
    const res = { statusCode: 200, headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(value) { this.statusCode = value; return this; },
      send(buffer) { resolve({ status: this.statusCode, buffer, headers: this.headers }); },
      json(value) { reject(new Error(JSON.stringify(value))); } };
    exportRouter.handle(req, res, error => reject(error || new Error('Export route missing')));
  });
  const result = await requestExport({ modelId: 'hourly-contract-period-1', listId: list.id,
    memberIds: [excluded.emp_code], modelOptions: { periodStart: '', periodEnd: '', subject: '', rows: {} } });
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /wordprocessingml.document/);
  const xml = xmlParts(result.buffer)['word/document.xml'];
  assert.match(xml, /معلم مدرج/);
  assert.doesNotMatch(xml, /معلم خارج القائمة/);
  assert.match(xml, /المعلمين المستعان بهم من الخارج/);
  const ordinary = xmlParts(await buildWordExport([sampleEmployee(101)]));
  assert.match(ordinary['word/document.xml'], /معلم تجريبي 101/);
  assert.match(ordinary['word/header1.xml'], /أسماء العاملين بالمدرسة/);
});
