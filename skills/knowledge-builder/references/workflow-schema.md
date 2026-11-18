# Workflow Schema Reference

Complete schema and runtime constraints for workflow JSON files (`workflows/<name>.json`).

## File Location

```
.agents/knowledges/<knowledge-name>/
└── workflows/
    └── <workflow-name>.json   ← Must match key in manifest.json "workflows"
```

## Schema

```json
{
  "name": "<workflow-name>",
  "description": "<what this workflow does>",
  "inputs": {
    "TARGET": {
      "required": true,
      "type": "path",
      "description": "Absolute path to target project root"
    },
    "PACKAGE_PATH": {
      "required": true,
      "type": "string",
      "description": "Package path (e.g. com/example/app)",
      "default": "com/example/app"
    }
  },
  "steps": [
    { "action": "mkdir|copy|run|message", ... }
  ]
}
```

## Security & Placeholder Rules (Enforced by MCP Server)

1. **Placeholder format**: `{{KEY}}` where `KEY` matches `/[A-Za-z0-9_]+/`.
2. **Root Path Containment for `copy.target` and `mkdir.path`**:
   - Every `target` (in `copy`) and `path` (in `mkdir`) **MUST** start with a root placeholder prefix `{{ROOT_KEY}}` (or `{{ROOT_KEY}}/...`, e.g., `{{TARGET}}/src/...`).
   - At runtime, the input value for `ROOT_KEY` **MUST** be an absolute path (`path.isAbsolute(inputs[ROOT_KEY]) === true`).
   - The rendered destination must not contain any unresolved `{{...}}` placeholders and must resolve strictly inside `inputs[ROOT_KEY]` (any `..` or symlink escape is blocked).
3. **Source & Script Containment**:
   - `copy.source` and `run.script` are resolved relative to the knowledge unit folder root and must stay strictly inside that unit folder.
4. **Binary-safe `copy`**:
   - Text files have `{{KEY}}` placeholders replaced with `inputs[KEY]`. Binary files (detected via null byte in first 8 KB) are copied byte-for-byte without placeholder replacement.

## Step Actions

### `copy` — Copy and render a template/resource file to target

```json
{
  "action": "copy",
  "source": "pages/AgGridPage.java",
  "target": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages/AgGridPage.java",
  "skip_if_exists": true
}
```

| Field | Required | Description |
|---|---|---|
| `source` | ✅ | Relative file path inside the knowledge unit folder |
| `target` | ✅ | Destination path starting with `{{ROOT_KEY}}/...` |
| `skip_if_exists` | Optional | If `true`, skips overwriting when destination file already exists (recommended for idempotency). Default: `false`. |

### `mkdir` — Create target directory

```json
{
  "action": "mkdir",
  "path": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages"
}
```

| Field | Required | Description |
|---|---|---|
| `path` | ✅ | Directory path starting with `{{ROOT_KEY}}` or `{{ROOT_KEY}}/...` |

### `run` — Execute a script inside the knowledge unit

```json
{
  "action": "run",
  "script": "scripts/validate.py",
  "args": ["--target", "{{TARGET}}"],
  "interpreter": "python"
}
```

| Field | Required | Description |
|---|---|---|
| `script` | ✅ | Script path relative to knowledge unit folder root |
| `args` | Optional | Array of string arguments (`{{KEY}}` placeholders are replaced) |
| `interpreter` | Optional | One of: `python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`, `cmd`. Auto-detected from file extension (`.py`, `.js`, `.mjs`, `.cjs`, `.ps1`, `.sh`, `.cmd`, `.bat`) if omitted. |

- Runs with `cwd` set to the knowledge unit folder and a 120-second timeout.
- On Windows, `.ps1` with default `pwsh` automatically falls back to `powershell` if `pwsh` is not installed.

### `message` — Emit progress message

```json
{
  "action": "message",
  "text": "Setting up AG Grid module in {{TARGET}}..."
}
```

## Complete Example

```json
{
  "name": "setup-ag-grid",
  "description": "Scaffold AG Grid testing page objects into an existing project",
  "inputs": {
    "TARGET": {"required": true, "type": "path", "description": "Absolute path to project root"},
    "PACKAGE_NAME": {"required": true, "type": "string", "description": "Java package name"},
    "PACKAGE_PATH": {"required": true, "type": "string", "description": "Java package as slash path"}
  },
  "steps": [
    {"action": "message", "text": "Setting up AG Grid in {{TARGET}}..."},
    {"action": "mkdir", "path": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages"},
    {
      "action": "copy",
      "source": "pages/BaseAngularPage.java",
      "target": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages/BaseAngularPage.java",
      "skip_if_exists": true
    },
    {
      "action": "copy",
      "source": "pages/AgGridPage.java",
      "target": "{{TARGET}}/src/test/java/{{PACKAGE_PATH}}/pages/AgGridPage.java",
      "skip_if_exists": false
    },
    {"action": "run", "script": "scripts/validate.py", "args": ["--target", "{{TARGET}}"]},
    {"action": "message", "text": "Done."}
  ]
}
```
