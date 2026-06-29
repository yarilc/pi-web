/**
 * Pi tool adapter for the pi-web extension.
 *
 * Registers two LLM-callable tools on top of the pure helpers:
 *   - web_fetch: read a URL and return clean markdown content
 *   - web_search: search the web and return titles/URLs/snippets
 *
 * The adapter is intentionally thin: it wires the Pi tool contract
 * (parameters, execute, prompt metadata, custom rendering) on top of the
 * testable logic in ssrf.ts / extract.ts / search.ts and the network layer in
 * net.ts. Large outputs are truncated with Pi's built-in helpers and the full
 * text is spilled to a temp file so the model can still reach it.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { extractContent } from "./extract.ts";
import { safeFetchText } from "./net.ts";
import {
	buildDuckDuckGoUrl,
	buildSearxngUrl,
	formatResults,
	getConfiguredProvider,
	parseDuckDuckGo,
	parseSearxng,
	type SearchResult,
} from "./search.ts";

/** Details persisted with a web_fetch tool result (for rendering and session state). */
interface WebFetchDetails {
	url: string;
	finalUrl: string;
	contentType: string | null;
	bytes: number;
	truncatedBySize: boolean;
	title: string | null;
	excerpt: string | null;
	byline: string | null;
	siteName: string | null;
	readerable: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Details persisted with a web_search tool result. */
interface WebSearchDetails {
	query: string;
	provider: string;
	resultCount: number;
	results: SearchResult[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** A single text content block, with the literal type preserved for Pi's union. */
function textBlock(text: string): { type: "text"; text: string } {
	return { type: "text" as const, text };
}

/** Clamp an optional integer parameter to [min, max] with a default. */
function clampInt(v: number | undefined, min: number, max: number, def: number): number {
	if (v == null || !Number.isFinite(v)) return def;
	return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Best-effort JSON parse used for SearXNG responses; returns null on failure. */
function safeJsonParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * Truncate text to Pi's limits, spill the full text to a temp file when
 * truncated, and return the Pi tool result shape. The base `details` object is
 * enriched with truncation metadata.
 */
async function withTruncation(
	text: string,
	details: Record<string, unknown>,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let out = truncation.content;
	const enriched: Record<string, unknown> = { ...details, truncation };

	if (truncation.truncated) {
		const dir = await mkdtemp(join(tmpdir(), "pi-web-"));
		const file = join(dir, "output.md");
		await writeFile(file, text, "utf8");
		enriched.fullOutputPath = file;
		const omittedLines = truncation.totalLines - truncation.outputLines;
		out += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines omitted. Full output saved to: ${file}]`;
	}

	return { content: [textBlock(out)], details: enriched };
}

/** Register the web_fetch and web_search tools on the given Pi instance. */
export function registerWebTools(pi: ExtensionAPI): void {
	const WebFetchParams = Type.Object({
		url: Type.String({ description: "Absolute http(s) URL to fetch and read." }),
		raw: Type.Optional(
			Type.Boolean({
				description:
					"Skip article extraction and convert the whole page body to markdown. Useful for non-article pages (forums, docs, tables). Default: false.",
			}),
		),
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch an http(s) URL and return its content as clean markdown. By default extracts the main article (Mozilla Readability); set raw=true to convert the whole page. Relative links are rewritten to absolute URLs. Output is truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} and the full output is saved to a temp file when truncated. Private/loopback/link-local hosts are blocked unless PI_WEB_ALLOW_PRIVATE=1.`,
		promptSnippet: "Fetch a URL and return its content as clean markdown",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, open, view, or fetch a web page or URL. web_fetch returns clean markdown extracted from the page; prefer it over bash curl when you need readable content.",
			"After web_search returns result URLs, use web_fetch on the most relevant result to read its full content before answering.",
		],
		parameters: WebFetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const url = (params.url ?? "").trim();
			if (!url) throw new Error("url is required.");
			onUpdate?.({ content: [textBlock(`Fetching ${url}...`)], details: {} });

			const fetched = await safeFetchText(url, { signal, timeoutMs: 20_000 });
			const looksHtml =
				(fetched.contentType ?? "").includes("html") ||
				/<\/?[a-z][\s>]/i.test(fetched.body.slice(0, 1024));

			const details: WebFetchDetails = {
				url,
				finalUrl: fetched.url,
				contentType: fetched.contentType,
				bytes: fetched.bytes,
				truncatedBySize: fetched.truncatedBySize,
				title: null,
				excerpt: null,
				byline: null,
				siteName: null,
				readerable: false,
			};

			let text: string;
			if (looksHtml) {
				const ext = extractContent(fetched.body, fetched.url, { raw: params.raw === true });
				details.title = ext.title;
				details.excerpt = ext.excerpt;
				details.byline = ext.byline;
				details.siteName = ext.siteName;
				details.readerable = ext.readerable;
				text = ext.text || fetched.body;
			} else {
				text = fetched.body;
			}

			return withTruncation(text, details as unknown as Record<string, unknown>);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url ?? ""),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			const d = result.details as WebFetchDetails | undefined;
			let text = "";
			if (d?.title) text += theme.fg("accent", d.title) + "\n";
			text += theme.fg("success", formatSize(d?.bytes ?? 0));
			if (d?.truncatedBySize) text += theme.fg("warning", " (body size-capped)");
			if (d?.truncation?.truncated) text += theme.fg("warning", " (output truncated)");
			if (expanded) {
				const block = result.content[0];
				if (block?.type === "text") {
					const lines = block.text.split("\n").slice(0, 15);
					for (const line of lines) text += "\n" + theme.fg("dim", line);
					if (block.text.split("\n").length > 15) text += "\n" + theme.fg("muted", "...");
				}
				if (d?.fullOutputPath) text += "\n" + theme.fg("dim", `Full output: ${d.fullOutputPath}`);
			}
			return new Text(text, 0, 0);
		},
	});

	const WebSearchParams = Type.Object({
		query: Type.String({ description: "Search query." }),
		count: Type.Optional(
			Type.Number({ description: "Maximum number of results to return (1-20). Default: 5." }),
		),
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web and return up to 'count' results (title, URL, snippet). Default provider is DuckDuckGo (no API key needed). Set PI_WEB_SEARCH_URL to a SearXNG base URL to use a SearXNG JSON API instead. Use web_fetch to read the full content of a result URL. Output is truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web and return titles, URLs, and snippets",
		promptGuidelines: [
			"Use web_search when the user asks to search the web, look something up online, or find current information. web_search returns titles, URLs, and snippets; use web_fetch to read the full content of the most relevant result before answering.",
		],
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const query = (params.query ?? "").trim();
			if (!query) throw new Error("query is required.");
			const count = clampInt(params.count, 1, 20, 5);
			onUpdate?.({ content: [textBlock(`Searching the web for "${query}"...`)], details: {} });

			const { provider, baseUrl } = getConfiguredProvider();
			const searchUrl =
				provider === "searxng" && baseUrl ? buildSearxngUrl(baseUrl, query) : buildDuckDuckGoUrl(query);

			const fetched = await safeFetchText(searchUrl, { signal, timeoutMs: 20_000 });
			const results =
				provider === "searxng" ? parseSearxng(safeJsonParse(fetched.body)) : parseDuckDuckGo(fetched.body);
			const trimmed = results.slice(0, count);

			const details: WebSearchDetails = {
				query,
				provider,
				resultCount: trimmed.length,
				results: trimmed,
			};
			return withTruncation(formatResults(query, provider, trimmed), details as unknown as Record<string, unknown>);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("accent", `"${args.query ?? ""}"`),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const d = result.details as WebSearchDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "done"), 0, 0);
			let text =
				theme.fg("success", `${d.resultCount} result${d.resultCount === 1 ? "" : "s"}`) +
				theme.fg("muted", ` (${d.provider})`);
			if (expanded) {
				for (const r of d.results) {
					text += "\n" + theme.fg("accent", r.title);
					text += "\n" + theme.fg("dim", r.url);
				}
			}
			return new Text(text, 0, 0);
		},
	});
}
