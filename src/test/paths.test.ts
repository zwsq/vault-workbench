import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, isFolderKey, joinPath, normalizePath, parentPath } from "../utils/paths";

test("normalizePath trims and collapses slashes", () => {
  assert.equal(normalizePath("/a//b/c/"), "a/b/c");
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath("///"), "");
});

test("joinPath joins segments", () => {
  assert.equal(joinPath("a", "b", "c"), "a/b/c");
  assert.equal(joinPath("", "b"), "b");
  assert.equal(joinPath("a/", "/b"), "a/b");
});

test("parentPath and baseName", () => {
  assert.equal(parentPath("a/b/c"), "a/b");
  assert.equal(parentPath("a"), "");
  assert.equal(baseName("a/b/c"), "c");
  assert.equal(baseName("a"), "a");
});

test("isFolderKey", () => {
  assert.equal(isFolderKey("apps/"), true);
  assert.equal(isFolderKey("config"), false);
});
