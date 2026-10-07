export const DICTATION_SAMPLE_RATE = 16_000;

export function resamplePcm(input, sourceRate, targetRate = DICTATION_SAMPLE_RATE) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

export function monoPcm(audioBuffer) {
  const output = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index] += samples[index] / audioBuffer.numberOfChannels;
  }
  return output;
}

export function wavBlob(samples, sampleRate = DICTATION_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function wavFilename(filename) {
  const value = String(filename || 'recording').replace(/\.[^.]+$/u, '');
  return `${value || 'recording'}.wav`;
}

export async function prepareAudioUpload(file, {
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) {
  if (file.type === 'audio/wav' || /\.wav$/iu.test(file.name || '')) {
    return { body: file, filename: file.name || 'recording.wav', mimeType: file.type || 'audio/wav', converted: false };
  }
  if (!AudioContextClass) throw new Error('This device cannot decode the selected audio or video file. Convert it to WAV and try again.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const samples = resamplePcm(monoPcm(decoded), decoded.sampleRate);
    return {
      body: wavBlob(samples),
      filename: wavFilename(file.name),
      mimeType: 'audio/wav',
      converted: true,
    };
  } catch (error) {
    throw new Error(`Could not decode “${file.name || 'the selected file'}”. Convert it to WAV and try again.`, { cause: error });
  } finally {
    await context.close?.().catch?.(() => {});
  }
}
