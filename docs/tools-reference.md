# Tools Reference

Complete reference for all MCP tools provided by the Knowledge Shelf server.

---

## list_docs

List all available knowledge base documents and units.

**Parameters:**  None

**Returns:**  JSON with `total` count and `documents` array.

**Document fields (manifest-based):**
| Field | Type | Description |
|---|---|---|
| `name` | string | Folder name relative to knowledge dir |
| `title` | string | From manifest `name` field |
| `description` | string | From manifest `description` field |
| `type` | string | boilerplate, template, toolkit, cookbook |
| `version` | string | Semantic version |
| `tags` | string[] | From manifest `tags` |
| `has_manifest` | boolean | Always `true` |
| `modules` | string[] | Module names |
| `workflows` | string[] | Workflow names |
| `scripts` | string[] | Script names |
| `references` | string[] | Reference names |

**Document fields (standalone .md):**
| Field | Type | Description |
|---|---|---|
| `name` | string | File path relative to knowledge dir |
| `title` | string | From frontmatter `title`, first `# heading`, or filename |
| `description` | string | From frontmatter or first paragraph |
| `tags` | string[] | From frontmatter `tags` or `keywords` |
| `aliases` | string[] | From frontmatter `aliases` |
| `sections` | string[] | Heading titles found in document |
| `has_manifest` | boolean | Always `false` |

**Example response:**
```json
{
  "total": 2,
  "documents": [
    {
      "name": "cucumber-boilerplate",
      "title": "cucumber-boilerplate",
      "description": "Cucumber UI testing boilerplate for Angular apps",
      "type": "boilerplate",
      "version": "2.1.0",
      "tags": ["cucumber", "selenium", "angular", "java"],
      "has_manifest": true,
      "modules": ["base", "ag-grid", "forms"],
      "workflows": ["setup-project", "add-module"],
      "scripts": ["validate"],
      "references": ["setup-guide", "ag-grid-guide"]
    },
    {
      "name": "guides/deployment.md",
      "title": "Deployment Guide",
      "description": "How to deploy services to production",
      "tags": ["deployment", "kubernetes", "ci-cd"],
      "aliases": ["deploy", "deploy-guide"],
      "sections": ["Prerequisites", "Steps", "Rollback"],
      "has_manifest": false
    }
  ]
}
```

**When knowledge dir is empty:**
```json
{
  "total": 0,
  "knowledge_dir": "C:\\Users\\user\\.knowledge",
  "message": "No documents found."
}
```

---

## search_docs

Search knowledge base by keyword.  Returns ranked results.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | Search keywords (space-separated) |
| `max_results` | number | ❌ | Maximum results to return (default: 10) |

**Scoring algorithm:**

Each query term is matched independently against document fields.  Scores accumulate across terms.

| Match location | Score per term |
|---|---|
| `aliases` | +12 |
| `title` | +10 |
| `tags` | +8 |
| `type` | +7 |
| `modules` | +6 |
| filename/path | +6 |
| section headings | +4 |
| `description` | +2 |

Matching is case-insensitive substring.  A document must score > 0 to appear in results.

**Example:**
```json
// Input: query = "cucumber ui", max_results = 5

// Response:
{
  "query": "cucumber ui",
  "total": 2,
  "results": [
    {
      "name": "cucumber-boilerplate",
      "title": "cucumber-boilerplate",
      "description": "Cucumber UI testing boilerplate",
      "tags": ["cucumber", "selenium", "ui"],
      "has_manifest": true,
      "relevance_score": 32
    },
    {
      "name": "guides/ui-testing.md",
      "title": "UI Testing Guide",
      "description": "Patterns for UI test automation",
      "tags": ["ui", "testing"],
      "has_manifest": false,
      "relevance_score": 14
    }
  ]
}
```

**Empty/no results:**
```json
{"query": "zzz", "total": 0, "message": "No documents."}
```

---

## get_doc

Retrieve the main document content of a knowledge unit or standalone file.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Knowledge unit folder name or `.md` file path |

