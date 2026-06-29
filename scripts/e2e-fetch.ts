/**
 * End-to-end fetch + extract check (requires network egress).
 *
 * Exercises the real read path used by the web_fetch tool:
 *   safeFetchText (SSRF guard, redirects, size cap, timeout)
 *     -> extractContent (Readability/turndown)
 * against a stable public page (https://example.com).
 *
 * This is the integration counterpart to the offline unit tests: no unit test
 * drives safeFetchText against real HTTP + real HTML, so this check is the only
 * guard against regressions in the net.ts -> extract.ts pipeline on live
 * content. It is therefore a REQUIRED CI gate.
 *
 * example.com is IANA-maintained and its <title> ("Example Domain") has been
 * stable for decades, so flakiness is limited to transient network blips,
 * which the caller is expected to absorb with retries.
 *
 * Run: node --import tsx scripts/e2e-fetch.ts
 */
import assert from "node:assert/strict";

import { extractContent } from "../src/extract.ts";
import { safeFetchText } from "../src/net.ts";

const TARGET_URL = "https://example.com";
const EXPECTED_TITLE = "Example Domain";

async function main(): Promise<void> {
	const fetched = await safeFetchText(TARGET_URL, { timeoutMs: 20_000 });
	assert.ok(fetched.body.length > 0, "expected a non-empty body from example.com");
	console.log(`fetch ${TARGET_URL}: ${fetched.contentType}, ${fetched.bytes} bytes, final ${fetched.url}`);

	const ext = extractContent(fetched.body, fetched.url, { raw: true });
	console.log(`extract title: ${ext.title}`);
	assert.equal(ext.title, EXPECTED_TITLE, `expected title "${EXPECTED_TITLE}"`);

	console.log("E2E-FETCH OK");
	process.exit(0);
}

main().catch((e) => {
	console.error("E2E-FETCH FAIL:", e);
	process.exit(1);
});
