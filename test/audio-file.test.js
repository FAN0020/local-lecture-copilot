import assert from 'node:assert/strict';
import test from 'node:test';
import { monoPcm, prepareAudioUpload, resamplePcm } from '../web/audio-file.js';

test('uploaded media is decoded, downmixed, resampled, and sent to Whisper as WAV', async () => {
  let closed = false;
  class FakeAudioContext {
    async decodeAudioData() {
      return {
        length: 4,
        numberOfChannels: 2,
        sampleRate: 32_000,
        getChannelData: (channel) => channel === 0
          ? new Float32Array([1, 0.5, 0, -0.5])
          : new Float32Array([0.5, 0, -0.5, -1]),
      };
    }
    async close() { closed = true; }
  }
  const source = {
    name: 'lecture.m4a',
    type: 'audio/x-m4a',
    async arrayBuffer() { return new ArrayBuffer(8); },
  };
  const upload = await prepareAudioUpload(source, { AudioContextClass: FakeAudioContext });
  const bytes = Buffer.from(await upload.body.arrayBuffer());
  assert.equal(upload.filename, 'lecture.wav');
  assert.equal(upload.mimeType, 'audio/wav');
  assert.equal(upload.converted, true);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), 4);
  assert.equal(closed, true);
});

test('audio conversion helpers average channels and resample PCM', () => {
  const mono = monoPcm({
    length: 3,
    numberOfChannels: 2,
    getChannelData: (channel) => channel ? new Float32Array([1, 0, -1]) : new Float32Array([-1, 0.5, 1]),
  });
  assert.deepEqual([...mono], [0, 0.25, 0]);
  assert.deepEqual([...resamplePcm(new Float32Array([0, 0.5, 1, 0.5]), 32_000, 16_000)], [0, 1]);
});
