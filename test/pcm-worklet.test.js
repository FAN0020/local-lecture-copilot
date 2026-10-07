import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { flushPcmWorklet } from '../web/pcm-worklet-client.js';

const source = await fs.readFile(new URL('../web/pcm-worklet.js', import.meta.url), 'utf8');

function processorHarness() {
  const messages = [];
  let Processor;
  vm.runInNewContext(source, {
    Float32Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (data, transfer) => messages.push({ data, transfer }) };
      }
    },
    registerProcessor(_name, processor) { Processor = processor; },
  });
  return { processor: new Processor(), messages };
}

test('PCM capture transfers one batch for sixteen render quanta instead of sixteen messages', () => {
  const { processor, messages } = processorHarness();
  for (let index = 0; index < 16; index += 1) processor.process([[new Float32Array(128).fill(index)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.length, 2048);
  assert.equal(messages[0].transfer.length, 1);
  assert.equal(messages[0].transfer[0], messages[0].data.buffer);
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual([...messages[0].data.slice(index * 128, (index + 1) * 128)], Array(128).fill(index));
  }
});

test('stopping flushes a sample-exact tail before acknowledgement and rejects later audio', () => {
  const { processor, messages } = processorHarness();
  const input = Float32Array.from({ length: 2201 }, (_, index) => index / 3000);
  processor.process([[input]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  const samples = messages.filter((message) => message.data instanceof Float32Array).flatMap((message) => [...message.data]);
  assert.deepEqual(samples, [...input]);
  assert.equal(messages.at(-1).data.type, 'flushed');
  assert.equal(messages[1].data.length, 153);
  processor.process([[new Float32Array(128)]]);
  assert.equal(messages.length, 3);
});

test('the capture client waits through final sample messages until the worklet acknowledges', async () => {
  const listeners = new Set();
  const sent = [];
  const port = {
    addEventListener(_name, listener) { listeners.add(listener); },
    removeEventListener(_name, listener) { listeners.delete(listener); },
    postMessage(message) { sent.push(message); },
  };
  let complete = false;
  const flush = flushPcmWorklet({ port }).then(() => { complete = true; });
  assert.deepEqual(sent, [{ type: 'flush' }]);
  for (const listener of listeners) listener({ data: new Float32Array(128) });
  await Promise.resolve();
  assert.equal(complete, false);
  for (const listener of listeners) listener({ data: { type: 'flushed' } });
  await flush;
  assert.equal(complete, true);
  assert.equal(listeners.size, 0);
});

test('a disconnected capture port rejects promptly and removes its listener', async () => {
  const listeners = new Set();
  await assert.rejects(flushPcmWorklet({ port: {
    addEventListener(_name, listener) { listeners.add(listener); },
    removeEventListener(_name, listener) { listeners.delete(listener); },
    postMessage() { throw new Error('Port disconnected'); },
  } }), /Port disconnected/);
  assert.equal(listeners.size, 0);
});
