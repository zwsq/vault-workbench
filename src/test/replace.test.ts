import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToSecret } from "../replace/replaceEngine";
import { buildMatcher } from "../search/matcher";
import { SearchOptions, SecretMatches } from "../models/search";
import { scanSecret } from "../search/searchEngine";

const opts: SearchOptions = {
  regex: false,
  matchCase: false,
  wholeWord: false,
  searchKeys: true,
  searchValues: true,
};

test("replaces value matches only for string values", () => {
  const data = { ConnectionString: "Server=old-db.company.local", port: 5432 };
  const matches = scanSecret("apps/api/config", data, buildMatcher("old-db", opts), opts);
  const group: SecretMatches = { secretPath: "apps/api/config", matches };
  const { data: out, changed } = applyToSecret(data, group, buildMatcher("old-db", opts), "new-db", opts);
  assert.equal(changed, true);
  assert.equal(out.ConnectionString, "Server=new-db.company.local");
  assert.equal(out.port, 5432);
});

test("renames key when matching on keys", () => {
  const data = { OLD_HOST: "x" };
  const matches = scanSecret("p", data, buildMatcher("OLD", opts), opts);
  const group: SecretMatches = { secretPath: "p", matches };
  const { data: out, changed } = applyToSecret(data, group, buildMatcher("OLD", opts), "NEW", opts);
  assert.equal(changed, true);
  assert.equal(out.NEW_HOST, "x");
  assert.equal("OLD_HOST" in out, false);
});

test("no change returns changed=false", () => {
  const data = { a: "b" };
  const matches = scanSecret("p", data, buildMatcher("zzz", opts), opts);
  const group: SecretMatches = { secretPath: "p", matches };
  const { changed } = applyToSecret(data, group, buildMatcher("zzz", opts), "y", opts);
  assert.equal(changed, false);
});

test("scanSecret finds key and value matches", () => {
  const data = { host: "old-db", note: "nothing" };
  const matches = scanSecret("p", data, buildMatcher("old", { ...opts }), { ...opts });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].location, "value");
});
