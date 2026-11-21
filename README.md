# Knowledge Shelf MCP Server

A personal knowledge management system for AI coding assistants, built as an [MCP](https://modelcontextprotocol.io/) server. Store documentation, code patterns, templates, and workflows locally — AI pulls only what it needs, when it needs it.

## The Problem

AI assistants forget everything between sessions. You explain the same patterns, paste the same boilerplate, re-describe the same internal APIs — over and over.

Steering files help, but they load everything into context upfront. For large knowledge bases (library docs, code templates, workflow guides), this wastes context budget and slows responses.

## The Solution

`knowledge-shelf` gives AI **on-demand access** to your knowledge. AI searches, finds what's relevant, and loads only that — like a developer searching internal docs.

```
You: "Set up AG Grid testing for this project"

AI: [searches knowledge] → finds cucumber-boilerplate
    [reads manifest] → discovers ag-grid module + setup workflow
    [runs workflow] → scaffolds page objects, step definitions, config
    Done. Project ready.
```

## What You Can Store

| Use Case                   | Example                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| **Library documentation**  | Internal framework APIs, custom annotations, config options           |
| **Reusable code patterns** | Page objects, base classes, utility functions you use across projects |
| **Project templates**      | Boilerplate for new microservices, test projects, modules             |
| **Team conventions**       | Coding standards, architecture decisions, naming rules                |
| **Workflow automation**    | Multi-step scaffolding, project setup, code generation                |
| **Onboarding guides**      | How-to docs for new team members (AI reads them too)                  |
| **Vendor/tool docs**       | Summarized docs for tools your team uses daily                        |

## How It Works

```
~/.knowledge/                          ← Your knowledge lives here
├── cucumber-boilerplate/              ← Manifest-based unit (code + workflows)
│   ├── manifest.json
│   ├── pages/AgGridPage.java
│   ├── workflows/setup-project.json
│   └── references/ag-grid-guide.md
├── spring-patterns/                   ← Another unit
│   ├── manifest.json
│   └── ...
└── team-guides/                       ← Simple markdown docs
    ├── deployment.md
    └── coding-standards.md
```

AI accesses this through 7 MCP tools:

| Tool              | What AI does with it                                        |
| ----------------- | ----------------------------------------------------------- |
| `search_docs`     | Find relevant knowledge by keyword                          |
| `get_manifest`    | Understand what a unit contains (modules, workflows)        |
| `get_doc`         | Read main documentation                                     |
| `get_doc_section` | Read a specific section                                     |
| `get_resource`    | Read code files, templates, configs                         |
| `run_workflow`    | Execute multi-step automation (scaffold, copy, run scripts) |
| `list_docs`       | Discover all available knowledge                            |

## Quick Start

### Initialize your knowledge directory

```bash
npx knowledge-shelf init
```

### Add knowledge from a git repo

```bash
npx knowledge-shelf add https://github.com/your-team/shared-knowledge.git --all
```

### Configure your AI Assistant

Add the configuration below to your MCP client's configuration file. Here are the paths for some popular tools:

- **Claude Desktop:** `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac)
- **Cursor:** `.cursor/mcp.json` (Workspace)
- **Windsurf:** `~/.windsurf/mcp.json`
- **Kiro:** `.kiro/settings/mcp.json`
- **Antigravity:** `~/.gemini/config/mcp.json`
- **And other MCP-compatible clients...**

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "npx",
      "args": ["-y", "knowledge-shelf"],
      "disabled": false,
      "autoApprove": [
        "list_docs",
        "search_docs",
        "get_doc",
        "get_doc_section",
        "get_resource",
        "get_manifest"
      ]
    }
  }
}
```

That's it. AI now has access to your knowledge.

> **Note:** `run_workflow` is intentionally excluded from `autoApprove` because it has side effects: it can write files under any absolute target directory passed via workflow inputs (e.g. `{{TARGET}}`) and execute bundled scripts (`node`, `python`, `pwsh`, `bash`, `cmd`). Only install knowledge from repositories you trust, and only add `run_workflow` to `autoApprove` if you trust every installed workflow.

To use a custom knowledge path:

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "npx",
      "args": ["-y", "knowledge-shelf", "C:\\path\\to\\knowledge"],
      "disabled": false,
      "autoApprove": [
        "list_docs",
        "search_docs",
        "get_doc",
        "get_doc_section",
        "get_resource",
        "get_manifest"
      ]
    }
  }
}
```

> **Tip:** You can set a global `KNOWLEDGE_DIR` environment variable (e.g., to `~/.kiro/knowledge/` or an absolute path) to persistently change the default directory for both CLI commands and MCP Server operations without passing paths or cờ (flags) manually.

## Two Knowledge Formats

### Manifest-based (for code, templates, workflows)

Best for reusable code patterns and automation. A folder with `manifest.json`:

```json
{
  "name": "my-boilerplate",
  "version": "1.0.0",
  "type": "boilerplate",
  "description": "Page objects and step definitions for Angular testing",
  "tags": ["cucumber", "selenium", "angular"],
  "modules": { "base": { "files": ["pages/BasePage.java"] } },
  "scripts": {
    "validate": {
      "file": "scripts/validate.py",
      "interpreter": "python",
      "timeout_ms": 60000,
      "args": {
        "--target": { "required": true, "type": "path", "description": "Target directory" }
      }
    }
  },
  "workflows": { "setup": { "description": "Scaffold new project" } }
}
```

- **`type`**: Accepts any non-empty string (`boilerplate`, `template`, `toolkit`, `cookbook`, or custom categories like `playbook`).
- **`scripts.*.args`**: Informational schema specifying arguments with shape: `required: boolean`, `type: string`, `description: string`, and optional `default?: string | number | boolean`. Validated for correct structure, but not applied at script runtime.
- **`timeout_ms`**: Bounds for scripts and workflow `run` steps are constrained to an integer between `1000` and `600000` ms (1s to 10m, default: `120000`).

### Standalone markdown (for documentation)

Best for guides, conventions, API docs. Just `.md` files with optional frontmatter:

```markdown
---
description: "Internal REST API authentication patterns"
tags: auth, jwt, spring-security
aliases: auth-guide
---

