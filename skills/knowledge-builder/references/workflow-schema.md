# Workflow Schema Reference

Complete schema for workflow JSON files (`workflows/<name>.json`).

## Overview

Workflows automate multi-step tasks.  AI calls `run_workflow` with the workflow name and inputs — the MCP server executes all steps sequentially.

## File Location

```
knowledge/<knowledge-name>/
└── workflows/
    ├── setup-project.json
    ├── add-module.json
    └── validate.json
```

## Schema

```json
{
  "name": "<workflow-name>",
  "description": "<what this workflow does>",
  "inputs": {
    "<INPUT_NAME>": {
      "required": true,
      "type": "path|string|number|boolean",
      "description": "<what this input is>",
      "default": "<optional default value>"
    }
  },
  "steps": [
    { "action": "copy|run|mkdir|message", ... }
  ]
}
```

## Top-Level Fields

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Workflow identifier (matches filename without .json) |
| `description` | ✅ | What this workflow does |
| `inputs` | Optional | Input parameters AI must provide (omit if no placeholders used) |
| `steps` | ✅ | Ordered list of actions to execute |

## Step Actions

### `copy` — Copy a resource file to target

```json
{
  "action": "copy",
  "source": "<relative-path-in-knowledge-folder>",
  "target": "{{INPUT}}/path/to/destination",
  "skip_if_exists": false
}
```

| Field | Required | Description |
|---|---|---|
| `source` | ✅ | File path relative to knowledge folder root |
| `target` | ✅ | Destination path (supports `{{PLACEHOLDER}}`) |
| `skip_if_exists` | Optional | Skip when target exists.  Default: `false`. |

**Behavior:**  Read source → replace `{{KEY}}` with input values → create parent dirs → write target.

### `run` — Execute a script

```json
{
  "action": "run",
  "script": "scripts/<filename>.py",
  "args": ["--target", "{{INPUT}}", "--flag"],
  "interpreter": "python"
}
```

| Field | Required | Description |
|---|---|---|
| `script` | ✅ | Script path relative to knowledge folder |
| `args` | Optional | CLI arguments (supports `{{PLACEHOLDER}}`) |
| `interpreter` | Optional | Auto-detected from extension if omitted |

**Behavior:**  Execute script with timeout (120s).  Non-zero exit → error recorded, workflow continues.

### `mkdir` — Create directory

```json
{
  "action": "mkdir",
  "path": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}"
}
```

### `message` — Output progress message

```json
{
  "action": "message",
  "text": "Setting up module..."
}
```

## Placeholder Replacement

All string fields support `{{KEY}}` replacement from workflow inputs.  Unreplaced placeholders remain as-is.

## Execution

- Steps execute sequentially
- Errors are recorded but do NOT stop execution (no rollback)
- Final response includes:  `steps_executed`, `files_created`, `files_skipped`, `scripts_run`, `errors`, `summary`

## Example

```json
{
  "name": "setup-ag-grid",
  "description": "Add AG Grid testing module",
  "inputs": {
    "TARGET": {"required": true, "type": "path", "description": "Project root"},
    "PACKAGE_PATH": {"required": true, "type": "string", "description": "Package as path"}
  },
  "steps": [
    {"action": "message", "text": "Setting up AG Grid..."},
    {"action": "mkdir", "path": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages"},
    {"action": "copy", "source": "pages/BaseAngularPage.java", "target": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages/BaseAngularPage.java", "skip_if_exists": true},
    {"action": "copy", "source": "pages/AgGridPage.java", "target": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages/AgGridPage.java"},
    {"action": "run", "script": "scripts/validate.py", "args": ["--target", "{{TARGET}}"]},
    {"action": "message", "text": "Done."}
  ]
}
```
