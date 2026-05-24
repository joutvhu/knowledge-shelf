# Manifest Schema Reference

Complete schema for `manifest.json` — the file that defines a knowledge unit.

## Required Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Identifier, must match folder name.  Lowercase, hyphens, numbers. |
| `version` | string | Semantic version (e.g., `"1.0.0"`). |
| `type` | string | One of:  `boilerplate`, `template`, `toolkit`, `cookbook`. |
| `description` | string | 1-2 sentence summary.  Used for search matching. |

## Optional Fields

| Field | Type | Description |
|---|---|---|
| `doc` | string | Filename of main doc (e.g., `"overview.md"`).  `get_doc` returns this file. |
| `tags` | string[] | Keywords for search.  Include language, framework, domain. |
| `requires` | string[] | Knowledge folders this depends on.  AI reads those first. |
| `enhances` | string[] | Knowledge folders this complements (not required). |
| `modules` | object | Named modules with files, dependencies, guide. |
| `scripts` | object | Named scripts with file path, interpreter, args. |
| `workflows` | object | Named workflows (name + description only — details in workflow JSON). |
| `references` | object | Named reference docs with file path + description. |
| `placeholders` | object | Named placeholders with description + example. |

## Modules

```json
"modules": {
  "<module-name>": {
    "description": "What this module provides",
    "guide": "references/<module-name>-guide.md",
    "files": [
      "<category>/<FileName1.ext>",
      "<category>/<FileName2.ext>"
    ],
    "dependencies": ["<other-module-name>"],
    "tags": ["<keyword1>", "<keyword2>"]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `description` | ✅ | What the module provides |
| `guide` | Optional | Path to reference doc explaining this module |
| `files` | Recommended | List of resource files belonging to this module |
| `dependencies` | Optional | Other module names that must be present first |
| `tags` | Optional | Keywords for matching user requests to modules |

> **Note:** "Required" here means the `validate` CLI will report errors if missing.  The MCP server itself is lenient — it indexes whatever is present.

**Dependency rules:**
- Dependencies are module names within the same knowledge unit
- AI should copy/install dependency modules before the dependent module
- Circular dependencies are not allowed

## Scripts

```json
"scripts": {
  "<script-name>": {
    "file": "scripts/<filename>.py",
    "interpreter": "python",
    "description": "What this script does",
    "args": {
      "--target": {"required": true, "type": "path", "description": "Target directory"},
      "--module": {"required": false, "type": "string", "description": "Module name", "default": "all"}
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `file` | ✅ | Path to script file relative to knowledge folder |
| `interpreter` | Optional | Runtime command.  Auto-detected from extension if omitted. |
| `description` | Recommended | What the script does |
| `args` | Optional | CLI arguments with metadata |

**Interpreter auto-detection:**

| Extension | Interpreter |
|---|---|
| `.py` | `python` |
| `.js` | `node` |
| `.ps1` | `pwsh` |
| `.cmd` | `cmd /c` |
| `.sh` | `bash` |

## Workflows

Manifest only stores name + description.  Full definition lives in `workflows/<name>.json`.

```json
"workflows": {
  "<workflow-name>": {"description": "What this workflow does"}
}
```

See `workflow-schema.md` for workflow JSON format.

## References

```json
"references": {
  "<ref-name>": {"file": "references/<filename>.md", "description": "What this covers"}
}
```

## Placeholders

```json
"placeholders": {
  "<PLACEHOLDER_NAME>": {"description": "What this value represents", "example": "com.example.app"}
}
```

- Keys are UPPER_SNAKE_CASE (matching `{{KEY}}` in resource files)
- `description` helps AI ask user the right question
- `example` helps AI suggest default values

## Full Example

```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "my-boilerplate",
  "version": "1.0.0",
  "type": "boilerplate",
  "doc": "overview.md",
  "description": "Boilerplate for XYZ framework testing",
  "tags": ["xyz", "testing", "java"],
  "requires": ["xyz-common-docs"],
  "enhances": [],
  "modules": {
    "base": {
      "description": "Base classes and configuration",
      "guide": "references/setup-guide.md",
      "files": ["src/BasePage.java", "config/Hooks.java"],
      "dependencies": [],
      "tags": ["base", "setup"]
    },
    "forms": {
      "description": "Form interaction utilities",
      "guide": "references/forms-guide.md",
      "files": ["src/FormPage.java", "steps/FormSteps.java"],
      "dependencies": ["base"],
      "tags": ["form", "input", "validation"]
    }
  },
  "scripts": {
    "setup": {
      "file": "scripts/setup.py",
      "interpreter": "python",
      "description": "Scaffold project with selected modules",
      "args": {
        "--target": {"required": true, "type": "path", "description": "Project directory"},
        "--modules": {"required": false, "type": "string", "description": "Modules to include", "default": "all"}
      }
    }
  },
  "workflows": {
    "setup-forms": {"description": "Add form testing to existing project"}
  },
  "references": {
    "setup-guide": {"file": "references/setup-guide.md", "description": "How to setup from scratch"},
    "forms-guide": {"file": "references/forms-guide.md", "description": "Form locators and patterns"}
  },
  "placeholders": {
    "PACKAGE_NAME": {"description": "Target package/namespace", "example": "com.example.qa"},
    "APP_NAME": {"description": "Application name", "example": "MyApp"}
  }
}
```
