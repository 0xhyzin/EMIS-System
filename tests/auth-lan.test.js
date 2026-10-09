import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { findLanAddresses, isPrivateIPv4, lanConfiguration, startLan } from '../scripts/start-lan.js';

const address = (ip, options = {}) => ({ address: ip, family: 'IPv4', internal: false, ...options });

test('LAN discovery prefers Ethernet then Wi-Fi, ignoring public, VPN and virtual interfaces', () => {
    const interfaces = {
        lo: [address('127.0.0.1', { internal: true })],
        wlan0: [address('192.168.1.12'), address('fe80::1', { family: 'IPv6' })],
        docker0: [address('172.17.0.1')],
        wg0: [address('10.44.0.2')],
        eth1: [address('203.0.113.12')],
        eth0: [address('10.0.0.5'), address('10.0.0.5')],
    };
    assert.deepEqual(findLanAddresses(interfaces), [
        { name: 'eth0', address: '10.0.0.5' },
        { name: 'wlan0', address: '192.168.1.12' },
    ]);
    const config = lanConfiguration({ PORT: '3100', DATA_DIR: '/fixture/data', NODE_OPTIONS: '--no-warnings' }, interfaces);
    assert.equal(config.origin, 'http://10.0.0.5:3100');
    assert.equal(config.childEnv.HOST, '0.0.0.0');
    assert.equal(config.childEnv.ALLOW_INSECURE_LAN, 'true');
    assert.equal(config.childEnv.DATA_DIR, '/fixture/data');
    assert.equal(config.childEnv.NODE_OPTIONS, '--no-warnings');
});

test('explicit LAN origin wins, while invalid or public origins and mismatching ports fail closed', () => {
    const interfaces = { Ethernet: [address('192.168.1.12')] };
    const chosen = lanConfiguration({ APP_ORIGIN: 'http://192.168.2.44:3300' }, interfaces);
    assert.equal(chosen.origin, 'http://192.168.2.44:3300');
    assert.equal(chosen.port, 3300);
    for (const origin of ['http://203.0.113.1:3000', 'http://example.com:3000', 'http://127.0.0.1:3000', 'http://user:pass@192.168.1.12:3000', 'http://192.168.1.12:3000/path']) {
        assert.throws(() => lanConfiguration({ APP_ORIGIN: origin }, interfaces));
    }
    assert.throws(() => lanConfiguration({ APP_ORIGIN: 'http://192.168.1.12:3300', PORT: '3000' }, interfaces));
    assert.throws(() => lanConfiguration({ PORT: '65536' }, interfaces));
    assert.throws(() => lanConfiguration({}, { docker0: [address('172.17.0.1')] }));
    assert.equal(isPrivateIPv4('172.15.9.1'), false);
    assert.equal(isPrivateIPv4('172.16.9.1'), true);
    assert.equal(isPrivateIPv4('192.168.999.1'), false);
});

test('launcher uses the active Node executable, inherits data settings and forwards graceful signals', () => {
    const previousCode = process.exitCode;
    const calls = [];
    const child = new EventEmitter();
    child.killed = false;
    child.kill = signal => { calls.push(signal); return true; };
    const before = process.listenerCount('SIGTERM');
    const launched = startLan({ env: { DATA_DIR: '/fixture/school', PORT: '3100' },
        interfaces: { Ethernet: [address('192.168.1.12')] },
        spawnImpl: (executable, args, options) => {
            assert.equal(executable, process.execPath);
            assert.ok(args[0].endsWith('server.js'));
            assert.equal(options.stdio, 'inherit');
            assert.equal(options.env.DATA_DIR, '/fixture/school');
            assert.equal(options.env.APP_ORIGIN, 'http://192.168.1.12:3100');
            return child;
        } });
    assert.equal(launched, child);
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    const handler = process.listeners('SIGTERM').at(-1);
    handler();
    assert.deepEqual(calls, ['SIGTERM']);
    child.emit('exit', 0, null);
    assert.equal(process.listenerCount('SIGTERM'), before);
    process.exitCode = previousCode;
});
