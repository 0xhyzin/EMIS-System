import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as db from '../db/database.js';
import { createApiRouter } from '../routes/api.js';
import {
  DEFAULT_HOURLY_OPTIONS, REPORT_MODELS, getReportModel, hourlyEmployeeKey,
  hourlyRow, normalizeHourlyOptions,
} from '../public/js/reportModels.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'emis-report-models-')); db.initDatabase({ dataDir: dir }); });
afterEach(() => { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });

function request(path, method = 'GET', body) {
  const router = createApiRouter();
  const req = Object.assign(new EventEmitter(), { method, url: path, originalUrl: path, headers: {}, body });
  return new Promise((resolve, reject) => {
    let output = '';
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: false, destroyed: false, headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(value = '') { output += value; this.writableEnded = true; resolve({ status: this.statusCode, body: JSON.parse(output) }); return this; },
      json(value) { return this.end(JSON.stringify(value)); },
      send(value) { return this.end(value); },
    });
    router.handle(req, res, error => error ? reject(error) : res.status(404).json({ error: 'غير موجود' }));
  });
}

test('registry keeps legacy staff register and exposes an independently selectable hourly model', () => {
  assert.deepEqual(REPORT_MODELS.map(model => model.id), ['staff-register', 'hourly-contract-period-1']);
  assert.equal(getReportModel('hourly-contract-period-1').kind, 'hourly-contract');
  assert.equal(getReportModel('missing'), null);
});

test('hourly rows derive school and employee values, with explicit printable overrides', () => {
  db.upsertEmployee(150, '29001010000005', 'ندى أحمد', {
    basicInfo: { empCode: 150, nationalIdNum: '29001010000005', brchDesc: 'تربية رياضية' },
    qlf: [{ qlfName: 'بكالوريوس تربية' }],
    job: [{ subjectDesc: 'التربية الرياضية' }],
  });
  const employee = db.getEmployee(150);
  assert.deepEqual(hourlyRow(employee, { schoolName: 'مدرسة النيل' }), [
    '', 'مدرسة النيل', 'ندى أحمد', '29001010000005', 'بكالوريوس تربية',
    'تربية رياضية', 'التربية الرياضية', '', '', '',
  ]);
  assert.deepEqual(hourlyRow(employee, { schoolName: 'مدرسة النيل' }, {
    specialization: '', educationalSubject: 'أنشطة', monthlySessions: '12', amount: '240', paymentDestination: 'الإدارة',
  }).slice(5), ['', 'أنشطة', '12', '240', 'الإدارة']);
  assert.match(hourlyEmployeeKey(employee), /^150:[0-9a-f]{16}$/);
  assert.equal(hourlyEmployeeKey(employee), hourlyEmployeeKey({ ...employee, full_name: 'تهجئة مصححة' }));
  assert.notEqual(hourlyEmployeeKey(employee), hourlyEmployeeKey({ ...employee, national_id: '29001010000006', raw_data: { ...employee.raw_data, basicInfo: { ...employee.raw_data.basicInfo, nationalIdNum: '29001010000006' } } }));
  assert.notEqual(hourlyEmployeeKey(employee), hourlyEmployeeKey({ ...employee, emp_code: 151 }));
  const noNationalId = { ...employee, national_id: '', raw_data: { ...employee.raw_data, basicInfo: { ...employee.raw_data.basicInfo, nationalIdNum: '' } } };
  assert.notEqual(hourlyEmployeeKey(noNationalId), hourlyEmployeeKey({ ...noNationalId, full_name: 'شخص آخر' }));
});

test('model settings save through API and survive database restart without changing staff settings', async () => {
  const endpoint = '/report-models/hourly-contract-period-1/settings';
  assert.deepEqual((await request(endpoint)).body, DEFAULT_HOURLY_OPTIONS);
  db.upsertEmployee(150, '29001010000005', 'ندى أحمد', {});
  const key = hourlyEmployeeKey(db.getEmployee(150));
  const input = {
    periodStart: '2026-09-12', periodEnd: '2026-09-30', subject: 'الرياضيات',
    rows: { [key]: { specialization: 'تعليم ابتدائي', educationalSubject: '', monthlySessions: '١٢', amount: '۲۴۰٫۵۰', paymentDestination: 'الإدارة' } },
  };
  const saved = await request(endpoint, 'PUT', input);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rows[key].monthlySessions, '12');
  assert.equal(saved.body.rows[key].amount, '240.50');
  assert.equal(saved.body.rows[key].educationalSubject, '');
  db.closeDatabase(); db.initDatabase({ dataDir: dir });
  assert.deepEqual((await request(endpoint)).body, saved.body);
  assert.deepEqual(db.getTableConfigs(), []);
});

test('invalid model, dates, rows and unknown fields are rejected without replacing saved settings', async () => {
  const endpoint = '/report-models/hourly-contract-period-1/settings';
  assert.equal((await request('/report-models/unknown/settings')).status, 404);
  assert.equal((await request('/report-models/staff-register/settings', 'PUT', {})).status, 404);
  const valid = { periodStart: '2026-09-12', periodEnd: '2026-09-30', subject: 'لغة عربية', rows: {} };
  assert.equal((await request(endpoint, 'PUT', valid)).status, 200);
  const invalid = [
    { ...valid, periodStart: '2026-02-30' },
    { ...valid, periodEnd: '2026-09-01' },
    { ...valid, subject: 'س'.repeat(121) },
    { ...valid, surprise: true },
    { ...valid, rows: { '1:0123456789abcdef': { rogue: 'value' } } },
    { ...valid, rows: { '1:0123456789abcdef': { amount: '12.345' } } },
    { ...valid, rows: { '1:0123456789abcdef': { monthlySessions: '-3' } } },
    { ...valid, rows: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`${i + 1}:0123456789abcdef`, { amount: '1' }])) },
  ];
  for (const candidate of invalid) {
    assert.equal((await request(endpoint, 'PUT', candidate)).status, 400);
    assert.deepEqual((await request(endpoint)).body, valid);
  }
  assert.deepEqual(normalizeHourlyOptions(valid), valid);
});
