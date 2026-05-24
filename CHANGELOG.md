# Changelog

## [1.0.0] - 2025-05-24

### MCP Server
- 7 tools: list_docs, search_docs, get_doc, get_doc_section, get_resource, get_manifest, run_workflow
- Manifest-based knowledge units (modules, workflows, scripts, references, placeholders)
- Standalone .md documents with YAML frontmatter (description, tags, aliases)
- Relevance-scored search (aliases 12, title 10, tags 8, type 7, modules 6, filename 6, sections 4, description 2)
- Security: path traversal protection on get_resource
- Default knowledge directory: ~/.knowledge

### Knowledge Shelf CLI
- `init` — Initialize knowledge directory with .gitignore and registry
- `add` — Clone from git repos (supports --path, --name, --all, sparse checkout)
- `list` — Show installed sources with origin and version
- `info` — Detailed view of a knowledge unit (type, modules, size, source)
- `search` — CLI keyword search with same scoring as MCP tool
- `validate` — Check manifest integrity (required fields, file refs, workflow JSON)
- `update` — Pull latest from remotes (respects pinned sources)
- `pin` / `unpin` — Version locking to prevent unwanted updates
- `export` — Package as zip or tar.gz for sharing
- `remove` — Delete knowledge and registry entry
- Resolution order: --dir flag > KNOWLEDGE_DIR env > walk-up .registry.json > ~/.knowledge

### Bundled Skill
- `knowledge-builder` skill for AI-assisted knowledge creation

### Documentation
- docs/cli-reference.md — Full CLI command reference (11 commands, options, exit codes)
- docs/tools-reference.md — Full tool parameter details and examples
- docs/knowledge-folder-guide.md — How to organize knowledge directories
- docs/publishing-knowledge.md — Git repo layouts for sharing
