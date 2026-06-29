/**
 * Web search providers for the pi-web tools.
 *
 * The pure parsers in this module operate on already-fetched HTML/JSON strings
 * so they can be unit-tested offline. The network call that produces those
 * strings lives in `net.ts`, and the Pi tool adapter composes them in `tools.ts`.
 *
 * Default provider: DuckDuckGo HTML/lite endpoint (no API key required).
 * Override: set `PI_WEB_SEARCH_URL` to a SearXNG base URL to use its JSON API.
 */
import { parseHTML } from "linkedom";

/** A single normalized search result returned to the LLM. */
export interface SearchResult {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

/** Supported search backends. */
export type SearchProvider = "duckduckgo" | "searxng";

/** Build the DuckDuckGo HTML/lite query URL (keyless, world region). */
export function buildDuckDuckGoUrl(query: string): string {
	return `https://html.duckduckgo.com/html/?kl=wt-wt&q=${encodeURIComponent(query)}`;
}

/** Build a SearXNG JSON API URL from a base URL (trailing slash tolerated). */
export function buildSearxngUrl(baseUrl: string, query: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${base}/search?format=json&q=${encodeURIComponent(query)}`;
}

/**
 * Resolve a DuckDuckGo redirect link to the real target URL.
 *
 * DDG HTML results wrap the real URL in a `//duckduckgo.com/l/?uddg=<encoded>`
 * redirect. We extract and decode the `uddg` parameter. Anything else is
 * resolved relative to duckduckgo.com and returned as-is.
 */
function resolveDdgHref(href: string): string | null {
	if (!href) return null;
	try {
		const u = new URL(href, "https://duckduckgo.com");
		const uddg = u.searchParams.get("uddg");
		if (uddg) return uddg;
		return u.href;
	} catch {
		return null;
	}
}

/** Parse a DuckDuckGo HTML/lite results page into SearchResult[]. */
export function parseDuckDuckGo(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];
	for (const el of Array.from(document.querySelectorAll(".result"))) {
		const a = el.querySelector(".result__a");
		const snippetEl = el.querySelector(".result__snippet");
		const url = resolveDdgHref(a?.getAttribute("href") ?? "");
		const title = a?.textContent?.trim() ?? "";
		const snippet = snippetEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		if (url && title) {
			results.push({ title, url, snippet });
		}
	}
	return results;
}

function hasResultShape(v: unknown): v is { url?: unknown; title?: unknown; content?: unknown } {
	return typeof v === "object" && v !== null;
}

/** Parse a SearXNG JSON response (`{ results: [...] }`) into SearchResult[]. */
export function parseSearxng(json: unknown): SearchResult[] {
	if (typeof json !== "object" || json === null) return [];
	const rawResults = (json as { results?: unknown }).results;
	if (!Array.isArray(rawResults)) return [];
	const results: SearchResult[] = [];
	for (const r of rawResults) {
		if (!hasResultShape(r)) continue;
		const url = typeof r.url === "string" ? r.url : "";
		const title = typeof r.title === "string" ? r.title.trim() : "";
		const snippet = typeof r.content === "string" ? r.content.replace(/\s+/g, " ").trim() : "";
		if (url && title) {
			results.push({ title, url, snippet });
		}
	}
	return results;
}

/** Read the configured search provider from the environment. */
export function getConfiguredProvider(): { provider: SearchProvider; baseUrl?: string } {
	const searxng = process.env.PI_WEB_SEARCH_URL;
	if (searxng && searxng.trim()) {
		return { provider: "searxng", baseUrl: searxng.trim() };
	}
	return { provider: "duckduckgo" };
}

/** Render search results as markdown text for the LLM. */
export function formatResults(query: string, provider: string, results: ReadonlyArray<SearchResult>): string {
	if (results.length === 0) {
		return `No results found for "${query}" (provider: ${provider}).`;
	}
	let out = `Web search results for "${query}" (${provider}, ${results.length}):\n\n`;
	results.forEach((r, i) => {
		out += `## ${i + 1}. ${r.title}\n`;
		out += `URL: ${r.url}\n`;
		if (r.snippet) out += `${r.snippet}\n`;
		out += "\n";
	});
	return out.trimEnd();
}
