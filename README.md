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
./pi-web.sh install     # build (esbuild bundle) + copy into the agent dir
./pi-web.sh status      # show installation status
./pi-web.sh check       # type-check + unit tests (offline)
./pi-web.sh update      # re-build and re-copy the bundle
./pi-web.sh uninstall   # remove the extension from the agent dir
```

The extension is pre-compiled with esbuild into a single bundle
(`dist/index.mjs`) before being copied. The bundle has the runtime deps
(linkedom, turndown, @mozilla/readability) bundled in and the Pi peer deps
kept external (Pi resolves them at runtime), so the destination needs no
`node_modules` — just the bundle and a minimal `package.json`. Loading the
pre-compiled bundle skips jiti, eliminating the ~13–15s cold-start overhead
of runtime TypeScript transpilation.

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
npm install                              # dev deps, incl. esbuild
npm run build                            # esbuild → dist/index.mjs
DEST="$HOME/.pi/agent/extensions/pi-web"
mkdir -p "$DEST"
cp dist/index.mjs "$DEST/index.js"       # .js + package.json type:module → ESM
cat > "$DEST/package.json" <<'JSON'
{
  "name": "pi-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.js"] }
}
JSON
# or ad-hoc, without installing into the agent dir:
pi --extension /path/to/pi-web/dist/index.mjs
```

The bundle is emitted as `dist/index.mjs` (ESM-explicit) but installed as
`index.js` with a companion `package.json` declaring `"type": "module"`.
This naming is deliberate: Pi derives the extension's display label from the
entry-point path segments and strips a trailing `index.ts`/`index.js` (but not
`index.mjs`), so `index.js` yields the label "pi-web".

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
npm run check        # tsc --noEmit (type-check, offline)
npm test             # unit tests for the pure SSRF / extraction / search parsers (offline)
npm run build        # esbuild bundle → dist/index.mjs (pre-compiled, no jiti at load time)
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
pi-web.sh       # extension manager: build / install / update / uninstall / status / check
src/
  index.ts     # extension factory (registers the tools)
  tools.ts     # Pi tool adapter: parameters, execute, rendering, truncation
  net.ts       # safeFetchText: SSRF guard + timeout + size cap + redirect validation
  ssrf.ts      # pure IP allow/deny logic (testable)
  extract.ts   # pure HTML -> markdown extraction (testable)
  search.ts    # pure DuckDuckGo/SearXNG parsers + URL builders (testable)
dist/             # build output (gitignored)
  index.mjs    # esbuild bundle (pre-compiled, runtime deps bundled, Pi peers external)
test/
  ssrf.test.ts
  extract.test.ts
  search.test.ts
scripts/
  smoke.ts        # runtime load smoke test (registers both tools via jiti)
  e2e-fetch.ts   # live fetch + extract on example.com (required CI gate, stable target)
  e2e-search.ts   # live DuckDuckGo search parse (informational; DDG may rate-limit CI)
```
