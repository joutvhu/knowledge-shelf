# CLI Reference

Complete reference for all Knowledge Manager CLI commands.

---

## Global Options

| Option | Description |
|---|---|
| `--dir <path>` | Explicit path to knowledge directory (overrides all other resolution) |

### Knowledge Directory Resolution

The CLI finds the knowledge directory in this order:

1. `--dir <path>` flag (highest priority)
2. `KNOWLEDGE_DIR` environment variable
3. Walk up from CWD looking for a folder containing `.registry.json`
4. `~/.knowledge` (global default)

---

## init

Initialize a knowledge directory.

```bash
knowledge-mcp init
knowledge-mcp init --dir /path/to/custom
```

**Creates:**
- `.registry.json` — empty source registry
- `.cache/` — temporary directory for git operations
- `.gitignore` — ignores `.cache/` (so registry can be committed)

---

## add

Install knowledge from a git repository.

```bash
knowledge-mcp add <url> [--path <subfolder>] [--name <alias>] [--all]
```

| Option | Description |
|---|---|
| `<url>` | Git repository URL (HTTPS or SSH) |
| `--path <subfolder>` | Install only a specific subfolder.  Uses sparse checkout for speed. |
| `--name <alias>` | Custom name for the installed unit (default: derived from URL or path) |
| `--all` | Auto-detect and install ALL subfolders with `manifest.json` (monorepo mode) |

**Examples:**
```bash
# Single repo = single unit
knowledge-mcp add https://github.com/team/qa-knowledge.git

# Specific subfolder from monorepo (sparse checkout)
knowledge-mcp add https://github.com/team/shared.git --path cucumber-boilerplate --name cucumber

# All manifest-based units from monorepo
knowledge-mcp add https://github.com/team/shared.git --all

# SSH URL
knowledge-mcp add git@github.com:team/private-knowledge.git
```

**Behavior:**
1. Clones repo (shallow, depth=1) to `.cache/`
2. If `--path` specified, uses `git sparse-checkout` (falls back to full clone if unsupported)
3. Copies content to `~/.knowledge/<name>/` (excludes `.git/`)
4. Records source in `.registry.json`
5. Cleans up `.cache/`

**Errors:**
- Fails if name already exists (use `update` instead)
- Fails if `--path` subfolder doesn't exist in repo
- Fails if git is not installed

---

## list

List all installed knowledge sources.

```bash
knowledge-mcp list
knowledge-mcp ls
```

**Output includes:**
- Source name (with `[pinned: version]` if pinned)
- Remote URL and subfolder path
- Current commit hash
- Last updated timestamp

---

## info

Show detailed information about a specific knowledge unit.

```bash
knowledge-mcp info <name>
```

**Output includes:**
- Type, version, description, tags
- Doc file, modules, workflows, scripts, references (if manifest-based)
- File count and total disk size
- Source URL, commit, install/update timestamps
- Whether it's from registry or local-only

---

## search

Search installed knowledge by keyword.

```bash
knowledge-mcp search <keywords>
```

Uses the same scoring algorithm as the MCP `search_docs` tool (excluding section headings):

| Match location | Score |
|---|---|
| `aliases` | 12 |
| `title` | 10 |
| `tags` | 8 |
| `type` | 7 |
| `modules` | 6 |
| filename | 6 |
| `description` | 2 |

Returns top 10 results sorted by relevance.

**Examples:**
```bash
knowledge-mcp search cucumber
knowledge-mcp search "spring boot testing"
knowledge-mcp search boilerplate java
```

---

## validate

Check knowledge unit integrity.

```bash
knowledge-mcp validate          # Validate all manifest-based units
knowledge-mcp validate <name>   # Validate specific unit
```

**Checks performed:**
- `manifest.json` is valid JSON
- Required fields present: `name`, `version`, `type`, `description`
- `name` matches folder name
- `doc` file exists (if specified)
- All `modules.*.files` exist on disk
- All `modules.*.guide` files exist (warning if missing)
- All `modules.*.dependencies` reference valid module names
- All `scripts.*.file` exist on disk
- All `references.*.file` exist on disk
- All workflow JSON files exist and are valid
- Workflow files have a `steps` array

**Exit code:**  1 if any errors found, 0 otherwise.

---

## update

Pull latest changes from remote repositories.

```bash
knowledge-mcp update            # Update all sources
knowledge-mcp update <name>     # Update specific source
```

**Behavior:**
- Skips pinned sources (shows "Skipping ... (pinned to ...)")
- Fresh shallow clone → compare commit hash → replace if changed
- Reports: updated count, failed count, already-up-to-date

---

## pin

Lock a source to prevent updates.

```bash
knowledge-mcp pin <name>              # Pin to current commit
knowledge-mcp pin <name> <version>    # Pin to specific tag/commit
```

Pinned sources are skipped during `update`.  The pin value is stored in `.registry.json`.

---

## unpin

Unlock a pinned source.

```bash
knowledge-mcp unpin <name>
```

After unpinning, the source will be updated normally.

---

## export

Package a knowledge unit as an archive for sharing.

```bash
knowledge-mcp export <name> [--output <path>] [--format zip|tar]
```

| Option | Default | Description |
|---|---|---|
| `--output <path>` | `./<name>.zip` | Output file path |
| `--format zip\|tar` | `zip` | Archive format (tar produces `.tar.gz`) |

**Examples:**
```bash
knowledge-mcp export cucumber                              # → ./cucumber.zip
knowledge-mcp export cucumber --output ~/share/cuke.zip    # Custom path
knowledge-mcp export cucumber --format tar                 # → ./cucumber.tar.gz
```

Uses PowerShell `Compress-Archive` on Windows, `zip`/`tar` on Unix.

---

## remove

Remove an installed knowledge unit.

```bash
knowledge-mcp remove <name>
knowledge-mcp rm <name>
```

Deletes the directory and removes the entry from `.registry.json`.  If the unit exists on disk but not in registry, it's still deleted (with a note).

---

## Environment Variables

| Variable | Description |
|---|---|
| `KNOWLEDGE_DIR` | Override knowledge directory path (priority 2, after --dir) |

---

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (missing args, not found, validation failures, git errors) |
