import { CloudLifecycleClient } from './cloud-client.js';
import { readInferenceMode, saveInferenceMode } from './inference-mode.js';
import { configureHost } from './transport.js';

function startupSurface(settings) {
  const surface = document.createElement('section');
  surface.className = 'cloud-startup';
  surface.setAttribute('aria-labelledby', 'cloud-startup-title');
  surface.innerHTML = `<form class="cloud-startup-card">
    <span class="brand-mark"><svg><use href="#i-audio"/></svg></span>
    <span class="cloud-startup-eyebrow">CLOUD MODE</span>
    <h1 id="cloud-startup-title">Starting cloud AI…</h1>
    <p class="cloud-startup-message">Waking the GPU and checking Whisper + Ollama.</p>
    <div class="cloud-startup-progress"><i></i></div>
    <label>Cloud controller<input name="controller" type="url" value="${settings.controllerUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" placeholder="https://your-site.netlify.app" autocomplete="url" required></label>
    <label>Cloud access code<input name="token" type="password" value="" autocomplete="current-password" required></label>
    <p class="cloud-startup-error" role="alert" hidden></p>
    <div class="cloud-startup-actions"><button class="secondary-button" type="button" data-use-local>Use local AI</button><button class="primary-button" type="submit">Retry cloud</button></div>
  </form>`;
  document.body.append(surface);
  document.querySelector('#app').inert = true;
  return surface;
}

async function startCloud(settings) {
  const surface = startupSurface(settings);
  const form = surface.querySelector('form');
  const heading = surface.querySelector('h1');
  const message = surface.querySelector('.cloud-startup-message');
  const error = surface.querySelector('.cloud-startup-error');
  form.controller.value = settings.controllerUrl;
  form.token.value = settings.accessCode;
  let client;
  async function connect(values) {
    error.hidden = true;
    form.querySelector('[type="submit"]').disabled = true;
    saveInferenceMode({ mode: 'cloud', controllerUrl: values.controllerUrl, accessCode: values.accessCode });
    client = new CloudLifecycleClient({
      controllerUrl: values.controllerUrl,
      accessCode: values.accessCode,
      onState(state) {
        heading.textContent = state.state === 'ready' ? 'Cloud AI ready' : 'Starting cloud AI…';
        message.textContent = state.message;
        document.body.dataset.cloudState = state.state;
      },
    });
    configureHost(client);
    try {
      await client.connect();
      const app = await import('./app.js');
      await app.appReady;
      document.documentElement.dataset.inferenceMode = 'cloud';
      document.querySelector('#app').inert = false;
      surface.remove();
      globalThis.addEventListener('pagehide', () => { void client.release(); }, { once: true });
    } catch (failure) {
      configureHost(null);
      error.textContent = failure.message;
      error.hidden = false;
      heading.textContent = 'Cloud AI needs attention';
      message.textContent = 'Check the controller, access code, and RunPod capacity, then retry.';
      form.querySelector('[type="submit"]').disabled = false;
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void connect({ controllerUrl: form.controller.value.trim(), accessCode: form.token.value.trim() });
  });
  form.querySelector('[data-use-local]').addEventListener('click', async () => {
    await client?.release();
    saveInferenceMode({ mode: 'local' });
    location.reload();
  });
  if (settings.controllerUrl && settings.accessCode) await connect(settings);
  else {
    heading.textContent = 'Connect cloud AI';
    message.textContent = 'Enter the Netlify controller URL and the access code provided by the owner.';
    surface.querySelector('.cloud-startup-progress').hidden = true;
    form.querySelector('[type="submit"]').disabled = false;
    (settings.controllerUrl ? form.token : form.controller).focus();
  }
}

const settings = readInferenceMode();
if (settings.mode === 'cloud') await startCloud(settings);
else {
  document.documentElement.dataset.inferenceMode = 'local';
  await import('./app.js');
}
