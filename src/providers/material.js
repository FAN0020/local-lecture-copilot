import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const inflate = promisify(zlib.inflate);
const MAX_TEXT = 500_000;
const PDFKIT_EXTRACTOR = fileURLToPath(new URL('./pdfkit-extract.swift', import.meta.url));
const PDFKIT_MODULE_CACHE = path.join(os.tmpdir(), 'lecture-copilot-pdfkit-cache');

function packagedPdfKitExecutable() {
  if (!process.resourcesPath || !PDFKIT_EXTRACTOR.includes(`${path.sep}app.asar${path.sep}`)) return null;
  return path.join(process.resourcesPath, 'runtime', 'pdfkit', `${process.platform}-${process.arch}`, 'pdfkit-extract');
}

function decodeEntities(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return entities[entity.toLowerCase()] ?? `&${entity};`;
  });
}
function xmlToText(xml) {
  return decodeEntities(xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>|<a:br\s*\/>/g, '\n')
    .replace(/<\/w:p>|<\/a:p>|<\/p>|<\/h\d>/g, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(errors).toString('utf8').slice(-500)}`)));
  });
}

function decodePdfString(input) {
  return input
    .replace(/\\([nrtbf()\\])/g, (_, code) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' })[code])
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\\r?\n/g, '');
}

function textFromPdfOperators(source) {
  const blocks = source.match(/BT[\s\S]*?ET/g) || [];
  const lines = [];
  for (const block of blocks) {
    const parts = [];
    const stringPattern = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let match;
    while ((match = stringPattern.exec(block))) {
      if (match[1] !== undefined) parts.push(decodePdfString(match[1]));
      else {
        const hex = match[2].replace(/\s/g, '');
        if (hex.length % 2 === 0) parts.push(Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, ''));
      }
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

async function fallbackPdf(buffer) {
  const source = buffer.toString('latin1');
  const chunks = [source];
  const streamPattern = /stream\r?\n/g;
  let match;
  while ((match = streamPattern.exec(source))) {
    const end = source.indexOf('endstream', match.index);
    if (end < 0) break;
    const raw = buffer.subarray(match.index + match[0].length, end);
    try {
      chunks.push((await inflate(raw)).toString('latin1'));
    } catch {
      // Some PDF streams use filters other than FlateDecode; the outer source is still inspected.
    }
  }
  return chunks.map(textFromPdfOperators).filter(Boolean).join('\n\n');
}

function assertReadablePdfText(value) {
  const text = String(value || '').trim();
  const sample = text.slice(0, 100_000);
  const controls = (sample.match(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/gu) || []).length;
  const controlRatio = controls / Math.max(1, sample.length);
  if (text.length < 20) throw new Error('The PDF contains no readable text. Scanned PDFs require OCR before upload.');
  if (controlRatio > 0.02) throw new Error('The PDF extractor returned binary data instead of readable text.');
  return text;
}

async function extractPdfWithPdfKit(file, executable) {
  if (executable) return (await run(executable, [file])).toString('utf8');
  const env = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: PDFKIT_MODULE_CACHE,
    SWIFT_MODULECACHE_PATH: PDFKIT_MODULE_CACHE,
  };
  return (await run('/usr/bin/swift', [PDFKIT_EXTRACTOR, file], { env })).toString('utf8');
}

async function extractArchive(file, extension) {
  if (extension === '.docx') {
    const xml = await run('unzip', ['-p', file, 'word/document.xml']);
    return xmlToText(xml.toString('utf8'));
  }
  const listing = (await run('unzip', ['-Z1', file])).toString('utf8').split('\n');
  const slides = listing
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const pages = [];
  for (const slide of slides) {
    const xml = await run('unzip', ['-p', file, slide]);
    pages.push(`## Slide ${pages.length + 1}\n${xmlToText(xml.toString('utf8'))}`);
  }
  return pages.join('\n\n');
}

export class LocalMaterialExtractor {
  constructor({ pdfKitExecutable = packagedPdfKitExecutable() } = {}) {
    this.pdfKitExecutable = pdfKitExecutable;
  }

  async extract(file, filename, { onProgress } = {}) {
    const startedAt = Date.now();
    const emit = async (code, details = {}) => {
      if (onProgress) await onProgress({ code, details: { filename, ...details } });
    };
    const extension = path.extname(filename).toLowerCase();
    let text = '';
    let extractor = 'plain-text';
    await emit('material-format-detected', { extension: extension || 'unknown' });
    if (['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.srt', '.vtt'].includes(extension)) {
      await emit('material-extractor-started', { extractor, operation: 'direct UTF-8 text read' });
      text = await fs.readFile(file, 'utf8');
    } else if (['.html', '.htm', '.xml'].includes(extension)) {
      extractor = 'markup';
      await emit('material-extractor-started', { extractor, operation: 'markup tag removal' });
      text = xmlToText(await fs.readFile(file, 'utf8'));
    } else if (['.docx', '.pptx'].includes(extension)) {
      extractor = extension === '.docx' ? 'docx' : 'pptx';
      await emit('material-extractor-started', { extractor, operation: 'Office XML extraction' });
      text = await extractArchive(file, extension);
    } else if (extension === '.pdf') {
      try {
        extractor = 'pdftotext';
        await emit('material-extractor-started', { extractor, operation: 'PDF layout text extraction' });
        text = assertReadablePdfText((await run('pdftotext', ['-layout', file, '-'])).toString('utf8'));
      } catch (primaryError) {
        try {
          if (process.platform !== 'darwin') throw primaryError;
          extractor = 'pdfkit';
          await emit('material-extractor-fallback', { extractor, operation: 'Apple PDFKit page text extraction' });
          text = assertReadablePdfText(await extractPdfWithPdfKit(file, this.pdfKitExecutable));
        } catch (pdfKitError) {
          extractor = 'pdf-fallback';
          await emit('material-extractor-fallback', { extractor, operation: 'built-in PDF text-operator scan' });
          try {
            text = assertReadablePdfText(await fallbackPdf(await fs.readFile(file)));
          } catch (fallbackError) {
            const error = new Error(`No reliable PDF text extractor is available. ${pdfKitError.message || fallbackError.message}`);
            error.code = 'PDF_TEXT_EXTRACTION_UNAVAILABLE';
            throw error;
          }
        }
      }
    } else if (['.rtf', '.doc'].includes(extension)) {
      extractor = 'textutil';
      await emit('material-extractor-started', { extractor, operation: 'document-to-text conversion' });
      text = (await run('textutil', ['-convert', 'txt', '-stdout', file])).toString('utf8');
    } else {
      const error = new Error(`Unsupported material type “${extension || 'unknown'}”. Use PDF, DOCX, PPTX, RTF, TXT, Markdown, CSV, JSON, HTML, SRT, or VTT.`);
      error.status = 415;
      throw error;
    }
    const rawCharacterCount = text.length;
    text = text.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!text) throw new Error('No readable text could be extracted from this material');
    const truncated = text.length > MAX_TEXT;
    await emit('material-text-normalized', {
      extractor,
      rawCharacterCount,
      normalizedCharacterCount: text.length,
      storedCharacterCount: Math.min(text.length, MAX_TEXT),
      truncated,
      durationMs: Date.now() - startedAt,
    });
    return { text: text.slice(0, MAX_TEXT), characterCount: text.length, truncated, extractor };
  }
}
