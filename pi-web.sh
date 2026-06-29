#!/usr/bin/env bash
#
# pi-web extension manager: install / update / uninstall / status / check.
#
# Builds the extension with esbuild (bundle, pre-compiled JS) and copies the
# single artifact into the Pi agent extensions directory
# ($AGENT_DIR/extensions/pi-web, default ~/.pi/agent/extensions/pi-web) so Pi
# auto-discovers it globally. Because the extension lives under the agent dir,
# mounting ~/.pi (or ~/.pi/agent) into a container makes the extension
# available to every session started inside that container — no per-project
# path references, no settings entries.
#
# The pre-compiled bundle (dist/index.mjs) loads without jiti, eliminating
# the ~13-15s cold-start overhead of runtime TypeScript transpilation. The
# runtime deps (linkedom, turndown, @mozilla/readability) are bundled in,
# so the destination needs no node_modules at all — just the single .mjs.
#
# The agent dir honors PI_CODING_AGENT_DIR (the same env var Pi uses) and
# falls back to ~/.pi/agent.
#
# Usage:
#   ./pi-web.sh install      build + copy the bundle into the agent dir
#   ./pi-web.sh update       re-build and re-copy the bundle
#   ./pi-web.sh uninstall    remove the extension from the agent dir
#   ./pi-web.sh status       show installation status
#   ./pi-web.sh check        run type-check and unit tests (offline)
#   ./pi-web.sh -h | --help  show this help
#
# Exit codes:
#   0   success
#   1   unexpected failure (a step exited non-zero)
#   2   bad usage (unknown command/option)
#   127 required command not found (pi / node / npm)

set -euo pipefail

# --- locate the extension source directory (the script's own dir) -----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# --- extension identity -----------------------------------------------------
readonly EXT_NAME="pi-web"
readonly EXT_BUNDLE="dist/index.mjs"   # relative to SCRIPT_DIR; the built artifact

# --- resolve the Pi agent directory -----------------------------------------
# Mirrors Pi's own resolution (config.js getAgentDir): PI_CODING_AGENT_DIR
# wins, otherwise $HOME/.pi/agent. Rebranded distributions rename the env var
# to <APP_NAME>_CODING_AGENT_DIR, so we also accept PI_CODING_AGENT_DIR only
# (the standard Pi name). The path is used as-is when set, so it must already
# be absolute.
resolve_agent_dir() {
    if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
        printf '%s' "$PI_CODING_AGENT_DIR"
    else
        printf '%s/.pi/agent' "$HOME"
    fi
}
readonly AGENT_DIR="$(resolve_agent_dir)"
readonly DEST="$AGENT_DIR/extensions/$EXT_NAME"

# --- required commands ------------------------------------------------------
require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'pi-web: "%s" command not found on PATH.\n' "$1" >&2
        printf '    Ensure %s is installed and on your PATH.\n' "$2" >&2
        exit 127
    }
}
require_cmd pi   "Pi (https://pi.dev)"
require_cmd node "Node.js (>=22)"
require_cmd npm  "npm (ships with Node.js)"

usage() {
    cat <<USAGE
Usage: pi-web.sh <command> [options]

Commands:
  install      Build the extension (esbuild bundle) and copy it into the Pi
               agent extensions directory. Pi auto-discovers extensions in
               that directory, so no settings entry is needed.
  update       Re-build and re-copy the bundle.
  uninstall    Remove the extension from the agent extensions directory.
  status       Show installation status.
  check        Run type-check and unit tests in the source tree (offline).

Options:
  -h, --help    Show this help.

Agent directory:
  The extension is installed into <agent-dir>/extensions/$EXT_NAME.
  <agent-dir> is \$PI_CODING_AGENT_DIR if set, otherwise ~/.pi/agent.
  Mount ~/.pi (or ~/.pi/agent) into a container to make the extension
  available to every session started inside it.

Environment variables consumed by the extension at runtime:
  PI_WEB_ALLOW_PRIVATE  allow fetching private/loopback hosts (set to 1 or true)
  PI_WEB_SEARCH_URL     SearXNG base URL to use web_search instead of DuckDuckGo
USAGE
}

