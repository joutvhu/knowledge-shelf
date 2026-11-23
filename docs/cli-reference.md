# CLI Reference

Complete reference for all Knowledge Shelf CLI commands.

---

## Global Options

| Option | Description |
|---|---|
| `--dir <path>` | Explicit path to knowledge directory (repeatable for layered MCP/search/list) |
| `--read-only` | (MCP server) Disable side-effecting workflow execution (`dry_run: true` still allowed) |
| `--strict-trust` | (MCP server) Block script execution in untrusted remote units |
| `--include-global` | (MCP server / CLI) Append `~/.knowledge` after explicit `--dir` layers |
| `--no-global` | (MCP server / CLI) Do not auto-append `~/.knowledge` |

### Knowledge Directory Resolution

The CLI and MCP server find knowledge directories in this order:

1. `--dir <path>` flag(s) (highest priority; first dir is primary writable dir)
2. `KNOWLEDGE_DIRS` (delimited list) or `KNOWLEDGE_DIR` environment variable
3. Walk up from CWD looking for `.agents/knowledges` or `.registry.json` (or `knowledge/.registry.json`)
4. `~/.knowledge` (global default)

---

## init

Initialize a knowledge directory.

```bash
knowledge-shelf init
knowledge-shelf init --dir /path/to/custom
```

**Creates:**
- `.registry.json` — empty source registry
- `.cache/` — temporary directory for git operations
- `.gitignore` — ignores `.cache/` (so registry can be committed)

---

## add

Install knowledge from a git repository.

```bash
knowledge-shelf add <url> [--path <subfolder>] [--name <alias>] [--ref <ref>] [--pack <name>] [--all] [--force] [--no-verify] [--trust] [--pin]
```

| Option | Description |
|---|---|
| `<url>` | Git repository URL (HTTPS or SSH) |
| `--path <subfolder>` | Install only a specific subfolder. Uses sparse checkout for speed. |
| `--name <alias>` | Custom name for the installed unit (default: derived from URL or path) |
| `--ref <ref>` | Specific branch, tag, or commit to checkout |
| `--pack <name>` | Install a named bundle of units declared in repo's `shelf.json` |
| `--all` | Auto-detect and install ALL subfolders with `manifest.json` (monorepo mode) |
| `--force`, `-f` | Overwrite existing installed units |
| `--no-verify` | Skip manifest / document validation before installing |
| `--trust` | Mark remote source as trusted for script execution under `--strict-trust` |
| `--pin` | Automatically pin source to installed commit/ref to prevent updates |

**Examples:**
```bash
# Single repo = single unit
knowledge-shelf add https://github.com/team/qa-knowledge.git

# Specific subfolder from monorepo (sparse checkout)
knowledge-shelf add https://github.com/team/shared.git --path cucumber-boilerplate --name cucumber

# All manifest-based units from monorepo
knowledge-shelf add https://github.com/team/shared.git --all

# SSH URL
knowledge-shelf add git@github.com:team/private-knowledge.git
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

## install

Validate and install locally drafted knowledge (e.g., from `./.agents/knowledges/`) into the active knowledge directory.

```bash
knowledge-shelf install <path> [--name <alias>] [--force] [--all]
```

| Option | Description |
|---|---|
| `<path>` | Local path to a manifest-based folder, a standalone `.md` file, or a parent staging directory (when used with `--all`). |
| `--name <alias>` | Custom name for the installed unit (default: folder/file basename). Not allowed with `--all`. |
| `--force`, `-f` | Overwrite existing knowledge unit of the same name. |
| `--all` | Auto-detect, validate, and install ALL manifest-based units and top-level standalone `.md` files inside `<path>`. |

**Examples:**
```bash
# Validate and install a drafted manifest unit from workspace staging
knowledge-shelf install ./.agents/knowledges/my-boilerplate

# Re-install after making changes in staging
knowledge-shelf install ./.agents/knowledges/my-boilerplate --force

# Install a standalone Markdown reference doc
knowledge-shelf install ./.agents/knowledges/spring-security-guide.md

