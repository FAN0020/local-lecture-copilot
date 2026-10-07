import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SPEECH_FIXTURE } from '../desktop/live-audio-validation.js';

const destination = path.resolve(process.argv[2] || 'debug-artifacts/windows/fixtures/jfk.wav');
const response = await fetch(SPEECH_FIXTURE.url, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Speech fixture download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(bytes).digest('hex'), SPEECH_FIXTURE.sha256);
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, bytes);
await fs.writeFile(`${destination}.json`, `${JSON.stringify(SPEECH_FIXTURE, null, 2)}\n`);
console.log(`Verified real speech fixture: ${destination}`);
