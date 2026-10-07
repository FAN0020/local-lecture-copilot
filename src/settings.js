import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './lib.js';

export async function loadSettings(file) {
  const resolved = path.resolve(file);
  try {
    const value = JSON.parse(await fs.readFile(resolved, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.warn(`Ignoring unreadable settings file ${resolved}: ${error.message}`);
    return {};
  }
}

export async function saveSettings(file, value) {
  await atomicJson(path.resolve(file), value);
  return value;
}
