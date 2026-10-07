import { CONTROLLER_BASE } from './config.js';
import { CloudLifecycleClient } from '../web/cloud-client.js';
import { configureHost } from '../web/transport.js';
import { TRANSLATIONS, setLocale } from '../web/i18n.js';

// Reuse the complete desktop UI. Only hosting/privacy copy changes.
Object.assign(TRANSLATIONS.en, {
  'app.localWorkspace': 'Live web workspace',
  'nav.storedOnly': 'Stored on the demo host',
  'state.savedLocally': 'Saved on demo host · {date}',
  'empty.eyebrow': 'Live Whisper + Ollama',
  'empty.description': 'Capture audio, preserve the original transcript, and create focused study material with models running on the demo host.',
  'settings.subtitle': 'Configure processing on the demo host',
  'settings.storageHint': 'This shared demo workspace is stored on the host. Its location is managed by the owner.',
  'settings.whisperHint': 'The host owner installs models. Choose from the models already available.',
  'document.localWhisper': 'Whisper · {model}',
  'document.startDictationHint': 'Start dictation to see text appear while you speak, or upload a recording for transcription on the demo host.',
  'status.startOllama': 'Ollama is unavailable. Ask the demo owner to start the model server.',
});
Object.assign(TRANSLATIONS['zh-CN'], {
  'app.localWorkspace': '在线演示工作区',
  'nav.storedOnly': '存储在演示主机上',
  'state.savedLocally': '已保存到演示主机 · {date}',
  'empty.eyebrow': '真实 Whisper + Ollama 处理',
  'empty.description': '录制音频、保留原始转录，并使用演示主机上的模型生成学习材料。',
  'settings.subtitle': '配置演示主机上的处理设置',
  'settings.storageHint': '共享演示工作区保存在主机上，位置由所有者管理。',
  'settings.whisperHint': '模型由主机所有者安装，请选择已安装的模型。',
  'document.localWhisper': 'Whisper · {model}',
  'document.startDictationHint': '开始听写即可实时查看文字，或上传录音以在演示主机上转录。',
  'status.startOllama': 'Ollama 暂不可用，请联系演示所有者启动模型服务。',
});
setLocale('en');

const gate = document.createElement('section');
gate.className = 'host-gate';
gate.setAttribute('aria-labelledby', 'host-title');
gate.innerHTML = `<form class="host-card">
  <span class="host-brand"><svg aria-hidden="true"><use href="#i-audio"/></svg> Lecture Copilot</span>
  <span class="host-eyebrow">LIVE WEB DEMO</span>
  <h1 id="host-title">Your lecture. A clearer understanding.</h1>
  <p>The complete lecture workspace: live transcription, bilingual documents, and course-aware notes.</p>
  <label for="host-code">Demo access code</label><input id="host-code" type="password" autocomplete="current-password" required>
  <p class="host-privacy">Audio, materials, and documents are processed and saved on the demo host. This is a shared workspace: other people with the access code can see its sessions.</p>
  <button class="host-connect" type="submit">Open live workspace <span aria-hidden="true">→</span></button>
  <p class="host-error" role="alert" hidden></p>
  <a class="host-source" href="https://github.com/FAN0020/local_dictator" target="_blank" rel="noopener noreferrer">Explore the project on GitHub ↗</a>
</form>`;
document.body.append(gate);
document.querySelector('#app').inert = true;
document.querySelector('#storage-path').readOnly = true;
document.querySelector('#choose-storage').hidden = true;
const form = gate.querySelector('form');
const codeInput = gate.querySelector('#host-code');
const button = gate.querySelector('button');
const errorElement = gate.querySelector('.host-error');
const storageKey = 'lecture-copilot-live-host';
let saved = {};
try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { /* Storage can be disabled. */ }
let started = false;
let lifecycle = null;
async function connect(code) {
  errorElement.hidden = true;
  button.disabled = true;
  button.textContent = 'Starting cloud AI…';
  try {
    const controllerUrl = CONTROLLER_BASE || location.origin;
    lifecycle = new CloudLifecycleClient({
      controllerUrl, accessCode: code,
      onState(state) {
        button.textContent = state.state === 'ready' ? 'Opening workspace…' : state.message;
        gate.querySelector('#host-title').textContent = state.state === 'starting' ? 'Starting cloud AI…' : 'Your lecture. A clearer understanding.';
      },
    });
    await lifecycle.connect();
    try { sessionStorage.setItem(storageKey, JSON.stringify({ code })); } catch { /* Current-tab connection still works. */ }
    if (started) { location.reload(); return; }
    configureHost(lifecycle);
    const app = await import('../web/app.js');
    started = true;
    await app.appReady;
    document.querySelector('#app').inert = false;
    gate.hidden = true;
    codeInput.value = '';
    document.querySelector('#new-session').focus();
  } catch (error) {
    configureHost(null);
    errorElement.textContent = error.name === 'TypeError' || error.name === 'TimeoutError'
      ? 'Cannot reach the demo host. It may be offline, or this site may not be allowed to connect. Ask the owner to check the host URL and allowed origins.'
      : error.message;
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Open live workspace →';
  }
}
form.addEventListener('submit', (event) => { event.preventDefault(); void connect(codeInput.value.trim()); });
globalThis.addEventListener('lecture-host-unauthorized', () => {
  try { sessionStorage.removeItem(storageKey); } catch { /* No persistent credential remains. */ }
  gate.hidden = false;
  document.querySelector('#app').inert = true;
});
globalThis.addEventListener('pagehide', () => { void lifecycle?.release(); }, { once: true });
if (saved.code) await connect(saved.code);
else codeInput.focus();
