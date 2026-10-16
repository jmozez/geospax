#!/usr/bin/env python3
"""The tool side of the example plugin (plugins/example-python).

GeoSpaX runs `python3 tools.py <tool-id>` and writes a request like

    {"plugin": "example-python", "tool": "layer-report",
     "params": {"layer": "field_samples.geojson", "field": "land_use"},
     "layers": ["field_samples.geojson", ...], "workdir": "/tmp/geospax-plugin-work"}

on stdin. Whatever this prints on stdout must be JSON; the engine shows it in the
Plugins pane and in the run log. A non-zero exit turns stderr into the error message.

Same contract for any language: `run:` in plugin.yaml is the whole command, so a Rust
binary, an R script (`Rscript ${plugin}/tools.R ${tool}`) or a WASI module
(`wasmtime run --dir ${workdir} ${plugin}/tools.wasm -- ${tool}`) work the same way.
"""
import json
import sys


def layer_report(req):
    layer = req["params"].get("layer") or (req.get("layers") or [None])[0]
    field = req["params"].get("field")
    if not layer:
        return {"ok": False, "error": "no layer given and no layers are loaded"}
    # A real plugin would read the layer through GeoSpaX (see docs/PLUGINS.md §5);
    # this one reports what it was given, so the round trip is easy to check.
    return {
        "ok": True,
        "message": f"report for {layer}" + (f" by {field}" if field else ""),
        "layer": layer,
        "field": field,
        "layers_seen": len(req.get("layers") or []),
        "suggestion": "count values with a real reader by calling back into the engine",
    }


def point_grid(req):
    params = req["params"]
    size = float(params.get("size") or 500)
    shape = params.get("shape") or "hex"
    if shape not in ("hex", "square"):
        return {"ok": False, "error": f"unknown shape {shape!r} (use hex or square)"}
    layer = params.get("layer") or (req.get("layers") or [None])[0]
    return {
        "ok": True,
        "message": f"{shape} grid of {size:g} m over {layer}",
        "cells": 0 if not layer else max(1, int(1_000_000 / max(size, 1) ** 2 * 3_000)),
        "output": f"{req.get('workdir', '/tmp')}/{layer or 'grid'}-{shape}-{size:g}m.geojson",
    }


TOOLS = {"layer-report": layer_report, "point-grid": point_grid}


def main():
    tool = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"bad request JSON: {e}"}))
        return 1
    fn = TOOLS.get(tool)
    if not fn:
        print(json.dumps({"ok": False, "error": f"unknown tool {tool!r}", "tools": sorted(TOOLS)}))
        return 2
    print(json.dumps(fn(req)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
