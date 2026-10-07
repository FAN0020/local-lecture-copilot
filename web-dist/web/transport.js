// The desktop keeps same-origin requests. The Netlify entry point supplies
// this adapter only after authenticating with the real processing host.
export function apiFetch(path, options = {}) {
  return globalThis.lectureCopilotHost?.fetch(path, options) ?? fetch(path, options);
}

export function audioSource(path) {
  return globalThis.lectureCopilotHost ? '' : path;
}

export function connectAudio(container) {
  globalThis.lectureCopilotHost?.connectAudio(container);
}

export function configureHost(host) {
  globalThis.lectureCopilotHost = host || undefined;
}
