import path from 'node:path';

export function resolveDesktopSttPaths({
  appPath,
  resourcesPath,
  userData,
  isPackaged,
  platform = process.platform,
  arch = process.arch,
  pathApi = path,
}) {
  const runtimeBase = isPackaged ? resourcesPath : appPath;
  const runtimeArch = platform === 'win32' ? 'x64' : arch;
  return {
    runtimeRoot: pathApi.join(runtimeBase, 'runtime', 'stt', `${platform}-${runtimeArch}`),
    modelRoot: pathApi.join(userData, 'models', 'whisper.cpp'),
  };
}
