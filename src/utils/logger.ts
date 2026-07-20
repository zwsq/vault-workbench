import * as vscode from "vscode";

/**
 * Output-channel logger.
 *
 * Security: this logger only ever emits metadata. It deliberately does not
 * accept structured secret payloads. Callers must pass already-safe strings
 * (paths, counts, status codes, error kinds). Never pass tokens, secret values,
 * connection strings, passwords, or API keys.
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name = "Vault") {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  /** Log an error object safely: only its name/kind/status, never its stack contents that could leak data. */
  errorFrom(context: string, err: unknown): void {
    const summary = summarizeError(err);
    this.write("ERROR", `${context}: ${summary}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level}] ${message}`);
  }
}

/** Produce a non-sensitive one-line summary of an error. */
export function summarizeError(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err && "message" in err) {
    const anyErr = err as { kind?: string; statusCode?: number; message?: string };
    const parts = [anyErr.kind, anyErr.statusCode ? `status=${anyErr.statusCode}` : undefined, anyErr.message]
      .filter(Boolean)
      .join(" ");
    return parts || "VaultError";
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return "Unknown error";
}
