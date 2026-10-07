import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { combinePcmWav, combinePcmWavFiles } from '../src/audio.js';

function wav(values) {
  const buffer = Buffer.alloc(44 + values.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + values.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(values.length * 2, 40);
  values.forEach((value, index) => buffer.writeInt16LE(value, 44 + index * 2));
  return buffer;
}

test('PCM dictation chunks combine into one valid WAV without losing samples', () => {
  const combined = combinePcmWav([wav([1, 2]), wav([3, 4, 5])]);
  assert.equal(combined.toString('ascii', 0, 4), 'RIFF');
  assert.equal(combined.readUInt32LE(40), 10);
  assert.deepEqual([0, 1, 2, 3, 4].map((index) => combined.readInt16LE(44 + index * 2)), [1, 2, 3, 4, 5]);
});

test('many persisted chunks are assembled incrementally and temporary output is cleaned', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-audio-assembly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputs = [];
  for (let index = 0; index < 100; index += 1) {
    const filename = path.join(root, `chunk-${String(index).padStart(3, '0')}.wav`);
    await fs.writeFile(filename, wav([index, index + 1, index + 2]));
    inputs.push(filename);
  }
  const output = path.join(root, 'combined.wav');
  const result = await combinePcmWavFiles(inputs, output, { copyBufferBytes: 4096 });
  const combined = await fs.readFile(output);
  assert.equal(result.bytes, 44 + 100 * 3 * 2);
  assert.equal(combined.readUInt32LE(40), 100 * 3 * 2);
  assert.equal(combined.readInt16LE(44), 0);
  assert.equal(combined.readInt16LE(combined.length - 2), 101);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.assembling-')), []);
  assert.deepEqual(await combinePcmWavFiles(inputs, output), result);
});
