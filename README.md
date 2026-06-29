# pi-web

A [Pi](https://github.com/earendil-works/pi) extension that gives the agent
two LLM-callable tools for the web:

- **`web_fetch`** — open an `http(s)` URL and return its content as clean
  markdown (Mozilla Readability article extraction by default, or the whole
  page with `raw=true`).
- **`web_search`** — search the web and return titles, URLs, and snippets.
  Uses DuckDuckGo out of the box (no API key) or a SearXNG instance when
  configured.

## Install

This is a package-style extension with runtime dependencies, so install them
once in the extension directory (jiti resolves them from `node_modules`):

```bash
cd pi-web
npm install
```

Then load it in Pi:

```bash
# ad-hoc
pi --extension /path/to/pi-web/src/index.ts

# or auto-discovered: copy/symlink the directory into your extensions folder
cp -r pi-web ~/.pi/agent/extensions/pi-web
```

No build step is required — Pi loads TypeScript via jiti.

## Tools

### `web_fetch`

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | Absolute `http(s)` URL to read. |
| `raw` | boolean (optional) | Skip article extraction; convert the whole page body. Useful for forums, docs, tables. Default `false`. |

The page is parsed with [linkedom](https://github.com/WebReflection/linkedom),
relative links are rewritten to absolute URLs, noise (`script`/`style`/`iframe`/
`svg`/…) is pruned, and the content is converted to markdown with
[turndown](https://github.com/mixmark-io/turndown). Output is truncated to
Pi's built-in limit (2000 lines / 50KB) and the full text is spilled to a temp
file when truncated.

### `web_search`

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query. |
| `count` | number (optional) | Max results to return, 1–20. Default `5`. |

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_WEB_SEARCH_URL` | _(unset)_ | Base URL of a SearXNG instance. When set, `web_search` uses its JSON API instead of DuckDuckGo. Example: `https://searx.example.com`. |
| `PI_WEB_ALLOW_PRIVATE` | _(unset)_ | Set to `1` or `true` to allow fetching private/loopback/link-local hosts. Off by default. Use only to reach internal documentation on a trusted network. |

## Security

Pi extensions run with the permissions of the user and Pi has no built-in
sandbox. `web_fetch` therefore applies **defense-in-depth SSRF protection**:

- only `http` and `https` schemes are allowed;
- URLs with embedded credentials are rejected;
- private, loopback, link-local, CGNAT, multicast, reserved, and cloud-metadata
  (`169.254.169.254`) addresses are blocked, for both IPv4 and IPv6 (including
  IPv4-mapped/compatible forms);
- the hostname is resolved and every resolved address is checked;
- HTTP redirects are followed manually and **each redirect target is
  re-validated**, so a public server cannot redirect the tool to an internal
  address.

This is **not a security sandbox**: DNS rebinding (a hostname that resolves to a
public address for the check and a private one for the real connection) is still
possible. Treat the guard as a footgun reducer. Run Pi inside a container or
network-restricted sandbox when fetching untrusted content unattended.

Responses are size-capped (2MB body) and timeout-capped (20s, abort-aware) so a
hostile or huge page cannot exhaust memory or hang the agent.

## Scripts

```bash
npm run check   # tsc --noEmit (type-check)
npm test        # unit tests for the pure SSRF / extraction / search parsers
```

The unit tests cover the pure helpers only (no network) and can run offline.

## Layout

```
src/
  index.ts     # extension factory (registers the tools)
  tools.ts     # Pi tool adapter: parameters, execute, rendering, truncation
  net.ts       # safeFetchText: SSRF guard + timeout + size cap + redirect validation
  ssrf.ts      # pure IP allow/deny logic (testable)
  extract.ts   # pure HTML -> markdown extraction (testable)
  search.ts    # pure DuckDuckGo/SearXNG parsers + URL builders (testable)
test/
  ssrf.test.ts
  extract.test.ts
  search.test.ts
```
