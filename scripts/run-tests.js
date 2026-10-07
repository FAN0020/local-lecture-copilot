import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(repositoryRoot, 'test');
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No top-level test files found in ${testDirectory}`);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
