import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopRuntimeTarget, resolveDesktopRuntimePaths } from '../desktop/runtime-paths.js';

test('Windows always resolves the production x64 runtime, including on an ARM64 host', () => {
  assert.equal(desktopRuntimeTarget('win32', 'arm64'), 'win32-x64');
  assert.equal(desktopRuntimeTarget('win32', 'x64'), 'win32-x64');
});

test('packaged Windows runtime and writable model paths remain separate', () => {
  const paths = resolveDesktopRuntimePaths({
    packaged: true,
    resourcesPath: 'C:\\Program Files\\Local Lecture Copilot\\resources',
    appPath: 'C:\\Program Files\\Local Lecture Copilot\\resources\\app.asar',
    userData: 'C:\\Users\\Student\\AppData\\Roaming\\local-lecture-copilot',
    platform: 'win32',
    arch: 'arm64',
  });
  assert.equal(paths.sttRuntimeRoot, 'C:\\Program Files\\Local Lecture Copilot\\resources\\runtime\\stt\\win32-x64');
  assert.equal(paths.sttModelRoot, 'C:\\Users\\Student\\AppData\\Roaming\\local-lecture-copilot\\models\\whisper.cpp');
  assert.equal(paths.workspaceRoot, 'C:\\Users\\Student\\AppData\\Roaming\\local-lecture-copilot\\workspace');
});

test('development runtime resolves below the application root', () => {
  const paths = resolveDesktopRuntimePaths({
    packaged: false,
    resourcesPath: 'C:\\ignored',
    appPath: 'C:\\src\\local_dictator',
    userData: 'C:\\Users\\Student\\AppData\\Roaming\\Electron',
    platform: 'win32',
    arch: 'x64',
  });
  assert.equal(paths.sttRuntimeRoot, 'C:\\src\\local_dictator\\runtime\\stt\\win32-x64');
  assert.equal(paths.preload, 'C:\\src\\local_dictator\\desktop\\preload.cjs');
});
