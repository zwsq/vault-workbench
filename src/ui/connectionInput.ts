import * as vscode from "vscode";
import { VaultConnection } from "../models/connection";

/** Simple UUID v4 generator (no external dependency). */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}

/**
 * Collect connection details via a sequence of input boxes and quick picks.
 * Returns undefined if the user cancels. Never prompts for the token here — the
 * token is captured separately via a password-masked input and stored in
 * SecretStorage.
 */
export async function promptConnection(existing?: VaultConnection): Promise<VaultConnection | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Vault Connection — Display Name",
    prompt: "A friendly name for this connection.",
    value: existing?.name ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Name is required." : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  const url = await vscode.window.showInputBox({
    title: "Vault Connection — URL",
    prompt: "e.g. https://vault.company.local:8200",
    value: existing?.url ?? "https://",
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:" ? undefined : "URL must be http or https.";
      } catch {
        return "Enter a valid URL.";
      }
    },
  });
  if (url === undefined) {
    return undefined;
  }

  const namespace = await vscode.window.showInputBox({
    title: "Vault Connection — Namespace (optional)",
    prompt: "Vault Enterprise namespace, or leave blank.",
    value: existing?.namespace ?? "",
    ignoreFocusOut: true,
  });
  if (namespace === undefined) {
    return undefined;
  }

  const defaultMount = await vscode.window.showInputBox({
    title: "Vault Connection — Default KV Mount",
    prompt: "e.g. secret",
    value: existing?.defaultMount ?? "secret",
    ignoreFocusOut: true,
  });
  if (defaultMount === undefined) {
    return undefined;
  }

  const basePath = await vscode.window.showInputBox({
    title: "Vault Connection — Path Prefix (optional)",
    prompt: "Browse from this sub-path if your token is scoped, e.g. apps/api. Leave blank for the mount root.",
    value: existing?.basePath ?? "",
    ignoreFocusOut: true,
  });
  if (basePath === undefined) {
    return undefined;
  }

  const kvPick = await vscode.window.showQuickPick(
    [
      { label: "Auto-detect", value: undefined as 1 | 2 | undefined },
      { label: "KV Version 2", value: 2 as const },
      { label: "KV Version 1", value: 1 as const },
    ],
    { title: "Vault Connection — KV Version", ignoreFocusOut: true }
  );
  if (kvPick === undefined) {
    return undefined;
  }

  const tlsPick = await vscode.window.showQuickPick(
    [
      { label: "Verify TLS certificate (recommended)", value: false },
      { label: "Skip TLS verification (self-signed / internal PKI)", value: true },
    ],
    {
      title: "Vault Connection — TLS",
      placeHolder: existing?.skipTlsVerify ? "Currently: skipping verification" : "Currently: verifying",
      ignoreFocusOut: true,
    }
  );
  if (tlsPick === undefined) {
    return undefined;
  }

  return {
    id: existing?.id ?? uuid(),
    name: name.trim(),
    url: url.trim().replace(/\/+$/, ""),
    authMethod: "token",
    namespace: namespace.trim() || undefined,
    defaultMount: defaultMount.trim(),
    basePath: basePath.trim() || undefined,
    skipTlsVerify: tlsPick.value,
    kvVersion: kvPick.value,
  };
}

/** Prompt for a Vault token with masked input. */
export async function promptToken(connectionName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Vault Token — ${connectionName}`,
    prompt: "The token is stored securely in VS Code SecretStorage and never synced.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Token is required." : undefined),
  });
}
