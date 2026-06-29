/**
 * CI verification: the pre-compiled bundle loads without jiti and registers
 * both tools with the expected names.
 *
 * This complements `npm run smoke` (which loads the TypeScript source via
 * jiti) by asserting the *built* artifact works on its own: no jiti, no
 * tsx, just the esbuild bundle imported directly by Node. A regression that
 * breaks the bundle (e.g. a missing/incorrect external, a broken import
 * path) would pass the smoke test but fail here.
 *
 * Run: node --import tsx scripts/verify-bundle.ts
 *   (tsx is used only so Node can run a .ts runner; the bundle itself is
 *   loaded as plain ESM, the same way Pi loads it at runtime.)
 */
import assert from "node:assert/strict";

interface ToolDef {
	name: string;
}

async function main(): Promise<void> {
	const bundleUrl = new URL("../dist/index.mjs", import.meta.url);
	const mod = await import(bundleUrl.href);
	const factory = mod.default;
	if (typeof factory !== "function") {
		throw new Error("bundle default export is not a function");
	}
	const tools: ToolDef[] = [];
	factory({ registerTool: (def: ToolDef) => tools.push(def) });
	const names = tools.map((t) => t.name).sort();
	console.log("bundle loads OK, tools:", names.join(", "));
	assert.deepEqual(names, ["web_fetch", "web_search"], "unexpected tools registered by bundle");
	console.log("VERIFY-BUNDLE OK");
}

main().catch((e) => {
	console.error("VERIFY-BUNDLE FAIL:", e);
	process.exit(1);
});
