export const RAW_TRANSCRIPT_BOTTOM_THRESHOLD = 64;

export function distanceFromBottom(container) {
  if (!container) return 0;
  return Math.max(0, Number(container.scrollHeight || 0) - Number(container.clientHeight || 0) - Number(container.scrollTop || 0));
}

export function isNearTranscriptBottom(container, threshold = RAW_TRANSCRIPT_BOTTOM_THRESHOLD) {
  return distanceFromBottom(container) <= threshold;
}

const SCROLL_AWAY_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const SCROLL_TOWARD_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ', 'Space', 'Spacebar']);

function visibleBlockAnchor(container) {
  if (!container?.querySelectorAll || !container.getBoundingClientRect) return null;
  const viewport = container.getBoundingClientRect();
  for (const block of container.querySelectorAll('[data-editor-block]')) {
    const rect = block.getBoundingClientRect?.();
    if (!rect || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    return {
      id: block.dataset?.editorBlock,
      offset: rect.top - viewport.top,
    };
  }
  return null;
}

function restoreBlockAnchor(container, anchor) {
  if (!anchor?.id || !container?.querySelectorAll || !container.getBoundingClientRect) return;
  const block = [...container.querySelectorAll('[data-editor-block]')]
    .find((candidate) => candidate.dataset?.editorBlock === anchor.id);
  if (!block?.getBoundingClientRect) return;
  const offset = block.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += offset - anchor.offset;
}

/**
 * Keeps live Raw transcript updates at the bottom without taking over the page
 * scroll or overriding a reader who has deliberately moved up the transcript.
 */
export class TranscriptFollowController {
  constructor({
    threshold = RAW_TRANSCRIPT_BOTTOM_THRESHOLD,
    schedule = (callback) => requestAnimationFrame(callback),
  } = {}) {
    this.threshold = threshold;
    this.schedule = schedule;
    this.container = null;
    this.snapshot = null;
    this.following = true;
    this.forceNext = false;
    this.ignoreScroll = false;
    this.restoreGeneration = 0;
    this.userIntentGeneration = 0;
    this.onScroll = () => {
      if (this.ignoreScroll || !this.container) return;
      this.updateFollowingFromScroll();
    };
    this.onWheel = (event) => this.handleScrollIntent({ away: Number(event?.deltaY || 0) < 0 });
    this.onTouchMove = () => this.handleScrollIntent({ away: true });
    this.onKeydown = (event) => {
      if (SCROLL_AWAY_KEYS.has(event?.key) || (event?.key === ' ' && event.shiftKey)) this.handleScrollIntent({ away: true });
      else if (SCROLL_TOWARD_KEYS.has(event?.key)) this.handleScrollIntent({ away: false });
    };
  }

  snapshotFor(container) {
    return {
      scrollTop: Number(container?.scrollTop || 0),
      following: this.following,
      anchor: visibleBlockAnchor(container),
    };
  }

  bind(container) {
    if (!container || container === this.container) return;
    this.container?.removeEventListener?.('scroll', this.onScroll);
    this.container?.removeEventListener?.('wheel', this.onWheel);
    this.container?.removeEventListener?.('touchmove', this.onTouchMove);
    this.container?.removeEventListener?.('keydown', this.onKeydown);
    this.container = container;
    container.addEventListener?.('scroll', this.onScroll, { passive: true });
    container.addEventListener?.('wheel', this.onWheel, { passive: true });
    container.addEventListener?.('touchmove', this.onTouchMove, { passive: true });
    container.addEventListener?.('keydown', this.onKeydown);
  }

  capture(container = this.container) {
    if (!container) return this.snapshot;
    this.bind(container);
    this.snapshot = this.snapshotFor(container);
    return this.snapshot;
  }

  updateFollowingFromScroll() {
    if (!this.container) return;
    this.following = isNearTranscriptBottom(this.container, this.threshold);
    this.snapshot = this.snapshotFor(this.container);
  }

  handleScrollIntent({ away = true } = {}) {
    if (away || !this.following) this.userIntentGeneration += 1;
    this.ignoreScroll = false;
    this.schedule(() => this.updateFollowingFromScroll());
  }

  scrollToBottom(container) {
    container.scrollTop = Math.max(0, Number(container.scrollHeight || 0) - Number(container.clientHeight || 0));
    this.following = true;
  }

  restore(container, snapshot = this.snapshot, { followLatest = false } = {}) {
    if (!container) return;
    this.bind(container);
    this.ignoreScroll = true;
    const shouldFollow = this.forceNext || (followLatest && (snapshot?.following ?? this.following));
    const restoreIntent = this.userIntentGeneration;
    this.forceNext = false;
    const generation = ++this.restoreGeneration;
    const apply = () => {
      if (generation !== this.restoreGeneration || restoreIntent !== this.userIntentGeneration) return false;
      if (shouldFollow) {
        this.scrollToBottom(container);
      } else if (snapshot) {
        container.scrollTop = snapshot.scrollTop;
        restoreBlockAnchor(container, snapshot.anchor);
      }
      this.snapshot = this.snapshotFor(container);
      return true;
    };
    apply();
    this.schedule(() => {
      if (!apply()) return;
      this.schedule(() => {
        apply();
        if (generation === this.restoreGeneration && restoreIntent === this.userIntentGeneration) this.ignoreScroll = false;
      });
    });
  }

  resume() {
    this.following = true;
    this.forceNext = true;
  }

  reset() {
    this.container?.removeEventListener?.('scroll', this.onScroll);
    this.container?.removeEventListener?.('wheel', this.onWheel);
    this.container?.removeEventListener?.('touchmove', this.onTouchMove);
    this.container?.removeEventListener?.('keydown', this.onKeydown);
    this.container = null;
    this.snapshot = null;
    this.following = true;
    this.forceNext = false;
    this.ignoreScroll = false;
    this.restoreGeneration += 1;
    this.userIntentGeneration += 1;
  }
}
