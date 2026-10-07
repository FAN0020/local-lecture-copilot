import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveDesktopSttPaths } from '../src/desktop-paths.js';

test('packaged Windows keeps runtime resources read-only and models under writable user data', () => {
  const paths = resolveDesktopSttPaths({
    appPath: 'C:\\Program Files\\Local Lecture Copilot\\resources\\app.asar',
    resourcesPath: 'C:\\Program Files\\Local Lecture Copilot\\resources',
    userData: 'C:\\Users\\Ada\\AppData\\Roaming\\Local Lecture Copilot',
    isPackaged: true,
    platform: 'win32',
    arch: 'arm64',
    pathApi: path.win32,
  });

  assert.equal(paths.runtimeRoot, 'C:\\Program Files\\Local Lecture Copilot\\resources\\runtime\\stt\\win32-x64');
  assert.equal(paths.modelRoot, 'C:\\Users\\Ada\\AppData\\Roaming\\Local Lecture Copilot\\models\\whisper.cpp');
  assert.equal(paths.modelRoot.startsWith('C:\\Program Files'), false);
});

test('packaged macOS keeps the existing resources and user-data split', () => {
  const paths = resolveDesktopSttPaths({
    appPath: '/Applications/Local Lecture Copilot.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/Local Lecture Copilot.app/Contents/Resources',
    userData: '/Users/ada/Library/Application Support/Local Lecture Copilot',
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    pathApi: path.posix,
  });

  assert.equal(paths.runtimeRoot, '/Applications/Local Lecture Copilot.app/Contents/Resources/runtime/stt/darwin-arm64');
  assert.equal(paths.modelRoot, '/Users/ada/Library/Application Support/Local Lecture Copilot/models/whisper.cpp');
});
