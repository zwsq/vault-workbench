import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  VaultService,
  accessiblePathRoots,
  apiPathToLogical,
  logicalPathsFromAcl,
  mountsFromAcl,
  parseUiSecretMounts,
} from "../vault/vaultService";
import { ResolvedConnection } from "../models/connection";

/**
 * Integration tests against an in-process mock Vault implementing a subset of
 * the KV v2 HTTP API. Verifies path layout, version detection, list/read/write,
 * and check-and-set conflict handling — without any real network access.
 */

let server: http.Server;
let baseUrl: string;
const store: Record<string, { data: Record<string, unknown>; version: number }> = {
  "secret/apps/api": { data: { host: "old-db", port: 5432 }, version: 3 },
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    const token = req.headers["x-vault-token"];
    if (token !== "test-token" && token !== "scoped-token") {
      return json(res, 403, { errors: ["permission denied"] });
    }

    // Path-scoped tokens cannot read sys/mounts or KV config, but Vault's default
    // policy still allows the UI discovery endpoints (same as real Vault).
    if (token === "scoped-token") {
      const blocked =
        path === "/v1/sys/mounts" ||
        path.startsWith("/v1/sys/mounts/") ||
        path === "/v1/secret/config";
      if (blocked) {
        return json(res, 403, { errors: ["permission denied"] });
      }
    }

    if (path === "/v1/sys/internal/ui/mounts/secret") {
      return json(res, 200, { data: { options: { version: "2" } } });
    }
    if (path === "/v1/sys/internal/ui/mounts" && req.method === "GET") {
      return json(res, 200, {
        data: {
          secret: {
            "secret/": { type: "kv", options: { version: "2" } },
            "kv-v1/": { type: "kv", options: { version: "1" } },
            "cubbyhole/": { type: "cubbyhole" },
          },
          auth: {
            "token/": { type: "token" },
          },
        },
      });
    }
    if (path === "/v1/sys/internal/ui/resultant-acl" && req.method === "GET") {
      return json(res, 200, {
        data: {
          exact_paths: {
            "auth/token/lookup-self": { capabilities: ["read"] },
            "secret/data/apps/api": { capabilities: ["read"] },
          },
          glob_paths: {
            "secret/data/apps/*": { capabilities: ["list", "read"] },
            "secret/metadata/apps/*": { capabilities: ["list", "read"] },
            "kv-v1/legacy/*": { capabilities: ["read", "list"] },
          },
          root: false,
        },
      });
    }
    if (path === "/v1/auth/token/lookup-self") {
      return json(res, 200, { data: { id: "redacted" } });
    }
    if (path === "/v1/secret/metadata/apps" && url.searchParams.get("list") === "true") {
      return json(res, 200, { data: { keys: ["api", "sub/"] } });
    }
    if (path === "/v1/secret/data/apps/api" && req.method === "GET") {
      const entry = store["secret/apps/api"];
      return json(res, 200, { data: { data: entry.data, metadata: { version: entry.version } } });
    }
    if (path === "/v1/secret/data/apps/api" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const entry = store["secret/apps/api"];
        const cas = body.options?.cas;
        if (typeof cas === "number" && cas !== entry.version) {
          return json(res, 400, { errors: ["check-and-set parameter did not match the current version"] });
        }
        entry.data = body.data;
        entry.version += 1;
        return json(res, 200, { data: { version: entry.version } });
      });
      return;
    }
    return json(res, 404, { errors: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

function makeService(token = "test-token", extra: Partial<ResolvedConnection> = {}): VaultService {
  const conn: ResolvedConnection = {
    id: "c1",
    name: "test",
    url: baseUrl,
    authMethod: "token",
    skipTlsVerify: false,
    defaultMount: "secret",
    token,
    ...extra,
  };
  return new VaultService(conn, 5000);
}

test("detects KV v2 from mounts endpoint", async () => {
  const version = await makeService().detectKvVersion("secret");
  assert.equal(version, 2);
});

test("list splits folders and secrets", async () => {
  const entries = await makeService().list("secret", "apps");
  const folder = entries.find((e) => e.name === "sub");
  const secret = entries.find((e) => e.name === "api");
  assert.ok(folder?.isFolder);
  assert.equal(secret?.isFolder, false);
  assert.equal(secret?.path, "apps/api");
});

test("read returns data and version", async () => {
  const rec = await makeService().read("secret", "apps/api");
  assert.equal(rec?.version, 3);
  assert.equal(rec?.data.host, "old-db");
});

test("write with correct cas succeeds", async () => {
  const svc = makeService();
  const rec = await svc.read("secret", "apps/api");
  const out = await svc.write("secret", "apps/api", { host: "new-db" }, rec?.version);
  assert.equal(typeof out.version, "number");
});

test("write with stale cas throws versionConflict", async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.write("secret", "apps/api", { host: "x" }, 1),
    (err: any) => err.kind === "versionConflict"
  );
});

