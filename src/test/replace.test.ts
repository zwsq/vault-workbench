import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMatchesToDocument } from "../replace/replaceEngine";
import { buildMatcher } from "../search/matcher";
import { renderSecretDocument, scanDocument } from "../search/document";
import { SearchOptions } from "../models/search";

const opts: SearchOptions = {
  regex: false,
  matchCase: false,
  wholeWord: false,
  searchKeys: true,
  searchValues: true,
};

function replace(data: Record<string, unknown>, query: string, replacement: string, o: SearchOptions) {
  const doc = renderSecretDocument(data);
  const matcher = buildMatcher(query, o);
  const matches = scanDocument(doc, matcher, o);
  const next = applyMatchesToDocument(doc, matches, matcher, replacement, o);
  return { next, changed: next !== doc, parsed: JSON.parse(next) };
}

test("replaces value matches, leaves non-string values intact", () => {
  const data = { ConnectionString: "Server=old-db.company.local", port: 5432 };
  const { parsed, changed } = replace(data, "old-db", "new-db", opts);
  assert.equal(changed, true);
  assert.equal(parsed.ConnectionString, "Server=new-db.company.local");
  assert.equal(parsed.port, 5432);
});

test("renames a key when matching keys", () => {
  const { parsed } = replace({ OLD_HOST: "x" }, "OLD", "NEW", opts);
  assert.equal(parsed.NEW_HOST, "x");
  assert.equal("OLD_HOST" in parsed, false);
});

test("searchValues only does not touch keys", () => {
  const valuesOnly = { ...opts, searchKeys: false };
  const { parsed } = replace({ host: "host-value" }, "host", "X", valuesOnly);
  assert.equal("host" in parsed, true); // key preserved
  assert.equal(parsed.host, "X-value");
});

test("no match yields no change", () => {
  const { changed } = replace({ a: "b" }, "zzz", "y", opts);
  assert.equal(changed, false);
});