hdr() {
    printf '\n== %s ==\n' "$1"
}

# Run an npm command inside the extension source directory (subshell).
npm_in_source() {
    (cd "$SCRIPT_DIR" && npm "$@")
}

# Build the extension bundle with esbuild and copy it into the destination.
# The bundle is pre-compiled JS with runtime deps (linkedom, turndown,
# @mozilla/readability) bundled in and Pi peer deps (@earendil-works/*,
# typebox) kept external so Pi resolves them at runtime via its loader
# aliases. Loading the bundle skips jiti, eliminating the ~13-15s cold-start
# overhead of runtime TypeScript transpilation. The destination needs no
# node_modules — just the single bundle plus a minimal package.json.
#
# The bundle is emitted as dist/index.mjs in the source tree (ESM-explicit),
# then installed into the destination as index.js with a companion
# package.json declaring "type": "module". This naming is deliberate: Pi
# derives the extension's display label from the entry-point path segments
# and strips a trailing "index.ts"/"index.js" (but NOT "index.mjs"), so
# "index.js" yields the label "pi-web" while "index.mjs" would show as
# "index.mjs". The package.json makes Node treat index.js as ESM.
build_and_copy() {
    hdr "Building extension bundle (esbuild)"
    npm_in_source run build
    local bundle_src="$SCRIPT_DIR/$EXT_BUNDLE"
    if [[ ! -f "$bundle_src" ]]; then
        printf 'pi-web: build did not produce %s\n' "$EXT_BUNDLE" >&2
        exit 1
    fi
    mkdir -p -- "$DEST"
    cp -f -- "$bundle_src" "$DEST/index.js"
    write_dest_package_json "$DEST/package.json"
}

# Write a minimal package.json into the destination. "type": "module" makes
# Node treat index.js as ESM (the bundle uses ESM syntax). The pi.extensions
# entry points Pi at the installed bundle. No dependencies are declared:
# runtime deps are bundled in, and Pi provides the peer deps at runtime.
write_dest_package_json() {
    cat > "$1" <<'PKGJSON'
{
  "name": "pi-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": [
      "./index.js"
    ]
  }
}
PKGJSON
}

# Remove any legacy "packages" entry in settings.json that points back at the
# source directory (left over from the previous reference-by-path install
# model). Safe no-op when settings.json is absent or has no such entry.
remove_legacy_registration() {
    local settings_file="$AGENT_DIR/settings.json"
    [[ -f "$settings_file" ]] || return 0
    node -e '
        const fs = require("fs");
        const path = require("path");
        const file = process.argv[1];
        const scriptDir = process.argv[2];
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { process.exit(0); }
        if (!Array.isArray(cfg.packages) || cfg.packages.length === 0) process.exit(0);
        const before = cfg.packages.length;
        cfg.packages = cfg.packages.filter((p) => {
            const src = typeof p === "string" ? p : (p && p.source);
            if (typeof src !== "string") return true;
            return path.resolve(path.dirname(file), src) !== scriptDir;
        });
        if (cfg.packages.length === before) process.exit(0);
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
        console.error("Removed legacy packages entry from " + file);
    ' "$settings_file" "$SCRIPT_DIR" || true
}

cmd_install() {
    hdr "Installing $EXT_NAME into $DEST"
    if [[ ! -d "$AGENT_DIR" ]]; then
        printf 'pi-web: agent directory does not exist: %s\n' "$AGENT_DIR" >&2
        printf '    Run `pi` once first to create it, or set PI_CODING_AGENT_DIR.\n' >&2
        exit 1
    fi
    mkdir -p -- "$AGENT_DIR/extensions"
    build_and_copy
    remove_legacy_registration
    printf '\nDone. %s is installed in the agent extensions directory.\n' "$EXT_NAME"
    printf 'Pi auto-discovers it globally; no settings entry is needed.\n'
    printf 'To use inside a container, mount ~/.pi (or ~/.pi/agent) into it.\n'
}

