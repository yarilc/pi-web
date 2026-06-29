import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildDuckDuckGoUrl,
	buildSearxngUrl,
	formatResults,
	parseDuckDuckGo,
	parseSearxng,
} from "../src/search.ts";

// A minimal DuckDuckGo HTML/lite results page. Result anchors wrap the real
// URL in a //duckduckgo.com/l/?uddg=<encoded> redirect.
const DDG_HTML = `<!doctype html>
<html><body>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&rut=abc">First Result</a></h2>
  <a class="result__snippet">First snippet text</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsecond">Second Result</a>
  <a class="result__snippet">Second  snippet</a>
</div>
<div class="result"><a class="result__a" href="">No URL</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fthird">   </a></div>
</body></html>`;

test("buildDuckDuckGoUrl encodes the query and targets the lite endpoint", () => {
	const u = new URL(buildDuckDuckGoUrl("hello world & more"));
	assert.equal(u.hostname, "html.duckduckgo.com");
	assert.equal(u.pathname, "/html/");
	assert.equal(u.searchParams.get("q"), "hello world & more");
});

test("buildSearxngUrl strips a trailing slash and requests JSON format", () => {
	const u = new URL(buildSearxngUrl("https://searx.example.com/", "pi extensions"));
	assert.equal(u.hostname, "searx.example.com");
	assert.equal(u.pathname, "/search");
	assert.equal(u.searchParams.get("format"), "json");
	assert.equal(u.searchParams.get("q"), "pi extensions");
});

test("parseDuckDuckGo extracts titles, decoded URLs, and cleaned snippets", () => {
	const results = parseDuckDuckGo(DDG_HTML);
	assert.equal(results.length, 2);
	assert.equal(results[0]?.title, "First Result");
	assert.equal(results[0]?.url, "https://example.com/first");
	assert.equal(results[0]?.snippet, "First snippet text");
	assert.equal(results[1]?.title, "Second Result");
	assert.equal(results[1]?.url, "https://example.com/second");
	// Whitespace run in the snippet is collapsed:
	assert.equal(results[1]?.snippet, "Second snippet");
});

test("parseDuckDuckGo drops results without a usable url or title", () => {
	// The "No URL" entry (empty href) and the whitespace-only title entry are skipped.
	const results = parseDuckDuckGo(DDG_HTML);
	for (const r of results) {
		assert.ok(r.url && r.title);
	}
});

test("parseSearxng parses JSON results and tolerates malformed entries", () => {
	const json = {
		results: [
			{ title: "A", url: "https://a.example.com", content: "snip A" },
			{ title: "B", url: "https://b.example.com", content: "snip B" },
			{ title: "", url: "https://c.example.com" }, // missing title -> dropped
			{ title: "D", url: "" }, // missing url -> dropped
			"garbage-entry",
			null,
		],
	};
	const results = parseSearxng(json);
	assert.equal(results.length, 2);
	assert.equal(results[0]?.title, "A");
	assert.equal(results[0]?.snippet, "snip A");
	assert.equal(results[1]?.url, "https://b.example.com");
});

test("parseSearxng tolerates non-object / missing-results input", () => {
	assert.deepEqual(parseSearxng(null), []);
	assert.deepEqual(parseSearxng({}), []);
	assert.deepEqual(parseSearxng("nope"), []);
	assert.deepEqual(parseSearxng({ results: "not-an-array" }), []);
});

test("formatResults renders markdown with numbered results", () => {
	const out = formatResults("pi", "duckduckgo", [
		{ title: "T1", url: "https://a.example.com", snippet: "S1" },
		{ title: "T2", url: "https://b.example.com", snippet: "" },
	]);
	assert.match(out, /Web search results for "pi" \(duckduckgo, 2\)/);
	assert.match(out, /## 1\. T1/);
	assert.match(out, /URL: https:\/\/a\.example\.com/);
	assert.match(out, /S1/);
	assert.match(out, /## 2\. T2/);
});

test("formatResults reports no results clearly", () => {
	const out = formatResults("nothing", "duckduckgo", []);
	assert.match(out, /No results found for "nothing"/);
});
