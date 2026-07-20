import * as vscode from "vscode";
import { ResolvedConnection } from "../models/connection";
import { ConnectionStore } from "../storage/connectionStore";
import { VaultError } from "../utils/errors";
import { VaultService } from "./vaultService";

/** Reads a numeric/boolean setting from the `vault` configuration section. */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration("vault");
  return {
    concurrency: cfg.get<number>("concurrency", 8),
    timeoutMs: cfg.get<number>("timeoutMs", 15000),
    backupBeforeReplace: cfg.get<boolean>("backupBeforeReplace", true),
    readOnly: cfg.get<boolean>("readOnly", false),
    defaultConnection: cfg.get<string>("defaultConnection", ""),
    defaultMount: cfg.get<string>("defaultMount", ""),
  };
}

/**
 * Builds {@link VaultService} instances for connections, resolving the token
 * from SecretStorage. Centralizes token resolution so the rest of the app never
 * touches SecretStorage directly.
 */
export class VaultServiceFactory {
  constructor(private readonly store: ConnectionStore) {}

  async resolve(connectionId: string): Promise<ResolvedConnection> {
    const conn = this.store.get(connectionId);
    if (!conn) {
      throw new VaultError("notFound", "The selected connection no longer exists.");
    }
    const token = await this.store.getToken(connectionId);
    if (!token) {
      throw new VaultError("tokenExpired", `No token set for "${conn.name}". Run "Vault: Set Token".`);
    }
    return { ...conn, token };
  }

  async create(connectionId: string): Promise<VaultService> {
    const resolved = await this.resolve(connectionId);
    const { timeoutMs } = getConfig();
    return new VaultService(resolved, timeoutMs);
  }
}
