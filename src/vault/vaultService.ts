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

  /**
   * List KV mounts the same way Vault UI does (`sys/internal/ui/mounts`).
   * With a token, returns mounts the token has capabilities on.
   */
  async listUiMounts(): Promise<UiMount[]> {
    try {
      const res = await this.api.call<any>("GET", "sys/internal/ui/mounts");
      const body = res.data ?? {};
      const secret = body.data?.secret ?? body.secret ?? {};
      const mounts = parseUiSecretMounts(secret);
      if (mounts.length > 0) {
        return mounts;
      }
    } catch (err) {
      if (
        !(
          err instanceof VaultError &&
          (err.kind === "unauthorized" ||
            err.kind === "forbidden" ||
            err.kind === "tokenExpired" ||
            err.kind === "notFound")
        )
      ) {
        throw err;
      }
    }
    return [];
  }

  /**
   * Best-effort KV mounts for browsing: UI mounts → ACL-derived → sys/mounts →
   * connection defaultMount. Scoped tokens usually succeed via UI mounts / ACL.
   */
  async discoverKvMounts(): Promise<UiMount[]> {
    const ui = await this.listUiMounts();
    if (ui.length > 0) {
      return ui;
    }

    const fromAcl = await this.mountsFromResultantAcl();
    if (fromAcl.length > 0) {
      return fromAcl.map((path) => ({ path, kvVersion: this.conn.kvVersion }));
    }

    const names = await this.listMounts();
    return names.map((path) => ({ path, kvVersion: this.conn.kvVersion }));
  }

  /** Read resultant-ACL, or undefined when the token cannot. */
  async readResultantAcl(): Promise<ResultantAcl | undefined> {
    try {
      const res = await this.api.call<any>("GET", "sys/internal/ui/resultant-acl");
      const acl = res.data?.data ?? res.data ?? {};
      return {
        exact_paths: acl.exact_paths,
        glob_paths: acl.glob_paths,
        root: Boolean(acl.root),
      };
    } catch (err) {
      if (
        err instanceof VaultError &&
        (err.kind === "unauthorized" ||
          err.kind === "forbidden" ||
          err.kind === "tokenExpired" ||
          err.kind === "notFound")
      ) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Logical secret paths under `mount` that the token can access, derived from
   * `sys/internal/ui/resultant-acl` (same source Vault UI uses).
   * Returns `[""]` when the token is root or has mount-wide access.
   */
  async listAccessiblePaths(mount: string): Promise<string[]> {
    const acl = await this.readResultantAcl();
    if (!acl) {
      return [];
    }
    return logicalPathsFromAcl(mount, acl);
  }

  /** Infer KV mount names from resultant-ACL path keys when UI mounts is empty. */
  async mountsFromResultantAcl(): Promise<string[]> {
    const acl = await this.readResultantAcl();
    if (!acl) {
      return [];
    }
    return mountsFromAcl(acl);
  }
}

/** Shape of `sys/internal/ui/resultant-acl` data used for discovery. */
export interface ResultantAcl {
  exact_paths?: Record<string, unknown>;
  glob_paths?: Record<string, unknown>;
  root?: boolean;
}

/** A KV mount discovered via the Vault UI mounts endpoint. */
export interface UiMount {
  path: string;
  kvVersion?: KvVersion;
}

/** Parse the `secret` map from `sys/internal/ui/mounts` into KV mounts. */
export function parseUiSecretMounts(secret: Record<string, any>): UiMount[] {
  const out: UiMount[] = [];
  for (const [rawPath, info] of Object.entries(secret ?? {})) {
    const type = info?.type;
    if (type !== "kv" && type !== "generic") {
      continue;
    }
    const path = normalizePath(String(rawPath).replace(/\/+$/, ""));
    if (!path) {
      continue;
    }
    const ver = info?.options?.version;
    let kvVersion: KvVersion | undefined;
    if (ver === "1" || ver === 1) {
      kvVersion = 1;
    } else if (ver === "2" || ver === 2) {
      kvVersion = 2;
    }
    out.push({ path, kvVersion });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Map resultant-ACL API paths to logical secret paths under a KV mount.
 * Strips KV v2 `data/` / `metadata/` prefixes and glob wildcards (`*`, `+`).
 */
export function logicalPathsFromAcl(
  mount: string,
  acl: {
    exact_paths?: Record<string, unknown>;
    glob_paths?: Record<string, unknown>;
    root?: boolean;
  }
): string[] {
  const m = normalizePath(mount);
  if (acl.root) {
    return [""];
  }
  const keys = [...Object.keys(acl.exact_paths ?? {}), ...Object.keys(acl.glob_paths ?? {})];
  const out = new Set<string>();
  for (const key of keys) {
    const logical = apiPathToLogical(m, key);
    if (logical !== undefined) {
      out.add(logical);
    }
  }
  return [...out].sort((a, b) => {
    if (a === "") {
      return -1;
    }
    if (b === "") {
      return 1;
    }
    return a.localeCompare(b);
  });
}

/** Convert a Vault ACL path (possibly with KV v2 prefixes / globs) to a logical path under mount. */
export function apiPathToLogical(mount: string, apiPath: string): string | undefined {
  const p = normalizePath(apiPath.replace(/[*+]+$/g, "").replace(/\/+$/, ""));
  if (!p) {
    return undefined;
  }
  if (p !== mount && !p.startsWith(mount + "/")) {
    return undefined;
  }
  let rest = p === mount ? "" : p.slice(mount.length + 1);
  if (rest === "data" || rest.startsWith("data/")) {
    rest = rest === "data" ? "" : rest.slice("data/".length);
  } else if (rest === "metadata" || rest.startsWith("metadata/")) {
    rest = rest === "metadata" ? "" : rest.slice("metadata/".length);
  }
  return normalizePath(rest);
}

/**
 * Infer KV mount names from ACL path keys. Skips obvious non-secret prefixes
 * (sys, auth, cubbyhole, identity, …).
 */
export function mountsFromAcl(acl: ResultantAcl): string[] {
  if (acl.root) {
    return [];
  }
  const skip = new Set([
    "sys",
    "auth",
    "cubbyhole",
    "identity",
    "transit",
    "pki",
    "ssh",
    "database",
    "aws",
    "azure",
    "gcp",
  ]);
  const mounts = new Set<string>();
  const keys = [...Object.keys(acl.exact_paths ?? {}), ...Object.keys(acl.glob_paths ?? {})];
  for (const key of keys) {
    const segs = normalizePath(key.replace(/[*+]+$/g, "")).split("/").filter(Boolean);
    if (segs.length === 0 || skip.has(segs[0])) {
      continue;
    }
    // KV v2: {mount}/data/... or {mount}/metadata/...
    if (segs.length >= 2 && (segs[1] === "data" || segs[1] === "metadata")) {
      mounts.add(segs[0]);
      continue;
    }
    // KV v1 / mount-wide: {mount} or {mount}/...
    mounts.add(segs[0]);
  }
  return [...mounts].sort((a, b) => a.localeCompare(b));
}

/**
 * Collapse ACL logical paths to the shallowest roots (e.g. apps + apps/api → apps).
 * An empty string means mount-wide access.
 */
export function accessiblePathRoots(paths: string[]): string[] {
  if (paths.includes("")) {
    return [""];
  }
  const sorted = [...paths].filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots: string[] = [];
  for (const p of sorted) {
    if (!roots.some((r) => p === r || p.startsWith(r + "/"))) {
      roots.push(p);
    }
  }
  return roots;
}
