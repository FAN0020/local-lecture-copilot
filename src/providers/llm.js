import { availableParallelism } from 'node:os';

const DEFAULT_SYSTEM = `You are a careful lecture editor. Follow the requested transformation exactly.
Never invent facts. Preserve uncertainty, technical terms, formulas, names, and source distinctions.
Return only the requested Markdown artifact, with no preamble or meta-commentary.`;

export class OllamaProvider {
  constructor({
    baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    timeoutMs = process.env.LECTURE_COPILOT_OLLAMA_TIMEOUT_MS || 120_000,
    keepAlive = process.env.LECTURE_COPILOT_OLLAMA_KEEP_ALIVE || '1m',
    numThreads = process.env.LECTURE_COPILOT_OLLAMA_THREADS || 4,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 120_000);
    this.keepAlive = keepAlive;
    const parsedThreads = Math.floor(Number(numThreads));
    this.numThreads = Math.min(availableParallelism(), Number.isFinite(parsedThreads) && parsedThreads > 0 ? parsedThreads : 4);
  }

  async generate({
    model,
    system = DEFAULT_SYSTEM,
    prompt,
    temperature = 0.1,
    signal,
    numCtx,
    numPredict,
    format,
    keepAlive = this.keepAlive,
  }) {
    const cancelled = () => Object.assign(new Error('Ollama request was cancelled'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 });
    if (signal?.aborted) throw cancelled();
    let response;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: requestSignal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: keepAlive,
          ...(format ? { format } : {}),
          options: {
            temperature,
            seed: 42,
            num_thread: this.numThreads,
            ...(Number(numCtx) > 0 ? { num_ctx: Math.floor(Number(numCtx)) } : {}),
            ...(Number(numPredict) > 0 ? { num_predict: Math.floor(Number(numPredict)) } : {}),
          },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (timeoutSignal.aborted) throw Object.assign(new Error(`Ollama request timed out after ${Math.round(this.timeoutMs / 1000)} seconds`), { code: 'OLLAMA_TIMEOUT', status: 504 });
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}. Start it with “ollama serve”. ${error.message}`);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${detail.slice(0, 600)}`);
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`Ollama returned malformed JSON: ${error.message}`);
    }
    const content = body.message?.content?.trim();
    if (!content) throw new Error('Ollama returned an empty response');
    return { content, provider: 'ollama', model, metrics: {
      totalDuration: body.total_duration,
      inputTokens: body.prompt_eval_count,
      outputTokens: body.eval_count,
    } };
  }

  async unload(model) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        signal: timeoutSignal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, keep_alive: 0 }),
      });
    } catch (error) {
      if (timeoutSignal.aborted) throw Object.assign(new Error(`Ollama unload timed out after ${Math.round(this.timeoutMs / 1000)} seconds`), { code: 'OLLAMA_TIMEOUT', status: 504 });
      throw new Error(`Cannot unload Ollama model ${model}: ${error.message}`);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama model unload failed (${response.status}): ${detail.slice(0, 600)}`);
    }
    return response.json();
  }

  async runningModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)) });
      if (!response.ok) return [];
      const body = await response.json();
      return (body.models || []).map((item) => ({
        name: item.name || item.model,
        size: item.size,
        sizeVram: item.size_vram,
        contextLength: item.context_length,
        expiresAt: item.expires_at,
        quantization: item.details?.quantization_level,
        parameterSize: item.details?.parameter_size,
      }));
    } catch {
      return [];
    }
  }

  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)) });
      if (!response.ok) return [];
      const body = await response.json();
      return (body.models || []).map((item) => item.name).filter(Boolean);
    } catch {
      return [];
    }
  }
}
