# Arkade Console

MCP server for live Arkade codebase introspection. Gives Claude Code (or any MCP client) direct access to Arkade source repos, API surfaces, and docs drift detection.

## What it does

The server clones and caches Arkade repos locally, then exposes tools that let an LLM inspect live source code without manual copy-paste or stale snapshots. Repos are shallow-cloned on first access and updated on subsequent calls.

### Tools

| Tool | Purpose |
|------|---------|
| `list_projects` | List all projects in the registry with repos and descriptions |
| `get_project_info` | Architecture context, recent git activity, latest tag, directory structure |
| `get_api_surface` | Extract public API (exports, types, interfaces) from a specific module |
| `search_repos` | Regex search across one or more repos (ripgrep with grep fallback) |
| `read_file` | Read a file from any repo, with offset/limit for large files |
| `check_docs_drift` | Detect API changes between cached and current source, flag affected docs pages |

### Registry

The server tracks 8 Arkade projects defined in `registry.json`:

- **ts-sdk** - TypeScript SDK (`@arkade-os/sdk`)
- **go-sdk** - Go client library
- **arkd** - Protocol server
- **boltz-swap** - Boltz swap integration
- **rust-sdk** - Rust SDK
- **dotnet-sdk** - .NET SDK (NArk)
- **arkade-assets** - UTXO-native asset protocol
- **arkade-docs** - Official docs site (Mintlify)

Each project entry maps named modules to source paths (entry points), so the LLM can request specific subsystems without navigating the repo itself.

### Context docs

Hand-written architecture summaries live in `context/`. These cover high-level design, key types, and conventions that aren't obvious from code alone. Available for: ts-sdk, go-sdk, arkd, boltz-swap.

## Setup

### Prerequisites

- Node.js 18+
- git

### Install

```bash
git clone https://github.com/brg444/arkade-console.git
cd arkade-console
npm install
```

### Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "arkade": {
      "command": "node",
      "args": ["/absolute/path/to/arkade-console/src/index.js"]
    }
  }
}
```

Restart Claude Code. The `arkade` MCP server will appear in your tool list.

### Run standalone (for testing)

```bash
npm start
```

The server communicates over stdio using JSON-RPC (MCP protocol). It is not an HTTP server.

## Usage examples

Once configured, Claude Code can call these tools directly during conversation:

**"What's the current API surface of the TypeScript SDK's identity module?"**
Calls `get_api_surface` with `project: "ts-sdk", module: "identity"`. Returns exported classes, interfaces, and types from `src/identity/`.

**"Search for how VTXOs are created across all Go code"**
Calls `search_repos` with `query: "CreateVtxo", glob: "*.go"`. Searches all cached repos.

**"Have there been API changes in ts-sdk since last check?"**
Calls `check_docs_drift` with `project: "ts-sdk"`. Snapshots the API surface before and after pulling latest, diffs them, and cross-references changed symbols against docs pages.

## How it works

1. **Registry** (`registry.json`) maps project IDs to GitHub repos, languages, and entry points.
2. **Repo cache** (`.repo-cache/`, gitignored) holds shallow clones. `ensureRepo()` clones on first access, fetches on subsequent calls. Works offline with stale cache.
3. **Extraction** parses TypeScript exports and Go type/func definitions using line-by-line pattern matching. Not a full AST, but captures the public API surface reliably for introspection.
4. **Drift detection** snapshots the API surface, pulls latest, snapshots again, diffs, then greps docs for any symbol that changed.
5. **Context docs** supplement code extraction with architectural knowledge that pure code parsing misses.

## Adding a project

Edit `registry.json`:

```json
{
  "new-project": {
    "repo": "org/repo-name",
    "language": "typescript",
    "description": "What this project does.",
    "entry_points": {
      "exports": "src/index.ts",
      "types": "src/types/"
    }
  }
}
```

Optionally add a `context/new-project.md` with architecture notes.
