import { ResolvedConnection } from "../models/connection";
import { classifyVaultError, VaultError } from "../utils/errors";
import { HttpTransportError, request } from "./httpClient";

/**
 * Low-level typed wrapper around Vault's HTTP API.
 *
 * Responsibilities:
 * - Attaches the X-Vault-Token and optional X-Vault-Namespace headers.
 * - Applies per-connection TLS verification and the configured timeout.
 * - Translates HTTP/transport failures into friendly {@link VaultError}s.
 *
 * It knows nothing about KV versioning semantics — that lives in the service layer.
 */
export class VaultApi {
  constructor(private readonly conn: ResolvedConnection, private readonly timeoutMs: number) {}

  private baseUrl(): string {
    return this.conn.url.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Vault-Token": this.conn.token };
    if (this.conn.namespace && this.conn.namespace.trim().length > 0) {
      h["X-Vault-Namespace"] = this.conn.namespace.trim();
    }
    return h;
  }

  /** Perform a request against a Vault v1 API path (without leading /v1/). */
  async call<T = any>(
    method: string,
    apiPath: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>
  ): Promise<{ status: number; data: T | undefined }> {
    const qs = buildQuery(query);
    const url = `${this.baseUrl()}/v1/${apiPath.replace(/^\/+/, "")}${qs}`;

    let res;
    try {
      res = await request({
        method,
        url,
        headers: this.headers(),
        body,
        timeoutMs: this.timeoutMs,
        rejectUnauthorized: !this.conn.skipTlsVerify,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) {
        throw classifyVaultError({ nodeCode: err.code, path: apiPath });
      }
      throw classifyVaultError({ path: apiPath });
    }

    let parsed: any;
    if (res.body && res.body.trim().length > 0) {
      try {
        parsed = JSON.parse(res.body);
      } catch {
        parsed = undefined;
      }
    }

    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, data: parsed as T };
    }
    // 404 with no handler => mount missing; keep body errors for classification.
    const vaultErrors: string[] | undefined = parsed?.errors;
    throw classifyVaultError({ status: res.status, vaultErrors, path: apiPath });
  }

  /** GET helper that returns undefined data on 404 instead of throwing. */
  async tryCall<T = any>(
    method: string,
    apiPath: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>
  ): Promise<{ status: number; data: T | undefined } | undefined> {
    try {
      return await this.call<T>(method, apiPath, body, query);
    } catch (err) {
      if (err instanceof VaultError && (err.kind === "notFound" || err.kind === "mountNotFound")) {
        return undefined;
      }
      throw err;
    }
  }
}

function buildQuery(query?: Record<string, string | number | undefined>): string {
  if (!query) {
    return "";
  }
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
