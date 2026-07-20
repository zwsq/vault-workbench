import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Per-request TLS verification toggle. Only applied to https requests. */
  rejectUnauthorized: boolean;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Error thrown for low-level transport failures (carries a Node error code). */
export class HttpTransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HttpTransportError";
    this.code = code;
  }
}

/**
 * A tiny promise-based HTTP client built on Node's core http/https modules.
 *
 * Design notes:
 * - No third-party dependencies (minimizes supply chain + keeps everything local).
 * - TLS verification is controlled per-request via {@link HttpRequestOptions.rejectUnauthorized};
 *   the global process TLS settings are never modified.
 * - The request body is JSON-encoded. Response body is returned as raw text and
 *   parsed by callers.
 */
export function request(options: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      reject(new HttpTransportError("ERR_INVALID_URL", "Invalid Vault URL."));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");

    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }

    const reqOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method,
      headers,
    };
    if (isHttps) {
      // Scope TLS relaxation to THIS request only. Never mutate global TLS config.
      (reqOptions as https.RequestOptions).rejectUnauthorized = options.rejectUnauthorized;
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new HttpTransportError("ETIMEDOUT", "Request timed out."));
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code || (err as HttpTransportError).code || "EUNKNOWN";
      reject(new HttpTransportError(code, err.message));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}
