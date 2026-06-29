import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContent } from "../src/extract.ts";

const HTML = `<!doctype html>
<html>
<head>
  <title>Example Article</title>
  <script>var secret = 1;</script>
  <style>.x { color: red; }</style>
</head>
<body>
  <nav><a href="/home">Home</a></nav>
  <article>
    <h1>Hello World</h1>
    <p>This is a <a href="/rel">relative link</a> and an <a href="https://example.com/abs">absolute</a> link.</p>
    <h2>Section</h2>
    <p>More body text here, padded out with enough characters to pass readerability
       thresholds hopefully hopefully hopefully hopefully hopefully hopefully.</p>
    <ul><li>one</li><li>two</li></ul>
  </article>
  <footer>copyright</footer>
</body>
</html>`;

test("extractContent returns the document title", () => {
	const r = extractContent(HTML, "https://example.com/page");
	assert.equal(r.title, "Example Article");
});

test("extractContent produces markdown with absolute links in raw mode", () => {
	const r = extractContent(HTML, "https://example.com/page", { raw: true });
	assert.match(r.text, /Hello World/);
	// Relative link absolutized against the page URL:
	assert.match(r.text, /\]\(https:\/\/example\.com\/rel\)/);
	// Absolute link preserved:
	assert.match(r.text, /\]\(https:\/\/example\.com\/abs\)/);
});

test("extractContent strips script/style noise", () => {
	const r = extractContent(HTML, "https://example.com/page", { raw: true });
	assert.doesNotMatch(r.text, /var secret/);
	assert.doesNotMatch(r.text, /\.x \{ color: red;/);
});

test("extractContent leaves non-http schemes untouched", () => {
	const html = `<html><body><a href="mailto:hi@example.com">mail</a></body></html>`;
	const r = extractContent(html, "https://example.com/page", { raw: true });
	assert.match(r.text, /\]\(mailto:hi@example\.com\)/);
});

test("extractContent handles empty html gracefully", () => {
	const r = extractContent("", "https://example.com/page");
	assert.equal(r.title, null);
	assert.equal(r.text, "");
});

test("extractContent keeps list items as markdown", () => {
	const r = extractContent(HTML, "https://example.com/page", { raw: true });
	assert.match(r.text, /-\s+one/);
	assert.match(r.text, /-\s+two/);
});
