/**
 * Live end-to-end check of the web pipeline (requires network egress).
 *
 * Validates the real path used by the tools: safeFetchText (SSRF guard,
 * redirects, size cap, timeout) + extractContent (Readability/turndown) +
 * the DuckDuckGo search parser against live HTML. The SSRF block is also
 * exercised against a loopback address.
 *
 * Run: node --import tsx scripts/live-check.ts
 *
 * DuckDuckGo may rate-limit or challenge automated requests from some
 * networks; a zero-result DDG response is reported but does not fail the
 * check (the parser is covered by offline unit tests).
 */
import assert from "node:assert/strict";

import { extractContent } from "../src/extract.ts";
import { safeFetchText } from "../src/net.ts";
import { buildDuckDuckGoUrl, parseDuckDuckGo } from "../src/search.ts";

async function main(): Promise<void> {
	// 1. Live fetch + extract on a stable public page.
	const fetched = await safeFetchText("https://example.com", { timeoutMs: 20_000 });
	assert.ok(fetched.body.length > 0, "expected a non-empty body from example.com");
	console.log(`fetch example.com: ${fetched.contentType}, ${fetched.bytes} bytes, final ${fetched.url}`);
	const ext = extractContent(fetched.body, fetched.url, { raw: true });
	console.log(`extract title: ${ext.title}`);
	assert.equal(ext.title, "Example Domain");

	// 2. SSRF guard must fire for a loopback address (no network needed; throws before fetch).
	let blocked = false;
	try {
		await safeFetchText("http://127.0.0.1/", { timeoutMs: 5000 });
	} catch (e) {
		blocked = /refused|private|loopback/i.test((e as Error).message);
	}
	assert.ok(blocked, "expected 127.0.0.1 to be refused by the SSRF guard");
	console.log("SSRF guard: blocked 127.0.0.1 (OK)");

	// 3. Live DuckDuckGo search parse (informational; DDG may block some networks).
	const s = await safeFetchText(buildDuckDuckGoUrl("pi coding agent"), { timeoutMs: 25_000 });
	const results = parseDuckDuckGo(s.body);
	console.log(`DDG results: ${results.length}`);
	if (results[0]) {
		console.log(`  first: ${results[0].title} -> ${results[0].url}`);
	}
	if (results.length === 0) {
		console.log("  (0 results — DDG may be rate-limiting/blocking this network; parser covered by unit tests)");
	}

	console.log("LIVE OK");
	process.exit(0);
}

main().catch((e) => {
	console.error("LIVE FAIL:", e);
	process.exit(1);
});
