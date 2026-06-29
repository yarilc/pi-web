/**
 * Runtime smoke test for the pi-web extension.
 *
 * Loads the real factory via tsx/jiti (so every runtime import — Readability,
 * linkedom, turndown, and the Pi SDK helpers — is actually resolved) and calls
 * it with a minimal stub ExtensionAPI. Verifies the factory runs without
 * throwing and registers both tools with an execute function and a parameters
 * schema. This complements the offline unit tests; it does not touch the
 * network.
 *
 * Run: node --import tsx scripts/smoke.ts
 */
import { registerWebTools } from "../src/tools.ts";

interface ToolDef {
	name: string;
	label?: string;
	execute?: (...args: unknown[]) => unknown;
	parameters?: object;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: unknown[];
}

const tools: ToolDef[] = [];
const pi = {
	registerTool(def: ToolDef) {
		tools.push(def);
	},
} as unknown as Parameters<typeof registerWebTools>[0];

registerWebTools(pi);

const names = tools.map((t) => t.name);
console.log("registered tools:", names.join(", "));

const expected = ["web_fetch", "web_search"];
for (const name of expected) {
	if (!names.includes(name)) {
		console.error(`SMOKE FAIL: expected tool "${name}" to be registered`);
		process.exit(1);
	}
}
for (const t of tools) {
	if (typeof t.execute !== "function") {
		console.error(`SMOKE FAIL: "${t.name}" has no execute function`);
		process.exit(1);
	}
	if (!t.parameters || typeof t.parameters !== "object") {
		console.error(`SMOKE FAIL: "${t.name}" has no parameters schema`);
		process.exit(1);
	}
	if (!t.description || !t.promptSnippet) {
		console.error(`SMOKE FAIL: "${t.name}" is missing description/promptSnippet`);
		process.exit(1);
	}
}

console.log("SMOKE OK: extension loads, both tools registered with execute + parameters + prompt metadata.");
process.exit(0);
