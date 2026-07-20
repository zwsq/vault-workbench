import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReplacement, buildMatcher, findRanges, hasMatch } from "../search/matcher";
import { SearchOptions } from "../models/search";

const base: SearchOptions = {
  regex: false,
  matchCase: false,
  wholeWord: false,
  searchKeys: true,
  searchValues: true,
};

test("literal, case-insensitive match", () => {
  const m = buildMatcher("db", { ...base });
  assert.ok(hasMatch(m, "old-DB.company.local"));
  assert.deepEqual(findRanges(buildMatcher("db", { ...base }), "adb DB").length, 2);
});

test("match case respected", () => {
  assert.equal(hasMatch(buildMatcher("DB", { ...base, matchCase: true }), "old-db"), false);
  assert.equal(hasMatch(buildMatcher("db", { ...base, matchCase: true }), "old-db"), true);
});

test("whole word", () => {
  assert.equal(hasMatch(buildMatcher("db", { ...base, wholeWord: true }), "sandbox"), false);
  assert.equal(hasMatch(buildMatcher("db", { ...base, wholeWord: true }), "the db host"), true);
});

test("regex groups in replacement", () => {
  const opts = { ...base, regex: true };
  const m = buildMatcher("old-(\\w+)", opts);
  assert.equal(applyReplacement(m, "old-db", "new-$1", opts), "new-db");
});

test("literal replacement escapes $", () => {
  const opts = { ...base };
  const m = buildMatcher("db", opts);
  assert.equal(applyReplacement(m, "a db b", "$db", opts), "a $db b");
});

test("invalid regex throws", () => {
  assert.throws(() => buildMatcher("(", { ...base, regex: true }));
});

test("multi-line literal is whitespace-flexible (indentation-insensitive)", () => {
  const doc = [
    "{",
    '  "logging": {',
    '    "sinks": [',
    "      {",
    '        "Args": {',
    '          "formatter": "ElasticsearchJsonFormatter"',
    "        },",
    '        "Name": "Console"',
    "      }",
    "    ]",
    "  }",
    "}",
  ].join("\n");
  // Query pasted with DIFFERENT indentation than the document.
  const query = [
    "{",
    '  "Args": {',
    '    "formatter": "ElasticsearchJsonFormatter"',
    "  },",
    '  "Name": "Console"',
    "}",
  ].join("\n");
  const m = buildMatcher(query, { ...base });
  assert.equal(hasMatch(m, doc), true);
});

test("single-line literal remains exact (whitespace significant)", () => {
  const m = buildMatcher("a b", { ...base });
  assert.equal(hasMatch(m, "a  b"), false); // two spaces should not match one
  assert.equal(hasMatch(buildMatcher("a b", { ...base }), "a b"), true);
});

test("zero-width matches do not loop forever", () => {
  const opts = { ...base, regex: true };
  const m = buildMatcher("x*", opts);
  const ranges = findRanges(m, "abc");
  assert.ok(ranges.length >= 1);
});
