# Changelog

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
