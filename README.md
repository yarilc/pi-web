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

A shell script `pi-web.sh` (at the repo root) manages install, update,
uninstall, status, and verification. It **copies** the extension into the
Pi agent extensions directory (`~/.pi/agent/extensions/pi-web/` by default) so
Pi auto-discovers it globally — no `settings.json` entry, no per-project path
references. Mounting `~/.pi` (or `~/.pi/agent`) into a container makes the
extension available to every session started inside it.

```bash
./pi-web.sh install     # copy extension into the agent dir + install runtime deps
./pi-web.sh status      # show installation + dependency status
./pi-web.sh check       # type-check + unit tests (offline)
./pi-web.sh update      # re-copy source + refresh runtime deps
./pi-web.sh uninstall   # remove the extension from the agent dir
```

The agent directory honors `PI_CODING_AGENT_DIR` (the same env var Pi uses)
and falls back to `~/.pi/agent`. Run `./pi-web.sh -h` for the full reference.
The script resolves the extension source from its own location, so it can be
invoked from anywhere.

### Use inside a container

Because the extension lives under the agent dir, mounting it into a container
is all that is needed:

```bash
podman run --rm -it \
  -v "$HOME/.pi:/root/.pi:ro" \
  -e HOME=/root \
  … pi
```

The extension (and any other global extension, skill, or prompt under
`~/.pi/agent`) is auto-discovered by Pi inside the container.

### Manual install (without the script)

```bash
cd pi-web
DEST="$HOME/.pi/agent/extensions/pi-web"
mkdir -p "$DEST/src"
cp index.ts "$DEST/"
cp -R src "$DEST/src"
# Write a minimal package.json with only the runtime dependencies (no peer
# deps — Pi provides @earendil-works/pi-* at runtime via loader aliases).
node -e 'const s=require("./package.json");const d={name:s.name,version:s.version,private:true,type:"module",pi:s.pi,dependencies:s.dependencies};require("fs").writeFileSync(process.argv[1],JSON.stringify(d,null,2)+"\n")' "$DEST/package.json"
(cd "$DEST" && npm install --omit=dev --no-fund)
# or ad-hoc, without installing into the agent dir:
pi --extension /path/to/pi-web/index.ts
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
npm run check        # tsc --noEmit (type-check)
npm test             # unit tests for the pure SSRF / extraction / search parsers (offline)
npm run smoke        # runtime load smoke test (registers both tools via jiti)
npm run e2e:fetch    # live fetch + extract on example.com (requires egress)
npm run e2e:search   # live DuckDuckGo search parse (informational; requires egress)
```

The unit tests cover the pure helpers only (no network) and can run offline.
The SSRF guard is covered both at the pure-IP level (`ssrf.test.ts` →
`isDisallowedIp`) and at the integration level (`ssrf.test.ts` →
`safeFetchText` refuses private/loopback/metadata hosts before connecting).

The e2e scripts are split by flakiness profile: `e2e:fetch` targets the
stable IANA example.com page and is a required CI gate; `e2e:search` hits
DuckDuckGo, which rate-limits CI runners, so it is informational only.

## Layout

```
pi-web.sh       # extension manager: install / update / uninstall / status / check
index.ts        # Pi entry point: re-exports src/index.ts so Pi labels the extension "pi-web"
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
scripts/
  smoke.ts        # runtime load smoke test (registers both tools via jiti)
  e2e-fetch.ts   # live fetch + extract on example.com (required CI gate, stable target)
  e2e-search.ts   # live DuckDuckGo search parse (informational; DDG may rate-limit CI)
```
