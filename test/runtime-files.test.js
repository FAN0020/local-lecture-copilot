import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { copyRuntimeDirectory } from '../scripts/runtime-files.js';

const execFile = promisify(execFileCallback);

function basicPdf(text) {
  const escaped = text.replace(/([()\\])/gu, '\\$1');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('Linux runtime library aliases survive removal of the extracted release directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-runtime-libraries-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'release');
  const target = path.join(root, 'runtime', 'bin');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'whisper-cli'), 'executable');
  await fs.writeFile(path.join(source, 'libwhisper.so.1.9.3'), 'shared library');
  try {
    await fs.symlink('libwhisper.so.1.9.3', path.join(source, 'libwhisper.so.1'), 'file');
    await fs.symlink('libwhisper.so.1', path.join(source, 'libwhisper.so'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows account cannot create the Unix release symlink fixture');
    return;
  }
  await copyRuntimeDirectory(source, target);
  await fs.rm(source, { recursive: true });
  assert.equal(await fs.readFile(path.join(target, 'whisper-cli'), 'utf8'), 'executable');
  for (const name of ['libwhisper.so', 'libwhisper.so.1', 'libwhisper.so.1.9.3']) {
    assert.equal(await fs.readFile(path.join(target, name), 'utf8'), 'shared library');
    assert.equal((await fs.lstat(path.join(target, name))).isFile(), true);
  }
});

test('macOS production build contains a directly executable PDFKit extractor', { skip: process.platform !== 'darwin' }, async (t) => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await execFile(process.execPath, [path.join(projectRoot, 'scripts', 'build.js')], { cwd: projectRoot });
  const helper = path.join(projectRoot, 'dist', 'runtime', 'pdfkit', `darwin-${process.arch}`, 'pdfkit-extract');
  const stat = await fs.stat(helper);
  assert.notEqual(stat.mode & 0o111, 0);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-pdfkit-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'reading.pdf');
  await fs.writeFile(file, basicPdf('Packaged PDFKit runtime extracts this course material.'));

  const { stdout } = await execFile(helper, [file], { env: { PATH: '/usr/bin:/bin' } });
  assert.match(stdout, /Packaged PDFKit runtime extracts this course material/);
});
