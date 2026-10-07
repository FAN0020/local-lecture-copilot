const MODE_KEY = 'lecture-copilot-inference-mode';
const CONTROLLER_KEY = 'lecture-copilot-cloud-controller';
const TOKEN_KEY = 'lecture-copilot-cloud-access';

export function readInferenceMode() {
  const mode = localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'local';
  return {
    mode,
    controllerUrl: localStorage.getItem(CONTROLLER_KEY) || '',
    accessCode: sessionStorage.getItem(TOKEN_KEY) || '',
  };
}

export function saveInferenceMode({ mode, controllerUrl = '', accessCode = '' }) {
  const selected = mode === 'cloud' ? 'cloud' : 'local';
  localStorage.setItem(MODE_KEY, selected);
  if (controllerUrl) localStorage.setItem(CONTROLLER_KEY, controllerUrl.trim());
  else if (selected === 'cloud') localStorage.removeItem(CONTROLLER_KEY);
  if (accessCode) sessionStorage.setItem(TOKEN_KEY, accessCode.trim());
  else if (selected === 'cloud') sessionStorage.removeItem(TOKEN_KEY);
  return readInferenceMode();
}

export function inferenceModeChanged(previous, next) {
  return previous.mode !== next.mode || (next.mode === 'cloud' && (previous.controllerUrl !== next.controllerUrl || previous.accessCode !== next.accessCode));
}