# Authentication Guide

...
```

## Knowledge Shelf CLI

Manage knowledge sources from git repositories — like npm for documentation.

Install globally to use the CLI directly without `npx`:

```bash
npm install -g knowledge-shelf
```

```bash
knowledge-shelf init                                    # Initialize ~/.knowledge
knowledge-shelf add <url>                               # Install from git repo
knowledge-shelf add <url> --all                         # Install all units from monorepo
knowledge-shelf add <url> --path <dir>                  # Install specific subfolder (sparse checkout)
knowledge-shelf install <path> [--force] [--all]        # Validate & install drafted knowledge from local path
knowledge-shelf search <keywords>                       # Search installed knowledge
knowledge-shelf info <name>                             # Show unit details
knowledge-shelf validate [name|path]                    # Check structure integrity (installed or local draft)
knowledge-shelf list                                    # Show installed sources
knowledge-shelf update [name] [--no-verify] [--force]   # Pull latest changes (stages & validates; honors --no-verify)
knowledge-shelf pin <name> [version] [--no-verify]      # Lock version (validates checkout; honors --no-verify)
knowledge-shelf unpin <name>                            # Unlock
knowledge-shelf sync [--frozen] [--force] [--no-verify] # Synchronize declared sources (skips local edits unless --force)
knowledge-shelf publish <path> --to <url> [--push]      # Publish unit or standalone .md directly to git repo
knowledge-shelf export <name>                           # Package as zip for sharing
knowledge-shelf remove <name>                           # Uninstall
```

### Key CLI Features & Integrity Protections

- **`publish <path> --to <url> [--push]`**: Supports publishing a manifest unit folder or a standalone `.md` file directly into a remote target repo (`knowledge-shelf publish docs/guide.md --to <repo> --push`).
  - Fast-forwards when updating an existing remote branch based on the remote branch tip (never force-pushes; `--force` overrides hygiene warnings only).
  - Automatically reports "No changes to publish" and exits cleanly without creating an empty commit if remote branch content already matches.
- **`update`**, **`sync`**, and **`pin`**:
  - Stage and validate fetched content before updating installed units. Pass the `--no-verify` flag to bypass staging validation.
  - `sync` detects local modifications via checksums and skips edited units without overwriting unless `--force` is specified. In frozen mode (`--frozen`), accepts full 40-character SHAs, prefix SHAs, and remote tags.

See [docs/cli-reference.md](docs/cli-reference.md) for full command documentation.

## Sharing Knowledge

Organize a git repo and your team can install with one command:

```bash
# Single unit repo
knowledge-shelf add https://github.com/team/qa-boilerplate.git

# Monorepo with multiple units
knowledge-shelf add https://github.com/team/shared-knowledge.git --all

# Specific subfolder
knowledge-shelf add https://github.com/team/project.git --path knowledge/api-patterns --name api-patterns

# Publish a manifest unit or standalone .md file directly to a remote repository
knowledge-shelf publish ./my-unit --to https://github.com/team/shared-knowledge.git --push
knowledge-shelf publish ./docs/deploy.md --to https://github.com/team/shared-knowledge.git --push
```

The `publish` command supports both manifest units and standalone `.md` files directly into a remote target repo (`knowledge-shelf publish docs/guide.md --to <repo>`). It verifies content hygiene (detecting credentials, secrets, and sensitive files), fast-forwards when updating an existing remote branch based on the remote branch tip (never force-pushes; `--force` overrides hygiene warnings only), and automatically reports "No changes to publish" and exits cleanly without creating an empty commit if remote branch content already matches.

See [docs/publishing-knowledge.md](docs/publishing-knowledge.md) for repo layout conventions.

## Knowledge Builder Skill

Includes the `knowledge-builder` skill for AI-assisted knowledge creation. Install it using the [skills CLI](https://skills.sh):

```bash
npx skills add joutvhu/knowledge-shelf
```

The skill helps AI:

- Draft new knowledge units in `./.agents/knowledges/` for review before installing
- Generate reference docs from library source code
- Convert loose docs into manifest-based units
- Validate and install drafted knowledge with `knowledge-shelf validate` and `knowledge-shelf install`

## Documentation

| Doc                                                              | Content                                           |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| [docs/cli-reference.md](docs/cli-reference.md)                   | All CLI commands, options, exit codes             |
| [docs/tools-reference.md](docs/tools-reference.md)               | MCP tool parameters, responses, examples          |
| [docs/knowledge-folder-guide.md](docs/knowledge-folder-guide.md) | Knowledge directory organization, manifest schema |
| [docs/publishing-knowledge.md](docs/publishing-knowledge.md)     | Git repo layouts, team sharing, private repos     |

## Development

```bash
npm install
npm run build       # Compile TypeScript
npm run dev         # Run with tsx (hot reload)
npm test            # Run tests (vitest)
npm start           # Run compiled server
```

## License

[Apache-2.0](LICENSE)
