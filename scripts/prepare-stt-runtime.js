import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_STT_MODEL, WHISPER_MODEL_REGISTRY, sha256File } from '../src/providers/whisper-models.js';
import { copyRuntimeDirectory } from './runtime-files.js';

const WHISPER_VERSION = 'b4938';
const BUNDLED_MODEL = WHISPER_MODEL_REGISTRY[DEFAULT_STT_MODEL];
const targetPlatform = process.argv.find((value) => value.startsWith('--platform='))?.split('=')[1] || process.platform;
const targetArch = process.argv.find((value) => value.startsWith('--arch='))?.split('=')[1] || (targetPlatform === 'win32' ? 'x64' : process.arch);
const target = path.resolve('runtime', 'stt', `${targetPlatform}-${targetArch}`);
const binaryName = targetPlatform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const binary = path.join(target, 'bin', binaryName);
const model = path.join(target, 'models', BUNDLED_MODEL.filename);

function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', shell: false, ...options });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${program} exited with code ${code}`)));
  });
}

async function download(url, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await command('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', destination, url]);
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function findFile(root, name) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, name);
      if (nested) return nested;
    } else if (entry.name === name) return candidate;
  }
  return null;
}

async function prepareMac(temp) {
  if (targetPlatform !== 'darwin') return false;
  const archive = path.join(temp, 'whisper.tar.gz');
  await download(`https://github.com/ggerganov/whisper.cpp/archive/refs/tags/${WHISPER_VERSION}.tar.gz`, archive);
  await command('tar', ['-xzf', archive, '-C', temp]);
  const source = path.join(temp, `whisper.cpp-${WHISPER_VERSION}`);
  const build = path.join(source, 'build');
  await command('cmake', ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF']);
  await command('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '--parallel']);
  const compiled = await findFile(build, 'whisper-cli');
  if (!compiled) throw new Error('whisper.cpp build completed without whisper-cli');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.copyFile(compiled, binary);
  await fs.chmod(binary, 0o755);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(target, 'LICENSE.whisper.cpp'));
  return true;
}

async function prepareLinux(temp) {
  if (!['linux', 'freebsd'].includes(targetPlatform)) return false;
  const archive = path.join(temp, 'whisper.tar.gz');
  const suffix = targetArch === 'arm64' ? 'arm64' : 'x64';
  await download(`https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-ubuntu-${suffix}.tar.gz`, archive);
  await command('tar', ['-xzf', archive, '-C', temp]);
  const compiled = await findFile(temp, 'whisper-cli');
  if (!compiled) throw new Error('Downloaded Linux runtime does not contain whisper-cli');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await copyRuntimeDirectory(path.dirname(compiled), path.dirname(binary));
  await download(`https://raw.githubusercontent.com/ggml-org/whisper.cpp/${WHISPER_VERSION}/LICENSE`, path.join(target, 'LICENSE.whisper.cpp'));
  await fs.chmod(binary, 0o755);
  return true;
}

async function prepareWindows(temp) {
  if (targetPlatform !== 'win32') return false;
  if (targetArch !== 'x64') throw new Error('The managed Windows STT runtime is currently published for x64 builds');
  const archive = path.join(temp, 'whisper.zip');
  const extracted = path.join(temp, 'whisper-win');
  await download(`https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`, archive);
  await fs.mkdir(extracted, { recursive: true });
  // Windows 11 includes bsdtar but does not guarantee an `unzip` executable.
  // bsdtar also handles ZIP files on macOS, so this works for native Windows
  // preparation and macOS configuration/cross-build validation.
  await command('tar', ['-xf', archive, '-C', extracted]);
  const compiled = await findFile(extracted, 'whisper-cli.exe');
  if (!compiled) throw new Error('Downloaded Windows runtime does not contain whisper-cli.exe');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  for (const entry of await fs.readdir(path.dirname(compiled), { withFileTypes: true })) {
    if (entry.isFile()) await fs.copyFile(path.join(path.dirname(compiled), entry.name), path.join(path.dirname(binary), entry.name));
  }
  await download(`https://raw.githubusercontent.com/ggerganov/whisper.cpp/${WHISPER_VERSION}/LICENSE`, path.join(target, 'LICENSE.whisper.cpp'));
  return true;
}

const linuxLibrariesReady = targetPlatform !== 'linux' || (await Promise.all(
  ['libwhisper.so.1', 'libggml.so.0', 'libggml-base.so.0'].map((name) => exists(path.join(target, 'bin', name))),
)).every(Boolean);
if (linuxLibrariesReady && await exists(binary) && await exists(model) && await sha256File(model) === BUNDLED_MODEL.sha256) {
  await fs.writeFile(path.resolve('runtime', 'stt', 'active-target.txt'), `${targetPlatform}-${targetArch}\n`);
  console.log(`Managed STT runtime is ready at ${target}`);
  process.exit(0);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-copilot-runtime-'));
try {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, 'models'), { recursive: true });
  const prepared = await prepareMac(temp) || await prepareWindows(temp) || await prepareLinux(temp);
  if (!prepared) throw new Error(`No managed Whisper runtime recipe is available for ${targetPlatform}-${targetArch}`);
  await download(BUNDLED_MODEL.url, model);
  const actualHash = await sha256File(model);
  if (actualHash !== BUNDLED_MODEL.sha256) throw new Error(`Whisper model checksum mismatch: expected ${BUNDLED_MODEL.sha256}, received ${actualHash}`);
  await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify({ provider: 'whisper.cpp', version: WHISPER_VERSION, platform: targetPlatform, arch: targetArch, models: [DEFAULT_STT_MODEL] }, null, 2)}\n`);
  await fs.writeFile(path.resolve('runtime', 'stt', 'active-target.txt'), `${targetPlatform}-${targetArch}\n`);
  console.log(`Managed STT runtime prepared at ${target}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
