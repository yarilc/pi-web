#!/usr/bin/env bash
#
# pi-web extension manager: install / update / uninstall / status / check.
#
# Wraps Pi's native `pi install` / `pi remove` commands (idempotent for local
# paths) and adds npm dependency management plus status and verification
# helpers. The extension directory is the script's own directory, so the script
# can be invoked from anywhere.
#
# Usage:
#   ./pi-web.sh install [-l]      npm install + register with Pi
#   ./pi-web.sh update  [-l]      npm update  + re-register with Pi
#   ./pi-web.sh uninstall [-l]    remove from Pi settings + delete node_modules
#   ./pi-web.sh status            show registration + dependency status
#   ./pi-web.sh check             run type-check and unit tests (offline)
#   ./pi-web.sh -h | --help       show this help
#
# Options:
#   -l, --local   Write to project settings (.pi/settings.json) instead of
#                 user settings (~/.pi/agent/settings.json). Passed through to
#                 `pi install` / `pi remove`.
#
# Exit codes:
#   0   success
#   1   unexpected failure (a step exited non-zero)
#   2   bad usage (unknown command/option)
#   127 required command not found (pi / node / npm)

set -euo pipefail

# --- locate the extension directory (the script's own dir, absolute) ---------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

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

# --- scope flag (filled by option parser) -----------------------------------
pi_scope_flag=""

usage() {
    cat <<'USAGE'
Usage: pi-web.sh <command> [options]

Commands:
  install      Install npm dependencies and register the extension with Pi.
  update       Refresh npm dependencies and re-register with Pi.
  uninstall    Remove the extension from Pi settings and delete node_modules.
  status       Show registration and dependency status.
  check        Run type-check and unit tests (offline; no network needed).

Options:
  -l, --local   Write to project settings (.pi/settings.json) instead of user
                settings (~/.pi/agent/settings.json). Passed through to pi.
  -h, --help    Show this help.

Environment variables consumed by the extension at runtime:
  PI_WEB_ALLOW_PRIVATE  allow fetching private/loopback hosts (set to 1 or true)
  PI_WEB_SEARCH_URL     SearXNG base URL to use web_search instead of DuckDuckGo
USAGE
}

hdr() {
    printf '\n== %s ==\n' "$1"
}

# Run an npm command inside the extension directory (subshell, won't change CWD).
npm_in_dir() {
    (cd "$SCRIPT_DIR" && npm "$@")
}

# Invoke `pi install` / `pi remove` with the configured scope.
pi_register() {
    if [[ "$pi_scope_flag" == "-l" ]]; then
        pi install "$SCRIPT_DIR" -l
    else
        pi install "$SCRIPT_DIR"
    fi
}
pi_unregister() {
    if [[ "$pi_scope_flag" == "-l" ]]; then
        pi remove "$SCRIPT_DIR" -l
    else
        pi remove "$SCRIPT_DIR"
    fi
}

# Print "registered" or "not-registered" for a given settings file and abs path.
# Always exits 0; read failures count as "not-registered" (fail closed).
registration_state() {
    local settings_file="$1"
    local abs_path="$2"
    local result
    result="$(node -e '
        const fs = require("fs");
        const path = require("path");
        const file = process.argv[1];
        const abs = process.argv[2];
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { process.stdout.write("not-registered"); process.exit(0); }
        const pkgs = Array.isArray(cfg.packages) ? cfg.packages : [];
        const dir = path.dirname(file);
        const found = pkgs.some((p) => {
            const src = typeof p === "string" ? p : (p && p.source);
            if (typeof src !== "string") return false;
            return path.resolve(dir, src) === abs;
        });
        process.stdout.write(found ? "registered" : "not-registered");
    ' "$settings_file" "$abs_path" 2>/dev/null)" || result="not-registered"
    printf '%s' "$result"
}

cmd_install() {
    hdr "Installing npm dependencies"
    npm_in_dir install --no-audit --no-fund
    hdr "Registering with Pi"
    pi_register
    printf '\nDone. The pi-web tools (web_fetch, web_search) are now available in Pi.\n'
}

cmd_update() {
    hdr "Refreshing npm dependencies"
    npm_in_dir update
    hdr "Re-registering with Pi"
    pi_register
    printf '\nDone. pi-web updated.\n'
}

cmd_uninstall() {
    hdr "Removing from Pi settings"
    pi_unregister
    hdr "Removing node_modules"
    if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
        rm -rf -- "$SCRIPT_DIR/node_modules"
        printf 'Deleted %s/node_modules\n' "$SCRIPT_DIR"
    else
        printf 'No node_modules directory to remove.\n'
    fi
    printf '\nDone. pi-web uninstalled. Source files are kept; run "install" to reinstall.\n'
}

cmd_status() {
    hdr "pi-web extension status"
    printf 'extension dir: %s\n' "$SCRIPT_DIR"

    if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
        local dep_count
        dep_count="$(find "$SCRIPT_DIR/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
        printf 'node_modules:  present (%s top-level packages)\n' "$dep_count"
    else
        printf 'node_modules:  missing (run "./pi-web.sh install")\n'
    fi

    local user_cfg="$HOME/.pi/agent/settings.json"
    local proj_cfg="$PWD/.pi/settings.json"
    local user_state proj_state
    user_state="$(registration_state "$user_cfg" "$SCRIPT_DIR")"
    proj_state="$(registration_state "$proj_cfg" "$SCRIPT_DIR")"
    printf 'registered:    '
    if [[ "$user_state" == "registered" || "$proj_state" == "registered" ]]; then
        [[ "$user_state" == "registered" ]] && printf 'user-settings'
        if [[ "$proj_state" == "registered" ]]; then
            [[ "$user_state" == "registered" ]] && printf ', '
            printf 'project-settings'
        fi
    else
        printf 'no (run "./pi-web.sh install")'
    fi
    printf '\n'

    printf 'pi:            %s\n' "$(pi --version 2>/dev/null || echo unknown)"
    printf 'node:          %s\n' "$(node --version)"
    printf 'npm:           %s\n' "$(npm --version)"
}

cmd_check() {
    hdr "Type-check (tsc --noEmit)"
    npm_in_dir run check
    hdr "Unit tests (offline)"
    npm_in_dir test
    printf '\nAll checks passed.\n'
}

main() {
    local subcommand="${1:-}"
    if [[ -z "$subcommand" ]]; then
        usage >&2
        exit 2
    fi
    # Drop the subcommand; -h/--help are accepted in its place too.
    if [[ "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
        usage
        exit 0
    fi
    shift

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -l|--local) pi_scope_flag="-l"; shift ;;
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
