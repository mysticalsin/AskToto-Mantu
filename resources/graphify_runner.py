#!/usr/bin/env python3
"""
AskToto ↔ graphify bridge.

Runs graphify's full pipeline over AskToto's markdown notes and writes a knowledge graph
(graph.json + graph.html) to an output directory. AskToto spawns this with the resolved Python
interpreter (the one that can `import graphify`), passing the notes folder, output dir, and backend.

The whole pipeline runs here in Python — detect → extract (LLM) → build → cluster → export — so the
Electron side only shells out once and reads graph.json. The extraction backend reuses what the user
already has: `claude-cli` (local Claude Code, no key — default), or `claude`/`openai` with a key passed
via the GRAPHIFY_API_KEY env var (never on argv, so it can't leak into the process list).

Output (stdout, last line): a single JSON object the Electron side parses, e.g.
  {"ok": true, "nodes": 42, "edges": 91, "communities": 7, "graph": "...", "html": "..."}
  {"ok": false, "error": "graphify import failed: ..."}
"""
import argparse
import json
import os
import sys
from pathlib import Path


def emit(obj: dict) -> None:
    """Write the single machine-readable result line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def files_from_detect(det: dict, key: str = "files") -> list:
    return [Path(f) for cat in (det.get(key) or {}).values() for f in cat]


def main() -> int:
    ap = argparse.ArgumentParser(prog="graphify_runner")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build (or incrementally update) the notes graph")
    b.add_argument("--input", required=True, help="notes folder to scan")
    b.add_argument("--out", required=True, help="output dir for graph.json / graph.html")
    b.add_argument("--backend", default="claude-cli", help="claude-cli | claude | openai | kimi | gemini")
    b.add_argument("--model", default=None)
    b.add_argument("--incremental", action="store_true", help="only re-extract changed notes, merge")
    b.add_argument("--obsidian", action="store_true", help="also write an Obsidian vault")

    # `check` — used by AskToto to confirm graphify is importable and report its version.
    sub.add_parser("check", help="report graphify availability + version")

    args = ap.parse_args()

    try:
        import graphify  # noqa: F401
        from graphify.detect import detect, detect_incremental, save_manifest
        from graphify.build import build_from_json, build_merge
        from graphify.cluster import cluster
        from graphify.export import to_json, to_html, to_obsidian
        from graphify.llm import extract_corpus_parallel
    except Exception as e:  # noqa: BLE001 — any import error means graphify isn't usable
        emit({"ok": False, "error": f"graphify import failed: {e}"})
        return 1

    if args.cmd == "check":
        emit({"ok": True, "version": getattr(graphify, "__version__", "unknown")})
        return 0

    inp = Path(args.input)
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    graph_path = outdir / "graph.json"
    api_key = os.environ.get("GRAPHIFY_API_KEY") or None

    if not inp.is_dir():
        emit({"ok": False, "error": f"notes folder not found: {inp}"})
        return 1

    # graphify keeps its manifest + cache under the cwd's graphify-out/. Run from the output dir so
    # those artifacts stay in AskToto's app data, never in the user's (OneDrive-synced) notes folder.
    os.chdir(outdir)

    incremental = args.incremental and graph_path.exists()
    if incremental:
        det = detect_incremental(inp)
        files = files_from_detect(det, "new_files") or files_from_detect(det, "files")
        if not files:
            emit({"ok": True, "unchanged": True, "nodes": 0, "edges": 0, "communities": 0})
            return 0
    else:
        det = detect(inp)
        files = files_from_detect(det)
        if not files:
            emit({"ok": False, "error": "No notes found to graph yet."})
            return 1

    try:
        extraction = extract_corpus_parallel(
            files, backend=args.backend, api_key=api_key, model=args.model, root=inp
        )
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"extraction failed ({args.backend}): {e}"})
        return 1

    if incremental:
        G = build_merge([extraction], graph_path=str(graph_path))
    else:
        G = build_from_json(extraction)

    if G.number_of_nodes() == 0:
        emit({"ok": False, "error": "extraction produced no nodes"})
        return 1

    communities = cluster(G)
    to_json(G, communities, str(graph_path), force=True)
    to_html(G, communities, str(outdir / "graph.html"))
    if args.obsidian:
        to_obsidian(G, communities, str(outdir / "obsidian"))

    # Persist the manifest so the next --incremental run diffs against this state.
    try:
        save_manifest(det.get("all_files") or det.get("files") or {})
    except Exception:  # noqa: BLE001 — manifest is an optimization, never fatal
        pass

    emit({
        "ok": True,
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "graph": str(graph_path),
        "html": str(outdir / "graph.html"),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
