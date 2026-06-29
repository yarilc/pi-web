/**
 * HTML content extraction for the web_fetch tool.
 *
 * Turns a fetched HTML document into clean markdown suitable for an LLM:
 *   1. Parse with linkedom (a fast DOM implementation that works in Node).
 *   2. Inject a <base> and rewrite relative a[href] to absolute URLs.
 *   3. Prune non-content noise (script/style/iframe/svg/...).
 *   4. By default, run Mozilla Readability to extract the main article; if the
 *      page is not readerable (or raw mode is requested), convert the whole
 *      <body> instead.
 *   5. Convert the resulting HTML to markdown with turndown.
 *
 * This is a pure function (input HTML + URL -> ExtractResult) so it can be
 * unit-tested offline without any network access.
 */
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/** Result of extracting readable content from an HTML document. */
export interface ExtractResult {
	readonly title: string | null;
	readonly text: string;
	readonly excerpt: string | null;
	readonly byline: string | null;
	readonly siteName: string | null;
	/** True when Readability accepted the page as an article. */
	readonly readerable: boolean;
}

/** Elements that never carry readable text and only add noise to markdown. */
const NOISE_SELECTORS = [
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"svg",
	"canvas",
	"link",
	"meta",
] as const;

function createTurndown(): TurndownService {
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "_",
		hr: "---",
	});
}

/** Read document.title defensively: linkedom getters throw on degenerate/empty documents. */
function safeTitle(document: Document): string | null {
	try {
		return document.title?.trim() || null;
	} catch {
		return null;
	}
}

/** Read <body> innerHTML defensively: linkedom's body getter throws when there is no documentElement. */
function safeBodyHtml(document: Document): string {
	try {
		return document.body?.innerHTML ?? "";
	} catch {
		return "";
	}
}

/**
 * Rewrite every a[href] to an absolute URL against the page URL, so the
 * markdown links the LLM receives are directly usable by web_fetch later.
 * In-page anchors and non-http(s) schemes (mailto:, javascript:, ...) are left
 * untouched.
 */
function absolutizeLinks(document: Document, baseUrl: string): void {
	for (const a of Array.from(document.querySelectorAll("a[href]"))) {
		const raw = a.getAttribute("href");
		if (!raw || raw.startsWith("#")) continue;
		if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.toLowerCase().startsWith("http")) continue;
		try {
			a.setAttribute("href", new URL(raw, baseUrl).href);
		} catch {
			// Leave malformed hrefs as-is rather than failing the whole extraction.
		}
	}
}

/** Remove non-content elements from the document in place. */
function pruneNoise(document: Document): void {
	for (const sel of NOISE_SELECTORS) {
		for (const el of Array.from(document.querySelectorAll(sel))) {
			el.remove();
		}
	}
}

/**
 * Extract readable markdown from an HTML string.
 *
 * @param html  Raw HTML returned by an HTTP fetch.
 * @param url   The page URL, used to resolve relative links and as a base.
 * @param opts.raw  Skip Readability article extraction and convert the whole
 *                  page body (useful for non-article pages such as forums or tables).
 */
export function extractContent(
	html: string,
	url: string,
	opts: { raw?: boolean } = {},
): ExtractResult {
	const { document } = parseHTML(html);

	// Inject <base> so any internal URL resolution honors the page origin.
	if (url) {
		try {
			const base = document.createElement("base");
			base.setAttribute("href", url);
			(document.head ?? document.documentElement)?.appendChild(base);
		} catch {
			// ignore — base injection is a nicety, not a requirement
		}
	}

	pruneNoise(document);
	absolutizeLinks(document, url);

	const title = safeTitle(document);
	const turndown = createTurndown();

	if (opts.raw) {
		const bodyHtml = safeBodyHtml(document);
		return {
			title,
			text: turndown.turndown(bodyHtml).trim(),
			excerpt: null,
			byline: null,
			siteName: null,
			readerable: false,
		};
	}

	let readerable = false;
	try {
		readerable = isProbablyReaderable(document as unknown as Document);
	} catch {
		readerable = false;
	}

	if (readerable) {
		try {
			const article = new Readability(document as unknown as Document, { charThreshold: 500 }).parse();
			if (article?.content) {
				return {
					title: article.title?.trim() || title,
					text: turndown.turndown(article.content).trim(),
					excerpt: article.excerpt?.trim() || null,
					byline: article.byline ?? null,
					siteName: article.siteName ?? null,
					readerable: true,
				};
			}
		} catch {
			// fall through to whole-body conversion
		}
	}

	const bodyHtml = safeBodyHtml(document);
	return {
		title,
		text: turndown.turndown(bodyHtml).trim(),
		excerpt: null,
		byline: null,
		siteName: null,
		readerable: false,
	};
}
