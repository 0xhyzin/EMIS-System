import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

export function initDatabase() {
    db = new DatabaseSync(join(dataDir, 'school.db'));

    db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
            emp_code INTEGER PRIMARY KEY,
            national_id TEXT,
            full_name TEXT,
            raw_data TEXT,
            staff_type TEXT DEFAULT 'core',
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS reference_values (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_key TEXT NOT NULL,
            field_label TEXT NOT NULL,
            field_value TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            UNIQUE(field_key, field_value)
        );

        CREATE TABLE IF NOT EXISTS table_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            columns TEXT,
            sorting TEXT,
            footer TEXT,
            title TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    
    // Add staff_type column if not exists (for migration)
    try {
        db.exec(`ALTER TABLE employees ADD COLUMN staff_type TEXT DEFAULT 'core'`);
    } catch(e) {
        // column already exists
    }
    
    console.log("Database initialized.");
}

export function saveSetting(key, value) {
    const stmt = db.prepare(`
        INSERT INTO settings (key, value) 
        VALUES (?, ?) 
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, typeof value === 'object' ? JSON.stringify(value) : value);
}

export function getSetting(key) {
    const stmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const row = stmt.get(key);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        return row.value;
    }
}

export function upsertEmployee(empCode, nationalId, fullName, rawData, staffType = 'core') {
    const stmt = db.prepare(`
        INSERT INTO employees (emp_code, national_id, full_name, raw_data, staff_type, last_updated)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(emp_code) DO UPDATE SET 
            national_id = excluded.national_id,
            full_name = excluded.full_name,
            raw_data = excluded.raw_data,
            staff_type = excluded.staff_type,
            last_updated = CURRENT_TIMESTAMP
    `);
    stmt.run(empCode, nationalId, fullName, typeof rawData === 'object' ? JSON.stringify(rawData) : rawData, staffType);
}

export function getAllEmployees(staffTypeFilter) {
    let stmt;
    if (staffTypeFilter === 'core' || staffTypeFilter === 'seconded') {
        stmt = db.prepare(`SELECT * FROM employees WHERE staff_type = ?`);
        const rows = stmt.all(staffTypeFilter);
        return rows.map(r => ({
            ...r,
            raw_data: JSON.parse(r.raw_data)
        }));
    } else {
        stmt = db.prepare(`SELECT * FROM employees`);
        const rows = stmt.all();
        return rows.map(r => ({
            ...r,
            raw_data: JSON.parse(r.raw_data)
        }));
    }
}

export function getEmployee(empCode) {
    const stmt = db.prepare(`SELECT * FROM employees WHERE emp_code = ?`);
    const row = stmt.get(empCode);
    if (!row) return null;
    return {
        ...row,
        raw_data: JSON.parse(row.raw_data)
    };
}

export function getEmployeeCount() {
    const totalRow = db.prepare(`SELECT COUNT(*) as count FROM employees`).get();
    const coreRow = db.prepare(`SELECT COUNT(*) as count FROM employees WHERE staff_type = 'core'`).get();
    const secondedRow = db.prepare(`SELECT COUNT(*) as count FROM employees WHERE staff_type = 'seconded'`).get();
    const lastUpdatedRow = db.prepare(`SELECT MAX(last_updated) as last_updated FROM employees`).get();
    return {
        total: totalRow.count,
        core: coreRow.count,
        seconded: secondedRow.count,
        lastUpdated: lastUpdatedRow.last_updated
    };
}

export function clearReferenceValues() {
    db.prepare(`DELETE FROM reference_values`).run();
}

export function addReferenceValue(fieldKey, fieldLabel, fieldValue) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO reference_values (field_key, field_label, field_value)
        VALUES (?, ?, ?)
    `);
    stmt.run(fieldKey, fieldLabel, fieldValue);
}

export function getReferenceValues(fieldKey) {
    const stmt = db.prepare(`SELECT * FROM reference_values WHERE field_key = ? ORDER BY sort_order ASC, id ASC`);
    return stmt.all();
}

export function getAllReferenceFields() {
    const stmt = db.prepare(`SELECT DISTINCT field_key, field_label FROM reference_values`);
    return stmt.all();
}

export function updateReferenceOrder(fieldKey, orderedValues) {
    const stmt = db.prepare(`UPDATE reference_values SET sort_order = ? WHERE field_key = ? AND field_value = ?`);
    db.exec('BEGIN');
    try {
        orderedValues.forEach((val, index) => {
            stmt.run(index, fieldKey, val);
        });
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

export function saveTableConfig(name, columns, sorting, footer, title) {
    const stmt = db.prepare(`
        INSERT INTO table_configs (name, columns, sorting, footer, title)
        VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        name, 
        JSON.stringify(columns), 
        JSON.stringify(sorting), 
        JSON.stringify(footer), 
        title
    );
    return result.lastInsertRowid;
}

export function getTableConfigs() {
    const stmt = db.prepare(`SELECT id, name, title, created_at, updated_at FROM table_configs`);
    return stmt.all();
}

export function getTableConfig(id) {
    const stmt = db.prepare(`SELECT * FROM table_configs WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return null;
    return {
        ...row,
        columns: JSON.parse(row.columns),
        sorting: JSON.parse(row.sorting),
        footer: JSON.parse(row.footer)
    };
}

export function deleteTableConfig(id) {
    const stmt = db.prepare(`DELETE FROM table_configs WHERE id = ?`);
    stmt.run(id);
}

export function getLastUpdateTime() {
    const row = db.prepare(`SELECT MAX(last_updated) as last_updated FROM employees`).get();
    return row.last_updated;
}
