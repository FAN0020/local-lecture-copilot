import assert from 'node:assert/strict';
import test from 'node:test';
import { SilenceAutoStopMonitor, rmsEnergy } from '../web/silence.js';

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

const frame = (value, length = 100) => Float32Array.from({ length }, () => value);

test('PCM RMS energy distinguishes silence from speech-level samples', () => {
  assert.equal(rmsEnergy(frame(0)), 0);
  assert.ok(Math.abs(rmsEnergy(frame(0.1)) - 0.1) < 1e-6);
});

test('silence timeout remains disabled until meaningful speech is detected', () => {
  const clock = new FakeClock();
  let stops = 0;
  const monitor = new SilenceAutoStopMonitor({
    timeoutMs: 1000,
    meaningfulSpeechMs: 250,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onSilence: () => { stops += 1; },
  }).start();

  monitor.process(frame(0), 1000);
  clock.advance(5000);
  assert.equal(stops, 0);
  assert.equal(monitor.hasSpeech, false);

  monitor.process(frame(0.1), 1000);
  monitor.process(frame(0.1), 1000);
  assert.equal(monitor.hasSpeech, false, 'brief energy must not enable auto-stop');
  monitor.process(frame(0.1), 1000);
  assert.equal(monitor.hasSpeech, true);
  monitor.process(frame(0), 1000);
  clock.advance(999);
  assert.equal(stops, 0);
  clock.advance(1);
  assert.equal(stops, 1);
});

test('speech resumes immediately reset the silence timeout and stop lifecycle is single-shot', () => {
  const clock = new FakeClock();
  let stops = 0;
  const monitor = new SilenceAutoStopMonitor({
    timeoutMs: 1000,
    meaningfulSpeechMs: 100,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onSilence: () => { stops += 1; },
  }).start();

  monitor.process(frame(0.1), 1000);
  monitor.process(frame(0), 1000);
  clock.advance(800);
  monitor.process(frame(0.1), 1000);
  clock.advance(400);
  assert.equal(stops, 0, 'resumed speech cancels the earlier deadline');

  monitor.process(frame(0), 1000);
  clock.advance(1000);
  assert.equal(stops, 1);
  clock.advance(5000);
  monitor.process(frame(0), 1000);
  assert.equal(stops, 1, 'auto-stop cannot race or fire twice');
});

test('manual stop cancels a pending silence timeout', () => {
  const clock = new FakeClock();
  let stops = 0;
  const monitor = new SilenceAutoStopMonitor({
    timeoutMs: 1000,
    meaningfulSpeechMs: 100,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onSilence: () => { stops += 1; },
  }).start();
  monitor.process(frame(0.1), 1000);
  monitor.process(frame(0), 1000);
  monitor.stop();
  clock.advance(2000);
  assert.equal(stops, 0);
});
