import path from 'node:path';

export function desktopRuntimeTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${platform === 'win32' ? 'x64' : arch}`;
}

export function resolveDesktopRuntimePaths({
  packaged,
  resourcesPath,
  appPath,
  userData,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const runtimeTarget = desktopRuntimeTarget(platform, arch);
  const resourceRoot = packaged ? resourcesPath : appPath;
  return {
    runtimeTarget,
    icon: pathApi.join(resourceRoot, 'icon.png'),
    preload: pathApi.join(appPath, 'desktop', 'preload.cjs'),
    sttRuntimeRoot: pathApi.join(resourceRoot, 'runtime', 'stt', runtimeTarget),
    sttModelRoot: pathApi.join(userData, 'models', 'whisper.cpp'),
    settingsPath: pathApi.join(userData, 'settings.json'),
    workspaceRoot: pathApi.join(userData, 'workspace'),
  };
}
