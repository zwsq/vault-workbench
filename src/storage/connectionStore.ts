import * as vscode from "vscode";
import { VaultConnection } from "../models/connection";

const CONNECTIONS_KEY = "vault.connections.v1";

/**
 * Persists connection definitions in extension globalState (local-only) and
 * tokens in SecretStorage.
 *
 * Security:
 * - Connection metadata (URL, namespace, mount) is stored in globalState which
 *   is NOT part of Settings Sync, so it never leaves the machine.
 * - Tokens are stored only in SecretStorage, keyed by connection id.
 * - We call {@link vscode.ExtensionContext.globalState.setKeysForSync} with an
 *   empty list to explicitly opt out of syncing any of our keys.
 */
export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {
    // Explicitly ensure none of our global keys are ever synced.
    this.context.globalState.setKeysForSync([]);
  }

  list(): VaultConnection[] {
    return this.context.globalState.get<VaultConnection[]>(CONNECTIONS_KEY, []);
  }

  get(id: string): VaultConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  getByName(name: string): VaultConnection | undefined {
    return this.list().find((c) => c.name === name);
  }

  async upsert(connection: VaultConnection): Promise<void> {
    const all = this.list();
    const idx = all.findIndex((c) => c.id === connection.id);
    if (idx === -1) {
      all.push(connection);
    } else {
      all[idx] = connection;
    }
    await this.persist(all);
  }

  async remove(id: string): Promise<void> {
    const all = this.list().filter((c) => c.id !== id);
    await this.persist(all);
    await this.deleteToken(id);
  }

  private async persist(all: VaultConnection[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, all);
    this.context.globalState.setKeysForSync([]);
  }

  // --- Token handling (SecretStorage only) ---

  tokenKey(id: string): string {
    return `vault.token.${id}`;
  }

  async setToken(id: string, token: string): Promise<void> {
    await this.context.secrets.store(this.tokenKey(id), token);
  }

  async getToken(id: string): Promise<string | undefined> {
    return this.context.secrets.get(this.tokenKey(id));
  }

  async deleteToken(id: string): Promise<void> {
    await this.context.secrets.delete(this.tokenKey(id));
  }
}
