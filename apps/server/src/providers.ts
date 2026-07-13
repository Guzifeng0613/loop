import OpenAI from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderId,
  ProviderTurnInput,
  ProviderTurnResult
} from '@loop/contracts';
import type { CredentialStore } from './credentials.js';

const OPENAI_MODELS = ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.4-mini'];
const DEEPSEEK_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash'];

function providerStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as Error & { status?: number }).status;
  if (status) return status;
  const match = /(?:API|status(?: code)?)\s+(\d{3})/i.exec(error.message);
  return match?.[1] ? Number(match[1]) : undefined;
}

export async function completeWithRetry(
  adapter: ProviderAdapter,
  input: ProviderTurnInput,
  signal?: AbortSignal,
  maxAttempts = 4
): Promise<ProviderTurnResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await adapter.completeTurn(input, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = providerStatus(error);
      if (status === 401 || status === 403) throw new Error('PROVIDER_NOT_CONFIGURED: 模型凭据无效或已过期');
      if (status !== 429) throw error;
      if (attempt === maxAttempts - 1) throw new Error('PROVIDER_RATE_LIMITED: 模型供应商持续限流，请稍后继续');
      const waitMs = Math.min(8_000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 250);
      await delay(waitMs, undefined, signal ? { signal } : undefined);
    }
  }
  throw new Error('PROVIDER_RATE_LIMITED: 模型供应商持续限流，请稍后继续');
}

class OpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  constructor(private readonly apiKey: string) {}

  async testConnection(): Promise<boolean> {
    const client = new OpenAI({ apiKey: this.apiKey });
    await client.models.list();
    return true;
  }

  async listModels(): Promise<string[]> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const page = await client.models.list();
    return page.data.map((model) => model.id).filter((id) => id.startsWith('gpt-')).sort();
  }

  async completeTurn(input: ProviderTurnInput, signal?: AbortSignal): Promise<ProviderTurnResult> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.responses.create({
      model: input.model,
      instructions: input.systemPrompt,
      input: input.messages.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content
      })),
      store: false
    }, signal ? { signal } : undefined);
    return {
      text: response.output_text,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      finishReason: response.status ?? 'completed'
    };
  }
}

class DeepSeekAdapter implements ProviderAdapter {
  readonly id = 'deepseek' as const;
  constructor(private readonly apiKey: string) {}

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      const error = new Error(`DeepSeek API ${response.status}: ${await response.text()}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async testConnection(): Promise<boolean> {
    await this.request({ model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    return true;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!response.ok) return DEEPSEEK_MODELS;
    const data = await response.json() as { data?: { id: string }[] };
    return data.data?.map((model) => model.id).sort() ?? DEEPSEEK_MODELS;
  }

  async completeTurn(input: ProviderTurnInput, signal?: AbortSignal): Promise<ProviderTurnResult> {
    const response = await this.request({
      model: input.model,
      messages: [{ role: 'system', content: input.systemPrompt }, ...input.messages],
      ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {})
    }, signal);
    return {
      text: response.choices?.[0]?.message?.content ?? '',
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      finishReason: response.choices?.[0]?.finish_reason ?? 'completed'
    };
  }
}

export class ProviderRegistry {
  constructor(private readonly credentials: CredentialStore) {}

  async get(id: ProviderId): Promise<ProviderAdapter | undefined> {
    const key = await this.credentials.get(id);
    if (!key) return undefined;
    if (id === 'openai') return new OpenAIAdapter(key);
    if (id === 'deepseek') return new DeepSeekAdapter(key);
    return undefined;
  }

  async configs(): Promise<ProviderConfig[]> {
    const openAIConfigured = Boolean(await this.credentials.get('openai'));
    const deepSeekConfigured = Boolean(await this.credentials.get('deepseek'));
    return [
      {
        id: 'openai', label: 'OpenAI', configured: openAIConfigured, enabled: true,
        defaultModel: 'gpt-5.5', availableModels: OPENAI_MODELS, supportsTools: true, supportsReasoning: true
      },
      {
        id: 'deepseek', label: 'DeepSeek V4', configured: deepSeekConfigured, enabled: true,
        defaultModel: 'deepseek-v4-pro', availableModels: DEEPSEEK_MODELS, supportsTools: true, supportsReasoning: true
      },
      {
        id: 'local-demo', label: '本地演示', configured: true, enabled: true,
        defaultModel: 'local-structured-demo', availableModels: ['local-structured-demo'], supportsTools: false, supportsReasoning: false
      }
    ];
  }
}
