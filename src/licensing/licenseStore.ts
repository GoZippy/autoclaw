// ZIPPY OPEN MATERIAL
//
// The single owner of license-key + BYO-key secret storage. Everything else
// goes through this so the secret keyspace lives in exactly one place.

import * as vscode from 'vscode';

const LICENSE_SECRET = 'autoclaw.license.key';
const BYO_KEY_SECRET = 'autoclaw.byok.apiKey';

export class LicenseStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getLicenseKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(LICENSE_SECRET);
    return key?.trim() || undefined;
  }

  async setLicenseKey(key: string): Promise<void> {
    await this.context.secrets.store(LICENSE_SECRET, key.trim());
  }

  async clearLicenseKey(): Promise<void> {
    await this.context.secrets.delete(LICENSE_SECRET);
  }

  async getByoKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(BYO_KEY_SECRET);
    return key?.trim() || undefined;
  }

  async setByoKey(key: string): Promise<void> {
    await this.context.secrets.store(BYO_KEY_SECRET, key.trim());
  }

  async clearByoKey(): Promise<void> {
    await this.context.secrets.delete(BYO_KEY_SECRET);
  }

  async hasByoKey(): Promise<boolean> {
    return !!(await this.getByoKey());
  }
}
