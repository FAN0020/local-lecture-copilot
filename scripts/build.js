import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const output = path.resolve('dist');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.cp(path.resolve('web'), path.join(output, 'web'), { recursive: true });
await fs.cp(path.resolve('src'), path.join(output, 'src'), { recursive: true });
await fs.cp(path.resolve('desktop'), path.join(output, 'desktop'), { recursive: true });
const sttTarget = (await fs.readFile(path.resolve('runtime', 'stt', 'active-target.txt'), 'utf8').catch(() => '')).trim();
await fs.mkdir(path.join(output, 'runtime', 'stt'), { recursive: true });
await fs.cp(path.resolve('runtime', 'stt', 'README.md'), path.join(output, 'runtime', 'stt', 'README.md'));
if (sttTarget) await fs.cp(path.resolve('runtime', 'stt', sttTarget), path.join(output, 'runtime', 'stt', sttTarget), { recursive: true });
const targetPlatform = option('platform', process.platform);
const targetArch = option('arch', process.arch);
if (targetPlatform === 'darwin') {
  if (!['arm64', 'x64'].includes(targetArch)) throw new Error(`Unsupported macOS architecture: ${targetArch}`);
  const helper = path.join(output, 'runtime', 'pdfkit', `darwin-${targetArch}`, 'pdfkit-extract');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  const swiftArch = targetArch === 'x64' ? 'x86_64' : targetArch;
  const deploymentTarget = targetArch === 'arm64' ? '11.0' : '10.15';
  await run('/usr/bin/xcrun', [
    '--sdk', 'macosx', 'swiftc', '-O',
    '-target', `${swiftArch}-apple-macosx${deploymentTarget}`,
    '-framework', 'PDFKit',
    '-o', helper,
    path.resolve('src', 'providers', 'pdfkit-extract.swift'),
  ]);
  await fs.chmod(helper, 0o755);
}
const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
delete packageJson.build;
delete packageJson.devDependencies;
delete packageJson.scripts;
delete packageJson.allowScripts;
await fs.writeFile(path.join(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(output, 'BUILD.txt'), `Local Lecture Copilot\nBuilt: ${new Date().toISOString()}\nRuntime: Node ${process.version}\n`, 'utf8');
console.log(`Production bundle created at ${output}`);
