import { rmsEnergy } from './silence.js';

export const SPEECH_SEGMENT_MIN_MS = 1_200;
export const SPEECH_SEGMENT_SILENCE_MS = 650;
export const SPEECH_SEGMENT_MAX_MS = 14_000;
export const SPEECH_SEGMENT_THRESHOLD = 0.015;

function concatFloat32(chunks, samples) {
  const output = new Float32Array(samples);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Energy-based streaming boundary detector used only to choose audio cuts. */
export class SpeechBoundarySegmenter {
  constructor({
    minDurationMs = SPEECH_SEGMENT_MIN_MS,
    silenceDurationMs = SPEECH_SEGMENT_SILENCE_MS,
    maxDurationMs = SPEECH_SEGMENT_MAX_MS,
    speechThreshold = SPEECH_SEGMENT_THRESHOLD,
    onSegment = () => {},
  } = {}) {
    this.minDurationMs = Math.max(0, Number(minDurationMs) || 0);
    this.silenceDurationMs = Math.max(0, Number(silenceDurationMs) || 0);
    this.maxDurationMs = Math.max(this.minDurationMs, Number(maxDurationMs) || SPEECH_SEGMENT_MAX_MS);
    this.speechThreshold = Math.max(0, Number(speechThreshold) || 0);
    this.onSegment = onSegment;
    this.reset();
  }

  reset() {
    this.chunks = [];
    this.samples = 0;
    this.sampleRate = null;
    this.timelineSamples = 0;
    this.segmentStartSample = 0;
    this.silenceSamples = 0;
    this.hasSpeech = false;
    return this;
  }

  process(samples, sampleRate = 48_000) {
    if (!samples?.length) return null;
    if (this.sampleRate && this.sampleRate !== sampleRate) throw new Error('Speech segmenter sample rate changed during capture');
    this.sampleRate = sampleRate;
    const frame = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    this.chunks.push(frame);
    this.samples += frame.length;
    this.timelineSamples += frame.length;
    const speech = rmsEnergy(frame) >= this.speechThreshold;
    if (speech) {
      this.hasSpeech = true;
      this.silenceSamples = 0;
    } else if (this.hasSpeech) {
      this.silenceSamples += frame.length;
    }
    const durationMs = (this.samples / sampleRate) * 1000;
    const silenceMs = (this.silenceSamples / sampleRate) * 1000;
    if (durationMs >= this.maxDurationMs) return this.flush('max-duration');
    if (this.hasSpeech && durationMs >= this.minDurationMs && silenceMs >= this.silenceDurationMs) {
      return this.flush('speech-boundary');
    }
    return null;
  }

  flush(reason = 'manual') {
    if (!this.samples || !this.sampleRate) return null;
    const startMs = (this.segmentStartSample / this.sampleRate) * 1000;
    const endMs = (this.timelineSamples / this.sampleRate) * 1000;
    const segment = {
      samples: concatFloat32(this.chunks, this.samples),
      startMs,
      endMs,
      durationMs: endMs - startMs,
      hasSpeech: this.hasSpeech,
      reason,
    };
    this.segmentStartSample = this.timelineSamples;
    this.chunks = [];
    this.samples = 0;
    this.silenceSamples = 0;
    this.hasSpeech = false;
    this.onSegment(segment);
    return segment;
  }
}
