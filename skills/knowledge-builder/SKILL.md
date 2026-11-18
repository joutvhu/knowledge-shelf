---
name: knowledge-builder
description: "Build, scaffold, validate, and install knowledge units for Knowledge Shelf. Use when creating new knowledge from scratch, extracting reference docs or boilerplates from source code, converting existing docs into manifest-based knowledge, adding modules/workflows/scripts, or validating and installing drafted knowledge. Triggers on: 'create knowledge', 'build knowledge', 'new knowledge', 'add module to knowledge', 'add workflow', 'scaffold knowledge', 'knowledge manifest', 'convert to knowledge', 'generate knowledge from source', 'write knowledge docs', 'install knowledge'."
---

# Knowledge Builder

Author, validate, and install knowledge units for the Knowledge Shelf MCP server.

## Authoring Workflow (Stage → Validate → Review → Install)

Always draft new or modified knowledge inside the workspace staging directory `./.agents/knowledges/` first so the user can inspect files in their IDE before installing into the active Knowledge Shelf directory (`~/.knowledge/` or `KNOWLEDGE_DIR`).

### Step 1: Clarify scope & format
Determine which of the two formats fits the request:
- **Manifest-based unit** (`./.agents/knowledges/<name>/manifest.json` + resources): For reusable code (`boilerplate`), project scaffolding (`template`), automation scripts (`toolkit`), or multi-part guides (`cookbook`).
- **Standalone Markdown doc** (`./.agents/knowledges/<name>.md` with YAML frontmatter): For single-file API references, team conventions, or library documentation without code templates or workflows.

### Step 2: Draft in workspace staging (`./.agents/knowledges/`)
1. Read `references/manifest-schema.md` when creating/updating `manifest.json`, and `references/workflow-schema.md` when authoring `workflows/<name>.json`.
2. Write all drafted files under `./.agents/knowledges/<name>/` (or `./.agents/knowledges/<name>.md` for standalone docs).
   - *Exception*: Only edit an installed knowledge folder directly if the user explicitly asks to modify an already-installed unit in place.

### Step 3: Validate the staged knowledge
Run the CLI validator directly against the staged path:
```bash
knowledge-shelf validate ./.agents/knowledges/<name>
```
Fix all reported errors (`✗ ERROR`) and address warnings (`⚠ WARNING`) before proceeding.

### Step 4: Present for user review & install
Show the user what was generated in `./.agents/knowledges/<name>` and ask them to review it. Once approved (or if the user asked to install immediately), install it into the Knowledge Shelf:
```bash
# Install a single manifest unit or standalone .md file (runs validation automatically)
knowledge-shelf install ./.agents/knowledges/<name>

# Overwrite an existing unit of the same name after iterative edits
knowledge-shelf install ./.agents/knowledges/<name> --force

# Install all drafted units inside ./.agents/knowledges/
knowledge-shelf install ./.agents/knowledges --all --force
```

---

## Knowledge Formats & Architecture

### 1. Manifest-Based Unit (`./.agents/knowledges/<name>/`)

```
.agents/knowledges/<name>/
├── manifest.json              ← Required: metadata, modules, workflows, scripts, references
├── overview.md                ← Main doc (referenced by manifest "doc" field; returned by get_doc)
├── references/                ← Deep guides & API docs (loaded on-demand via get_resource)
├── workflows/                 ← Automation definitions (<workflow-name>.json; run via run_workflow)
├── scripts/                   ← Self-contained scripts (.py, .js, .ps1, .sh, .cmd)
└── <resource-dirs>/           ← Self-contained code templates with {{UPPER_SNAKE_CASE}} placeholders
```

Minimal `manifest.json`:
```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "<name>",
  "version": "1.0.0",
  "type": "<boilerplate|template|toolkit|cookbook>",
  "doc": "overview.md",
  "description": "<1-2 sentence summary with specific domain keywords>",
  "aliases": ["<short-alias>", "<alt-name>"],
  "tags": ["<lang>", "<framework>", "<domain>", "<pattern>"],
  "modules": {},
  "scripts": {},
  "workflows": {},
  "references": {},
  "placeholders": {}
}
```

### 2. Standalone Markdown Document (`./.agents/knowledges/<name>.md`)

> **Important**: Never name a standalone document `README.md` — the Knowledge Shelf scanner ignores `README.md` and `manifest.json` when indexing standalone files.

```markdown
---
title: "<Human-readable Title>"
description: "<1-2 sentence summary for search>"
tags: [<lang>, <framework>, <domain>, <topic>]
aliases: [<short-name>, <artifact-id>]
---

# <Title>

## <Section Heading 1>
...
```
*(Note: Markdown files placed inside `references/` of a manifest-based unit do NOT need YAML frontmatter because `manifest.json` handles their metadata.)*

---

## Engine Rules & Non-Obvious Constraints

1. **Search Ranking Weights (`search_docs` & `knowledge-shelf search`)**:
   - `aliases`: **12 pts** | `title` (or `manifest.name`): **10 pts** | `tags`: **8 pts** | `type`: **7 pts** | `modules` & folder/file `name`: **6 pts** | Markdown `sections` (H1–H6 headings): **4 pts** | `description`: **2 pts**.
   - Always populate `aliases` (e.g. artifact IDs, abbreviations) and 8–12 specific `tags` so AI agents can discover the unit on the first search.
2. **`doc` vs `references/` Split (Context Budget)**:
   - `doc` (loaded via `get_doc`) must stay concise (< 100 lines): overview, prerequisites, and quick-start workflow/module table.
   - Put detailed API tables, module wiring instructions, and edge cases in `references/<topic>.md` (loaded on-demand via `get_resource` or `get_doc_section`).
3. **Workflow Path Containment Security (`copy` and `mkdir` steps)**:
   - Every `target` (in `copy`) and `path` (in `mkdir`) **MUST** start with a root placeholder prefix `{{ROOT_KEY}}/...` (e.g. `{{TARGET}}/src/...`), and the runtime value of `ROOT_KEY` must be an **absolute path**. Relative targets or paths without a `{{ROOT_KEY}}` prefix are rejected by the MCP server security check.
   - Every `source` (in `copy`) and `script` (in `run`) must stay strictly inside the knowledge unit folder (no `..` traversal).
4. **Allowed Script Interpreters (`run` steps)**:
   - Whitelisted interpreters: `python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`, `cmd`.
   - Auto-detected extensions when `interpreter` is omitted: `.py` → `python`, `.js`/`.mjs`/`.cjs` → `node`, `.ps1` → `pwsh` (falls back to `powershell` on Windows), `.sh` → `bash`, `.cmd`/`.bat` → `cmd`.
   - Scripts execute with `cwd` set to the knowledge unit folder and a 120-second timeout. Keep scripts self-contained with zero external relative imports outside the unit folder.
5. **Placeholders**:
   - Must use exact `{{UPPER_SNAKE_CASE}}` syntax (`/[A-Za-z0-9_]+/`). Declare all placeholders used across code templates in `manifest.json` under `"placeholders"`.
6. **Module Wiring Guides**:
   - When a module's files need to be wired into existing host project files (e.g. registering hooks, dependency injection, config), attach `"guide": "references/<module>-guide.md"` to the module entry documenting target file locations, host code edits, and a minimal usage example.

## References (Load on Demand)

| Reference | When to read |
|---|---|
| `references/manifest-schema.md` | Full `manifest.json` field specifications and complete example |
| `references/workflow-schema.md` | Full `workflows/<name>.json` step actions, security rules, and execution semantics |
