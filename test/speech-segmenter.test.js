import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeechBoundarySegmenter } from '../web/speech-segmenter.js';

const frame = (value, milliseconds, sampleRate = 1000) => Float32Array.from({ length: milliseconds * sampleRate / 1000 }, () => value);

test('speech segmenter cuts on a natural trailing-silence boundary with stable timestamps', () => {
  const emitted = [];
  const segmenter = new SpeechBoundarySegmenter({ minDurationMs: 500, silenceDurationMs: 300, maxDurationMs: 5000, onSegment: (segment) => emitted.push(segment) });
  segmenter.process(frame(0, 200), 1000);
  segmenter.process(frame(0.1, 600), 1000);
  assert.equal(segmenter.process(frame(0, 300), 1000)?.reason, 'speech-boundary');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].startMs, 0);
  assert.equal(emitted[0].endMs, 1100);
  assert.equal(emitted[0].hasSpeech, true);

  segmenter.process(frame(0.1, 500), 1000);
  const final = segmenter.flush('stop');
  assert.equal(final.startMs, 1100);
  assert.equal(final.endMs, 1600);
});

test('speech segmenter bounds continuous speech and preserves silent audio segments', () => {
  const segmenter = new SpeechBoundarySegmenter({ minDurationMs: 100, silenceDurationMs: 100, maxDurationMs: 1000 });
  const speech = segmenter.process(frame(0.1, 1000), 1000);
  assert.equal(speech.reason, 'max-duration');
  assert.equal(speech.hasSpeech, true);
  const silence = segmenter.process(frame(0, 1000), 1000);
  assert.equal(silence.reason, 'max-duration');
  assert.equal(silence.hasSpeech, false);
  assert.equal(silence.startMs, 1000);
  assert.equal(silence.endMs, 2000);
});
