export const SILENCE_TIMEOUT_MS = 60_000;
export const SPEECH_RMS_THRESHOLD = 0.015;
export const MEANINGFUL_SPEECH_MS = 250;

export function rmsEnergy(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += Number(sample || 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/**
 * Small, dependency-free silence lifecycle monitor for live PCM frames.
 * Silence before the first meaningful speech frame is intentionally ignored.
 */
export class SilenceAutoStopMonitor {
  constructor({
    timeoutMs = SILENCE_TIMEOUT_MS,
    speechThreshold = SPEECH_RMS_THRESHOLD,
    meaningfulSpeechMs = MEANINGFUL_SPEECH_MS,
    onSpeech = () => {},
    onSilence = () => {},
    setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.speechThreshold = speechThreshold;
    this.meaningfulSpeechMs = meaningfulSpeechMs;
    this.onSpeech = onSpeech;
    this.onSilence = onSilence;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.active = false;
    this.hasSpeech = false;
    this.silenceTimer = null;
    this.triggered = false;
    this.lastEnergy = 0;
    this.candidateSpeechMs = 0;
  }

  start() {
    this.stop();
    this.active = true;
    this.hasSpeech = false;
    this.triggered = false;
    this.lastEnergy = 0;
    this.candidateSpeechMs = 0;
    return this;
  }

  process(samples, sampleRate = 48_000) {
    if (!this.active) return 'inactive';
    const energy = rmsEnergy(samples);
    this.lastEnergy = energy;
    if (energy >= this.speechThreshold) {
      this.candidateSpeechMs += (samples.length / sampleRate) * 1000;
      if (!this.hasSpeech && this.candidateSpeechMs < this.meaningfulSpeechMs) return 'candidate-speech';
      const firstSpeech = !this.hasSpeech;
      this.hasSpeech = true;
      this.clearSilenceTimer();
      if (firstSpeech) this.onSpeech(energy);
      return 'speech';
    }
    if (!this.hasSpeech) this.candidateSpeechMs = 0;
    if (this.hasSpeech && this.silenceTimer === null) {
      this.silenceTimer = this.setTimeoutFn(() => {
        this.silenceTimer = null;
        if (!this.active || !this.hasSpeech || this.triggered) return;
        this.triggered = true;
        this.active = false;
        this.onSilence();
      }, this.timeoutMs);
    }
    return 'silence';
  }

  clearSilenceTimer() {
    if (this.silenceTimer !== null) this.clearTimeoutFn(this.silenceTimer);
    this.silenceTimer = null;
  }

  stop() {
    this.clearSilenceTimer();
    this.active = false;
    return this;
  }
}
