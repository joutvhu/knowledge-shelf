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
    { "action": "mkdir|copy|copy_dir|patch|run|message", ... }
  ]
}
```

## Security & Placeholder Rules (Enforced by MCP Server)

1. **Placeholder format**: `{{KEY}}` where `KEY` matches `/[A-Za-z0-9_]+/`.
2. **Root Path Containment for `copy.target`, `copy_dir.target`, `patch.target`, `mkdir.path`, and `run.cwd`**:
   - Every target/path/cwd **MUST** start with a root placeholder prefix `{{ROOT_KEY}}` (or `{{ROOT_KEY}}/...`, e.g., `{{TARGET}}/src/...`).
   - At runtime, the input value for `ROOT_KEY` **MUST** be an absolute path (`path.isAbsolute(inputs[ROOT_KEY]) === true`).
   - The rendered destination must not contain any unresolved `{{...}}` placeholders and must resolve strictly inside `inputs[ROOT_KEY]` (any `..` or symlink escape is blocked).
3. **Source & Script Containment**:
   - `copy.source`, `copy_dir.source`, and `run.script` are resolved relative to the knowledge unit folder root and must stay strictly inside that unit folder.
4. **Binary-safe `copy` / `copy_dir`**:
   - Text files have `{{KEY}}` placeholders replaced with `inputs[KEY]`. Binary files (detected via null byte in first 8 KB) are copied byte-for-byte without placeholder replacement.
5. **Conditional execution (`when`) & Preview (`dry_run`)**:
   - Any step may specify `"when": { "input": "FLAG", "equals": "true" }` (`equals`, `not_equals`, `in`, `exists`, `not_exists`).
   - `run_workflow` accepts `dry_run: true` to preview file creations, patches, and script commands without modifying disk.

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

### `copy_dir` — Recursively copy and render a template directory

```json
{
  "action": "copy_dir",
  "source": "templates/service",
  "target": "{{TARGET}}/src/{{PACKAGE_PATH}}",
  "exclude": ["**/*.bak"],
  "skip_if_exists": true,
  "render_filenames": true
}
```

| Field | Required | Description |
|---|---|---|
| `source` | ✅ | Relative directory path inside the knowledge unit folder |
| `target` | ✅ | Destination directory starting with `{{ROOT_KEY}}/...` |
| `exclude` | Optional | Glob patterns to skip |
| `skip_if_exists` | Optional | Skip files that already exist at target |
| `render_filenames` | Optional | Replace `{{KEY}}` in relative file/folder names (default: `true`) |

### `patch` — Idempotently patch an existing file

```json
{
  "action": "patch",
  "target": "{{TARGET}}/src/app.config.ts",
  "mode": "insert_before",
  "anchor": "// [providers]",
  "content": "  provideAgGrid(),",
  "skip_if_contains": "provideAgGrid()"
}
```

| Field | Required | Description |
|---|---|---|
| `target` | ✅ | File path starting with `{{ROOT_KEY}}/...` |
| `mode` | Optional | `insert_before`, `insert_after`, `replace`, `append` (default), or `prepend` |
| `anchor` | Conditional | Required for `insert_before`, `insert_after`, and `replace` |
| `content` | ✅ | Content string (`{{KEY}}` placeholders supported) |
| `skip_if_contains` | Optional | Skip patch if file already contains this substring (idempotency) |

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
  "interpreter": "python",
  "cwd": "{{TARGET}}",
  "timeout_ms": 60000
}
```

| Field | Required | Description |
|---|---|---|
| `script` | Conditional | Script path relative to unit root (required unless `script_ref` is given) |
| `script_ref` | Conditional | Key in `manifest.scripts` to inherit `file`, `interpreter`, and `timeout_ms` |
| `args` | Optional | Array of string arguments (`{{KEY}}` placeholders are replaced) |
| `interpreter` | Optional | One of: `python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`, `cmd`. Auto-detected from file extension if omitted. |
| `cwd` | Optional | Working directory starting with `{{ROOT_KEY}}` (defaults to unit folder) |
| `timeout_ms` | Optional | Timeout in milliseconds: integer between 1000 and 600000 (default: `120000`) |

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
