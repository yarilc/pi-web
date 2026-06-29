/**
 * Network layer for the pi-web tools.
 *
 * `safeFetchText` is the single entry point used by both web_fetch and
 * web_search. It enforces:
 *   - http(s) only, no embedded credentials
 *   - SSRF protection: private/loopback/link-local/cloud-metadata hosts are
 *     blocked (opt out with PI_WEB_ALLOW_PRIVATE=1); redirect targets are
 *     re-validated on every hop to defeat redirect-based SSRF
 *   - a per-request timeout (default 20s) wired to the caller's AbortSignal
 *   - a hard body-size cap (default 2 MB) enforced while streaming, so an
 *     unbounded response can never exhaust memory
 *
 * This is a thin network adapter over the pure SSRF helpers in `ssrf.ts`.
 */
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

import { isDisallowedIp } from "./ssrf.ts";

/** Default request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Default maximum downloaded body size in bytes (2 MB). */
export const DEFAULT_MAX_BYTES = 2_000_000;
/** Maximum HTTP redirects followed before bailing out. */
const MAX_REDIRECTS = 5;

/** User agent identifies the extension so sites can recognize the traffic. */
const USER_AGENT =
	"Mozilla/5.0 (compatible; pi-web-extension/1.0; +https://github.com/earendil-works/pi)";

const FETCH_HEADERS: Readonly<Record<string, string>> = {
	"user-agent": USER_AGENT,
	accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
	"accept-language": "en-US,en;q=0.9",
};

export interface SafeFetchOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxBytes?: number;
}

export interface SafeFetchResult {
	/** Final URL after following redirects. */
	readonly url: string;
	readonly contentType: string | null;
	readonly body: string;
	readonly bytes: number;
	/** True when the body was cut off at maxBytes before being fully read. */
	readonly truncatedBySize: boolean;
}

/** Read PI_WEB_ALLOW_PRIVATE at call time so runtime env changes are honored. */
function isPrivateAllowed(): boolean {
	const v = process.env.PI_WEB_ALLOW_PRIVATE;
	return v === "1" || v === "true";
}

/** True when a content-type can be meaningfully returned as text to the LLM. */
function isTextContentType(contentType: string | null): boolean {
	if (!contentType) return true; // lenient when the server omits it
	const ct = contentType.toLowerCase();
	return (
		ct.startsWith("text/") ||
		ct.includes("html") ||
		ct.includes("json") ||
		ct.includes("xml") ||
		ct.includes("xhtml") ||
		ct.includes("javascript") ||
		ct.includes("yaml") ||
		ct.includes("csv")
	);
}

/**
 * Resolve a hostname and reject if any resolved address is non-public.
 * IP literals are checked directly. Fails closed on DNS errors and empty
 * results. This is defense-in-depth, not a sandbox (see ssrf.ts caveat).
 */
async function assertPublicHost(hostname: string): Promise<void> {
	if (isIPv4(hostname) || isIPv6(hostname)) {
		if (isDisallowedIp(hostname)) {
			throw new Error(
				`Refused: ${hostname} is a private/loopback/link-local address (set PI_WEB_ALLOW_PRIVATE=1 to override).`,
			);
		}
		return;
	}

	let addresses: string[];
	try {
		const res = await lookup(hostname, { all: true, verbatim: true });
		addresses = res.map((r) => r.address);
	} catch (err) {
		throw new Error(`DNS lookup failed for ${hostname}: ${(err as Error).message}`);
	}

	if (addresses.length === 0) {
		throw new Error(`DNS lookup returned no addresses for ${hostname}.`);
	}
	for (const addr of addresses) {
		if (isDisallowedIp(addr)) {
			throw new Error(
				`Refused: ${hostname} resolves to ${addr}, a private/loopback/link-local address (set PI_WEB_ALLOW_PRIVATE=1 to override).`,
			);
		}
	}
}

/** Validate scheme + credentials, and run the SSRF host check unless opted out. */
async function assertPublicUrl(targetUrl: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(targetUrl);
	} catch {
		throw new Error(`Invalid URL: ${targetUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported URL scheme: ${parsed.protocol} (only http and https are allowed).`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("URLs with embedded credentials are not allowed.");
	}
	if (!isPrivateAllowed()) {
		await assertPublicHost(parsed.hostname);
	}
}

/** Propagate an external AbortSignal into a local AbortController. */
function linkSignals(controller: AbortController, external: AbortSignal | undefined): void {
	if (!external) return;
	if (external.aborted) {
		controller.abort((external as AbortSignal).reason);
		return;
	}
	external.addEventListener("abort", () => controller.abort((external as AbortSignal).reason), {
		once: true,
	});
}

/**
 * Read a ReadableStream as text, stopping as soon as `maxBytes` has been
 * downloaded. Returns the decoded text, total bytes seen, and whether the body
 * was truncated. Memory stays bounded at roughly maxBytes.
 */
async function readCappedText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	if (!body) return { text: "", bytes: 0, truncated: false };
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let received = 0;
	let truncated = false;
	let text = "";
	try {
		for (;;) {
			if (signal.aborted) throw new Error("aborted");
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			received += value.byteLength;
			if (received > maxBytes) {
				const before = received - value.byteLength;
				const keep = Math.max(0, maxBytes - before);
				if (keep > 0) text += decoder.decode(value.subarray(0, keep), { stream: true });
				truncated = true;
				break;
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode(); // flush trailing bytes
	} finally {
		reader.releaseLock();
	}
	return { text, bytes: received, truncated };
}

/**
 * Fetch a URL and return its body as text, with SSRF guards, timeout, manual
 * redirect validation, and a body-size cap. Throws on any refusal, non-2xx
 * final status, non-text content-type, timeout, or abort.
 */
export async function safeFetchText(targetUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`web fetch timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	linkSignals(controller, opts.signal);

	let url = targetUrl;
	let res: Response | undefined;
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await assertPublicUrl(url);
			const r = await fetch(url, {
				signal: controller.signal,
				redirect: "manual",
				headers: FETCH_HEADERS,
			});
			if (r.status >= 300 && r.status < 400) {
				const loc = r.headers.get("location");
				if (!loc) throw new Error(`Redirect ${r.status} without a Location header.`);
				try {
					url = new URL(loc, url).href;
				} catch {
					throw new Error(`Invalid redirect Location: ${loc}`);
				}
				await r.body?.cancel().catch(() => {});
				continue;
			}
			res = r;
			break;
		}
		if (!res) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
		}
		const contentType = res.headers.get("content-type") ?? null;
		if (!isTextContentType(contentType)) {
			throw new Error(
				`Unsupported content-type: ${contentType ?? "(unknown)"} (web_fetch supports text/HTML/JSON/XML).`,
			);
		}
		const { text, bytes, truncated } = await readCappedText(res.body, maxBytes, controller.signal);
		return { url: res.url || url, contentType, body: text, bytes, truncatedBySize: truncated };
	} finally {
		clearTimeout(timer);
	}
}
