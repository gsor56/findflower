#!/usr/bin/env bash
set -Eeuo pipefail

# Credentials are supplied by the Studio environment and are never printed.
: "${HF_TOKEN:?HF_TOKEN must be set in the environment}"
: "${FIND10K_SHARD_INDEX:?FIND10K_SHARD_INDEX must be set in the environment}"

if [[ ! "$FIND10K_SHARD_INDEX" =~ ^[0-9]+$ ]]; then
  printf '%s\n' "FIND10K_SHARD_INDEX must be a non-negative integer" >&2
  exit 2
fi

FIND10K_TOTAL_SHARDS="${FIND10K_TOTAL_SHARDS:-5}"
if [[ ! "$FIND10K_TOTAL_SHARDS" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' "FIND10K_TOTAL_SHARDS must be a positive integer" >&2
  exit 2
fi
if (( FIND10K_SHARD_INDEX >= FIND10K_TOTAL_SHARDS )); then
  printf '%s\n' "FIND10K_SHARD_INDEX must be less than FIND10K_TOTAL_SHARDS" >&2
  exit 2
fi

SCRIPT_ROOT="${FINDFLOWER_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNNER="${SCRIPT_ROOT}/training/find10k_federation_runner.py"
if [[ ! -f "$RUNNER" ]]; then
  printf 'Runner not found: %s\n' "$RUNNER" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "python3 is required but was not found on PATH" >&2
  exit 1
fi

export HF_TOKEN FIND10K_SHARD_INDEX FIND10K_TOTAL_SHARDS
exec python3 "$RUNNER" \
  --shard-index "$FIND10K_SHARD_INDEX" \
  --total-shards "$FIND10K_TOTAL_SHARDS"
