import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');

/** Opaque browser sessions and encrypted ministry credentials stay on this computer. */
export class AuthStore {
    constructor(dataDir, { now = () => Date.now() } = {}) {
        this.now = now;
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const keyPath = join(dataDir, 'auth.key');
        if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
        this.key = readFileSync(keyPath);
        if (this.key.length !== 32) throw new Error('Invalid authentication encryption key');
        const databasePath = join(dataDir, 'auth.sqlite');
        this.db = new DatabaseSync(databasePath);
        this.db.exec(`
            PRAGMA journal_mode = DELETE;
            CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user TEXT NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pairing (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        `);
        for (const path of [keyPath, databasePath]) {
            try { chmodSync(path, 0o600); } catch { /* Windows uses filesystem ACLs instead. */ }
        }
        this.prune();
    }

    prune() {
        this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
        this.db.prepare('DELETE FROM pairing WHERE expires_at <= ?').run(this.now());
    }

    createSession(user, ttl = 30 * 24 * 60 * 60 * 1000) {
        this.prune();
        const token = randomBytes(32).toString('base64url');
        const expiresAt = this.now() + ttl;
        this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), JSON.stringify(user), expiresAt);
        return { token, user, expiresAt };
    }

    getSession(token) {
        if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
        const row = this.db.prepare('SELECT user, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), this.now());
        return row ? { user: JSON.parse(row.user), expiresAt: row.expires_at } : null;
    }

    deleteSession(token) {
        if (typeof token === 'string') this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    }

    clearSessions() { this.db.exec('DELETE FROM sessions; DELETE FROM pairing;'); }

    putSecret(name, value) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(name));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        const stored = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        this.db.prepare('INSERT INTO secrets VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET encrypted=excluded.encrypted').run(name, stored);
    }

    getSecret(name) {
        const row = this.db.prepare('SELECT encrypted FROM secrets WHERE name = ?').get(name);
        if (!row) return null;
        try {
            const value = Buffer.from(row.encrypted, 'base64');
            const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
            decipher.setAAD(Buffer.from(name));
            decipher.setAuthTag(value.subarray(12, 28));
            return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'));
        } catch {
            this.deleteSecret(name);
            return null;
        }
    }

    deleteSecret(name) { this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name); }

    createPairing(code, ttl = 5 * 60 * 1000) {
        this.db.exec('DELETE FROM pairing');
        const expiresAt = this.now() + ttl;
        this.db.prepare('INSERT INTO pairing VALUES (?, ?)').run(hash(code), expiresAt);
        return expiresAt;
    }

    consumePairing(code) {
        this.prune();
        if (typeof code !== 'string' || !/^\d{8}$/.test(code)) return false;
        const result = this.db.prepare('DELETE FROM pairing WHERE code_hash = ? AND expires_at > ? RETURNING code_hash').get(hash(code), this.now());
        return !!result;
    }

    close() { this.db.close(); }
}
