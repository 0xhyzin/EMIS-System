import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportExport, exportFormatInfo } from '../public/js/api.js';

test('Word, Excel and PDF requests keep exactly the same custom table and employee selection', () => {
  const config = {
    title: 'كشف مختار',
    columns: [{ path: 'index', isIndex: true, label: 'م' }, { isMerged: true, label: 'المؤهل وتاريخه', fields: ['qlf.qlfName', 'qlf.empQlfDate'], separator: 'newline' }, { path: 'basicInfo.nationalIdNum', label: 'الرقم القومي' }],
    orientation: 'portrait', useArabicNumerals: true, footer: ['أول', 'ثان', 'ثالث'],
    staffType: 'seconded', source: 'manual', search: 'أحمد',
    filters: [{ path: 'job.jobDesc', mode: 'include', values: ['معلم'] }],
    sorting: [{ path: 'fullName', direction: 'custom', customOrder: ['أحمد', 'علي'] }], listId: 7,
  };
  const before = structuredClone(config);
  const word = createReportExport(config, 'word');
  const excel = createReportExport(config, 'excel');
  const pdf = createReportExport(config, 'pdf');
  assert.equal(word.url, '/api/export/word');
  assert.equal(excel.url, '/api/export/excel');
  assert.equal(word.filename, 'كشف مختار.docx');
  assert.equal(excel.filename, 'كشف مختار.xlsx');
  assert.equal(pdf.url, '/api/export/pdf');
  assert.equal(pdf.filename, 'كشف مختار.pdf');
  assert.deepEqual(pdf.options, word.options);
  assert.deepEqual(excel.options, word.options);
  assert.deepEqual(JSON.parse(word.options.body), config);
  assert.deepEqual(config, before);
});

test('hourly model keeps keyed teacher details in all three formats', () => {
  const config = { modelId: 'hourly-contract-period-1', modelOptions: {
    subject: 'الرياضيات', periodStart: '2026-10-01', periodEnd: '2026-10-31',
    rows: { 'employee:42:fixture': { monthlySessions: '48', amount: '3600', paymentDestination: 'البنك' } },
  }, listId: 8, sorting: [{ path: 'fullName', direction: 'desc' }] };
  for (const format of ['word', 'excel', 'pdf']) {
    const report = createReportExport(config, format);
    assert.ok(report.filename.startsWith('نموذج 2 بالحصة'));
    assert.ok(report.filename.endsWith(`.${exportFormatInfo(format).extension}`));
    assert.deepEqual(JSON.parse(report.options.body), config);
  }
});

test('file names remove filesystem separators without changing the table title', () => {
  const config = { title: 'كشف/أكتوبر:تجربة', columns: [{ path: 'fullName', label: 'الاسم' }] };
  const report = createReportExport(config, 'excel');
  assert.equal(report.filename, 'كشف-أكتوبر-تجربة.xlsx');
  assert.equal(JSON.parse(report.options.body).title, config.title);
});

test('unsupported formats and inherited object properties cannot select an export route', () => {
  for (const format of ['csv', 'png', '__proto__', 'constructor', '', null]) {
    assert.throws(() => createReportExport({}, format), /Word أو Excel/);
  }
});
