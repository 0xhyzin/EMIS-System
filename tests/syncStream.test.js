import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSyncStream } from '../public/js/syncStream.js';

test('sync stream preserves split Arabic characters and SSE events across transport chunks', async () => {
  const wire = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"step":"fetching_details","message":"بيانات المعلم"}\r\n\r\ndata: {"step":"done","mode":"normal"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (let i=0;i<wire.length;i+=3) controller.enqueue(wire.slice(i,i+3)); controller.close(); } });
  const events=[];
  await consumeSyncStream(new Response(stream), event=>events.push(event));
  assert.deepEqual(events.map(event=>event.step), ['fetching_details','done']);
  assert.equal(events[0].message, 'بيانات المعلم');
});

test('HTTP refusal and interrupted stream are errors while a final aborted sync is delivered once', async () => {
  await assert.rejects(consumeSyncStream(new Response(JSON.stringify({error:'التأكيد مطلوب'}),{status:400}),()=>{}), /التأكيد مطلوب/);
  await assert.rejects(consumeSyncStream(new Response('data: {"step":"fetching_list"}\n\n'),()=>{}), /انقطع الاتصال/);
  const events=[];
  await consumeSyncStream(new Response('data: {"step":"error","aborted":true,"committed":false}\n\n'),event=>events.push(event));
  assert.equal(events.length,1); assert.equal(events[0].committed,false);
});
