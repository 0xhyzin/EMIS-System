import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };
const HASH_PREFIX = `scrypt$v1$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}`;
const COOKIE_VERSION = 'v1';

function passwordIsBounded(password) {
    return typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 1024;
}

function decodeCanonical(value, bytes) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null;
}

export function hashOwnerPassword(password) {
    if (!passwordIsBounded(password) || password.length < 12) throw new Error('Owner password must contain at least 12 characters and at most 1024 UTF-8 bytes.');
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 32, SCRYPT_OPTIONS);
    return `${HASH_PREFIX}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function ownerPasswordHashIsValid(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 160) return false;
    const fields = encoded.split('$');
    return fields.length === 7 && fields.slice(0, 5).join('$') === HASH_PREFIX
        && !!decodeCanonical(fields[5], 16) && !!decodeCanonical(fields[6], 32);
}

export function verifyOwnerPassword(password, encoded) {
    if (!passwordIsBounded(password) || !ownerPasswordHashIsValid(encoded)) return false;
    const fields = encoded.split('$');
    const actual = scryptSync(password, decodeCanonical(fields[5], 16), 32, SCRYPT_OPTIONS);
    return timingSafeEqual(actual, decodeCanonical(fields[6], 32));
}

function secretIsValid(secret) {
    return typeof secret === 'string' && secret.length >= 32 && secret.length <= 4096;
}

function claimIsValid(claim) {
    return !!claim && typeof claim === 'object' && !Array.isArray(claim)
        && Object.keys(claim).length === 2 && Object.hasOwn(claim, 'token') && Object.hasOwn(claim, 'expiresAt')
        && typeof claim.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(claim.token)
        && Number.isSafeInteger(claim.expiresAt) && claim.expiresAt > 0;
}

export function signCloudSession(claim, secret) {
    if (!secretIsValid(secret)) throw new Error('EMIS_SESSION_SECRET must contain at least 32 characters.');
    if (!claimIsValid(claim)) throw new Error('Invalid cloud session claim.');
    const payload = Buffer.from(JSON.stringify({ token: claim.token, expiresAt: claim.expiresAt })).toString('base64url');
    const signed = `${COOKIE_VERSION}.${payload}`;
    const signature = createHmac('sha256', secret).update(signed).digest('base64url');
    return `${signed}.${signature}`;
}

/** The gateway may check this signature; runtime must still check AuthStore for revocation. */
export function verifyCloudSession(cookie, secret, now = Date.now()) {
    if (!secretIsValid(secret) || typeof cookie !== 'string' || cookie.length > 512 || !Number.isSafeInteger(now)) return null;
    const parts = cookie.split('.');
    if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    const signature = decodeCanonical(parts[2], 32);
    if (!signature) return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (!timingSafeEqual(signature, expected)) return null;
    try {
        const json = Buffer.from(parts[1], 'base64url');
        if (json.toString('base64url') !== parts[1]) return null;
        const claim = JSON.parse(json.toString('utf8'));
        return claimIsValid(claim) && claim.expiresAt > now ? { token: claim.token, expiresAt: claim.expiresAt } : null;
    } catch { return null; }
}

export function signCloudPairing(code, expiresAt, secret) {
    if (!/^\d{8}$/.test(code)) throw new Error('Invalid pairing code.');
    const token = createHmac('sha256', secret).update(`pair:${code}`).digest('base64url');
    return signCloudSession({ token, expiresAt }, secret);
}
export function verifyCloudPairing(code, proof, secret, now = Date.now()) {
    if (typeof code !== 'string' || !/^\d{8}$/.test(code)) return false;
    const claim = verifyCloudSession(proof, secret, now);
    if (!claim || claim.expiresAt > now + 5 * 60_000) return false;
    const token = createHmac('sha256', secret).update(`pair:${code}`).digest('base64url');
    return timingSafeEqual(Buffer.from(token), Buffer.from(claim.token));
}
