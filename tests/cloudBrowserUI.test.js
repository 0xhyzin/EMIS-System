import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPoint, createBrowserPoller, createBrowserLogin } from '../public/js/cloudBrowser.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('login immediately shows loading, blocks duplicate starts and displays the start failure', async () => {
  const reply = deferred(), events = [];
  let starts = 0;
  const flow = createBrowserLogin({ prepare: async () => {}, start: () => { starts++; return reply.promise; }, close: async () => {},
    onPending: () => events.push('loading'), onReady: () => events.push('ready'), onError: e => events.push(e.message) });
  const attempt = flow.begin();
  assert.deepEqual(events, ['loading']);
  assert.equal(flow.begin(), attempt);
  await tick(); assert.equal(starts, 1);
  reply.reject(new Error('وزارة غير متاحة'));
  await attempt; assert.deepEqual(events, ['loading', 'وزارة غير متاحة']);
});

test('closing during version validation prevents a login from launching later', async () => {
  const validation = deferred(), events = [];
  const flow = createBrowserLogin({ prepare: () => validation.promise, start: async () => events.push('start'), close: async () => events.push('close'),
    onPending: () => {}, onReady: () => events.push('ready'), onError: () => events.push('error') });
  flow.begin(); await tick(); const closed = flow.end(); validation.resolve(); await closed;
  assert.deepEqual(events, []);
});

test('closing during start ignores its result and reopening waits for backend close', async () => {
  const reply = deferred(), closing = deferred(), events = [];
  let starts = 0;
  const flow = createBrowserLogin({ prepare: async () => {}, start: () => { starts++; return starts === 1 ? reply.promise : Promise.resolve(); },
    close: () => { events.push('close'); return closing.promise; }, onPending: () => {}, onReady: () => events.push('ready'), onError: () => events.push('error') });
  flow.begin(); await tick(); flow.end(); const reopened = flow.begin();
  reply.resolve(); await tick(); assert.equal(starts, 1); assert.deepEqual(events, ['close']);
  closing.resolve(); await reopened; assert.equal(starts, 2); assert.deepEqual(events, ['close', 'ready']);
  await flow.end();
});

test('mobile click positions follow the displayed screenshot rather than page coordinates', () => {
  const bounds = { left: 12, top: 250, width: 360, height: 273.6 };
  const viewport = { width: 1000, height: 760 };
  assert.deepEqual(browserPoint({ clientX: 192, clientY: 386.8 }, bounds, viewport), { x: 500, y: 380 });
  assert.deepEqual(browserPoint({ clientX: 371.9, clientY: 523.5 }, bounds, viewport), { x: 999, y: 759 });
  assert.equal(browserPoint({ clientX: 11, clientY: 250 }, bounds, viewport), null);
  assert.equal(browserPoint({ clientX: 372, clientY: 250 }, bounds, viewport), null);
  assert.equal(browserPoint({ clientX: 50, clientY: 200 }, bounds, viewport), null);
  assert.equal(browserPoint({ clientX: 0, clientY: 0 }, { width: 0, height: 0 }, viewport), null);
});

test('closing the browser aborts pending frames and ignores a late result without restarting polling', async () => {
  let resolveRead, signal;
  const applied = [], scheduled = [];
  const poller = createBrowserPoller({
    read: receivedSignal => { signal = receivedSignal; return new Promise(resolve => { resolveRead = resolve; }); },
    apply: frame => applied.push(frame), onError: error => { throw error; },
    setTimer: (fn, delay) => { scheduled.push({ fn, delay }); return 1; }, clearTimer: () => {},
  });
  poller.start(); assert.equal(signal.aborted, false);
  poller.stop(); assert.equal(signal.aborted, true);
  resolveRead({ privateFrame: 'not displayed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, []); assert.deepEqual(scheduled, []);
});

test('frame polling does not overlap, uses at least one second, and pauses while the page is hidden', async () => {
  let visible = true, reads = 0;
  const scheduled = [], errors = [];
  const poller = createBrowserPoller({
    read: async () => { reads++; return reads; }, apply: () => {}, onError: error => errors.push(error),
    isVisible: () => visible, interval: 5,
    setTimer: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; }, clearTimer: () => {},
  });
  poller.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(scheduled.length, 1); assert.equal(scheduled[0].delay, 1000);
  visible = false; await scheduled[0].fn(); assert.equal(reads, 1);
  visible = true; await scheduled[1].fn(); assert.equal(reads, 2);
  assert.deepEqual(errors, []); poller.stop();
});
