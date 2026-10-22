# AI in GeoSpaX

GeoSpaX's AI features are optional and run where you choose. Nothing is sent anywhere until you pick a
model, and with Ollama nothing leaves your computer.

| Feature | What it does | Where it runs |
| --- | --- | --- |
| **Ask** (right pane) | Answers questions about your data in plain words, selects features, starts recipes | Ollama on this computer, any OpenAI-compatible server, or Claude with your API key |
| **MCP server** (`geospax-server mcp`) | Gives AI assistants (Claude Desktop, Claude Code, editors) GeoSpaX's tools | On this computer; the assistant you connect decides where its model runs |

Satellite embeddings (AlphaEarth) and object detection and segmentation (ONNX models) are next on the
roadmap.

## 1. Ask

Open **Analysis › Ask**, the **Ask** tab of the right pane, or right-click a layer › *Ask about this
layer…*. Type a question, for example:

- *What layers do I have, and what is in them?*
- *How many survey sites are above 2000 m? Select them.*
- *Which reserve is the largest? Zoom to the reserves.*
- *Make hot spots of the incidents.* (runs the recipe)

The assistant does not guess. It looks at your data through the same tools the app uses and gives
figures only from what those tools return. Under each answer, *Looked at the data N times* lists every
tool it called, with the layer and the filter. Selections and zooms it asks for happen on the map, and
selected features show in the attribute table.

### Its tools

| Tool | What it does |
| --- | --- |
| `list_layers` | Layers (id, geometry, feature count, fields and types, definition query) and rasters |
| `describe_field` | Min, max, mean and quantiles of a number field; the most frequent values of a text field |
| `query_features` | Up to 50 attribute rows, filtered with a SQL `WHERE` clause and sorted, plus the total count |
| `select_features` | Selects features with a `WHERE` clause (highlighted on the map) |
| `zoom_to_layer` | Zooms the map (Ask only) |
| `list_recipes`, `run_recipe`, `get_run` | Lists the workflows, starts one, follows it |

Recipes that run Python or R code are never started by the assistant. Start those yourself from the
Automate pane.

### Choosing the model

Click **Model…** in the Ask pane, or **Analysis › Model…**.

| Choice | Set up | Privacy |
| --- | --- | --- |
| **Ollama (on this computer)**, the default | Install from [ollama.com](https://ollama.com), then `ollama pull llama3.2` (or `qwen2.5`, `llama3.1`, or any model that supports tools). Address: `http://127.0.0.1:11434`. | Nothing leaves this computer. |
| **OpenAI-compatible server** | LM Studio (`http://127.0.0.1:1234`), llama.cpp server, vLLM, or a cloud provider that speaks `/v1/chat/completions`. An API key only if the server needs one. | A local server keeps everything local. A cloud server receives your question and what the tools return. |
| **Claude (your API key)** | A key from [console.anthropic.com](https://console.anthropic.com). Model `claude-opus-5-5` (default and most capable), `claude-sonnet-5-5` (faster), or `claude-haiku-5-5` (cheapest). | Your question and what the tools return (layer names, field values) are sent to Anthropic. |

**Save and list models** asks the server which models it has. The key is stored in `ai.json` in the
GeoSpaX state folder, readable only by your user account. It is never sent back to the browser. Tick
*Forget the saved key* to remove it.

Small local models answer simple questions well. For long multi-step questions, use a larger model
(`qwen2.5:14b`, `llama3.1:70b`) or Claude. With Claude on the Opus 5.5, Fable 5.1, or Sonnet 5.5
models, a request Claude declines is retried on another Claude model, and you are told if it was
still declined.

### API

| Route | |
| --- | --- |
| `GET /api/ai/settings` | `{provider, url, model, has_key, tools}`; the key itself is never returned |
| `PUT /api/ai/settings` | `{provider: "ollama"\|"openai"\|"anthropic", url, model, key?}`; omit `key` to keep it, `""` to remove it |
| `GET /api/ai/models` | The models the configured server offers: `{models, error}` |
| `POST /api/ask` | `{question, history: [{role, text}]}` → `{answer, steps: [{tool, args, ok, error?}], actions: [{kind: "select"\|"zoom"\|"run", …}]}`; 502 with `error` when the model server fails |

## 2. MCP server

`geospax-server mcp` serves GeoSpaX's tools to any [Model Context Protocol](https://modelcontextprotocol.io)
client over stdio. These are the tools above except `zoom_to_layer`, which needs the app. It opens your
data folders like the app does, but without the web server, device watching or triggers. Only MCP
messages go to stdout; notes go to stderr.

**Claude Code**

```sh
claude mcp add geospax -- geospax-server mcp --data ~/GIS
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "geospax": {
      "command": "geospax-server",
      "args": ["mcp", "--data", "/home/me/GIS"]
    }
  }
}
```

On Windows, use the full path, e.g. `"C:\\Program Files\\GeoSpaX\\geospax-server.exe"`, and a Windows
data path.

Options: `--data DIR` (repeatable), `--state-dir DIR` (default `<first data folder>/.geospax`, shared with
the app, so recipes and runs are the same), `--recipes DIR`, `--threads N`.

Tool errors come back as results with `isError: true`, so the assistant can correct its request (a wrong
field name, for example). Results longer than 12,000 characters are cut, and the cut is marked.

## 3. Safety

- Every tool is a call to GeoSpaX's own API. The assistant can do nothing that you could not do in the
  app, and nothing that runs code.
- Field values can contain text that tries to steer the assistant. That text can at most make it call
  the same read-only tools or start a non-code recipe, whose results go only into the runs folder.
- Beyond `localhost`, the web edition's API needs its access token (README › Security), so another
  device cannot use your key.
