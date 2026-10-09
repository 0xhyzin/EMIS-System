import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEmployees, getValue, columnText, DEFAULT_COLUMNS } from '../public/js/dataModel.js';

const rows = [
    { emp_code: 10, full_name: 'أحمد علي', national_id: '00000000000001', source: 'ministry', staff_type: 'core', raw_data: { basicInfo: { empHiredate: '2020-03-02' }, job: [{ jobDesc: 'معلم' }], qlf: [{ qlfName: 'تربية', empQlfDate: '2015-07-01' }] } },
    { emp_code: -1, full_name: 'إيمان حسن', national_id: '00000000000002', source: 'manual', staff_type: 'seconded', raw_data: { basicInfo: { empHiredate: '02/02/2019' }, job: { jobDesc: 'كبير معلمين' } } },
    { emp_code: -2, full_name: 'منى حسن', national_id: '00000000000003', source: 'manual', staff_type: 'core', raw_data: { basicInfo: { empHiredate: '' }, job: { jobDesc: 'غير مصنف' } } },
];
const ids = result => result.map(row => row.emp_code);

test('Arabic names and Arabic digits search preserve identifiers as text', () => {
    assert.deepEqual(ids(selectEmployees(rows, { search: 'احمد' })), [10]);
    assert.deepEqual(ids(selectEmployees(rows, { search: '٠٠٠٠٠٠٠٠٠٠٠٠٠٢' })), [-1]);
    assert.equal(columnText(rows[0], DEFAULT_COLUMNS[2]), '00000000000001');
});

test('source, staff type, include and exclude filters compose identically for preview and export', () => {
    assert.deepEqual(ids(selectEmployees(rows, { source: 'manual', staffType: 'core' })), [-2]);
    assert.deepEqual(ids(selectEmployees(rows, { filters: [{ path: 'job.jobDesc', values: ['معلم', 'كبير معلمين'], mode: 'include' }, { path: 'fullName', values: ['أحمد علي'], mode: 'exclude' }] })), [-1]);
    assert.equal(getValue(rows[0], 'job.jobDesc'), 'معلم');
    assert.equal(getValue(rows[0].raw_data, 'qlf.qlfName'), 'تربية');
});

test('chronological sort supports ISO and displayed dates, with blank dates last in both directions', () => {
    assert.deepEqual(ids(selectEmployees(rows, { sorting: [{ path: 'basicInfo.empHiredate', type: 'date', direction: 'asc' }] })), [-1, 10, -2]);
    assert.deepEqual(ids(selectEmployees(rows, { sorting: [{ path: 'basicInfo.empHiredate', type: 'date', direction: 'desc' }] })), [10, -1, -2]);
});

test('custom priority precedes unknown values and merged qualification has a real line break', () => {
    assert.deepEqual(ids(selectEmployees(rows, { sorting: [{ path: 'job.jobDesc', direction: 'custom', customOrder: ['كبير معلمين', 'معلم'] }] })), [-1, 10, -2]);
    assert.equal(columnText(rows[0], DEFAULT_COLUMNS[5]), 'تربية\n01/07/2015');
    assert.equal(columnText(rows[0], DEFAULT_COLUMNS[0], 11, { useArabicNumerals: true }), '١٢');
    assert.deepEqual(ids(rows), [10, -1, -2], 'Selections must not mutate the original employee list');
});

test('custom list selection intersects filters and an empty list never means all staff', () => {
    assert.deepEqual(ids(selectEmployees(rows, { memberIds: [10, -1, 99999] })), [10, -1]);
    assert.deepEqual(ids(selectEmployees(rows, { memberIds: [10, -1], source: 'manual' })), [-1]);
    assert.deepEqual(ids(selectEmployees(rows, { memberIds: [] })), []);
    assert.deepEqual(ids(selectEmployees(rows, { memberIds: [99999] })), []);
    assert.deepEqual(ids(selectEmployees(rows, { memberIds: null })), [10, -1, -2]);
});
