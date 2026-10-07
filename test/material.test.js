import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalMaterialExtractor } from '../src/providers/material.js';

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

test('extracts plain-text and HTML course materials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-material-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extractor = new LocalMaterialExtractor();
  const textFile = path.join(root, 'reading.md');
  const htmlFile = path.join(root, 'slides.html');
  await fs.writeFile(textFile, '# Bayes theorem\nPosterior depends on prior and likelihood.');
  await fs.writeFile(htmlFile, '<h1>Week 2</h1><p>Conditional probability &amp; evidence.</p>');
  const text = await extractor.extract(textFile, 'reading.md');
  const html = await extractor.extract(htmlFile, 'slides.html');
  assert.match(text.text, /Posterior/);
  assert.match(html.text, /Conditional probability & evidence/);
  assert.equal(html.extractor, 'markup');
});

test('material extraction reports short traceable steps with real counts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-material-progress-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'reading.md');
  await fs.writeFile(file, '# Retrieval\nBayes theorem combines prior, likelihood, and evidence.');
  const events = [];
  const result = await new LocalMaterialExtractor().extract(file, 'reading.md', {
    onProgress: async (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.code), [
    'material-format-detected',
    'material-extractor-started',
    'material-text-normalized',
  ]);
  assert.equal(events[0].details.extension, '.md');
  assert.equal(events[1].details.extractor, 'plain-text');
  assert.equal(events[2].details.storedCharacterCount, result.text.length);
  assert.equal(events[2].details.truncated, false);
});

test('macOS PDFKit fallback extracts readable PDF text when pdftotext is unavailable', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-material-pdfkit-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'reading.pdf');
  await fs.writeFile(file, basicPdf('Bayes theorem combines prior likelihood and evidence.'));
  const events = [];
  const result = await new LocalMaterialExtractor().extract(file, 'reading.pdf', {
    onProgress: async (event) => events.push(event),
  });
  assert.match(result.text, /Bayes theorem combines prior likelihood and evidence/);
  assert.ok(['pdftotext', 'pdfkit'].includes(result.extractor));
  if (result.extractor === 'pdfkit') {
    assert.ok(events.some((event) => event.code === 'material-extractor-fallback' && event.details.extractor === 'pdfkit'));
  }
});

test('macOS PDF extraction can use a packaged executable without the Swift interpreter', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-material-packaged-pdfkit-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'reading.pdf');
  const helper = path.join(root, 'pdfkit-extract');
  await fs.writeFile(file, 'not readable by pdftotext');
  await fs.writeFile(helper, '#!/bin/sh\nprintf "Packaged PDFKit helper extracted readable course material.\\n"\n');
  await fs.chmod(helper, 0o755);

  const result = await new LocalMaterialExtractor({ pdfKitExecutable: helper }).extract(file, 'reading.pdf');

  assert.equal(result.extractor, 'pdfkit');
  assert.equal(result.text, 'Packaged PDFKit helper extracted readable course material.');
});
