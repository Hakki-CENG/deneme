"""
Minimal OpenAI-compatible /embeddings endpoint backed by a real sentence
transformer.

Why this exists: every claim in the codebase about what the retrieval pipeline
scores "with a real encoder" (0.317 -> 0.400) was written from a run nobody
could reproduce. The recall gate reads EMBEDDINGS_URL and otherwise falls back
to a deterministic hash encoder that is explicitly not semantic, so the gate
fails from inside and the honest conclusion — "the encoder is the limit, not the
retrieval logic" — stayed unverifiable.

This makes it verifiable without a paid API key:

    python3 packages/eval/tools/local-embeddings-server.py &
    EMBEDDINGS_URL=http://127.0.0.1:8099/v1/embeddings npm run eval:recall -w @haf/eval

Model: all-MiniLM-L6-v2 (384-dim, ~90MB). Small enough to run on CPU in this
sandbox, and a genuine sentence transformer rather than a bag of hashes.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
PORT = int(os.environ.get("EMBED_PORT", "8099"))

print(f"loading {MODEL_NAME} ...", flush=True)
MODEL = SentenceTransformer(MODEL_NAME)
print(f"loaded. dim={MODEL.get_sentence_embedding_dimension()}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the eval output readable
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")

        text = payload.get("input", [])
        if isinstance(text, str):
            text = [text]

        vectors = MODEL.encode(text, normalize_embeddings=True)
        body = json.dumps(
            {
                "object": "list",
                "model": MODEL_NAME,
                "data": [
                    {"object": "embedding", "index": i, "embedding": v.tolist()}
                    for i, v in enumerate(vectors)
                ],
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            }
        ).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok", "model": MODEL_NAME}).encode())


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"listening on http://0.0.0.0:{PORT}/v1/embeddings", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
