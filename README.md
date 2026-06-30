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
./pi-web.sh install     # copy the committed bundle into the agent dir
./pi-web.sh status      # show installation status
./pi-web.sh check       # type-check + unit tests (offline)
./pi-web.sh update      # re-copy the bundle (after pulling changes)
./pi-web.sh uninstall   # remove the extension from the agent dir
```

The extension is pre-compiled with esbuild into a single bundle
(`index.js`, committed at the repo root) before being copied. The bundle has
the runtime deps (linkedom, turndown, @mozilla/readability) bundled in and
the Pi peer deps kept external (Pi resolves them at runtime), so the
destination needs no `node_modules` — just the bundle and a minimal
`package.json`. Loading the pre-compiled bundle skips jiti, eliminating the
~13–15s cold-start overhead of runtime TypeScript transpilation.

The bundle is committed to the repo (not built at install time), so this
script does not require esbuild or any dev dependency — it just copies the
artifact. The same committed bundle is what `pi install git:...` loads
(see below).

The agent directory honors `PI_CODING_AGENT_DIR` (the same env var Pi uses)
and falls back to `~/.pi/agent`. Run `./pi-web.sh -h` for the full reference.
The script resolves the extension source from its own location, so it can be
invoked from anywhere.

### Install from git (Pi's package manager)

The repo is structured to be installable with Pi's native git source:

```bash
pi install git:github.com/yarilc/pi-web
```

Pi clones the repo into `~/.pi/agent/git/github.com/yarilc/pi-web/` and loads
the committed `index.js` bundle directly (no build step, no esbuild needed).
This works because the distribution artifact (`index.js`) is committed and
the `pi.extensions` manifest points at it.

Use a pinned ref (tag or commit) for reproducibility:

```bash
pi install git:github.com/yarilc/pi-web@v0.1.0
```

Update later with `pi update --extensions`.

> **Note on peer deps:** when Pi installs a git source it runs
> `npm install --omit=dev` **without** `--legacy-peer-deps`, so npm also
> installs the `@earendil-works/pi-*` peers into the clone's
> `node_modules`. This is harmless: Pi resolves its own modules via loader
> aliases at runtime, so the installed peers are unused shadow copies. They
> add disk usage but do not affect behavior.

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
npm run build                            # esbuild → index.js (committed artifact)
DEST="$HOME/.pi/agent/extensions/pi-web"
mkdir -p "$DEST"
cp index.js "$DEST/index.js"
cat > "$DEST/package.json" <<'JSON
{
  "name": "pi-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.js"] }
}
JSON
# or ad-hoc, without installing into the agent dir:
pi --extension /path/to/pi-web/index.js
```

The bundle is committed as `index.js` (not `index.mjs`) deliberately: Pi
derives the extension's display label from the entry-point path segments and
strips a trailing `index.ts`/`index.js` (but not `index.mjs`), so `index.js`
yields the label "pi-web". The `package.json` `"type": "module"` makes Node
treat `index.js` as ESM.

For development, `npm run build` regenerates `index.js` from `src/`; commit
the result. The CI sync guard (`git diff --exit-code -- index.js`) fails if
the committed bundle does not match a fresh build.

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

### Recommended: run inside pi-container

For real isolation, run Pi inside
[pi-container](https://github.com/yarilc/pi-container) — a rootless Podman
wrapper purpose-built for Pi. It runs Pi with a read-only root filesystem,
dropped capabilities (`--cap-drop=ALL`), `no-new-privileges`, resource limits,
and SELinux labels, while transparently mapping container file ownership back
to your host user. Extensions installed under `~/.pi/agent/extensions/`
(including this one) are auto-discovered inside the container exactly as on
the host.

For untrusted content, combine it with the two flags that neutralize the
residual SSRF/data-exfiltration risks:

```bash
# Read-only Pi config (prevents a subverted agent from planting persistent
# malicious extensions/skills) + no network egress:
PI_READONLY_CONFIG=1 PI_NETWORK=none pic "fetch and summarize this untrusted page"
```

`PI_NETWORK=none` blocks all outbound traffic, so even a DNS-rebinding or
SSRF bypass cannot reach an internal host. `PI_READONLY_CONFIG=1` mounts
`~/.pi` and `~/.agents` read-only so a compromised agent cannot persist
malicious extensions across runs. See the pi-container
[SECURITY.md](https://github.com/yarilc/pi-container/blob/main/SECURITY.md)
for the full threat model.

Responses are size-capped (2MB body) and timeout-capped (20s, abort-aware) so a
hostile or huge page cannot exhaust memory or hang the agent.

## Scripts

```bash
npm run check        # tsc --noEmit (type-check, offline)
npm test             # unit tests for the pure SSRF / extraction / search parsers (offline)
npm run build        # esbuild bundle → index.js (committed, distribution artifact)
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
index.js        # COMMITTED esbuild bundle (distribution artifact; what `pi install git:` loads)
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
  verify-bundle.ts # asserts the committed index.js loads (no jiti) and registers both tools
  e2e-fetch.ts   # live fetch + extract on example.com (required CI gate, stable target)
  e2e-search.ts   # live DuckDuckGo search parse (informational; DDG may rate-limit CI)
```
