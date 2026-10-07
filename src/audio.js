import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function readWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('Dictation chunk is not a valid WAV file'), { status: 400 });
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') data = buffer.subarray(start, end);
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw Object.assign(new Error('Dictation audio must be mono 16-bit PCM WAV'), { status: 400 });
  }
  return { ...format, data };
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Could not write combined dictation audio');
    written += result.bytesWritten;
  }
}

function wavHeader(sampleRate, pcmBytes) {
  if (pcmBytes > 0xffffffff - 36) throw Object.assign(new Error('Combined WAV exceeds the 4 GB PCM WAV limit'), { status: 413 });
  const output = Buffer.alloc(44);
  output.write('RIFF', 0);
  output.writeUInt32LE(36 + pcmBytes, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(pcmBytes, 40);
  return output;
}

async function inspectWavFile(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const riff = Buffer.alloc(12);
    const initial = await handle.read(riff, 0, riff.length, 0);
    if (initial.bytesRead !== riff.length || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw Object.assign(new Error('Dictation chunk is not a valid WAV file'), { status: 400 });
    }
    let offset = 12;
    let format;
    let dataOffset;
    let dataBytes;
    while (offset + 8 <= stat.size) {
      const chunkHeader = Buffer.alloc(8);
      const chunkRead = await handle.read(chunkHeader, 0, chunkHeader.length, offset);
      if (chunkRead.bytesRead !== chunkHeader.length) break;
      const id = chunkHeader.toString('ascii', 0, 4);
      const size = chunkHeader.readUInt32LE(4);
      const start = offset + 8;
      if (start + size > stat.size) throw Object.assign(new Error('Dictation WAV chunk is truncated'), { status: 400 });
      if (id === 'fmt ' && size >= 16) {
        const fmt = Buffer.alloc(16);
        await handle.read(fmt, 0, fmt.length, start);
        format = {
          audioFormat: fmt.readUInt16LE(0),
          channels: fmt.readUInt16LE(2),
          sampleRate: fmt.readUInt32LE(4),
          bitsPerSample: fmt.readUInt16LE(14),
        };
      }
      if (id === 'data') {
        dataOffset = start;
        dataBytes = size;
        break;
      }
      offset = start + size + (size % 2);
    }
    if (!format || dataOffset === undefined || format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
      throw Object.assign(new Error('Dictation audio must be mono 16-bit PCM WAV'), { status: 400 });
    }
    return { ...format, dataOffset, dataBytes };
  } finally {
    await handle.close();
  }
}

/** Assemble persisted PCM chunks while retaining at most one small copy buffer. */
export async function combinePcmWavFiles(inputPaths, outputPath, { copyBufferBytes = 256 * 1024 } = {}) {
  if (!inputPaths.length) throw Object.assign(new Error('No dictation audio was recorded'), { status: 422 });
  const chunks = [];
  for (const inputPath of inputPaths) chunks.push(await inspectWavFile(inputPath));
  const sampleRate = chunks[0].sampleRate;
  if (chunks.some((chunk) => chunk.sampleRate !== sampleRate)) {
    throw Object.assign(new Error('Dictation chunks use inconsistent sample rates'), { status: 400 });
  }
  const pcmBytes = chunks.reduce((total, chunk) => total + chunk.dataBytes, 0);
  const expectedBytes = 44 + pcmBytes;
  const validateExisting = async () => {
    const existing = await inspectWavFile(outputPath);
    if (existing.sampleRate !== sampleRate || existing.dataBytes !== pcmBytes) {
      throw Object.assign(new Error('Existing combined dictation audio does not match saved chunks'), { code: 'EEXIST' });
    }
    return { bytes: expectedBytes, sampleRate, pcmBytes };
  };
  try {
    await fs.access(outputPath);
    return validateExisting();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.assembling-${process.pid}-${randomUUID()}`;
  let output;
  try {
    output = await fs.open(temporaryPath, 'wx');
    await writeAll(output, wavHeader(sampleRate, pcmBytes), 0);
    let outputPosition = 44;
    const copyBuffer = Buffer.allocUnsafe(Math.max(4096, Number(copyBufferBytes) || 256 * 1024));
    for (let index = 0; index < inputPaths.length; index += 1) {
      const input = await fs.open(inputPaths[index], 'r');
      try {
        let remaining = chunks[index].dataBytes;
        let inputPosition = chunks[index].dataOffset;
        while (remaining > 0) {
          const length = Math.min(copyBuffer.length, remaining);
          const result = await input.read(copyBuffer, 0, length, inputPosition);
          if (!result.bytesRead) throw Object.assign(new Error('Dictation WAV data ended unexpectedly'), { status: 400 });
          await writeAll(output, copyBuffer.subarray(0, result.bytesRead), outputPosition);
          inputPosition += result.bytesRead;
          outputPosition += result.bytesRead;
          remaining -= result.bytesRead;
        }
      } finally {
        await input.close();
      }
    }
    await output.sync();
    await output.close();
    output = null;
    try {
      await fs.link(temporaryPath, outputPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await validateExisting();
    }
    return { bytes: expectedBytes, sampleRate, pcmBytes };
  } finally {
    await output?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true });
  }
}

export function combinePcmWav(buffers) {
  if (!buffers.length) throw Object.assign(new Error('No dictation audio was recorded'), { status: 422 });
  const chunks = buffers.map(readWav);
  const first = chunks[0];
  if (chunks.some((chunk) => chunk.sampleRate !== first.sampleRate)) {
    throw Object.assign(new Error('Dictation chunks use inconsistent sample rates'), { status: 400 });
  }
  const pcm = Buffer.concat(chunks.map((chunk) => chunk.data));
  const output = Buffer.alloc(44 + pcm.length);
  wavHeader(first.sampleRate, pcm.length).copy(output, 0);
  pcm.copy(output, 44);
  return output;
}
