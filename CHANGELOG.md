# Changelog

## [1.0.2] - 2026-05-31

### Refactored
- Migrated MCP server setup from the deprecated `Server` to the recommended `McpServer` API (`@modelcontextprotocol/sdk/server/mcp.js`).
- Migrated tool registrations from manual `setRequestHandler` + `ListToolsRequestSchema`/`CallToolRequestSchema` to `server.registerTool`.
- Replaced plain JSON Schema objects with Zod-based type-safe input schemas (`z.object()`) for all tools — enables automatic argument validation by the SDK.
- Added `zod` as a runtime dependency.

### Fixed
- Fixed `run_workflow` `inputs` parameter type: changed from `string` (requiring manual `JSON.stringify` by the caller) to `object` (`z.record(z.string(), z.string())`), matching MCP conventions. Updated `toolRunWorkflow` to accept `unknown` and coerce values to string instead of calling `JSON.parse`.
- Fixed `list_docs` tool description which had been incorrectly set to a context-gatherer agent description unrelated to the tool's purpose.

### Changed
- Added MCP server `instructions` field with guidance on when and how to use each tool, recommended call order (`search_docs` → `get_manifest` → `get_doc`/`get_doc_section`/`get_resource` → `run_workflow`), and the two knowledge formats.
- Improved all tool descriptions with usage guidance, cross-tool hints, and path format examples:
  - `search_docs`: clarified it should be called first before any task; documented scoring order.
  - `get_doc`: added hint to prefer `get_doc_section` for large documents.
  - `get_doc_section`: noted context efficiency and partial heading match support.
  - `get_resource`: added "use `get_manifest` first to discover paths" and path format example.
  - `get_manifest`: added "always call before `run_workflow`" guidance.
  - `run_workflow`: noted side effects (file creation, script execution).
- Improved all tool parameter descriptions with path format clarifications (relative to knowledge directory root) and concrete examples.

## [1.0.1] - 2026-05-30

### Security
- Fixed path traversal vulnerability in `get_doc`, `get_manifest`, and `run_workflow` — all tool inputs are now validated to stay inside the knowledge directory
- Fixed command injection in workflow `run` steps — replaced `execSync` string concatenation with `spawnSync` array args (shell is never invoked)
- Fixed command injection in CLI git operations (`add`, `update`) — replaced `execSync` string interpolation with `spawnSync` array args
- Fixed PowerShell command injection in `export` on Windows — single quotes in paths are now escaped with `''`
- Fixed symlink traversal in `get_resource`, `get_doc`, `get_manifest`, `run_workflow` — `realpathSync` is used to resolve symlinks before boundary check, and the resolved canonical path is returned to callers
- Fixed script path traversal in workflow `run` steps — script path is validated to stay inside the knowledge unit folder before execution
- Fixed missing cleanup of temporary clone directory on `add` failure
- Added interpreter whitelist for workflow scripts (`python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`)

### Performance
- `walkDir` in both MCP server and CLI now skips `.git`, `.cache`, and `node_modules` directories

### Fixed
- Frontmatter parsing in MCP server now uses `\r?\n` split for consistent behavior on Windows (CRLF line endings)

### Changed
- Added `repository`, `homepage`, and `bugs` fields to `package.json` for npm registry display

## [1.0.0] - 2025-05-24

Initial release of Knowledge Shelf — a personal knowledge management system for AI coding assistants, built as an MCP server.

### MCP Server

Give your AI on-demand access to your local knowledge base through 7 tools:

- **`list_docs`** — Discover all available knowledge units and documents
- **`search_docs`** — Find relevant knowledge by keyword with relevance scoring
- **`get_doc`** — Read the main documentation of a knowledge unit
- **`get_doc_section`** — Read a specific section without loading the full document
- **`get_resource`** — Read code files, templates, and configs from a unit
- **`get_manifest`** — Inspect what a unit contains (modules, workflows, references)
- **`run_workflow`** — Execute multi-step automation (scaffold, copy files, run scripts)

**Knowledge formats supported:**
- Manifest-based units — folders with `manifest.json` for code patterns, templates, and workflows (supports modules, scripts, references, placeholders)
- Standalone `.md` documents — plain markdown files with optional YAML frontmatter (`description`, `tags`, `aliases`)

**Search scoring:** aliases (12) → title (10) → tags (8) → type (7) → modules/filename (6) → sections (4) → description (2)

**Security:** Path traversal protection on `get_resource`

**Default knowledge directory:** `~/.knowledge`

### Knowledge Shelf CLI

Manage knowledge sources from git repositories — like npm for documentation.

- **`init`** — Initialize knowledge directory with `.gitignore` and registry
- **`add`** — Clone from git repos; supports `--path`, `--name`, `--all`, and sparse checkout
- **`list`** — Show installed sources with origin and version
- **`info`** — Detailed view of a knowledge unit (type, modules, size, source)
- **`search`** — CLI keyword search using the same scoring as the MCP tool
- **`validate`** — Check manifest integrity (required fields, file references, workflow JSON)
- **`update`** — Pull latest from remotes (respects pinned sources)
- **`pin`** / **`unpin`** — Version locking to prevent unwanted updates
- **`export`** — Package a unit as `.zip` or `.tar.gz` for sharing
- **`remove`** — Delete a knowledge unit and its registry entry

**Directory resolution order:** `--dir` flag → `KNOWLEDGE_DIR` env → walk-up `.registry.json` → `~/.knowledge`

### Bundled Skill

- `knowledge-builder` — AI-assisted skill for scaffolding new knowledge units, generating reference docs from source code, converting loose docs into manifest-based units, and validating structure

### Documentation

- `docs/cli-reference.md` — Full CLI command reference (11 commands, options, exit codes)
- `docs/tools-reference.md` — MCP tool parameters, responses, and examples
- `docs/knowledge-folder-guide.md` — How to organize knowledge directories and write manifests
- `docs/publishing-knowledge.md` — Git repo layouts for team sharing