**Resolution order:**
1. Check if `name` is a directory with `manifest.json` → read manifest's `doc` file
2. Check if `name` is a directory without manifest → fall through to file lookup
3. Check if `name` is a file path (or directory treated as file fails) → case-insensitive fallback search
4. If nothing found → error "not found"

**Response format:**
```
directory: <absolute-path-to-folder>
---

<document body without frontmatter>
```

The `directory:` header tells AI the absolute path for running scripts or accessing resources.

**Example (manifest-based):**
```
directory: C:\Users\user\.knowledge\cucumber-boilerplate
---

# Cucumber UI Boilerplate

This boilerplate provides page objects, step definitions, and utilities
for testing Angular applications with Cucumber + Selenium.

## Getting Started
...
```

**Example (standalone .md):**
```
directory: C:\Users\user\.knowledge\guides
---

# Deployment Guide

Step-by-step instructions for deploying to production.
...
```

**Error response:**
```json
{
  "error": "Document 'nonexistent' not found.",
  "hint": "Use list_docs() to see available documents."
}
```

---

## get_doc_section

Retrieve a specific section from a document.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Document path or knowledge unit name |
| `section` | string | ✅ | Section heading text (case-insensitive, partial match) |

**Behavior:**
- Calls `get_doc` internally to get full content
- Searches for a heading matching `section` (case-insensitive, supports partial match)
- Returns content from that heading to the next heading of same or higher level
- If not found, returns available section names

**Matching rules:**
- `"getting started"` matches `## Getting Started`
- `"start"` matches `## Getting Started` (partial)
- Matches first occurrence if multiple headings contain the term

**Example (success):**
```
## Getting Started

Follow these steps to set up the project:

1. Clone the repository
2. Run the setup workflow
3. Configure your environment
```

**Example (not found):**
```json
{
  "error": "Section 'nonexistent' not found.",
  "available_sections": ["Getting Started", "Configuration", "Advanced Usage"]
}
```

---

## get_resource

Retrieve any file from the knowledge base as text.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | File path relative to knowledge directory |

**Use cases:**
- Read code templates: `my-boilerplate/src/BasePage.java`
- Read reference docs: `my-boilerplate/references/setup-guide.md`
- Read scripts: `my-boilerplate/scripts/validate.py`
- Read configs: `my-boilerplate/config/application.yml`

**Security:**
- Path traversal (`../`) outside the knowledge directory is blocked
- Returns error for binary files that can't be read as UTF-8

**Example (success):**
```java
package com.example.pages;

import org.openqa.selenium.WebDriver;

public abstract class BasePage {
    protected final WebDriver driver;
    ...
}
```

**Example (not found):**
```json
{
  "error": "Resource 'my-boilerplate/nonexistent.java' not found.",
  "hint": "Use get_manifest() to see available resources."
}
```

**Example (path traversal blocked):**
```json
{
  "error": "Access denied.  Path outside knowledge directory."
}
```

---

## get_manifest

Retrieve the `manifest.json` of a knowledge folder.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Knowledge folder name |

**Returns:**  Full manifest JSON with an added `_directory` field.

**Example response:**
```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "cucumber-boilerplate",
  "version": "2.1.0",
  "type": "boilerplate",
  "doc": "overview.md",
  "description": "Cucumber UI testing boilerplate for Angular apps",
  "tags": ["cucumber", "selenium", "angular", "java"],
  "modules": {
    "base": {
      "description": "Base page objects and hooks",
      "guide": "references/setup-guide.md",
      "files": ["pages/BasePage.java", "config/Hooks.java"],
      "dependencies": [],
      "tags": ["base", "setup"]
    },
    "ag-grid": {
      "description": "AG Grid interaction utilities",
      "guide": "references/ag-grid-guide.md",
      "files": ["pages/AgGridPage.java", "steps/AgGridSteps.java"],
      "dependencies": ["base"],
      "tags": ["ag-grid", "table"]
    }
  },
  "workflows": {
    "setup-project": {"description": "Scaffold a new test project"},
    "add-module": {"description": "Add a module to existing project"}
  },
  "scripts": {
    "validate": {
      "file": "scripts/validate.py",
      "interpreter": "python",
      "description": "Validate project structure"
    }
  },
  "references": {
    "setup-guide": {"file": "references/setup-guide.md", "description": "Initial setup"},
    "ag-grid-guide": {"file": "references/ag-grid-guide.md", "description": "AG Grid patterns"}
  },
  "placeholders": {
    "PACKAGE_NAME": {"description": "Target Java package", "example": "com.example.qa"},
    "APP_URL": {"description": "Application base URL", "example": "http://localhost:4200"}
  },
  "_directory": "C:\\Users\\user\\.knowledge\\cucumber-boilerplate"
}
```

