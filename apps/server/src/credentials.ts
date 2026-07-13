import { Entry } from '@napi-rs/keyring';
import type { ProviderId } from '@loop/contracts';

const service = 'Loop Agent Workbench';

export class CredentialStore {
  private account(providerId: ProviderId): string {
    return `provider:${providerId}`;
  }

  async set(providerId: ProviderId, secret: string): Promise<void> {
    if (providerId === 'local-demo') return;
    new Entry(service, this.account(providerId)).setPassword(secret);
  }

  async get(providerId: ProviderId): Promise<string | undefined> {
    if (providerId === 'local-demo') return undefined;
    const environment = providerId === 'openai' ? process.env.OPENAI_API_KEY : process.env.DEEPSEEK_API_KEY;
    if (environment) return environment;
    try {
      return new Entry(service, this.account(providerId)).getPassword() || undefined;
    } catch {
      return undefined;
    }
  }

  async delete(providerId: ProviderId): Promise<void> {
    if (providerId === 'local-demo') return;
    try {
      new Entry(service, this.account(providerId)).deletePassword();
    } catch {
      // Missing credentials are already deleted.
    }
  }
}

