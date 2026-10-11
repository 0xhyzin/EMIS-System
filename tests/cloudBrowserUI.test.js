import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPoint, createBrowserPoller } from '../public/js/cloudBrowser.js';

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
