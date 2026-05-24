# Knowledge Base MCP Server

A personal knowledge management system for AI coding assistants.  Store documentation, code patterns, templates, and workflows locally — AI pulls only what it needs, when it needs it.

Built on the [Model Context Protocol](https://modelcontextprotocol.io/).

## The Problem

AI assistants forget everything between sessions.  You explain the same patterns, paste the same boilerplate, re-describe the same internal APIs — over and over.

Steering files help, but they load everything into context upfront.  For large knowledge bases (library docs, code templates, workflow guides), this wastes context budget and slows responses.

## The Solution

`knowledge-mcp` gives AI **on-demand access** to your knowledge.  AI searches, finds what's relevant, and loads only that — like a developer searching internal docs.

```
You: "Set up AG Grid testing for this project"

AI: [searches knowledge] → finds cucumber-boilerplate
    [reads manifest] → discovers ag-grid module + setup workflow
    [runs workflow] → scaffolds page objects, step definitions, config
    Done. Project ready.
```

## What You Can Store

| Use Case | Example |
|---|---|
| **Library documentation** | Internal framework APIs, custom annotations, config options |
| **Reusable code patterns** | Page objects, base classes, utility functions you use across projects |
| **Project templates** | Boilerplate for new microservices, test projects, modules |
| **Team conventions** | Coding standards, architecture decisions, naming rules |
| **Workflow automation** | Multi-step scaffolding, project setup, code generation |
| **Onboarding guides** | How-to docs for new team members (AI reads them too) |
| **Vendor/tool docs** | Summarized docs for tools your team uses daily |

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

| Tool | What AI does with it |
|---|---|
| `search_docs` | Find relevant knowledge by keyword |
| `get_manifest` | Understand what a unit contains (modules, workflows) |
| `get_doc` | Read main documentation |
| `get_doc_section` | Read a specific section |
| `get_resource` | Read code files, templates, configs |
| `run_workflow` | Execute multi-step automation (scaffold, copy, run scripts) |
| `list_docs` | Discover all available knowledge |

## Quick Start

```bash
# 1. Initialize your knowledge directory
npx knowledge-mcp init

# 2. Add knowledge from a git repo
npx knowledge-mcp add https://github.com/your-team/shared-knowledge.git --all

# 3. Configure your AI Assistant

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
      "args": ["-y", "knowledge-mcp"],
      "disabled": false,
      "autoApprove": ["list_docs", "search_docs", "get_doc", "get_doc_section", "get_resource", "get_manifest"]
    }
  }
}
```

That's it.  AI now has access to your knowledge.

> **Note:** `run_workflow` is intentionally excluded from `autoApprove` because it has side effects (creates files, runs scripts).  Add it only if you trust all installed knowledge workflows.

To use a custom knowledge path:

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "npx",
      "args": ["-y", "knowledge-mcp", "C:\\path\\to\\knowledge"],
      "disabled": false,
      "autoApprove": ["list_docs", "search_docs", "get_doc", "get_doc_section", "get_resource", "get_manifest"]
    }
  }
}
```

## Two Knowledge Formats

### Manifest-based (for code, templates, workflows)

Best for reusable code patterns and automation.  A folder with `manifest.json`:

```json
{
  "name": "my-boilerplate",
  "version": "1.0.0",
  "type": "boilerplate",
  "description": "Page objects and step definitions for Angular testing",
  "tags": ["cucumber", "selenium", "angular"],
  "modules": { "base": { "files": ["pages/BasePage.java"], ... } },
  "workflows": { "setup": { "description": "Scaffold new project" } }
}
```

### Standalone markdown (for documentation)

Best for guides, conventions, API docs.  Just `.md` files with optional frontmatter:

```markdown
---
description: "Internal REST API authentication patterns"
tags: auth, jwt, spring-security
aliases: auth-guide
---

# Authentication Guide
...
```

## Knowledge Manager CLI

Manage knowledge sources from git repositories — like npm for documentation.

```bash
knowledge-mcp init                    # Initialize ~/.knowledge
knowledge-mcp add <url>               # Install from git repo
knowledge-mcp add <url> --all         # Install all units from monorepo
knowledge-mcp add <url> --path <dir>  # Install specific subfolder (sparse checkout)
knowledge-mcp search <keywords>       # Search installed knowledge
knowledge-mcp info <name>             # Show unit details
knowledge-mcp validate [name]         # Check structure integrity
knowledge-mcp list                    # Show installed sources
knowledge-mcp update [name]           # Pull latest from remotes
knowledge-mcp pin <name> [version]    # Lock version (skip updates)
knowledge-mcp unpin <name>            # Unlock
knowledge-mcp export <name>           # Package as zip for sharing
knowledge-mcp remove <name>           # Uninstall
```

See [docs/cli-reference.md](docs/cli-reference.md) for full command documentation.

## Sharing Knowledge

Organize a git repo and your team can install with one command:

```bash
# Single unit repo
knowledge-mcp add https://github.com/team/qa-boilerplate.git

# Monorepo with multiple units
knowledge-mcp add https://github.com/team/shared-knowledge.git --all

# Specific subfolder
knowledge-mcp add https://github.com/team/project.git --path knowledge/api-patterns --name api-patterns
```

See [docs/publishing-knowledge.md](docs/publishing-knowledge.md) for repo layout conventions.

## Bundled Skill

Includes the `knowledge-builder` skill for AI-assisted knowledge creation.  Copy to your AI agent's skills directory:

```bash
cp -r node_modules/knowledge-mcp/skills/knowledge-builder <path-to-your-agent-skills>/
```

The skill helps AI:
- Scaffold new knowledge units from scratch
- Generate reference docs from library source code
- Convert loose docs into manifest-based units
- Validate structure and fix issues

## Documentation

| Doc | Content |
|---|---|
| [docs/cli-reference.md](docs/cli-reference.md) | All CLI commands, options, exit codes |
| [docs/tools-reference.md](docs/tools-reference.md) | MCP tool parameters, responses, examples |
| [docs/knowledge-folder-guide.md](docs/knowledge-folder-guide.md) | Knowledge directory organization, manifest schema |
| [docs/publishing-knowledge.md](docs/publishing-knowledge.md) | Git repo layouts, team sharing, private repos |

## Development

```bash
npm install
npm run build       # Compile TypeScript
npm run dev         # Run with tsx (hot reload)
npm test            # Run tests (vitest)
npm start           # Run compiled server
```

## License

MIT