**Error (not found):**
```json
{
  "error": "Knowledge folder 'nonexistent' not found.",
  "hint": "Use list_docs() to see available knowledge units."
}
```

**Error (no manifest):**
```json
{
  "error": "No manifest.json in 'guides'.",
  "hint": "This is a legacy knowledge folder without structured metadata."
}
```

---

## run_workflow

Execute a predefined workflow from a knowledge folder.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Knowledge folder name |
| `workflow` | string | ✅ | Workflow name (matches filename in `workflows/`) |
| `inputs` | string | ❌ | JSON string of input values for placeholder replacement |

**⚠️ Side effects:**  This tool creates files, runs scripts, and creates directories.  It is intentionally excluded from `autoApprove` in MCP configuration.

**Workflow step types:**

| Action | What it does |
|---|---|
| `copy` | Read source file → replace `{{PLACEHOLDERS}}` → write to target path |
| `run` | Execute a script with interpreter (120s timeout) |
| `mkdir` | Create directory (recursive) |
| `message` | Output progress text (no side effects) |

**Placeholder replacement:**  All `{{KEY}}` patterns in step fields and file content are replaced with values from `inputs`.

**Example request:**
```json
{
  "name": "cucumber-boilerplate",
  "workflow": "setup-project",
  "inputs": "{\"TARGET\": \"C:/projects/new-qa\", \"PACKAGE_NAME\": \"com.example.qa\", \"APP_URL\": \"http://localhost:4200\"}"
}
```

**Example response (success):**
```json
{
  "workflow": "setup-project",
  "steps_executed": 6,
  "files_created": [
    "C:/projects/new-qa/src/test/java/com/example/qa/pages/BasePage.java",
    "C:/projects/new-qa/src/test/java/com/example/qa/config/Hooks.java",
    "C:/projects/new-qa/src/test/resources/application.yml"
  ],
  "files_skipped": [
    "pom.xml"
  ],
  "scripts_run": [
    {
      "script": "scripts/validate.py",
      "exit_code": 0,
      "stdout": "✓ Structure valid\n",
      "stderr": ""
    }
  ],
  "messages": [
    "Setting up project in C:/projects/new-qa...",
    "Done!  Run 'mvn verify' to confirm setup."
  ],
  "errors": [],
  "summary": "3 files created, 1 skipped, 1 scripts run, 0 errors"
}
```

**Example response (missing inputs):**
```json
{
  "error": "Missing required inputs: [\"TARGET\",\"PACKAGE_NAME\"]",
  "workflow_inputs": {
    "TARGET": {"required": true, "type": "path", "description": "Project root"},
    "PACKAGE_NAME": {"required": true, "type": "string", "description": "Java package"}
  }
}
```

**Example response (workflow not found):**
```json
{
  "error": "Workflow 'nonexistent' not found.",
  "available_workflows": ["setup-project", "add-module"]
}
```

---

## Typical AI Workflow

A recommended sequence for AI to use these tools:

1. **`search_docs`** — Find relevant knowledge by keyword
2. **`get_manifest`** — Understand structure (modules, workflows, scripts)
3. **`get_doc`** — Read main documentation
4. **`get_doc_section`** — Drill into specific section
5. **`get_resource`** — Read code files, templates, configs
6. **`run_workflow`** — Execute automation (after confirming with user)