test("bad token yields tokenExpired/permission error", async () => {
  await assert.rejects(
    () => makeService("wrong").read("secret", "apps/api"),
    (err: any) => err.kind === "tokenExpired" || err.kind === "unauthorized"
  );
});

test("scoped token can browse despite sys/config 403 (KV detection tolerates it)", async () => {
  // sys/internal/ui/mounts is under sys/ and returns 403 for the scoped token,
  // so detection must fall back without throwing.
  const svc = makeService("scoped-token");
  const version = await svc.detectKvVersion("secret");
  assert.equal(version, 2);
  const entries = await svc.list("secret", "apps");
  assert.ok(entries.find((e) => e.name === "api"));
});

test("scoped token listMounts falls back to default mount instead of 403", async () => {
  const mounts = await makeService("scoped-token").listMounts();
  assert.deepEqual(mounts, ["secret"]);
});

test("explicit kvVersion skips detection entirely", async () => {
  const svc = makeService("scoped-token", { kvVersion: 2 });
  assert.equal(await svc.detectKvVersion("secret"), 2);
});

test("listUiMounts returns KV mounts with versions from UI endpoint", async () => {
  const mounts = await makeService().listUiMounts();
  assert.deepEqual(
    mounts.map((m) => ({ path: m.path, kvVersion: m.kvVersion })),
    [
      { path: "kv-v1", kvVersion: 1 },
      { path: "secret", kvVersion: 2 },
    ]
  );
});

test("listAccessiblePaths maps KV v2 ACL paths to logical prefixes", async () => {
  const paths = await makeService().listAccessiblePaths("secret");
  assert.deepEqual(paths, ["apps", "apps/api"]);
});

test("listAccessiblePaths for another mount uses that mount's ACL entries", async () => {
  const paths = await makeService().listAccessiblePaths("kv-v1");
  assert.deepEqual(paths, ["legacy"]);
});

test("parseUiSecretMounts filters non-KV and strips trailing slash", () => {
  const mounts = parseUiSecretMounts({
    "secret/": { type: "kv", options: { version: "2" } },
    "db/": { type: "database" },
  });
  assert.deepEqual(mounts, [{ path: "secret", kvVersion: 2 }]);
});

test("apiPathToLogical strips data/metadata and globs", () => {
  assert.equal(apiPathToLogical("secret", "secret/data/apps/*"), "apps");
  assert.equal(apiPathToLogical("secret", "secret/metadata/apps/api"), "apps/api");
  assert.equal(apiPathToLogical("secret", "secret/data"), "");
  assert.equal(apiPathToLogical("secret", "other/data/apps"), undefined);
});

test("logicalPathsFromAcl returns mount root for root tokens", () => {
  assert.deepEqual(logicalPathsFromAcl("secret", { root: true }), [""]);
});

test("logicalPathsFromAcl dedupes data and metadata globs", () => {
  const paths = logicalPathsFromAcl("secret", {
    glob_paths: {
      "secret/data/apps/*": {},
      "secret/metadata/apps/*": {},
    },
  });
  assert.deepEqual(paths, ["apps"]);
});

test("scoped token discoverKvMounts uses UI mounts without sys/mounts", async () => {
  const mounts = await makeService("scoped-token", { defaultMount: "" }).discoverKvMounts();
  assert.deepEqual(
    mounts.map((m) => m.path),
    ["kv-v1", "secret"]
  );
});

test("scoped token listAccessiblePaths still works via UI ACL", async () => {
  const paths = await makeService("scoped-token", { defaultMount: "" }).listAccessiblePaths("secret");
  assert.deepEqual(paths, ["apps", "apps/api"]);
});

test("mountsFromAcl infers KV mounts and skips sys/auth", () => {
  assert.deepEqual(
    mountsFromAcl({
      exact_paths: { "auth/token/lookup-self": {} },
      glob_paths: {
        "secret/data/apps/*": {},
        "kv-v1/legacy/*": {},
        "sys/mounts": {},
      },
    }),
    ["kv-v1", "secret"]
  );
});

test("accessiblePathRoots keeps shallowest prefixes", () => {
  assert.deepEqual(accessiblePathRoots(["apps/api", "apps", "other"]), ["apps", "other"]);
  assert.deepEqual(accessiblePathRoots(["", "apps"]), [""]);
});