cmd_update() {
    hdr "Updating $EXT_NAME in $DEST"
    if [[ ! -d "$DEST" ]]; then
        printf 'pi-web: destination does not exist: %s\n' "$DEST" >&2
        printf '    Run "install" first.\n' >&2
        exit 1
    fi
    build_and_copy
    printf '\nDone. %s updated.\n' "$EXT_NAME"
}

cmd_uninstall() {
    hdr "Removing $EXT_NAME from $DEST"
    if [[ -d "$DEST" ]]; then
        rm -rf -- "$DEST"
        printf 'Removed %s\n' "$DEST"
    else
        printf 'Nothing to remove: %s does not exist.\n' "$DEST"
    fi
    remove_legacy_registration
    printf '\nDone. %s uninstalled. Source files are kept; run "install" to reinstall.\n' "$EXT_NAME"
}

cmd_status() {
    hdr "$EXT_NAME extension status"
    printf 'source dir:    %s\n' "$SCRIPT_DIR"
    printf 'agent dir:     %s\n' "$AGENT_DIR"
    printf 'destination:   %s\n' "$DEST"

    if [[ -d "$DEST" ]]; then
        printf 'installed:     yes\n'
        if [[ -f "$DEST/index.js" ]]; then
            printf 'bundle:        present (%s)\n' "$(du -h "$DEST/index.js" | cut -f1)"
        else
            printf 'bundle:        MISSING\n'
        fi
    else
        printf 'installed:     no (run "./pi-web.sh install")\n'
    fi

    # Legacy reference-by-path registration check (should be empty after install).
    local settings_file="$AGENT_DIR/settings.json"
    if [[ -f "$settings_file" ]]; then
        local legacy
        legacy="$(node -e '
            const fs = require("fs");
            const path = require("path");
            const file = process.argv[1];
            const scriptDir = process.argv[2];
            let cfg;
            try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
            catch { process.stdout.write("none"); process.exit(0); }
            const pkgs = Array.isArray(cfg.packages) ? cfg.packages : [];
            const found = pkgs.some((p) => {
                const src = typeof p === "string" ? p : (p && p.source);
                if (typeof src !== "string") return false;
                return path.resolve(path.dirname(file), src) === scriptDir;
            });
            process.stdout.write(found ? "present (stale)" : "none");
        ' "$settings_file" "$SCRIPT_DIR" 2>/dev/null || printf 'none')"
        printf 'legacy entry:  %s\n' "$legacy"
    else
        printf 'legacy entry:  none (no settings.json)\n'
    fi

    printf 'pi:            %s\n' "$(pi --version 2>/dev/null || echo unknown)"
    printf 'node:          %s\n' "$(node --version)"
    printf 'npm:           %s\n' "$(npm --version)"
}

cmd_check() {
    hdr "Type-check (tsc --noEmit)"
    npm_in_source run check
    hdr "Unit tests (offline)"
    npm_in_source test
    printf '\nAll checks passed.\n'
}

main() {
    local subcommand="${1:-}"
    if [[ -z "$subcommand" ]]; then
        usage >&2
        exit 2
    fi
    if [[ "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
        usage
        exit 0
    fi
    shift

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)  usage; exit 0 ;;
            *) printf 'pi-web: unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
        esac
    done

    case "$subcommand" in
        install)   cmd_install ;;
        update)    cmd_update ;;
        uninstall) cmd_uninstall ;;
        status)    cmd_status ;;
        check)     cmd_check ;;
        *) printf 'pi-web: unknown command: %s\n' "$subcommand" >&2; usage >&2; exit 2 ;;
    esac
}

main "$@"
