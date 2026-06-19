#!/usr/bin/env python3
"""
curate_server.py
----------------
Local dev server for Webtakt that ALSO lets you edit the curated sample list
(samples/curated.json) from the running app — the "curator" workflow.

Normally the site is served by a plain static server (`python3 -m http.server
8000`) and the Curated tab in the sample browser is read-only: a browser can't
write to disk. Run THIS server instead and the ★ ADD / ✕ REMOVE buttons in the
ARCHIVE tab post to it, and it writes samples/curated.json directly. Commit the
file and the addition is live for everyone online.

This is the safety mechanic: anyone can browse + load, but only someone running
their own curate server (i.e. you, locally) can change the shipped list.

Endpoints (added on top of normal static file serving):
  GET  /curate/status        → {"curator": true}   (lets the app detect us)
  POST /curate/add    {entry} → append entry to curated.json (dedupe by url)
  POST /curate/remove {url}   → remove the entry with that url

Run from the project root:
    python3 tools/curate_server.py            # serves on :8000
    python3 tools/curate_server.py 8080       # custom port

Bound to 127.0.0.1 only — not reachable from other machines.
"""

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Project root = parent of tools/. Serve from here so paths match the static
# server (index.html at root, samples/ under it).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURATED_PATH = os.path.join(ROOT, "samples", "curated.json")

ALLOWED_CATEGORIES = None  # free-form; the app guesses a category but any string is fine


def _load_manifest():
    """Read curated.json, tolerating the bare-array legacy shape."""
    try:
        with open(CURATED_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": 1, "items": []}
    if isinstance(data, list):
        return {"version": 1, "items": data}
    data.setdefault("version", 1)
    data.setdefault("items", [])
    return data


def _save_manifest(manifest):
    """Write curated.json pretty-printed (stable, diff-friendly, UTF-8)."""
    os.makedirs(os.path.dirname(CURATED_PATH), exist_ok=True)
    with open(CURATED_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _clean_entry(raw):
    """Normalise a posted entry; require a url + name."""
    url = (raw.get("url") or "").strip()
    name = (raw.get("name") or "").strip()
    if not url or not name:
        return None
    return {
        "name": name,
        "category": (raw.get("category") or "misc").strip(),
        "url": url,
        "source": (raw.get("source") or "").strip(),
        "license": (raw.get("license") or "Public Domain (archive.org)").strip(),
    }


class CurateHandler(SimpleHTTPRequestHandler):
    # Serve everything relative to the project root regardless of CWD.
    def translate_path(self, path):
        rel = SimpleHTTPRequestHandler.translate_path(self, path)
        # SimpleHTTPRequestHandler resolves against os.getcwd(); rebase onto ROOT.
        return os.path.join(ROOT, os.path.relpath(rel, os.getcwd()))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Same-origin app, but be explicit so a localhost:8000 page can read it.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self):
        if self.path.rstrip("/") == "/curate/status":
            self._send_json({"curator": True})
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        route = self.path.rstrip("/")
        if route == "/curate/add":
            return self._handle_add()
        if route == "/curate/remove":
            return self._handle_remove()
        self._send_json({"error": "unknown endpoint"}, status=404)

    def _handle_add(self):
        payload = self._read_json_body()
        if payload is None:
            return self._send_json({"error": "bad JSON"}, status=400)
        entry = _clean_entry(payload)
        if not entry:
            return self._send_json({"error": "entry needs name + url"}, status=400)

        manifest = _load_manifest()
        items = manifest["items"]
        if any(e.get("url") == entry["url"] for e in items):
            return self._send_json({"ok": True, "duplicate": True, "count": len(items)})
        items.append(entry)
        _save_manifest(manifest)
        print(f"  + curated: {entry['name']}  ({entry['category']})  [{len(items)} total]")
        return self._send_json({"ok": True, "count": len(items)})

    def _handle_remove(self):
        payload = self._read_json_body()
        if payload is None:
            return self._send_json({"error": "bad JSON"}, status=400)
        url = (payload.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "missing url"}, status=400)

        manifest = _load_manifest()
        before = len(manifest["items"])
        manifest["items"] = [e for e in manifest["items"] if e.get("url") != url]
        removed = before - len(manifest["items"])
        if removed:
            _save_manifest(manifest)
            print(f"  - curated: removed 1  [{len(manifest['items'])} total]")
        return self._send_json({"ok": True, "removed": removed, "count": len(manifest["items"])})

    # Quieter logging — one line per curate action is enough; keep request log too.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", port), CurateHandler)
    print(f"Webtakt curate server → http://127.0.0.1:{port}")
    print(f"  editing {CURATED_PATH}")
    print("  ★ ADD / ✕ REMOVE in the sample browser now write this file.")
    print("  Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
