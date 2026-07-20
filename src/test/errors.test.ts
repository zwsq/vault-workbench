import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVaultError } from "../utils/errors";

test("403 permission denied maps to tokenExpired", () => {
  const e = classifyVaultError({ status: 403, vaultErrors: ["permission denied"] });
  assert.equal(e.kind, "tokenExpired");
});

test("403 namespace maps to namespaceNotFound", () => {
  const e = classifyVaultError({ status: 403, vaultErrors: ["namespace not found"] });
  assert.equal(e.kind, "namespaceNotFound");
});

test("404 no handler maps to mountNotFound", () => {
  const e = classifyVaultError({ status: 404, vaultErrors: ["no handler for route"] });
  assert.equal(e.kind, "mountNotFound");
});

test("404 maps to notFound", () => {
  assert.equal(classifyVaultError({ status: 404 }).kind, "notFound");
});

test("412 maps to versionConflict", () => {
  assert.equal(classifyVaultError({ status: 412 }).kind, "versionConflict");
});

test("TLS node code maps to tls", () => {
  assert.equal(classifyVaultError({ nodeCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }).kind, "tls");
  assert.equal(classifyVaultError({ nodeCode: "SELF_SIGNED_CERT_IN_CHAIN" }).kind, "tls");
});

test("timeout maps to timeout", () => {
  assert.equal(classifyVaultError({ nodeCode: "ETIMEDOUT" }).kind, "timeout");
});

test("connection refused maps to network", () => {
  assert.equal(classifyVaultError({ nodeCode: "ECONNREFUSED" }).kind, "network");
});

test("error messages never echo back raw Vault error bodies or secret material", () => {
  // Even if Vault's raw error body contained a leaked token-like value, the
  // friendly message must not embed it verbatim.
  const leaked = "s.AbCdEf1234567890secretvalue";
  const e = classifyVaultError({ status: 403, vaultErrors: [`permission denied ${leaked}`], path: "secret/data/apps" });
  assert.ok(!e.message.includes(leaked), "friendly message must not contain raw error body");
  assert.ok(!e.message.includes("secret/data/apps"), "friendly message must not embed the path");
});
