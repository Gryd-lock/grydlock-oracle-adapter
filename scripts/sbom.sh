#!/usr/bin/env bash
#
# Generate a CycloneDX Software Bill of Materials (SBOM) for this project.
#
# Output is written to `sbom/bom.json` (CycloneDX 1.6, JSON) by default, or to
# the path given as the first argument.
#
# Usage:
#   ./scripts/sbom.sh [output-file]
#
# The generated SBOM is intended to be uploaded as a CI build artifact and to
# feed downstream vulnerability / license gating.
set -euo pipefail

# Resolve the repository root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

OUTPUT_FILE="${1:-sbom/bom.json}"
mkdir -p "$(dirname "${OUTPUT_FILE}")"

echo "Generating CycloneDX SBOM -> ${OUTPUT_FILE}"
node node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js \
  --output-file "${OUTPUT_FILE}" \
  --output-format JSON \
  --spec-version 1.6 \
  --mc-type library \
  --validate

echo "SBOM written: ${OUTPUT_FILE}"