# Install all drafted units inside ./.agents/knowledges/
knowledge-shelf install ./.agents/knowledges --all --force
```

**Behavior:**
1. Validates the target manifest unit(s) or standalone `.md` file(s) before copying.
2. If any validation error is found, aborts with exit code 1 without modifying the knowledge directory.
3. Copies validated files to `<knowledge-dir>/<name>` (and syncs `manifest.name` if `--name` was passed).
4. Records the source in `.registry.json` with `url: "local:<resolved-path>"` and `commit: "local"`.

---

## list

List all installed knowledge sources.

```bash
knowledge-shelf list
knowledge-shelf ls
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
knowledge-shelf info <name>
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
knowledge-shelf search <keywords> [--type <type>]
```

Uses the exact same scoring algorithm as the MCP `search_docs` tool:

| Match location | Score |
|---|---|
| `aliases` | 12 |
| `title` | 10 |
| `tags` | 8 |
| `type` | 7 |
| `modules` | 6 |
| filename | 6 |
| section headings | 4 |
| `description` | 2 |

Returns top 10 results sorted by relevance.

**Examples:**
```bash
knowledge-shelf search cucumber
knowledge-shelf search "spring boot testing"
knowledge-shelf search boilerplate java
```

---

## validate

Check knowledge unit integrity (for installed units or local draft paths).

```bash
knowledge-shelf validate                                  # Validate all manifest-based units in knowledge dir
knowledge-shelf validate <name>                           # Validate specific installed unit
knowledge-shelf validate ./.agents/knowledges/<name>      # Validate a drafted unit or standalone .md directly by path
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
knowledge-shelf update [name] [--force] [--no-verify]
```

| Option | Description |
|---|---|
| `[name]` | Specific source name to update (updates all sources if omitted) |
| `--force`, `-f` | Overwrite local modifications |
| `--no-verify` | Skip validation of fetched content before installing |

**Behavior:**
- Skips pinned sources (shows "Skipping ... (pinned to ...)")
- Skips locally modified units unless `--force` is passed
- Stages fetched content into a temporary directory and validates it (`validateManifestUnitDir` for manifest units, `validateStandaloneMdFile` for `.md` files) before replacing the installed unit
- If validation fails, the existing installed version and registry entry remain untouched, the unit is counted as failed, and the command exits with code 1 (unless `--no-verify` is passed)
- Reports: updated count, failed count, already-up-to-date

---

## pin

Lock a source to prevent updates.

```bash
knowledge-shelf pin <name> [version] [--no-verify]
```

| Option | Description |
|---|---|
| `<name>` | Installed source name |
| `[version]` | Specific tag or commit SHA to pin (pins to current commit if omitted) |
| `--no-verify` | Skip validation of checked-out ref content before replacing |

**Behavior:**
- Checks out the specified git ref into a staging directory and validates it before replacing installed files.
- On validation error, keeps the installed version and registry unchanged, does not set `pin`, and exits with code 1 (unless `--no-verify` is used).
- Pinned sources are skipped during `update`. The pin value is stored in `.registry.json`.

---

## unpin

Unlock a pinned source.

```bash
knowledge-shelf unpin <name>
```

After unpinning, the source will be updated normally.

---

## export

Package a knowledge unit as an archive for sharing.

```bash
knowledge-shelf export <name> [--output <path>] [--format zip|tar]
```

| Option | Default | Description |
|---|---|---|
| `--output <path>` | `./<name>.zip` | Output file path |
| `--format zip\|tar` | `zip` | Archive format (tar produces `.tar.gz`) |

**Examples:**
```bash
knowledge-shelf export cucumber                              # → ./cucumber.zip
knowledge-shelf export cucumber --output ~/share/cuke.zip    # Custom path
knowledge-shelf export cucumber --format tar                 # → ./cucumber.tar.gz
```

Uses PowerShell `Compress-Archive` on Windows, `zip`/`tar` on Unix.

---

## remove

Remove an installed knowledge unit.

```bash
knowledge-shelf remove <name>
knowledge-shelf rm <name>
```

Deletes the directory and removes the entry from `.registry.json`.  If the unit exists on disk but not in registry, it's still deleted (with a note).

---

## Additional Git, Sync & Sharing Commands

### `catalog <url> [--ref <ref>]`
Inspect available units and packs inside a remote repository (via `shelf.json` or `manifest.json` auto-discovery) before installing.

### `sync [--file <knowledge-shelf.json>] [--frozen] [--force] [--no-verify]`
Install and synchronize all sources declared in `knowledge-shelf.json` (or remote entries in `.registry.json`), deduplicating monorepo clones and honoring pinned refs.

- **Local modification check:** If an installed unit's current checksum differs from `registry.checksum` (local edits), `sync` skips that unit with a message naming the unit and a hint to use `--force`. It does not overwrite files and leaves the registry untouched unless `--force` is provided.
- **Frozen mode (`--frozen`):** Verifies that installed sources match expected versions without network operations. Accepts full 40-character commit SHAs, short SHAs (matching by prefix for hex strings of at least 7 characters), and git tags/branches (matching `regEntry.pin` or resolving remotely to matching commit SHAs). Exits with code 1 if a mismatch or missing unit is found.
- **Staging & Validation:** Fetched content is staged and validated before replacing existing units; invalid manifests abort the unit update and count as failed unless `--no-verify` is used.
- `--no-verify`: Skip validation of fetched content before installing.

### `outdated` / `status`
Check remote commit status and detect local file modifications (`[modified-locally]`) for installed sources.

### `scaffold <name> [--type boilerplate|template|toolkit|cookbook|repo] [--output <dir>]`
Generate a starter knowledge unit or a shareable monorepo skeleton (including `shelf.json` and `.github/workflows/validate-knowledge.yml`).

### `index [dir] [--output <shelf.json>]`
Scan a directory of knowledge units and generate or update `shelf.json`.

### `publish <path> --to <git-url> [--path <dest-path>] [--branch <branch>] [--message <message>] [--push] [--force]`
Validate, hygiene-check, and publish a knowledge unit folder or a standalone `.md` file to a target git repository.

- **Commit message (`--message`, `-m <message>`):** Custom commit message. Defaults to `chore(knowledge): publish <unit> v<version>` (or `chore(knowledge): publish <file>` for standalone documents).

- **Standalone `.md` publishing:** Accepts either a manifest-based unit directory or a standalone `.md` file. Validates markdown frontmatter and copies the file to the target repo at `--path` if given, or at the repo root under its own filename if omitted.
- **Path destination (`--path <dest-path>`):** For a directory unit, specifies the destination subfolder in the target repo. For a standalone `.md` file, specifies the destination path/file in the target repo.
- **Default branch:** If `--branch` is omitted, defaults to `knowledge/<name>-<version>` for manifest units and `knowledge/<name>` for standalone markdown files.
- **Fast-forward onto existing remote branches:** If the target branch exists on the remote, `publish` fetches and bases the working branch on the remote branch tip, applying the unit content as a new commit on top of it.
- **Never force-pushes:** `publish` pushes strictly as a fast-forward and never uses `--force` on git push. `--force` on the command line only overrides pre-publish hygiene check warnings (e.g., detected secrets, sensitive files). If push is rejected by the remote, `publish` fails with exit code 1 without altering remote history. If the unit already matches the branch content, it prints "No changes to publish" and exits 0.

### `import <archive.zip|.tar.gz> [--name <alias>] [--force] [--all] [--trust]`
Extract, validate, and install a packaged knowledge unit or standalone `.md` file from a `.zip` or `.tar.gz` archive. Use `--all` for multi-unit archives and `--trust` to mark imported archive unit(s) as trusted for script execution under `--strict-trust`.

### `trust <name>` / `untrust <name>`
Manage per-unit script execution trust when running the MCP server with `--strict-trust`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `KNOWLEDGE_DIRS` | Delimited list (`;` on Windows, `:` on Unix) of layered knowledge directories (highest priority first) |
| `KNOWLEDGE_DIR` | Override single knowledge directory path (priority 2, after `--dir`) |
| `KNOWLEDGE_READ_ONLY` | Set `1` or `true` to disable side-effecting workflow execution (`dry_run: true` remains allowed) |
| `KNOWLEDGE_STRICT_TRUST` | Set `1` or `true` to block workflow `run` steps in untrusted remote units |

### How to Set KNOWLEDGE_DIR Permanently

To avoid passing the `--dir` flag on every CLI execution, you can configure the environment variable persistently:

#### macOS & Linux
Append the following line to your shell configuration (e.g., `~/.zshrc` or `~/.bashrc`):
```bash
export KNOWLEDGE_DIR="$HOME/.kiro/knowledge"
```
Then reload the configuration: `source ~/.zshrc`

#### Windows (PowerShell)
Execute this command in PowerShell to set a user-level environment variable:
```powershell
[Environment]::SetEnvironmentVariable("KNOWLEDGE_DIR", "$HOME\.kiro\knowledge", "User")
```

#### Windows (GUI)
1. Search for **"Environment Variables"** in Windows Search and select **"Edit the system environment variables"**.
2. Click **"Environment Variables..."**.
3. Under **"User variables"**, click **"New..."** and enter:
   - **Variable name:** `KNOWLEDGE_DIR`
   - **Variable value:** `C:\Users\YourUsername\.kiro\knowledge`
4. Click **OK** to save. Restart your terminal for changes to take effect.

---

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (missing args, not found, validation failures, git errors) |
