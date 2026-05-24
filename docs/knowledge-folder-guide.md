# Knowledge Folder Guide

How to organize your `knowledge/` directory so the MCP server can index and serve it.

## Two Formats

### 1. Manifest-based (knowledge units)

A folder with `manifest.json` is treated as a single knowledge unit.  The manifest provides structured metadata — modules, workflows, scripts, references, placeholders.

```
knowledge/my-boilerplate/
├── manifest.json             ← Defines the knowledge unit
├── overview.md               ← Doc file (manifest "doc" field)
├── references/               ← Detailed guides
├── scripts/                  ← Automation scripts
├── workflows/                ← Predefined step sequences
└── src/                      ← Code resources
```

### 2. Standalone documents (individual .md files)

Individual `.md` files with optional YAML frontmatter are indexed individually.

```
knowledge/my-topic/
├── guide-part-1.md           ← Indexed individually
├── guide-part-2.md           ← Indexed individually
└── api-reference.md          ← Indexed individually
```

---

## Creating a Manifest-Based Knowledge Unit

1. Create a subfolder (e.g., `knowledge/my-boilerplate/`)
2. Add `manifest.json` with at minimum:  `name`, `version`, `type`, `description`
3. Optionally add:  `doc`, `modules`, `scripts`, `workflows`, `references`, `placeholders`
4. Add resource files (code, configs, templates) in subfolders
5. The MCP server automatically detects and indexes it

### Minimal manifest.json

```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "my-knowledge",
  "version": "1.0.0",
  "type": "boilerplate",
  "description": "Short description for search matching"
}
```

### Knowledge Types

These are organizational guidelines — the server does not enforce type restrictions.

| Type | Has modules? | Has scripts? | Has code? | Purpose |
|---|---|---|---|---|
| `boilerplate` | ✅ | ✅ | ✅ | Copy code partially into projects |
| `template` | ❌ | ✅ | ✅ | Scaffold entire projects |
| `toolkit` | ❌ | ✅ | ❌ | Run scripts for tasks |
| `cookbook` | ✅ | ❌ | ⚠️ examples | Patterns and guides |

---

## Creating Standalone Documents

1. Create a `.md` file in the knowledge folder (or a subfolder)
2. Add optional YAML frontmatter with `description`, `tags`, `aliases`
3. The MCP server automatically indexes it

```markdown
---
description: "Brief summary of what this document covers"
tags: keyword1, keyword2, keyword3
aliases: short-name, alternate-name
---

# Document Title

Content goes here...
```

### Frontmatter Fields

| Field | Purpose | Search Score |
|---|---|---|
| `aliases` | Alternative names/abbreviations | 12 (highest) |
| `title` | Document title (or use first `# heading`) | 10 |
| `tags` | Comma-separated keywords | 8 |
| `description` | 1-2 sentence summary | 2 |

---

## Ignored Files

The MCP server ignores:
- `README.md` files (not indexed)
- `manifest.json` files (used for metadata, not content)

---

## Tips

- Use manifest-based format for anything with code, scripts, or workflows
- Use standalone `.md` files for simple reference documentation
- Keep doc files concise — split details into `references/` folder
- Use `tags` for searchability (include language, framework, domain)
- `aliases` get the highest search score — add abbreviations people actually type
- Run `knowledge-mcp validate` after creating/modifying units to catch issues

---

## Full Manifest Schema

```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "my-knowledge",
  "version": "1.0.0",
  "type": "boilerplate|template|toolkit|cookbook",
  "doc": "overview.md",
  "description": "1-2 sentence summary for search",
  "tags": ["keyword1", "keyword2"],
  "requires": ["other-knowledge-name"],
  "enhances": ["complementary-knowledge"],
  "modules": {
    "module-name": {
      "description": "What this module provides",
      "guide": "references/module-guide.md",
      "files": ["src/File1.java", "src/File2.java"],
      "dependencies": ["other-module"],
      "tags": ["keyword"]
    }
  },
  "scripts": {
    "script-name": {
      "file": "scripts/script.py",
      "interpreter": "python",
      "description": "What this script does",
      "args": {
        "--target": {"required": true, "type": "path", "description": "Target dir"}
      }
    }
  },
  "workflows": {
    "workflow-name": {"description": "What this workflow does"}
  },
  "references": {
    "ref-name": {"file": "references/ref.md", "description": "What it covers"}
  },
  "placeholders": {
    "PLACEHOLDER_NAME": {"description": "What this value is", "example": "com.example"}
  }
}
```

### Required fields

| Field | Description |
|---|---|
| `name` | Must match folder name.  Lowercase, hyphens, numbers. |
| `version` | Semantic version (e.g., `"1.0.0"`) |
| `type` | One of: `boilerplate`, `template`, `toolkit`, `cookbook` |
| `description` | 1-2 sentences.  Drives search relevance. |

### Optional fields

| Field | Description |
|---|---|
| `doc` | Main doc filename.  `get_doc` returns this file's content. |
| `tags` | Keywords for search (include language, framework, domain) |
| `requires` | Other knowledge units this depends on |
| `enhances` | Complementary knowledge (not required) |
| `modules` | Named code modules with files and dependencies |
| `scripts` | Automation scripts with interpreter and args |
| `workflows` | Named workflows (details in `workflows/<name>.json`) |
| `references` | Documentation files with descriptions |
| `placeholders` | Template variables used in code files |

---

## Workflow JSON Schema

Workflow files live at `workflows/<name>.json`:

```json
{
  "name": "setup-project",
  "description": "Scaffold a new project",
  "inputs": {
    "TARGET": {"required": true, "type": "path", "description": "Project root"},
    "NAME": {"required": false, "type": "string", "description": "App name", "default": "my-app"}
  },
  "steps": [
    {"action": "message", "text": "Setting up {{NAME}}..."},
    {"action": "mkdir", "path": "{{TARGET}}/src"},
    {"action": "copy", "source": "templates/Base.java", "target": "{{TARGET}}/src/Base.java", "skip_if_exists": true},
    {"action": "run", "script": "scripts/validate.py", "args": ["--target", "{{TARGET}}"]},
    {"action": "message", "text": "Done!"}
  ]
}
```

Steps execute sequentially.  Errors are recorded but don't stop execution.
