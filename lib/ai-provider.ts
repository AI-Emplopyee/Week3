// Live application configuration is GLM-only. Historical Kimi readers remain
// available for offline evidence replay, never as an automatic fallback.
export const DEFAULT_DOCUMENT_MODEL = 'glm-5.3-flash';
export const ZAI_ENDPOINT = 'https://api.z.ai/api/paas/v4';

export function documentAiConfiguration(environment: { ZAI_API_KEY?: string; ZAI_MODEL?: string }) {
  return { provider: 'zai' as const, apiKey: environment.ZAI_API_KEY, model: environment.ZAI_MODEL || DEFAULT_DOCUMENT_MODEL };
}

export function modelRequestOptions(model: string) {
  if (model === DEFAULT_DOCUMENT_MODEL) return {
    thinking: { type: 'enabled', clear_thinking: false },
    reasoning_effort: 'low',
    temperature: 1,
    top_p: 0.95,
  };
  if (/^kimi-k2\.[56](?:-|$)/.test(model)) return { thinking: { type: 'disabled' } };
  if (/^kimi-k3(?:-|$)/.test(model)) return { reasoning_effort: 'low' };
  return {};
}

export class AiResponseSizeError extends Error {
  constructor() {
    super('The AI provider returned an oversized or empty response.');
    this.name = 'AiResponseSizeError';
  }
}

/** Discard provider content without letting a stream error hide the HTTP status. */
export async function discardAiResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Bound both advertised and streamed bytes; never leave a rejected body open. */
export async function readBoundedAiResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body || Number(response.headers.get('content-length')) > maximumBytes) {
    await discardAiResponse(response);
    throw new AiResponseSizeError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AiResponseSizeError();
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new AiResponseSizeError();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
