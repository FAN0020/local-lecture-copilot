import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function filesIn(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesIn(target));
    else output.push(target);
  }
  return output;
}

const files = [...await filesIn('src'), ...await filesIn('web'), ...await filesIn('desktop'), ...await filesIn('scripts'), ...await filesIn('test')];
const javascript = files.filter((file) => file.endsWith('.js') || file.endsWith('.cjs'));
for (const file of javascript) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exitCode = 1;
  }
  const source = await fs.readFile(file, 'utf8');
  const deferredMarker = new RegExp(`\\b(?:${['TO', 'DO'].join('')}|${['FIX', 'ME'].join('')})\\b`);
  if (deferredMarker.test(source)) {
    console.error(`${file}: unresolved deferred-work marker`);
    process.exitCode = 1;
  }
  if (/[ \t]+$/m.test(source)) {
    console.error(`${file}: trailing whitespace`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Checked ${javascript.length} JavaScript files.`);
