import * as vscode from "vscode";
import { VaultConnection } from "../models/connection";
import { ConnectionStore } from "../storage/connectionStore";
import { isAuthError, offerReauthOnError } from "../ui/connectionInput";
import { Logger, summarizeError } from "../utils/logger";
import { VaultError } from "../utils/errors";
import { baseName, joinPath, normalizePath } from "../utils/paths";
import { accessiblePathRoots } from "../vault/vaultService";
import { VaultServiceFactory } from "../vault/vaultServiceFactory";

export type VaultNodeKind = "group" | "connection" | "mount" | "folder" | "secret";

/** A node in the Vault Explorer tree. */
export interface VaultNode {
  kind: VaultNodeKind;
  label: string;
  /** Connection id; empty string for group nodes. */
  connectionId: string;
  /** Present for group nodes and connections that belong to a group. */
  groupId?: string;
  mount?: string;
  /** Path relative to the mount (folders and secrets). */
  path?: string;
}

/**
 * Provides the lazy-loading Vault Explorer tree. Children are fetched on demand
 * as folders are expanded so opening a connection with tens of thousands of
 * secrets never blocks the UI.
 *
 * Root children are connection groups plus ungrouped connections.
 */
export class VaultTreeProvider implements vscode.TreeDataProvider<VaultNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<VaultNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly factory: VaultServiceFactory,
    private readonly logger: Logger
  ) {}

  refresh(node?: VaultNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(node: VaultNode): vscode.TreeItem {
    switch (node.kind) {
      case "group":
        return this.groupItem(node);
      case "connection":
        return this.connectionItem(node);
      case "mount": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `mount:${node.connectionId}:${node.mount}`;
        item.iconPath = new vscode.ThemeIcon("database");
        item.contextValue = "vaultMount";
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `folder:${node.connectionId}:${node.mount}:${node.path}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "vaultFolder";
        item.tooltip = `${node.mount}/${node.path}`;
        return item;
      }
      case "secret": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `secret:${node.connectionId}:${node.mount}:${node.path}`;
        item.iconPath = new vscode.ThemeIcon("key");
        item.contextValue = "vaultSecret";
        item.command = {
          command: "vault.openSecret",
          title: "Open Secret",
          arguments: [node],
        };
        return item;
      }
    }
  }

  private groupItem(node: VaultNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${node.groupId}`;
    item.iconPath = new vscode.ThemeIcon("folder-library");
    item.contextValue = "vaultGroup";
    item.tooltip = `Group: ${node.label}`;
    return item;
  }

  private connectionItem(node: VaultNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `connection:${node.connectionId}`;
    item.iconPath = new vscode.ThemeIcon("server-environment");
    item.contextValue = "vaultConnection";
    const conn = this.store.get(node.connectionId);
    if (conn) {
      item.description = conn.url.replace(/^https?:\/\//, "");
      item.tooltip = new vscode.MarkdownString(
        [
          `**${conn.name}**`,
          `URL: ${conn.url}`,
          conn.namespace ? `Namespace: ${conn.namespace}` : undefined,
          conn.defaultMount ? `Mount: ${conn.defaultMount}` : undefined,
          conn.basePath ? `Path prefix: ${conn.basePath}` : undefined,
          `TLS verify: ${conn.skipTlsVerify ? "off" : "on"}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      );
    }
    return item;
  }

  async getChildren(node?: VaultNode): Promise<VaultNode[]> {
    if (!node) {
      const groups = this.store.listGroups().map((g) => this.toGroupNode(g.id, g.name));
      const ungrouped = this.store.listInGroup(undefined).map((c) => this.toConnectionNode(c));
      return [...groups, ...ungrouped];
    }
    try {
      switch (node.kind) {
        case "group":
          return this.store.listInGroup(node.groupId).map((c) => this.toConnectionNode(c));
        case "connection":
          return await this.mountsOf(node.connectionId);
        case "mount": {
          const base = normalizePath(this.store.get(node.connectionId)?.basePath ?? "");
          if (base) {
            // Path prefix is set (Edit Connection): show only that path under the
            // mount — never siblings from a full mount listing or ACL roots.
            return [
              {
                kind: "folder" as const,
                label: base,
                connectionId: node.connectionId,
                mount: node.mount!,
                path: base,
              },
            ];
          }
          return await this.listChildrenWithAclFallback(node.connectionId, node.mount!, "");
        }
        case "folder":
          return await this.listChildrenWithAclFallback(
            node.connectionId,
            node.mount!,
            node.path ?? ""
          );
        default:
          return [];
      }
    } catch (err) {
      this.logger.warn(`Failed to expand ${node.kind}: ${summarizeError(err)}`);
      const conn = node.connectionId ? this.store.get(node.connectionId) : undefined;
      const reauthed = await offerReauthOnError(err, conn, this.store);
      if (reauthed) {
        try {
          return await this.getChildren(node);
        } catch (retryErr) {
          this.logger.warn(`Retry after re-auth failed: ${summarizeError(retryErr)}`);
          vscode.window.showErrorMessage(`Vault: ${summarizeError(retryErr)}`);
          return [];
        }
      }
      if (!conn || !isAuthError(err)) {
        vscode.window.showErrorMessage(`Vault: ${summarizeError(err)}`);
      }
      return [];
    }
  }

  private toGroupNode(groupId: string, name: string): VaultNode {
    return { kind: "group", label: name, connectionId: "", groupId };
  }

  private toConnectionNode(c: VaultConnection): VaultNode {
    return { kind: "connection", label: c.name, connectionId: c.id, groupId: c.groupId };
  }

  private async mountsOf(connectionId: string): Promise<VaultNode[]> {
    const conn = this.store.get(connectionId)!;
    // Edit Connection can pin a single KV mount; honor that instead of listing all.
    const pinned = (conn.defaultMount ?? "").trim();
    if (pinned) {
      return [{ kind: "mount" as const, label: pinned, connectionId, mount: pinned }];
    }
    const service = await this.factory.create(connectionId);
    const mounts = await service.discoverKvMounts();
    return mounts.map((m) => ({
      kind: "mount" as const,
      label: m.path,
      connectionId,
      mount: m.path,
    }));
  }

  /**
   * List children under a mount/path. When LIST returns nothing / permission denied
   * at this path — typical for path-scoped tokens — seed folder nodes from
   * resultant-ACL, but only under `path` (never siblings outside it).
   */
  private async listChildrenWithAclFallback(
    connectionId: string,
    mount: string,
    path: string
  ): Promise<VaultNode[]> {
    const normPath = normalizePath(path);
    try {
      const children = await this.listChildren(connectionId, mount, normPath);
      if (children.length > 0) {
        return children;
      }
    } catch (err) {
      if (!this.isListPermissionDenied(err)) {
        throw err;
      }
    }

    const service = await this.factory.create(connectionId);
    const accessible = await service.listAccessiblePaths(mount);
    const under = accessible.filter((p) => {
      if (!normPath) {
        return p !== "";
      }
      return p === normPath || p.startsWith(normPath + "/");
    });
    const roots = accessiblePathRoots(under);

    // Immediate children relative to normPath (or top ACL roots when at mount root).
    const seeded: string[] = [];
    for (const p of roots) {
      if (!normPath) {
        if (p) {
          seeded.push(p);
        }
        continue;
      }
      if (p === normPath) {
        continue;
      }
      if (p.startsWith(normPath + "/")) {
        const rest = p.slice(normPath.length + 1);
        const next = rest.split("/")[0];
        if (next) {
          seeded.push(joinPath(normPath, next));
        }
      }
    }

    const unique = [...new Set(seeded)];
    return unique.map((p) => ({
      kind: "folder" as const,
      label: baseName(p) || p,
      connectionId,
      mount,
      path: p,
    }));
  }

  private isListPermissionDenied(err: unknown): boolean {
    return (
      err instanceof VaultError &&
      (err.kind === "unauthorized" || err.kind === "forbidden" || err.kind === "tokenExpired")
    );
  }

  private async listChildren(connectionId: string, mount: string, path: string): Promise<VaultNode[]> {
    const service = await this.factory.create(connectionId);
    const entries = await service.list(mount, path);
    const folders = entries
      .filter((e) => e.isFolder)
      .map<VaultNode>((e) => ({
        kind: "folder",
        label: e.name,
        connectionId,
        mount,
        path: joinPath(path, e.name),
      }));
    const secrets = entries
      .filter((e) => !e.isFolder)
      .map<VaultNode>((e) => ({
        kind: "secret",
        label: e.name,
        connectionId,
        mount,
        path: joinPath(path, e.name),
      }));
    return [...folders, ...secrets];
  }
}
