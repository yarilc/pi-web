/**
 * End-to-end search check against DuckDuckGo (requires network egress).
 *
 * Exercises the real search path used by the web_search tool:
 *   safeFetchText(buildDuckDuckGoUrl(...)) -> parseDuckDuckGo(...)
 *
 * This check is INFORMATIONAL, not a gate. DuckDuckGo frequently rate-limits
 * or challenges automated requests from CI runner IP ranges (GitHub Actions
 * datacenter IPs in particular), so a zero-result response is reported but
 * does not fail the check. The DDG parser itself is fully covered by the
 * offline unit tests in test/search.test.ts; this script only validates that
 * the live request + parse wiring still produces *some* structured output
 * against the real endpoint.
 *
 * In CI this script runs with continue-on-error: true so DDG flakiness never
 * blocks a merge while still surfacing a (weak) availability signal.
 *
 * Run: node --import tsx scripts/e2e-search.ts
 */
import { safeFetchText } from "../src/net.ts";
import { buildDuckDuckGoUrl, parseDuckDuckGo } from "../src/search.ts";

async function main(): Promise<void> {
	const query = "pi coding agent";
	const url = buildDuckDuckGoUrl(query);
	console.log(`search DDG: ${url}`);
	const fetched = await safeFetchText(url, { timeoutMs: 25_000 });
	const results = parseDuckDuckGo(fetched.body);
	console.log(`DDG results: ${results.length}`);
	if (results[0]) {
		console.log(`  first: ${results[0].title} -> ${results[0].url}`);
	}
	if (results.length === 0) {
		console.log("  (0 results - DDG may be rate-limiting/blocking this network; parser covered by unit tests)");
	}
	console.log("E2E-SEARCH OK (informational)");
	process.exit(0);
}

main().catch((e) => {
	console.error("E2E-SEARCH FAIL:", e);
	process.exit(1);
});
