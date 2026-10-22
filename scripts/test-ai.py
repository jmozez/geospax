#!/usr/bin/env python3
"""The assistant and the MCP server, end to end, with no real model.

A scripted model server speaks Ollama (/api/chat), the OpenAI chat API (/v1/chat/completions) and the
Claude Messages API (/v1/messages). Each "model" calls list_layers, then query_features and
select_features on the survey layer, then answers with the count it was given, so the test checks
that GeoSpaX ran the tools on the real data and fed the results back in each provider's format
(for Claude: the API key and version headers, the assistant content sent back unchanged with its
thinking block, all tool results in one user message).

Then `geospax-server mcp` is driven over stdio like an MCP client would.

usage: test-ai.py BIN DATA_DIR   (DATA_DIR from scripts/test-edit-data.py)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIN, DATA = sys.argv[1], sys.argv[2]
WHERE = "elevation_m > 2000"
passed, failed = 0, []


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}" + (f" ({extra})" if extra else ""))
    else:
        failed.append(name)
        print(f"  FAIL {name}" + (f" ({extra})" if extra else ""))


# ---------------------------------------------------------------- scripted model
seen = {"anthropic_headers": None, "anthropic_echo": None, "anthropic_results_in_one": None, "openai_auth": None}


def script(tool_outputs):
    """What the model does next, given the tool results so far: (tool, args) or ('answer', text)."""
    n = len(tool_outputs)
    if n == 0:
        return "list_layers", {}
    if n == 1:
        layers = json.loads(tool_outputs[0])["layers"]
        survey = next(l for l in layers if any(f.startswith("elevation_m") for f in l["fields"] or []))
        script.layer = survey["id"]
        return "query_features", {"layer": survey["id"], "where": WHERE, "limit": 3}
    if n == 2:
        return "select_features", {"layer": script.layer, "where": WHERE}
    total = json.loads(tool_outputs[1])["total"]
    sel = json.loads(tool_outputs[2])["selected"]
    return "answer", f"{total} sites are above 2000 m; {sel} selected."


class Model(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/api/tags":
            return self.reply({"models": [{"name": "llama3.2:latest"}, {"name": "qwen2.5:7b"}]})
        if self.path == "/v1/models":
            return self.reply({"data": [{"id": "local-model"}]})
        self.reply({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        msgs = body["messages"]
        if self.path == "/api/chat":  # Ollama: arguments are objects, tool results by name
            outs = [m["content"] for m in msgs if m["role"] == "tool"]
            step = script(outs)
            if step[0] == "answer":
                return self.reply({"message": {"role": "assistant", "content": step[1]}, "done": True})
            return self.reply({"message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": step[0], "arguments": step[1]}}]}})
        if self.path == "/v1/chat/completions":  # OpenAI: arguments are strings, results by tool_call_id
            seen["openai_auth"] = self.headers.get("Authorization")
            outs = [m["content"] for m in msgs if m["role"] == "tool"]
            ids_ok = all(m.get("tool_call_id", "").startswith("call_") for m in msgs if m["role"] == "tool")
            if not ids_ok:
                return self.reply({"error": {"message": "tool message without its tool_call_id"}}, 400)
            step = script(outs)
            if step[0] == "answer":
                return self.reply({"choices": [{"message": {"role": "assistant", "content": step[1]}, "finish_reason": "stop"}]})
            call = {"id": f"call_{len(outs)}", "type": "function", "function": {"name": step[0], "arguments": json.dumps(step[1])}}
            return self.reply({"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": "tool_calls"}]})
        if self.path == "/v1/messages":  # Claude
            seen["anthropic_headers"] = (self.headers.get("x-api-key"), self.headers.get("anthropic-version"), self.headers.get("anthropic-beta"), body.get("fallbacks"), "temperature" in body)
            outs = []
            for i, m in enumerate(msgs):
                if m["role"] == "user" and isinstance(m["content"], list):
                    res = [b for b in m["content"] if b.get("type") == "tool_result"]
                    seen["anthropic_results_in_one"] = len(res) == len([b for b in msgs[i - 1]["content"] if b.get("type") == "tool_use"])
                    outs += [b["content"] for b in res]
                if m["role"] == "assistant" and isinstance(m["content"], list):
                    seen["anthropic_echo"] = m["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig-xyz"}
            step = script(outs)
            if step[0] == "answer":
                return self.reply({"type": "message", "role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": step[1]}]})
            return self.reply({"type": "message", "role": "assistant", "stop_reason": "tool_use", "content": [
                {"type": "thinking", "thinking": "", "signature": "sig-xyz"},
                {"type": "tool_use", "id": f"toolu_{len(outs)}", "name": step[0], "input": step[1]},
            ]})
        self.reply({"error": "not found"}, 404)


model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
MODEL = f"http://127.0.0.1:{model.server_address[1]}"

# ---------------------------------------------------------------- GeoSpaX
state = tempfile.mkdtemp(prefix="gx-ai-")
PORT = 18093
srv = subprocess.Popen([BIN, "--data", DATA, "--state-dir", state, "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(state, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


try:
    for _ in range(60):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    # the truth, straight from the engine
    _, layers = call("GET", "api/layers")
    survey = next(l for l in layers["layers"] if any(f["name"] == "elevation_m" for f in l["fields"]))
    _, t = call("POST", f"api/layers/{survey['id']}/table", {"where": WHERE, "limit": 1})
    want = t["total"]

    print("settings")
    s, r = call("GET", "api/ai/settings")
    check("default is Ollama on this computer, no key", s == 200 and r["provider"] == "ollama" and not r["has_key"] and "list_layers" in r["tools"])
    s, r = call("PUT", "api/ai/settings", {"provider": "nope"})
    check("an unknown provider is refused", s == 400)

    for provider, model_name, key in [("ollama", "llama3.2:latest", ""), ("openai", "local-model", "sk-local"), ("anthropic", "claude-opus-5-5", "sk-test")]:
        print(provider)
        s, r = call("PUT", "api/ai/settings", {"provider": provider, "url": MODEL, "model": model_name, "key": key})
        check("settings saved, key never echoed", s == 200 and "key" not in r and r["has_key"] == bool(key))
        if provider != "anthropic":
            s, m = call("GET", "api/ai/models")
            check("models listed from the server", model_name in m["models"], ", ".join(m["models"]))
        s, r = call("POST", "api/ask", {"question": "How many survey sites are above 2000 m? Select them.", "history": []})
        check("answer uses the real count", s == 200 and r["answer"].startswith(f"{want} sites") and f"{want} selected" in r["answer"], r.get("answer") or r.get("error"))
        check("three tools ran", [x["tool"] for x in r.get("steps", [])] == ["list_layers", "query_features", "select_features"] and all(x["ok"] for x in r["steps"]))
        sel = [a for a in r.get("actions", []) if a["kind"] == "select"]
        check("a selection for the map", len(sel) == 1 and len(sel[0]["fids"]) == want and sel[0]["layer"] == survey["id"])
    k, ver, beta, fb, temp = seen["anthropic_headers"]
    check("Claude: key and API version headers", k == "sk-test" and ver == "2026-10-21")
    check("Claude: server-side fallback on, no sampling params", beta == "server-side-fallback-2026-07-01" and fb == "default" and not temp)
    check("Claude: assistant content sent back unchanged (thinking block)", seen["anthropic_echo"] is True)
    check("Claude: all tool results of a turn in one message", seen["anthropic_results_in_one"] is True)
    check("OpenAI-compatible: bearer key sent", seen["openai_auth"] == "Bearer sk-local")
    s, r = call("POST", "api/ask", {"question": ""})
    check("an empty question is refused", s == 502 and "question" in r["error"])
    call("PUT", "api/ai/settings", {"provider": "ollama", "url": "http://127.0.0.1:9", "model": "x"})
    s, r = call("POST", "api/ask", {"question": "hello"})
    check("Ollama not running says so", s == 502 and "Ollama is not running" in r["error"], r.get("error", "")[:80])
    st = os.stat(os.path.join(state, "ai.json")).st_mode & 0o777
    check("the settings file is private (0600)", st == 0o600, oct(st))
finally:
    srv.terminate()
    srv.wait()

# ---------------------------------------------------------------- MCP
print("mcp")
p = subprocess.Popen([BIN, "mcp", "--data", DATA, "--state-dir", state], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def rpc(msg):
    p.stdin.write(json.dumps(msg) + "\n")
    p.stdin.flush()
    if "id" not in msg:
        return None
    return json.loads(p.stdout.readline())


r = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}})
check("initialize", r["result"]["serverInfo"]["name"] == "geospax" and "tools" in r["result"]["capabilities"] and r["result"]["protocolVersion"] == "2025-06-18")
rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
r = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
names = [t["name"] for t in r["result"]["tools"]]
check("tools listed with schemas (no map-only tools)", "query_features" in names and "zoom_to_layer" not in names and all(t["inputSchema"]["type"] == "object" for t in r["result"]["tools"]), ", ".join(names))
r = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "query_features", "arguments": {"layer": survey["id"], "where": WHERE, "limit": 2}}})
res = r["result"]
check("tools/call returns the data", not res["isError"] and res["structuredContent"]["total"] == want and len(res["structuredContent"]["rows"]) == 2)
r = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "describe_field", "arguments": {"layer": survey["id"], "field": "elevation_m"}}})
summ = r["result"]["structuredContent"]["summary"]
check("describe_field gives statistics", not r["result"]["isError"] and "min" in json.dumps(summ), json.dumps(summ)[:80])
r = rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "query_features", "arguments": {"layer": "nope"}}})
check("a tool error is a result with isError", r["result"]["isError"] and "no layer" in r["result"]["content"][0]["text"])
r = rpc({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "zoom_to_layer", "arguments": {"layer": survey["id"]}}})
check("map-only tools are not callable", "error" in r and r["error"]["code"] == -32602)
r = rpc({"jsonrpc": "2.0", "id": 7, "method": "nope"})
check("unknown method", r["error"]["code"] == -32601)
p.stdin.write("not json\n")
p.stdin.flush()
r = json.loads(p.stdout.readline())
check("a parse error is answered", r["error"]["code"] == -32700 and r["id"] is None)
r = rpc({"jsonrpc": "2.0", "id": 8, "method": "ping"})
check("ping", r["result"] == {})
p.stdin.close()
check("exits when the client goes away", p.wait(timeout=10) == 0)
shutil.rmtree(state, ignore_errors=True)
model.shutdown()

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
