import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './lib.js';

/**
 * Filesystem operations used by the session store.
 *
 * Keeping these operations behind a small adapter makes the persistence layer
 * independent from the process that hosts it. The web server and the desktop
 * shell both use this adapter, while the browser continues to communicate via
 * the existing HTTP API.
 */
export class FileStorageAdapter {
  constructor(root) {
    this.setRoot(root);
  }

  setRoot(root) {
    const value = String(root || '').trim();
    if (!value) throw new Error('A workspace directory is required');
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
      throw new Error('The workspace directory cannot be the filesystem root');
    }
    this.root = resolved;
    return this.root;
  }

  resolve(target = '.') {
    const candidate = path.resolve(this.root, target);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${path.sep}`)) {
      throw new Error('Storage path escapes the workspace directory');
    }
    return candidate;
  }

  async mkdir(target) {
    await fs.mkdir(this.resolve(target), { recursive: true });
  }

  async readdir(target, options) {
    return fs.readdir(this.resolve(target), options);
  }

  async readFile(target, options) {
    return fs.readFile(this.resolve(target), options);
  }

  async writeFile(target, data, options) {
    const resolved = this.resolve(target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    return fs.writeFile(resolved, data, options);
  }

  async writeAtomicJson(target, value) {
    await atomicJson(this.resolve(target), value);
  }

  async unlink(target) {
    return fs.unlink(this.resolve(target));
  }

  async rm(target, options) {
    return fs.rm(this.resolve(target), options);
  }

  async copyTo(destination) {
    const target = path.resolve(destination);
    if (target === this.root) return target;
    if (target.startsWith(`${this.root}${path.sep}`) || this.root.startsWith(`${target}${path.sep}`)) {
      throw new Error('The new workspace cannot be inside or contain the current workspace');
    }
    await fs.mkdir(target, { recursive: true });
    let entries = [];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return target;
      throw error;
    }
    for (const entry of entries) {
      await fs.cp(path.join(this.root, entry.name), path.join(target, entry.name), {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: false,
      });
    }
    return target;
  }
}
