import * as vscode from "vscode";
import { ConnectionGroup, VaultConnection } from "../models/connection";

const CONNECTIONS_KEY = "vault.connections.v1";
const GROUPS_KEY = "vault.connectionGroups.v1";

/**
 * Persists connection definitions and optional groups in extension globalState
 * (local-only) and tokens in SecretStorage.
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
    return this.sortedConnections(this.context.globalState.get<VaultConnection[]>(CONNECTIONS_KEY, []));
  }

  get(id: string): VaultConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  getByName(name: string): VaultConnection | undefined {
    return this.list().find((c) => c.name === name);
  }

  async upsert(connection: VaultConnection): Promise<void> {
    const all = this.rawConnections();
    const idx = all.findIndex((c) => c.id === connection.id);
    if (idx === -1) {
      const siblings = all.filter((c) => (c.groupId ?? "") === (connection.groupId ?? ""));
      const maxOrder = siblings.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), -1);
      all.push({ ...connection, sortOrder: connection.sortOrder ?? maxOrder + 1 });
    } else {
      all[idx] = { ...all[idx], ...connection };
    }
    await this.persistConnections(all);
  }

  async remove(id: string): Promise<void> {
    const all = this.rawConnections().filter((c) => c.id !== id);
    await this.persistConnections(all);
    await this.deleteToken(id);
  }

  listGroups(): ConnectionGroup[] {
    return this.sortedGroups(this.context.globalState.get<ConnectionGroup[]>(GROUPS_KEY, []));
  }

  getGroup(id: string): ConnectionGroup | undefined {
    return this.listGroups().find((g) => g.id === id);
  }

  async upsertGroup(group: ConnectionGroup): Promise<void> {
    const all = this.rawGroups();
    const idx = all.findIndex((g) => g.id === group.id);
    if (idx === -1) {
      const maxOrder = all.reduce((m, g) => Math.max(m, g.sortOrder), -1);
      all.push({ ...group, sortOrder: group.sortOrder ?? maxOrder + 1 });
    } else {
      all[idx] = { ...all[idx], ...group };
    }
    await this.persistGroups(all);
  }

  async removeGroup(id: string): Promise<void> {
    const groups = this.rawGroups().filter((g) => g.id !== id);
    await this.persistGroups(groups);
    // Ungroup connections that belonged to the deleted group.
    const conns = this.rawConnections().map((c) =>
      c.groupId === id ? { ...c, groupId: undefined } : c
    );
    await this.persistConnections(conns);
  }

  /** Connections in a group (or ungrouped when groupId is undefined). */
  listInGroup(groupId: string | undefined): VaultConnection[] {
    const key = groupId ?? "";
    return this.list().filter((c) => (c.groupId ?? "") === key);
  }

  async setConnectionGroup(connectionId: string, groupId: string | undefined): Promise<void> {
    const all = this.rawConnections();
    const conn = all.find((c) => c.id === connectionId);
    if (!conn) {
      return;
    }
    const siblings = all.filter(
      (c) => c.id !== connectionId && (c.groupId ?? "") === (groupId ?? "")
    );
    const maxOrder = siblings.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), -1);
    conn.groupId = groupId;
    conn.sortOrder = maxOrder + 1;
    await this.persistConnections(all);
  }

  /**
   * Reorder connections within the same group (or among ungrouped).
   * `orderedIds` is the full desired order for that group.
   */
  async reorderConnections(groupId: string | undefined, orderedIds: string[]): Promise<void> {
    const key = groupId ?? "";
    const all = this.rawConnections();
    orderedIds.forEach((id, index) => {
      const conn = all.find((c) => c.id === id);
      if (conn && (conn.groupId ?? "") === key) {
        conn.sortOrder = index;
      }
    });
    await this.persistConnections(all);
  }

  /** Reorder groups at the root. `orderedIds` is the full desired group order. */
  async reorderGroups(orderedIds: string[]): Promise<void> {
    const all = this.rawGroups();
    orderedIds.forEach((id, index) => {
      const group = all.find((g) => g.id === id);
      if (group) {
        group.sortOrder = index;
      }
    });
    await this.persistGroups(all);
  }

  /** Move a connection one slot up or down within its group (or among ungrouped). */
  async shiftConnection(connectionId: string, direction: -1 | 1): Promise<boolean> {
    const conn = this.get(connectionId);
    if (!conn) {
      return false;
    }
    const siblings = this.listInGroup(conn.groupId);
    const idx = siblings.findIndex((c) => c.id === connectionId);
    const swapWith = idx + direction;
    if (idx < 0 || swapWith < 0 || swapWith >= siblings.length) {
      return false;
    }
    const ids = siblings.map((c) => c.id);
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    await this.reorderConnections(conn.groupId, ids);
    return true;
  }

  /** Move a group one slot up or down among groups. */
  async shiftGroup(groupId: string, direction: -1 | 1): Promise<boolean> {
    const groups = this.listGroups();
    const idx = groups.findIndex((g) => g.id === groupId);
    const swapWith = idx + direction;
    if (idx < 0 || swapWith < 0 || swapWith >= groups.length) {
      return false;
    }
    const ids = groups.map((g) => g.id);
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    await this.reorderGroups(ids);
    return true;
  }

  /**
   * Move `connectionId` into `targetGroupId` (or ungrouped) and insert it before
   * `beforeConnectionId` when provided; otherwise append.
   */
  async moveConnection(
    connectionId: string,
    targetGroupId: string | undefined,
    beforeConnectionId?: string
  ): Promise<void> {
    const all = this.rawConnections();
    const moving = all.find((c) => c.id === connectionId);
    if (!moving) {
      return;
    }
    moving.groupId = targetGroupId;

    const key = targetGroupId ?? "";
    const siblings = all
      .filter((c) => c.id !== connectionId && (c.groupId ?? "") === key)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    const ordered: VaultConnection[] = [];
    let inserted = false;
    for (const s of siblings) {
      if (beforeConnectionId && s.id === beforeConnectionId) {
        ordered.push(moving);
        inserted = true;
      }
      ordered.push(s);
    }
    if (!inserted) {
      ordered.push(moving);
    }
    ordered.forEach((c, index) => {
      c.sortOrder = index;
    });
    await this.persistConnections(all);
  }

  private rawConnections(): VaultConnection[] {
    return [...this.context.globalState.get<VaultConnection[]>(CONNECTIONS_KEY, [])];
  }

  private rawGroups(): ConnectionGroup[] {
    return [...this.context.globalState.get<ConnectionGroup[]>(GROUPS_KEY, [])];
  }

  private sortedConnections(all: VaultConnection[]): VaultConnection[] {
    return [...all].sort((a, b) => {
      const ga = a.groupId ?? "";
      const gb = b.groupId ?? "";
      if (ga !== gb) {
        return ga.localeCompare(gb);
      }
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
    });
  }

  private sortedGroups(all: ConnectionGroup[]): ConnectionGroup[] {
    return [...all].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  private async persistConnections(all: VaultConnection[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, all);
    this.context.globalState.setKeysForSync([]);
  }

  private async persistGroups(all: ConnectionGroup[]): Promise<void> {
    await this.context.globalState.update(GROUPS_KEY, all);
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
