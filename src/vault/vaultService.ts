import { VaultApi } from "../api/vaultApi";
import { KvVersion, ResolvedConnection } from "../models/connection";
import { ListingEntry, SecretData, SecretRecord } from "../models/secret";
import { VaultError } from "../utils/errors";
import { isFolderKey, joinPath, normalizePath } from "../utils/paths";

/**
 * High-level, KV-version-aware operations against a single Vault connection.
 *
 * Handles the differing path layouts of KV v1 (`{mount}/{path}`) and KV v2
 * (`{mount}/data/{path}`, `{mount}/metadata/{path}`), auto-detects the engine
 * version, and returns clean domain objects. Contains no VS Code dependencies.
 */
export class VaultService {
  private readonly api: VaultApi;
  private readonly versionCache = new Map<string, KvVersion>();

  constructor(private readonly conn: ResolvedConnection, timeoutMs: number) {
    this.api = new VaultApi(conn, timeoutMs);
  }

  /** Verify connectivity and token validity via the token self-lookup endpoint. */
  async verify(): Promise<void> {
    await this.api.call("GET", "auth/token/lookup-self");
  }

  /**
   * Detect the KV engine version for a mount.
   *
   * Order of resolution: explicit connection override → cache → the Vault UI
   * mounts endpoint → a `{mount}/config` probe. Crucially, permission (403)
   * errors from the sys/config endpoints are tolerated: a token scoped to a
   * single path can still browse because we fall back to KV v2 (the modern
   * default) rather than aborting. Set an explicit KV version on the connection
   * to remove all guessing.
   */
  async detectKvVersion(mount: string): Promise<KvVersion> {
    const key = normalizePath(mount);
    if (this.conn.kvVersion) {
      return this.conn.kvVersion;
    }
    const cached = this.versionCache.get(key);
    if (cached) {
      return cached;
    }

    let version: KvVersion = 2;
    const info = await this.safePermission(() => this.api.tryCall<any>("GET", `sys/internal/ui/mounts/${key}`));
    const reported = info?.data?.data?.options?.version ?? info?.data?.options?.version;
    if (reported === "1" || reported === 1) {
      version = 1;
    } else if (reported === "2" || reported === 2) {
      version = 2;
    } else {
      // KV v2 exposes a `{mount}/config` endpoint (200); KV v1 returns 404
      // (tryCall maps 404 to undefined). If the token lacks permission to probe
      // (marker), default to v2.
      const PERMISSION_MARKER = Symbol("permission-denied");
      const cfg = await this.safePermission(
        () => this.api.tryCall("GET", `${key}/config`),
        PERMISSION_MARKER as any
      );
      version = cfg === undefined ? 1 : 2;
    }
    this.versionCache.set(key, version);
    return version;
  }

  /**
   * Run an API call, swallowing permission-style errors. Returns `fallback`
   * (default undefined) when the token is not allowed to make the call, so
   * scoped tokens do not break higher-level operations.
   */
  private async safePermission<T>(fn: () => Promise<T>, fallback?: T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof VaultError &&
        (err.kind === "unauthorized" ||
          err.kind === "forbidden" ||
          err.kind === "tokenExpired" ||
          err.kind === "namespaceNotFound")
      ) {
        return fallback;
      }
      throw err;
    }
  }

  /** List immediate children of `path` under `mount`. */
  async list(mount: string, path: string): Promise<ListingEntry[]> {
    const version = await this.detectKvVersion(mount);
    const m = normalizePath(mount);
    const p = normalizePath(path);
    const apiPath = version === 2 ? joinPath(m, "metadata", p) : joinPath(m, p);

    const res = await this.api.tryCall<{ data?: { keys?: string[] } }>("GET", apiPath, undefined, {
      list: "true",
    });
    const keys = res?.data?.data?.keys ?? [];
    return keys.map((key) => {
      const folder = isFolderKey(key);
      const name = folder ? key.slice(0, -1) : key;
      return {
        name,
        path: joinPath(p, name),
        isFolder: folder,
      } satisfies ListingEntry;
    });
  }

  /** Read a single secret. Returns undefined if it does not exist. */
  async read(mount: string, path: string): Promise<SecretRecord | undefined> {
    const version = await this.detectKvVersion(mount);
    const m = normalizePath(mount);
    const p = normalizePath(path);

    if (version === 2) {
      const apiPath = joinPath(m, "data", p);
      const res = await this.api.tryCall<any>("GET", apiPath);
      if (!res) {
        return undefined;
      }
      const meta = res.data?.data?.metadata;
      const data = (res.data?.data?.data ?? {}) as SecretData;
      const deleted = Boolean(meta?.deletion_time);
      if (deleted && Object.keys(data).length === 0) {
        return { path: p, mount: m, kvVersion: 2, data, version: meta?.version, deleted: true };
      }
      return { path: p, mount: m, kvVersion: 2, data, version: meta?.version, deleted };
    }

    const apiPath = joinPath(m, p);
    const res = await this.api.tryCall<any>("GET", apiPath);
    if (!res) {
      return undefined;
    }
    const data = (res.data?.data ?? {}) as SecretData;
    return { path: p, mount: m, kvVersion: 1, data };
  }

  /**
   * Write a secret. For KV v2, `expectedVersion` enables a check-and-set write
   * that fails with a version conflict if the secret changed meanwhile.
   */
  async write(
    mount: string,
    path: string,
    data: SecretData,
    expectedVersion?: number
  ): Promise<SecretRecord> {
    const version = await this.detectKvVersion(mount);
    const m = normalizePath(mount);
    const p = normalizePath(path);

    if (version === 2) {
      const apiPath = joinPath(m, "data", p);
      const body: any = { data };
      if (typeof expectedVersion === "number") {
        body.options = { cas: expectedVersion };
      }
      const res = await this.api.call<any>("POST", apiPath, body);
      const newVersion = res.data?.data?.version;
      return { path: p, mount: m, kvVersion: 2, data, version: newVersion };
    }

    const apiPath = joinPath(m, p);
    await this.api.call("POST", apiPath, data);
    return { path: p, mount: m, kvVersion: 1, data };
  }

  /** Delete a secret (metadata + all versions for KV v2). */
  async delete(mount: string, path: string): Promise<void> {
    const version = await this.detectKvVersion(mount);
    const m = normalizePath(mount);
    const p = normalizePath(path);
    const apiPath = version === 2 ? joinPath(m, "metadata", p) : joinPath(m, p);
    await this.api.call("DELETE", apiPath);
  }

  /** List KV mounts visible to the token, best-effort. */
  async listMounts(): Promise<string[]> {
    try {
      const res = await this.api.call<any>("GET", "sys/mounts");
      const raw = res.data?.data ?? res.data ?? {};
      return Object.entries(raw)
        .filter(([, v]) => (v as any)?.type === "kv" || (v as any)?.type === "generic")
        .map(([k]) => k.replace(/\/+$/, ""));
    } catch (err) {
      // A scoped token typically cannot read sys/mounts. Fall back to the
      // connection's default mount instead of failing the whole browse.
      if (
        err instanceof VaultError &&
        (err.kind === "unauthorized" ||
          err.kind === "forbidden" ||
          err.kind === "tokenExpired" ||
          err.kind === "notFound" ||
          err.kind === "mountNotFound")
      ) {
        return this.conn.defaultMount ? [normalizePath(this.conn.defaultMount)] : [];
      }
      throw err;
    }
  }
}
