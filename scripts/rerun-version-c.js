import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fingerprint, atomicJson } from '../src/lib.js';
import { runStage } from '../src/pipeline.js';
import { OllamaProvider } from '../src/providers/llm.js';
import { LocalMaterialExtractor } from '../src/providers/material.js';

const CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_MANIFEST = path.join(CODE_ROOT, 'test/test_audio/assignment_transcriptions/manifest.json');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const identity = (value) => sha256(JSON.stringify(value));

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function contained(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Path escapes its source directory: ${relative}`);
  return resolved;
}

async function checkedFile(file, expected, label) {
  const bytes = await fs.readFile(file);
  const digest = sha256(bytes);
  if (expected && expected !== digest) throw new Error(`${label} SHA256 mismatch: ${file}`);
  return { file, sha256: digest, bytes };
}

export async function codeIdentity(root = CODE_ROOT) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
    }
  }
  await visit(path.join(root, 'src'));
  files.push(path.join(root, 'scripts/rerun-version-c.js'), path.join(root, 'package.json'));
  const hashes = [];
  for (const file of files) hashes.push({ path: path.relative(root, file), sha256: sha256(await fs.readFile(file)) });
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* File hashes remain usable outside a Git checkout. */ }
  return { sha256: identity(hashes), gitCommit, files: hashes };
}

/** Validate every source before permitting output or inference. No reference transcript is read. */
export async function prepareRun(options = {}, dependencies = {}) {
  const sourceManifest = path.resolve(options.manifest || DEFAULT_MANIFEST);
  const sourceDirectory = path.dirname(sourceManifest);
  const audioRoot = path.resolve(options.audioRoot || path.dirname(sourceDirectory));
  const baselineDirectory = path.resolve(options.baselineDirectory || path.join(audioRoot, 'version_b'));
  const outputDirectory = path.resolve(options.outputDirectory || path.join(audioRoot, 'version_c_5'));
  const manifestBytes = await fs.readFile(sourceManifest);
  const source = JSON.parse(manifestBytes);
  if (source.whisper?.model !== 'base') throw new Error('This rerun requires the original fixed Whisper Base ASR manifest.');
  if (source.status !== 'complete' || !Array.isArray(source.cases) || !source.cases.length) throw new Error('The source manifest must contain a complete case collection.');
  const sourceDirs = [sourceDirectory, baselineDirectory, path.join(audioRoot, 'version_c'), path.join(audioRoot, 'version_a')];
  if (sourceDirs.some((directory) => outputDirectory === path.resolve(directory) || path.resolve(directory).startsWith(`${outputDirectory}${path.sep}`))) {
    throw new Error('Output directory would overlap existing source data.');
  }
  const extractor = dependencies.extractor || new LocalMaterialExtractor();
  const materialSets = {};
  const materialIdentity = {};
  for (const [set, documents] of Object.entries(source.contextDocuments || {})) {
    const contextDirectory = contained(audioRoot, source.contextMapping[set]);
    materialSets[set] = [];
    materialIdentity[set] = [];
    for (const [index, document] of documents.entries()) {
      const input = await checkedFile(contained(contextDirectory, document.filename), document.sha256, 'Course material');
      const extracted = await extractor.extract(input.file, document.filename);
      if (document.extractor === 'pdftotext' && extracted.extractor !== 'pdftotext') {
        throw new Error(`pdftotext is required to reproduce the original material extraction: ${document.filename}. Add its directory to PATH or pass --pdftotext-dir.`);
      }
      const id = `${set}_material_${index + 1}`;
      materialSets[set].push({ id, filename: document.filename, status: 'ready', extractedText: extracted.text });
      materialIdentity[set].push({ id, filename: document.filename, sourceSha256: input.sha256, extractedTextSha256: sha256(extracted.text), extractor: extracted.extractor, characterCount: extracted.characterCount, truncated: extracted.truncated });
    }
  }
  const seenIds = new Set();
  const seenNames = new Set();
  const cases = [];
  for (const item of source.cases) {
    if (!/^[a-zA-Z0-9_-]+$/.test(item.caseId) || seenIds.has(item.caseId)) throw new Error(`Invalid or duplicate case ID: ${item.caseId}`);
    seenIds.add(item.caseId);
    const outputName = path.basename(item.variants.B.output);
    if (seenNames.has(outputName) || !outputName.endsWith('.txt')) throw new Error(`Invalid or duplicate output name: ${outputName}`);
    seenNames.add(outputName);
    const audio = await checkedFile(contained(audioRoot, item.sourceAudio), item.sourceAudioSha256, 'Audio');
    const raw = await checkedFile(contained(sourceDirectory, item.rawOutput), null, 'Fixed Base ASR');
    const baseline = await checkedFile(contained(baselineDirectory, outputName), item.variants.B.outputSha256, 'Frozen Version B');
    if (!raw.bytes.toString('utf8').trim() || !baseline.bytes.toString('utf8').trim()) throw new Error(`Empty ASR or Version B transcript: ${item.caseId}`);
    const provenance = {
      caseId: item.caseId,
      sourceAudio: item.sourceAudio,
      sourceAudioSha256: audio.sha256,
      durationSeconds: item.durationSeconds,
      rawInput: item.rawOutput,
      rawInputSha256: raw.sha256,
      baselineFile: baseline.file,
      baselineSha256: baseline.sha256,
      baselineBranchCommit: source.branchCommits?.B,
      materialSet: item.set,
      output: outputName,
    };
    cases.push({ ...provenance, rawText: raw.bytes.toString('utf8'), baselineText: baseline.bytes.toString('utf8'), materials: materialSets[item.set] || [], provenance });
  }
  const code = await (dependencies.codeIdentity || codeIdentity)();
  const configuration = {
    provider: 'ollama',
    model: options.model || source.llm?.model || 'qwen3.5:4b',
    modelDigest: options.modelDigest || null,
    baseUrl: options.baseUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    temperature: 0.1,
    seed: 42,
    timeoutMs: Number(options.timeoutMs) || 120_000,
    keepAlive: '2m',
    cleanupOptions: { forceCleanup: true },
  };
  const inputs = { sourceManifestSha256: sha256(manifestBytes), code, configuration, materials: materialIdentity, cases: cases.map((item) => item.provenance) };
  return { sourceManifest, sourceDirectory, audioRoot, baselineDirectory, outputDirectory, variant: path.basename(outputDirectory), source, configuration, inputs, runFingerprint: identity(inputs), cases };
}

function errorDetails(error) {
  return { name: error.name, message: error.message, code: error.code || null };
}

async function assertOutputInventory(plan) {
  let entries;
  try { entries = await fs.readdir(plan.outputDirectory); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const permitted = new Set(['manifest.json', 'diagnostics', '.gitignore', ...plan.cases.map((item) => item.output)]);
  for (const entry of entries) if (!permitted.has(entry)) throw new Error(`Unexpected existing output file; refusing to reuse directory: ${entry}`);
}

async function persistOutput(file, text, replaceableHashes = []) {
  try { await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const actual = await fs.readFile(file, 'utf8');
    if (actual === text) return;
    if (!replaceableHashes.includes(sha256(actual))) throw new Error(`Existing output differs; refusing to overwrite: ${file}`);
    // Only this matching run's hash-verified degraded result may be superseded.
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  }
}

/** Resume only a matching run. All requests and responses remain in ignored local diagnostics. */
export async function executeRun(plan, dependencies = {}) {
  const log = dependencies.log || console.log;
  const stage = dependencies.runStage || runStage;
  const provider = dependencies.provider || new OllamaProvider(plan.configuration);
  await assertOutputInventory(plan);
  const manifestFile = path.join(plan.outputDirectory, 'manifest.json');
  let manifest = await optionalJson(manifestFile);
  if (manifest && manifest.runFingerprint !== plan.runFingerprint) throw new Error('Existing Version C rerun has different source/code/material/model/config fingerprints. Choose a new output directory.');
  if (!manifest) {
    try {
      if ((await fs.readdir(plan.outputDirectory)).length) throw new Error('Nonempty output directory has no matching run manifest; refusing to adopt existing files.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    manifest = {
      schemaVersion: 1,
      variant: plan.variant,
      status: 'running',
      createdAt: new Date().toISOString(),
      methodology: 'Reuse the exact original fixed Whisper Base ASR text and frozen Version B output for each SHA256-verified audio slice. Apply conservative course-material terminology repair to Version B. Do not rerun ASR and do not supply evaluation references to correction.',
      sourceManifest: plan.sourceManifest,
      originalWhisper: plan.source.whisper,
      originalBranchCommits: plan.source.branchCommits,
      runFingerprint: plan.runFingerprint,
      inputs: plan.inputs,
      cases: [],
    };
    await fs.mkdir(plan.outputDirectory, { recursive: true });
    await atomicJson(manifestFile, manifest);
  }
  const diagnosticsDirectory = path.join(plan.outputDirectory, 'diagnostics');
  await fs.mkdir(diagnosticsDirectory, { recursive: true });
  await persistOutput(path.join(diagnosticsDirectory, '.gitignore'), '*\n!.gitignore\n');
  for (const [index, item] of plan.cases.entries()) {
    const currentCode = await (dependencies.codeIdentity || codeIdentity)();
    if (currentCode.sha256 !== plan.inputs.code.sha256) throw new Error('Correction code changed during the run. Stop and use a new output directory.');
    await checkedFile(contained(plan.audioRoot, item.sourceAudio), item.sourceAudioSha256, 'Audio');
    await checkedFile(contained(plan.sourceDirectory, item.rawInput), item.rawInputSha256, 'Fixed Base ASR');
    await checkedFile(item.baselineFile, item.baselineSha256, 'Frozen Version B');
    const caseFingerprint = identity({ runFingerprint: plan.runFingerprint, provenance: item.provenance });
    const diagnosticFile = path.join(diagnosticsDirectory, `${item.caseId}.json`);
    const outputFile = path.join(plan.outputDirectory, item.output);
    let diagnostic = await optionalJson(diagnosticFile);
    if (diagnostic && diagnostic.caseFingerprint !== caseFingerprint) throw new Error(`Diagnostic fingerprint mismatch: ${item.caseId}`);
    const saved = manifest.cases.find((entry) => entry.caseId === item.caseId);
    if (saved?.status === 'complete') {
      if (!diagnostic || diagnostic.status !== 'complete' || saved.caseFingerprint !== caseFingerprint) throw new Error(`Completed case lacks matching diagnostics: ${item.caseId}`);
      if (diagnostic.outputSha256 !== saved.outputSha256 || sha256(diagnostic.outputText) !== saved.outputSha256) throw new Error(`Completed case diagnostic hash mismatch: ${item.caseId}`);
      await checkedFile(outputFile, saved.outputSha256, 'Completed Version C rerun output');
      log(`[${index + 1}/${plan.cases.length}] ${item.caseId}: verified existing output`);
      continue;
    }
    diagnostic ||= { caseId: item.caseId, caseFingerprint, provenance: item.provenance, attempts: [] };
    const replaceableHashes = diagnostic.attempts.filter((attempt) => attempt.status === 'degraded').map((attempt) => attempt.outputSha256);
    if (saved?.status === 'degraded') replaceableHashes.push(saved.outputSha256);
    try {
      const existing = await fs.readFile(outputFile);
      if (![...replaceableHashes, diagnostic.outputSha256].includes(sha256(existing))) throw new Error(`Existing output differs; refusing to overwrite: ${outputFile}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (diagnostic.status !== 'complete') {
      const attempt = { startedAt: new Date().toISOString(), calls: [] };
      diagnostic.attempts.push(attempt);
      diagnostic.status = 'running';
      await atomicJson(diagnosticFile, diagnostic);
      const llm = {
        async generate(request) {
          const { signal: _signal, ...serializable } = request;
          const call = { request: serializable, startedAt: new Date().toISOString() };
          attempt.calls.push(call);
          await atomicJson(diagnosticFile, diagnostic);
          try {
            const response = await provider.generate(request);
            call.response = response;
            call.finishedAt = new Date().toISOString();
            await atomicJson(diagnosticFile, diagnostic);
            return response;
          } catch (error) {
            call.error = errorDetails(error);
            await atomicJson(diagnosticFile, diagnostic);
            throw error;
          }
        },
      };
      try {
        const result = await stage({
          stage: 'cleanup',
          session: { id: item.caseId, language: 'en', llmModel: plan.configuration.model, materials: item.materials, artifacts: { rawTranscript: { content: item.rawText }, highQualityTranscript: null, cleanedTranscript: null } },
          llm,
          options: {
            ...plan.configuration.cleanupOptions,
            model: plan.configuration.model,
            cleanupBaseline: { content: item.baselineText, sourceFingerprint: fingerprint(item.rawText), model: plan.configuration.model, provenance: { variant: 'B', outputSha256: item.baselineSha256, sourceManifest: plan.sourceManifest, branchCommit: item.baselineBranchCommit } },
          },
        });
        if (!result.artifact?.content?.trim()) throw new Error('Correction returned an empty transcript.');
        attempt.finishedAt = new Date().toISOString();
        diagnostic.artifact = result.artifact;
        diagnostic.outputText = result.artifact.content.trim() === item.baselineText.trim()
          ? item.baselineText : `${result.artifact.content.trim()}\n`;
        diagnostic.outputSha256 = sha256(diagnostic.outputText);
        diagnostic.inferenceErrors = Math.max(Number(result.artifact.metrics?.repairErrors) || 0, attempt.calls.filter((call) => call.error).length);
        diagnostic.status = diagnostic.inferenceErrors ? 'degraded' : 'complete';
        Object.assign(attempt, { status: diagnostic.status, inferenceErrors: diagnostic.inferenceErrors, artifact: result.artifact, outputText: diagnostic.outputText, outputSha256: diagnostic.outputSha256 });
        await atomicJson(diagnosticFile, diagnostic);
      } catch (error) {
        attempt.error = errorDetails(error);
        diagnostic.status = 'failed';
        await atomicJson(diagnosticFile, diagnostic);
        manifest.status = 'failed';
        manifest.lastError = { caseId: item.caseId, ...errorDetails(error) };
        await atomicJson(manifestFile, manifest);
        throw error;
      }
    }
    // A completed diagnostic lets a matching interrupted run recover without a second model call.
    if (sha256(diagnostic.outputText) !== diagnostic.outputSha256) throw new Error(`Completed diagnostic output hash mismatch: ${item.caseId}`);
    await persistOutput(outputFile, diagnostic.outputText, replaceableHashes);
    const artifact = diagnostic.artifact;
    const record = { ...item.provenance, caseFingerprint, status: diagnostic.status, inferenceErrors: diagnostic.inferenceErrors || 0, outputSha256: diagnostic.outputSha256, diagnostics: path.relative(plan.outputDirectory, diagnosticFile), model: artifact.model || plan.configuration.model, provider: artifact.provider, metrics: artifact.metrics, materialIds: artifact.materialIds || [], baseline: artifact.baseline, repairs: artifact.repairs, completedAt: new Date().toISOString() };
    manifest.cases = manifest.cases.filter((entry) => entry.caseId !== item.caseId).concat(record);
    manifest.status = 'running';
    delete manifest.lastError;
    await atomicJson(manifestFile, manifest);
    log(`[${index + 1}/${plan.cases.length}] ${item.caseId}: saved ${item.output}${record.status === 'degraded' ? ` (degraded: ${record.inferenceErrors} inference error(s); rerun to retry)` : ''}`);
  }
  manifest.degradedCases = manifest.cases.filter((item) => item.status === 'degraded').length;
  manifest.inferenceErrors = manifest.cases.reduce((total, item) => total + (item.inferenceErrors || 0), 0);
  manifest.status = manifest.degradedCases ? 'degraded' : 'complete';
  manifest.completedAt = new Date().toISOString();
  await atomicJson(manifestFile, manifest);
  return manifest;
}

