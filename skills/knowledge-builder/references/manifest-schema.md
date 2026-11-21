# Manifest Schema Reference

Complete schema for `manifest.json` — the metadata definition of a manifest-based knowledge unit.

## Required Fields

| Field | Type | Rules |
|---|---|---|
| `name` | string | Must match the unit folder name exactly. Lowercase letters, numbers, and hyphens only. (Scored at **10 pts** in search). |
| `version` | string | Semantic version (e.g., `"1.0.0"`). |
| `type` | string | Any non-empty string; documented values: `boilerplate`, `template`, `toolkit`, `cookbook`. (Scored at **7 pts** in search). |
| `description` | string | 1–2 sentence summary containing key search nouns. (Scored at **2 pts** in search). |

## Optional Fields

| Field | Type | Description |
|---|---|---|
| `doc` | string | Relative path to main overview Markdown file (e.g., `"overview.md"`). Returned by `get_doc`. |
| `aliases` | string[] | High-priority alternate names, artifact IDs, or abbreviations. (**Highest search weight: 12 pts**). |
| `tags` | string[] | 8–12 search keywords covering language, framework, domain, and pattern. (**8 pts** in search). |
| `status` | string | Lifecycle status: `"active"` (default), `"deprecated"`, or `"draft"`. Deprecated units are down-ranked in search and display a warning banner in `get_doc`. |
| `superseded_by` | string \| null | Replacement unit name when `status` is `"deprecated"`. |
| `verified_at` | string | ISO date (`YYYY-MM-DD`) when the unit was last verified. |
| `applies_to` | object | Compatibility metadata (`languages`, `frameworks`, `detect_files`) indexed by search. |
| `source` | object | Provenance metadata (`repository`, `upstream_repo`, `upstream_ref`, `license`, `maintainers`). |
| `requires` | string[] | Other knowledge unit names this unit depends on (checked by `validate`). |
| `enhances` | string[] | Other knowledge unit names this unit complements. |
| `modules` | object | Named reusable code/doc modules with `files` (supports globs like `src/**/*.java`), `exclude`, `dependencies`, `guide`, and `tags`. (Module keys score **6 pts**). |
| `scripts` | object | Named automation scripts with `file`, `interpreter`, `timeout_ms` (integer 1000..600000), `description`, and `args`. `scripts.*.args` is informational (validated for shape, not applied when a script runs). |
| `workflows` | object | Named workflows (`{ "<name>": { "description": "...", "file": "optional/path.json" } }`). Full definition lives in `workflows/<name>.json` by default. |
| `references` | object | Named on-demand reference docs (`{ "<name>": { "file": "references/<file>.md", "description": "...", "tags": [...] } }`). Reference headings and tags are indexed in search. |
| `placeholders` | object | Named template variables (`{{UPPER_SNAKE_CASE}}`) with `type`, `required`, `pattern`, `description`, and `example`. |

## Modules (`modules`)

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

- All paths in `files` and `guide` are relative to the knowledge unit folder root and must exist on disk (`knowledge-shelf validate` verifies every path and blocks path traversal).
- `dependencies` must reference valid module keys within the same `manifest.json` (no circular dependencies).

## Scripts (`scripts`)

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

- `file` is required and must exist inside the knowledge unit folder.
- `interpreter` is optional if the file uses a standard extension (`.py`, `.js`, `.mjs`, `.cjs`, `.ps1`, `.sh`, `.cmd`, `.bat`). Allowed values: `python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`, `cmd`.
- `timeout_ms` is optional; if specified, it must be an integer between 1000 and 600000 (defaults to 120000).
- `args` is informational (validated for shape with `required` boolean, optional `type` and `description` strings, but not applied when a script runs).

## Workflows (`workflows`)

Manifest only declares the workflow name and description. For every key `<workflow-name>`, a corresponding `workflows/<workflow-name>.json` file must exist with a valid `steps` array:

```json
"workflows": {
  "<workflow-name>": {"description": "What this workflow does"}
}
```

## References (`references`)

```json
"references": {
  "<ref-name>": {
    "file": "references/<filename>.md",
    "description": "What this reference covers"
  }
}
```

## Placeholders (`placeholders`)

```json
"placeholders": {
  "PACKAGE_NAME": {"description": "Target package or namespace", "example": "com.example.app"}
}
```

- Keys must match `{{UPPER_SNAKE_CASE}}` (`/[A-Za-z0-9_]+/`) used inside template files and workflows.

## Complete Example

```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "my-boilerplate",
  "version": "1.0.0",
  "type": "boilerplate",
  "doc": "overview.md",
  "description": "Boilerplate for XYZ framework testing with page objects and form utilities",
  "aliases": ["xyz-test", "xyz-qa"],
  "tags": ["xyz", "testing", "java", "page-object", "automation", "forms", "e2e", "qa"],
  "requires": [],
  "enhances": [],
  "modules": {
    "base": {
      "description": "Base classes and test lifecycle hooks",
      "guide": "references/setup-guide.md",
      "files": ["src/BasePage.java", "config/Hooks.java"],
      "dependencies": [],
      "tags": ["base", "setup"]
    },
    "forms": {
      "description": "Form interaction and validation utilities",
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
    "setup-forms": {"description": "Add form testing module to an existing project"}
  },
  "references": {
    "setup-guide": {"file": "references/setup-guide.md", "description": "Initial project setup and hook registration"},
    "forms-guide": {"file": "references/forms-guide.md", "description": "Form locators, API methods, and usage examples"}
  },
  "placeholders": {
    "TARGET": {"description": "Absolute path to target project root", "example": "/workspace/my-project"},
    "PACKAGE_NAME": {"description": "Target Java package", "example": "com.example.qa"},
    "PACKAGE_PATH": {"description": "Target Java package as directory path", "example": "com/example/qa"}
  }
}
```
