import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineStarts, offsetToPosition, renderSecretDocument, scanDocument } from "../search/document";
import { buildMatcher } from "../search/matcher";
import { SearchOptions } from "../models/search";

const opts: SearchOptions = {
  regex: false,
  matchCase: false,
  wholeWord: false,
  searchKeys: true,
  searchValues: true,
};

test("offsetToPosition maps offsets to line/char", () => {
  const text = "a\nbb\nccc";
  const starts = computeLineStarts(text);
  assert.deepEqual(offsetToPosition(starts, 0), { line: 0, character: 0 });
  assert.deepEqual(offsetToPosition(starts, 2), { line: 1, character: 0 });
  assert.deepEqual(offsetToPosition(starts, 5), { line: 2, character: 0 });
  assert.deepEqual(offsetToPosition(starts, 7), { line: 2, character: 2 });
});

test("finds match inside a nested, indented object (multi-line value)", () => {
  const data = { config: { database: { host: "old-db.company.local" } } };
  const doc = renderSecretDocument(data);
  const matches = scanDocument(doc, buildMatcher("old-db", opts), opts);
  assert.equal(matches.length, 1);
  const m = matches[0];
  // The match must point at the exact line in the pretty-printed document.
  const lines = doc.split("\n");
  assert.ok(lines[m.startLine].includes("old-db"));
  assert.equal(doc.slice(m.startOffset, m.endOffset), "old-db");
});

test("classifies key vs value matches", () => {
  const data = { host: "the-host-value" };
  const keyOnly = scanDocument(renderSecretDocument(data), buildMatcher("host", opts), {
    ...opts,
    searchValues: false,
  });
  assert.equal(keyOnly.length, 1);
  assert.equal(keyOnly[0].location, "key");

  const valueOnly = scanDocument(renderSecretDocument(data), buildMatcher("host", opts), {
    ...opts,
    searchKeys: false,
  });
  assert.equal(valueOnly.length, 1);
  assert.equal(valueOnly[0].location, "value");
});

test("nested keys are searchable as keys", () => {
  const data = { outer: { REDIS_HOST: "x" } };
  const matches = scanDocument(renderSecretDocument(data), buildMatcher("REDIS_HOST", opts), opts);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].location, "key");
});

test("multi-line regex match spans lines", () => {
  const data = { a: "1", b: "2" };
  const doc = renderSecretDocument(data);
  const m = scanDocument(doc, buildMatcher('"a": "1",\\n\\s*"b"', { ...opts, regex: true }), {
    ...opts,
    regex: true,
  });
  assert.equal(m.length, 1);
  assert.ok(m[0].endLine > m[0].startLine);
});