export function parseArguments(argv) {
  const options = {};
  const names = { '--manifest': 'manifest', '--audio-root': 'audioRoot', '--baseline-dir': 'baselineDirectory', '--output-dir': 'outputDirectory', '--ollama-url': 'baseUrl', '--model': 'model', '--timeout-ms': 'timeoutMs', '--pdftotext-dir': 'pdftotextDirectory' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--help') options.help = true;
    else {
      if (!names[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${key}`);
      options[names[key]] = argv[++index];
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/rerun-version-c.js [--manifest PATH] [--audio-root PATH] [--baseline-dir PATH] [--output-dir PATH] [--ollama-url URL] [--model NAME] [--timeout-ms MS] [--pdftotext-dir PATH] [--dry-run]\nReuses fixed Base ASR and frozen B outputs. --dry-run validates inputs without inference or writes. Matching interrupted runs resume automatically.');
    return;
  }
  if (options.pdftotextDirectory) process.env.PATH = `${path.resolve(options.pdftotextDirectory)}${path.delimiter}${process.env.PATH || ''}`;
  let plan = await prepareRun(options);
  if (options.dryRun) {
    console.log(JSON.stringify({ cases: plan.cases.length, outputDirectory: plan.outputDirectory, runFingerprint: plan.runFingerprint, inputs: plan.inputs }, null, 2));
    return;
  }
  const response = await fetch(`${plan.configuration.baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cannot identify installed Ollama model: HTTP ${response.status}`);
  const body = await response.json();
  const model = (body.models || []).find((entry) => entry.name === plan.configuration.model || entry.model === plan.configuration.model);
  if (!model?.digest) throw new Error(`Requested model ${plan.configuration.model} is not installed with an identifiable digest.`);
  plan = await prepareRun({ ...options, modelDigest: model.digest });
  const manifest = await executeRun(plan);
  if (manifest.status === 'degraded') {
    console.error(`Saved ${manifest.cases.length} ${plan.variant} transcripts, but ${manifest.degradedCases} case(s) had inference errors. Evaluation is incomplete; rerun the same command to retry them.`);
    process.exitCode = 1;
  } else console.log(`Completed ${manifest.cases.length} ${plan.variant} transcripts in ${plan.outputDirectory}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
