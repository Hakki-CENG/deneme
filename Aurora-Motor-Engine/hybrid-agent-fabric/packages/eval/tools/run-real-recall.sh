#!/usr/bin/env bash
#
# Runs the FAZ 11 acceptance criterion against a real encoder.
#
# `npm run eval:recall` falls back to a deterministic hash encoder that is
# explicitly not semantic, so it fails from inside and prints "the encoder is
# the limit, not the retrieval logic". That conclusion was unverifiable until
# this script existed: it starts a real MiniLM encoder on CPU, points the gate
# at it, and shuts it down again.
#
#   npm run eval:recall:real -w @haf/eval
#
# Requires: pip install sentence-transformers  (~90MB model, downloaded once)

set -euo pipefail

PORT="${EMBED_PORT:-8099}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_LOG="$(mktemp)"

if ! python3 -c "import sentence_transformers" 2>/dev/null; then
  echo "sentence-transformers is not installed. Run:" >&2
  echo "  pip install sentence-transformers" >&2
  exit 1
fi

python3 "${HERE}/local-embeddings-server.py" >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# Always stop the encoder, including on failure — a stray process holding the
# port makes the next run fail for an unrelated reason.
cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
  rm -f "${SERVER_LOG}"
}
trap cleanup EXIT

# Poll instead of sleeping: model load time varies with cache state, and a
# fixed sleep is either too short on a cold cache or wasted on a warm one.
echo "starting encoder on port ${PORT}..."
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "encoder failed to start:" >&2
    cat "${SERVER_LOG}" >&2
    exit 1
  fi
  sleep 1
done

EMBEDDINGS_URL="http://127.0.0.1:${PORT}/v1/embeddings" \
  npx tsx "${HERE}/../src/runner/recall-gate-cli.ts" "$@"
