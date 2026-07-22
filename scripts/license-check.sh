#!/usr/bin/env bash
#
# Enforce the project's license allowlist / denylist.
#
# Reads the resolved dependency tree and fails (exit 1) if any installed
# package uses a license that is NOT in the allowlist, or IS in the denylist.
#
# Configuration (environment variables):
#   LICENSE_ALLOWLIST  Space-separated SPDX ids that are permitted.
#                      Default: MIT Apache-2.0 ISC BSD-2-Clause BSD-3-Clause
#                              0BSD Unlicense CC0-1.0 BlueOak-1.0.0 Python-2.0
#                              WTFPL CC-BY-4.0 ISC
#   LICENSE_DENYLIST   Space-separated SPDX ids that are forbidden.
#                      Default: AGPL-3.0 GPL-3.0 LGPL-3.0 GPL-2.0 LGPL-2.1
#                              CC-BY-NC-4.0
#
# Usage:
#   ./scripts/license-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ALLOWLIST="${LICENSE_ALLOWLIST:-MIT Apache-2.0 ISC BSD-2-Clause BSD-3-Clause 0BSD Unlicense CC0-1.0 BlueOak-1.0.0 Python-2.0 WTFPL CC-BY-4.0}"
DENYLIST="${LICENSE_DENYLIST:-AGPL-3.0 GPL-3.0 LGPL-3.0 GPL-2.0 LGPL-2.1 CC-BY-NC-4.0}"

# The root project package is governed by this repo's own LICENSE file and is
# exempt from the dependency allowlist/denylist check (npm ls reports the root
# as UNLICENSED when "private": true is set — that is a known npm quirk, not a
# real license violation).
ROOT_NAME="$(node -p "require('./package.json').name" 2>/dev/null || echo "")"

echo "Resolving dependency licenses..."
# license-checker-rseidelsohn emits one JSON object per package.
mapfile -t LICENSES < <(npx --no-install license-checker-rseidelsohn --production --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);const seen=new Set();for(const p of Object.keys(j)){if('$ROOT_NAME'&&p.startsWith('$ROOT_NAME@'))continue;const l=j[p].licenses;if(l){l.split(/OR|AND|\//).forEach(x=>{const t=x.trim();if(t)seen.add(t);});}}console.log([...seen].join('\n'));}catch(e){}});" \
  || true)

# Fallback: parse raw `npm ls` licenses if the checker is unavailable.
if [ "${#LICENSES[@]}" -eq 0 ]; then
  echo "license-checker unavailable; falling back to npm ls" >&2
  mapfile -t LICENSES < <(npm ls --all --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);const seen=new Set();const walk=(n)=>{if(!n)return;for(const k of Object.keys(n)){const p=n[k];if(p&&p.license){String(p.license).split(/OR|AND|\//).forEach(x=>{const t=x.trim();if(t)seen.add(t);});}if(p&&p.dependencies)walk(p.dependencies);}};if(j.dependencies)walk(j.dependencies);console.log([...seen].join('\n'));}catch(e){}});" || true)
fi

echo "Detected licenses:"
printf '  - %s\n' "${LICENSES[@]:-<none>}"

ALLOWED=0
for lic in "${LICENSES[@]:-}"; do
  [ -z "${lic}" ] && continue
  # Unquoted on purpose: ALLOWLIST/DENYLIST are space-separated lists, and
  # word-splitting them here is what turns "MIT Apache-2.0 ..." into one
  # entry per line for grep -x (exact whole-line match) below. Quoting them
  # (as this used to do) fed grep -x the entire list as a single line,
  # which could never exactly match a single license id — every license,
  # including ones already in the default allowlist, was misreported as
  # "UNKNOWN (not in allowlist)".
  # shellcheck disable=SC2086
  if printf '%s\n' ${DENYLIST} | grep -qx "${lic}"; then
    echo "DENIED license detected: ${lic}" >&2
    ALLOWED=1
  fi
  # shellcheck disable=SC2086
  if ! printf '%s\n' ${ALLOWLIST} | grep -qx "${lic}"; then
    echo "UNKNOWN (not in allowlist) license detected: ${lic}" >&2
    ALLOWED=1
  fi
done

if [ "${ALLOWED}" -ne 0 ]; then
  echo "License check FAILED. See https://github.com/Gryd-lock/grydlock-oracle-adapter/blob/main/CONTRIBUTING.md#handling-a-flagged-dependency" >&2
  exit 1
fi

echo "License check passed."
