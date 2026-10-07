import assert from 'node:assert/strict';
import test from 'node:test';
import { TranscriptFollowController } from '../web/transcript-follow.js';

class FakeScrollContainer {
  constructor({ scrollHeight = 1_000, clientHeight = 300, scrollTop = 0 } = {}) {
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.listeners = new Map();
    this.blocks = [];
    this.scrollTop = scrollTop;
  }

  get scrollTop() {
    return this.currentScrollTop;
  }

  set scrollTop(value) {
    const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
    this.currentScrollTop = Math.max(0, Math.min(Number(value) || 0, maximum));
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  querySelectorAll() {
    return this.blocks;
  }

  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight };
  }

  setBlocks(blocks) {
    this.blocks = blocks.map(({ id, top, height = 80 }) => ({
      dataset: { editorBlock: id },
      getBoundingClientRect: () => ({
        top: top - this.scrollTop,
        bottom: top - this.scrollTop + height,
      }),
    }));
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event);
  }

  userScrollTo(value) {
    this.scrollTop = value;
    this.dispatch('scroll');
  }

  userWheelTo(value, { deltaY = -120 } = {}) {
    this.dispatch('wheel', { deltaY });
    this.userScrollTo(value);
  }
}

function followController() {
  return new TranscriptFollowController({ schedule: (callback) => callback() });
}

function deferredFollowController() {
  const frames = [];
  const controller = new TranscriptFollowController({ schedule: (callback) => frames.push(callback) });
  return {
    controller,
    frames,
    flushFrame() {
      frames.shift()?.();
    },
    flushAll() {
      while (frames.length) frames.shift()();
    },
  };
}

test('continuous transcript updates remain at the bottom of the transcript container', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });

  for (const height of [1_120, 1_260, 1_480]) {
    const snapshot = controller.capture(transcript);
    transcript.scrollHeight = height;
    controller.restore(transcript, snapshot, { followLatest: true });
    assert.equal(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight);
  }
});

test('interim-to-final replacement follows the new bottom without jumping upward', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });

  let snapshot = controller.capture(transcript);
  transcript.scrollHeight = 980;
  controller.restore(transcript, snapshot, { followLatest: true });
  assert.equal(transcript.scrollTop, 680);

  snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_090;
  controller.restore(transcript, snapshot, { followLatest: true });
  assert.equal(transcript.scrollTop, 790);
});

test('late layout growth after DOM reconstruction still settles at the newest transcript bottom', () => {
  const { controller, flushFrame } = deferredFollowController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });

  const snapshot = controller.capture(transcript);
  transcript.scrollHeight = 0;
  controller.restore(transcript, snapshot, { followLatest: true });
  assert.equal(transcript.scrollTop, 0);

  transcript.scrollHeight = 1_480;
  flushFrame();
  assert.equal(transcript.scrollTop, 1_180);

  transcript.scrollHeight = 1_620;
  flushFrame();
  assert.equal(transcript.scrollTop, 1_320);
});

test('user scroll intent cancels pending follow work before the next layout frame', () => {
  const { controller, flushAll } = deferredFollowController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });

  const snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_300;
  controller.restore(transcript, snapshot, { followLatest: true });
  transcript.userWheelTo(420, { deltaY: -120 });
  transcript.scrollHeight = 1_640;
  flushAll();

  assert.equal(controller.following, false);
  assert.equal(transcript.scrollTop, 420);
});

test('returning near bottom cancels anchored restore and resumes live following', () => {
  const { controller, flushAll } = deferredFollowController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });
  controller.capture(transcript);
  transcript.userScrollTo(240);

  let snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_500;
  controller.restore(transcript, snapshot, { followLatest: true });
  transcript.userWheelTo(1_200, { deltaY: 120 });
  flushAll();

  assert.equal(controller.following, true);
  assert.equal(transcript.scrollTop, 1_200);

  snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_720;
  controller.restore(transcript, snapshot, { followLatest: true });

  assert.equal(transcript.scrollTop, 1_420);
});

test('a deliberate upward scroll suspends auto-follow during incoming updates', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });
  controller.capture(transcript);
  transcript.userScrollTo(280);

  const snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_300;
  controller.restore(transcript, snapshot, { followLatest: true });

  assert.equal(controller.following, false);
  assert.equal(transcript.scrollTop, 280);
});

test('returning near the bottom resumes follow-latest behavior', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });
  controller.capture(transcript);
  transcript.userScrollTo(250);
  transcript.userScrollTo(650);

  const snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_240;
  controller.restore(transcript, snapshot, { followLatest: true });

  assert.equal(controller.following, true);
  assert.equal(transcript.scrollTop, 940);
});

test('translation and artifact-only rerenders preserve Raw scroll position', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 650 });

  let snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_120;
  controller.restore(transcript, snapshot, { followLatest: false });
  assert.equal(transcript.scrollTop, 650);

  snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_260;
  controller.restore(transcript, snapshot, { followLatest: true });
  assert.equal(transcript.scrollTop, 960);
});

test('DOM reconstruction keeps the same transcript block anchored in the viewport', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 280 });
  transcript.setBlocks([{ id: 'stable-block', top: 250 }]);

  const snapshot = controller.capture(transcript);
  transcript.setBlocks([{ id: 'stable-block', top: 330 }]);
  controller.restore(transcript, snapshot, { followLatest: false });

  assert.equal(transcript.scrollTop, 360);
});

test('stopping preserves reader position and resuming dictation restores auto-follow', () => {
  const controller = followController();
  const transcript = new FakeScrollContainer({ scrollTop: 700 });
  controller.capture(transcript);
  transcript.userScrollTo(220);

  let snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_180;
  controller.restore(transcript, snapshot, { followLatest: false });
  assert.equal(transcript.scrollTop, 220);

  controller.resume();
  snapshot = controller.capture(transcript);
  transcript.scrollHeight = 1_320;
  controller.restore(transcript, snapshot, { followLatest: false });
  assert.equal(transcript.scrollTop, 1_020);
  assert.equal(controller.following, true);
});
