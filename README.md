# Archestack MCP server

[![npm](https://img.shields.io/npm/v/%40archestack%2Fmcp?label=npm)](https://www.npmjs.com/package/@archestack/mcp) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/archestack/mcp/blob/main/LICENSE)

Ask your assistant about open-source AI projects and get answers from the [Archestack](https://archestack.com/) rankings: scores, GitHub facts, reviews and open-source picks for paid tools.

It covers two lists:

- [Best of AI](https://archestack.com/best-of-ai/): self-hosted AI apps and infrastructure, like chat UIs, model servers, RAG, agents and vector databases.
- [Best of Vibe Coding](https://archestack.com/best-of-vibe-coding/): starters, coding agents, MCP servers, skills and plugins for building with AI.

The server runs on your machine and reads the [open data API](https://archestack.com/api/). No key, no account.

## Install

Needs Node.js 22 or newer. One click for Cursor or VS Code:

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=archestack&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhcmNoZXN0YWNrL21jcCJdfQ==) [![Add to VS Code](https://img.shields.io/badge/VS_Code-Add_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=archestack&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40archestack%2Fmcp%22%5D%7D)

**Claude Code**

```bash
claude mcp add archestack -- npx -y @archestack/mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart the app.

```json
{
  "mcpServers": {
    "archestack": { "command": "npx", "args": ["-y", "@archestack/mcp"] }
  }
}
```

**Cursor**: the same `mcpServers` block in `~/.cursor/mcp.json`, or in `.cursor/mcp.json` for one project.

**VS Code** without the button:

```bash
code --add-mcp '{"name":"archestack","command":"npx","args":["-y","@archestack/mcp"]}'
```

**From source**

```bash
git clone https://github.com/archestack/mcp.git archestack-mcp
cd archestack-mcp
npm ci && npm run build
```

Then point your client at `node /full/path/to/archestack-mcp/dist/index.js` instead of `npx -y @archestack/mcp`.

## Tools

| Tool              | What it does                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `search_projects` | Finds projects by words and filters: list, category, license family, runs without a GPU, arm64 build, live demo |
| `get_project`     | One project in full: score and its parts, place in its category, GitHub facts, health, links, review            |
| `top_in_category` | The ranking of one category, best first                                                                         |
| `compare`         | 2 to 4 projects side by side                                                                                    |
| `alternatives_to` | Open-source picks for a paid product, such as Cursor or ChatGPT                                                 |

All five are read-only. Things to ask:

- "Which vector database runs without a GPU?"
- "Open-source alternatives to Cursor"
- "Compare Open WebUI and LibreChat"
- "Top 5 coding agents with an arm64 build"

What comes back, shortened (`search_projects` with "vector database" and `no_gpu`, data of 2026-10-13):

```json
{
  "updated": "2026-10-13",
  "total": 15,
  "results": [
    {
      "name": "Milvus",
      "place": 1,
      "score": 81,
      "stars": 46366,
      "license": "Apache-2.0",
      "gpu": "optional",
      "arm64": true,
      "tagline": "Distributed vector database with dense, sparse and hybrid search at scale",
      "source_url": "https://archestack.com/best-of-ai/projects/milvus/",
      "checked_at": "2026-10-13"
    },
    { "name": "Meilisearch", "place": 2, "score": 75, "gpu": "none", "...": "..." }
  ]
}
```

## How it works

- It talks to archestack.com and nothing else. The API is static JSON served with the site. The server sends nothing about you or your questions and has no telemetry.
- The server checks each file against the JSON Schema published next to it ([/api/v1/schema/](https://archestack.com/api/v1/schema/project.json)). If a file does not match, you get an error instead of a made-up answer.
- Each request times out after 8 seconds, with two retries and backoff. The server keeps each file in memory for an hour; Archestack refreshes the data twice a day.
- Every project in an answer carries `source_url`, its page on archestack.com, and `checked_at`, the date its facts were checked on GitHub.
- `ARCHESTACK_API_URL` points the server at another copy of the API. The tests use it for a local one.

## Data and license

The code is MIT. The data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) by Archestack: if you publish something built on it, link the project page (`source_url`).

Archestack checks every project on GitHub: stars, last commit, license, Docker files. How the score works: [archestack.com/methodology/](https://archestack.com/methodology/).

## Development

```bash
npm ci
npm test           # builds, then runs the server over stdio against recorded API answers
npm run fixtures   # records fresh answers from archestack.com into test/fixtures
npx @modelcontextprotocol/inspector node dist/index.js   # try the tools by hand
```

Bugs and ideas: [open an issue](https://github.com/archestack/mcp/issues).
