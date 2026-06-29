/**
 * pi-web extension entry point.
 *
 * Adds two LLM-callable tools to Pi:
 *   - web_fetch: read a URL and return its content as clean markdown
 *   - web_search: search the web and return titles, URLs, and snippets
 *
 * Loaded by Pi via jiti (TypeScript works without a build step). The factory
 * is synchronous and registers tools only — no background resources are
 * started, so it is safe even in invocations that never start a session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerWebTools } from "./tools.ts";

export default function webExtension(pi: ExtensionAPI): void {
	registerWebTools(pi);
}
