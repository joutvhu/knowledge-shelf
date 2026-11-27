# Changelog

## [1.1.0] - 2026-11-28

### Added
- Added `get_module` MCP tool to resolve a manifest module's files, wiring guides, placeholders, and transitive dependencies in topological order.
- Added layered knowledge directory support via repeatable `--dir`, `KNOWLEDGE_DIRS` env var, `--include-global`, `--no-global`, and workspace `.agents/knowledges` auto-discovery.
- Added MCP server governance flags `--read-only` (`KNOWLEDGE_READ_ONLY`) and `--strict-trust` (`KNOWLEDGE_STRICT_TRUST`), along with `knowledge-shelf trust <name>` / `untrust <name>` CLI commands.
- Added `sync`, `catalog`, `outdated`/`status`, `scaffold`, `index`, `publish`, and `import` CLI commands for team synchronization, remote repository discovery, monorepo indexing, hygiene-checked publishing, and archive installation.
- Added `install <path> [--name <alias>] [--force] [--all]` CLI command to validate and install drafted knowledge units or standalone `.md` files from a local directory.
- Added support for passing direct local paths to `validate` before installing into the knowledge directory.
- Added `--ref`, `--pack`, `--force`, `--no-verify`, `--trust`, and `--pin` options to `add`, and `--no-verify` to `update`, `sync`, and `pin`.
- Added `fullCommit` field to `.registry.json` source entries to store full 40-character commit SHAs for exact comparisons during frozen sync.
- Added support for publishing standalone `.md` files directly into a remote target repo with frontmatter validation, `--message`/`-m`, and hygiene checks.
- Added `type`, `tags`, `unit`, and `include_content` filters plus `total_matches` / `truncated` metadata to `search_docs` (and `--type`, `--tag`/`--tags`, `--unit`, `--content`, `--max` to CLI `search`), along with `applies_to` / `references` scoring, whole-token priority, and `deprecated` down-ranking.
- Added `offset`/`limit` line slicing and Markdown `section` extraction to `get_resource`, and `sections` heading lists to `list_docs`.
- Added `dry_run` preview mode, conditional `when` expressions (`input`, `exists`, `not_exists`), `copy_dir`, `patch`, and `message` actions, and custom `workflows.*.file` paths for workflows.
- Added support for custom `type` categories (any non-empty string) in manifests, schema, and `search_docs` filter in addition to built-in types.
- Added JSON Schemas under `schemas/` (`manifest-v1`, `workflow-v1`, `shelf-v1`, `knowledge-shelf-config-v1`) and in-memory index caching across directory scans.

### Security
- Enforced strict path containment (`resolveInsideDir`) across `manifest.doc`, case-insensitive document lookups, workflow names, workflow `copy` sources, workflow `copy`/`mkdir` target paths, `.cache/` clone targets, and all CLI commands (`remove`, `add`, `update`, `info`, `export`, `validate`, `pin`).
- Blocked reserved, dot-prefixed (`.hidden`, `.cache`, `.registry.json`), absolute, drive-prefixed, and parent-traversal (`..`) unit names across `tryResolveSafeUnitDir()`, `resolveSafeUnitDir()`, `cmdInstall`, `cmdScaffold`, `cmdInfo`, and `cmdExport`.
- Added Zip Slip, Tar Slip, and symlink/hardlink protection (`assertSafeArchivePaths`, `assertNoSymlinks`, `extractArchiveSafely`) for `import` and `update` archive extraction.
- Prevented unit nesting conflicts and namespace directory overwrites (`checkUnitNestingConflict`) across `add`, `sync`, and `install`.
- Normalized unit names (backslashes, trailing slashes) in registry matching and `isUnitTrusted` so legacy `.registry.json` entries cannot bypass `--strict-trust`.
- Sanitized repository names derived from git URLs (`deriveNameFromUrl`) and verified `.cache/` containment (`getCloneTarget`) so URLs ending in `..`, `.`, or `.git` cannot delete the knowledge directory.
- Hardened Windows `.cmd`/`.bat` script and shim execution (`isSafeCmdArg`, `resolveWindowsExecutable`) by resolving shims in `PATH`/`PATHEXT` order and rejecting arguments or paths containing `cmd.exe` metacharacters (`" % ! ^ & | < >` or control characters).
- Protected internal dot-prefixed paths (`.registry.json`, `.cache`, `.git`) from removal via `knowledge-shelf remove`.
- Hygiene scanner enhancements: scanned copy set across dot-prefixed folders and `node_modules`, detecting sensitive files (`.env`, `.env.*`, `.npmrc`, `.netrc`, `.pypirc`, `.secret*`), token patterns (GitHub tokens `ghp_`/`gho_`/`github_pat_`, AWS access key IDs `AKIA...`, Slack tokens `xoxb-`/`xoxp-`, PEM private keys), and hardcoded secret assignments, while ignoring placeholder expressions, masked values, type keywords, and code/env references.
- Prevented credential leakage: scanner warning messages never include raw secret values.
- Safeguarded `cmdPublish`: blocked hidden destination segments (e.g. `units/.hidden`, `.git`), refused wiping existing container directories or overwriting regular files when `--path` omits a trailing slash, and preserved repository infrastructure files (`.github/`, `.gitignore`, `.gitattributes`, `LICENSE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `README.md`) when publishing to repo root (`--path .`).
- Excluded `.git/` directories from exported `.tar.gz` and `.zip` archives and refused exporting an archive inside the exported unit directory itself.
- Capped `expandBraces` expansion count against exponential blowup and restricted `--read-only` / `--strict-trust` CLI flag ignoring to pre-subcommand positions.
- Enforced validation of all standalone files in `cmdAdd` (rejecting non-markdown single files unless `--no-verify` is passed) and validated undeclared `workflows/*.json` files inside units.

### Fixed
- Fixed `--no-global` isolation in `resolveKnowledgeDirs`, CLI commands, and MCP server so empty workspaces neither leak global `~/.knowledge` docs nor mutate global state.
- Fixed `cmdSync` and `cmdSync --frozen`: normalized source subpaths, verified URL/path/branch match before skipping updates at the same commit, enforced local checksum drift checks in both normal and `--frozen` modes, supported `.md` extension fallback, avoided inheriting `trusted`/`branch` when URL changes, persisted valid units while isolating unsafe entries, and supported 40-char SHAs, >=7-char hex prefixes, and `branch` + `pin` combinations.
- Fixed multi-layer CLI handling across `publish`, `outdated`, `update`, `pin`, `unpin`, `trust`/`untrust`, `info`, `list`, `validate`, `export`, and `remove`: warn and skip corrupted registries in multi-layer mode while failing cleanly in single-layer mode, deduplicate tracked sources case-insensitively on Windows, prevent `cmdRemove` from deleting lower-layer units when shadowed by an unmanaged unit or deleting workspace `.agents/knowledges` drafts when `--dir` is omitted.
- Fixed nested unit name support (`team/foo`) across `add --name`, `install --name`, `export`, `import --name`, `update`, `sync`, and `validateManifestUnitDir`.
- Fixed `cmdExport` and `cmdImport`: fixed `zip` CLI argument passing, supported `--output` targeting an existing directory, appended `.tar.gz`/`.zip` when omitted, preserved nested prefixes and dotfiles (excluding `.git/`), automatically unwrapped wrapped multi-unit archives, and unwrapped single units containing nested template `manifest.json` files on `import --name`.
- Fixed `cmdPublish`: handled standalone `.md` files with `--path <dir>` (no trailing slash), updated `shelf.json` on target branches, based updates on `refs/remotes/origin/<targetBranch>` without force-pushing, reported "No changes to publish" when content matches, prioritized explicit `--dir` over same-named CWD folders, and rejected bare help flags while accepting commit messages with leading dashes.
- Fixed `cmdValidate`: failed with `Path not found` for nonexistent explicit local paths, prioritized installed units over CWD when `--dir` is explicit, discovered nested units/docs across layers while skipping root `manifest.json` and nested template manifests, rejected directories in `modules.files` (including under brace expansion) and `when.exists` without root placeholder, and validated `tags`, `aliases`, `placeholders`, `inputs`, `run.args`, `message.text`, and `copy_dir.exclude` schemas.
- Fixed `cmdInfo`, `cmdCatalog`, `cmdIndex`, and `cmdList`: reported JSON syntax errors on malformed `manifest.json`, discovered nested standalone `.md` files when `shelf.json` is absent, created missing `--output` parent directories for `index`, suppressed child units of tracked monorepos from unmanaged lists, and matched standalone `.md` names without `.md` extension.
- Fixed `search_docs` and CLI `search`: normalized `unit` filter (trim, `./`, trailing `/`, backslashes, optional `.md`), ignored whitespace-only filters, applied `deprecated` down-ranking to total scores including content hits, filtered <=2-char terms by whole-token boundary in content search, and prevented malformed manifest fields from crashing ranking.
- Fixed `toolRunWorkflow` and workflow execution:
  - Simulated sequential `copy`, `copy_dir`, `patch` (`create_if_missing`), and `mkdir` steps in a `dry_run` virtual filesystem so `when.exists`/`when.not_exists` and chained `patch` steps evaluate accurately.
  - Refused `patch` steps on binary files in both `dry_run` and real runs, matched LF multi-line `anchor`/`skip_if_contains` on CRLF files while preserving CRLF, prevented duplicate blank lines on `insert_after`, and rejected empty anchors or non-object steps.
  - Terminated spawned child process trees on `run` timeout (`taskkill /T /F` on Windows, process group `SIGKILL` on POSIX), clamped/validated `timeout_ms` (1000–600000 ms), and improved error reporting when `cwd` does not exist.
  - Collected placeholders across `when.input`, `patch` `anchor`/`skip_if_contains`, and `copy`/`copy_dir` template contents and filenames; skipped `manifest.placeholders` required checks and `--strict-trust` blocking when steps are skipped by `when.input`; prevented `manifest.placeholders.*.default` from bypassing `workflow.inputs.*.required: true`; respected `render_filenames: false`; and guarded against `Object.prototype` keys.
  - Copied binary files as raw buffers in `copy`/`copy_dir`, prioritized `manifest.scripts[script_ref]`, and reported `--strict-trust` script warnings in `dry_run`.
- Fixed `toolGetManifest`, `toolGetDoc`, `toolGetDocSection`, `toolGetResource`, and MCP resources: rejected non-object/array `manifest.json`, supported nested `.md` files inside manifest units with or without `.md` extension, ignored inline triple backticks and `#` comments in fenced blocks in `extractSections`, added diacritic-folding fallback in `get_doc_section`, prevented inverted line headers when `offset` exceeds file length, detected binary resources via `NUL` bytes, set `isError: true` on error responses, percent-encoded resource URIs, and added `title` to MCP resource listings.
- Fixed `parseFrontmatter`, `stripBom`, and `index-cache`: prevented `---` horizontal rules from truncating markdown bodies, stripped UTF-8 BOM before JSON parsing, matched `README.md` case-insensitively, indexed uppercase `.MD` files, and invalidated index cache when any non-markdown reference file changes.
- Fixed CLI entrypoint, registry safety, and cross-platform behavior: showed help in interactive TTY mode without arguments, exited 1 promptly on unknown commands in non-TTY mode, fixed `VAL_OPTIONS` (`-f`, `--dir`, `--key=val`, empty `--opt=`), rejected unexpected extra positional arguments, added PID-aware `.registry.lock` reclamation (`withRegistryLock`), atomic `.registry.json` and directory replacement (`saveRegistry`, `replaceDirSync`, `renameWithRetry`), and prioritized `KNOWLEDGE_DIRS` over `KNOWLEDGE_DIR` and `.agents/knowledges` over global fallback.
- Added `schemas/` to package distribution files in `package.json`.

### Changed
- Refactored core and CLI logic into modular `src/core/*` and `src/cli/*` modules with `src/server.ts` MCP server factory, unifying search scoring between the MCP server and CLI.
- Updated `update` CLI command to use sparse checkout for subfolder sources (`--path`), and updated `validate` and `add --all` to discover nested manifest units recursively.
- Replaced duplicated `tests/tool-helper.mjs` test harness with direct MCP SDK `Client` + `InMemoryTransport` and `StdioClientTransport` integration tests against the real server, and added GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- Updated `README.md`, `docs/`, `schemas/workflow-v1.schema.json`, and `skills/knowledge-builder/` documentation to match 1.1.0 features and `$schema` URLs.
- Updated `@modelcontextprotocol/sdk`, `zod`, and `vitest` to patch transitive dependency vulnerabilities, and bumped `engines.node` to `>=20.0.0`.

### Removed
- Removed `install-skill` CLI command in favor of `npx skills add joutvhu/knowledge-shelf`.

## [1.0.3] - 2026-05-31

### Added
- Added new `install-skill` CLI command to easily install the bundled `knowledge-builder` skill directly into an agent's skills directory.
- Enabled `install-skill` to automatically default to the current working directory (`.`) if no path argument is provided.
- Added comprehensive integration tests in `tests/cli.test.ts` to verify programmatic copying and overwriting of bundled skills.

## [1.0.2] - 2026-05-31

### Refactored
- Migrated MCP server setup from the deprecated `Server` to the recommended `McpServer` API (`@modelcontextprotocol/sdk/server/mcp.js`).
- Migrated tool registrations from manual `setRequestHandler` + `ListToolsRequestSchema`/`CallToolRequestSchema` to `server.registerTool`.
- Replaced plain JSON Schema objects with Zod-based type-safe input schemas (`z.object()`) for all tools — enables automatic argument validation by the SDK.
- Added `zod` as a runtime dependency.

### Fixed
- Fixed `run_workflow` `inputs` parameter type: changed from `string` (requiring manual `JSON.stringify` by the caller) to `object` (`z.record(z.string(), z.string())`), matching MCP conventions. Updated `toolRunWorkflow` to accept `unknown` and coerce values to string instead of calling `JSON.parse`.
- Fixed `list_docs` tool description which had been incorrectly set to a context-gatherer agent description unrelated to the tool's purpose.

### Changed
- Added MCP server `instructions` field with guidance on when and how to use each tool, recommended call order (`search_docs` → `get_manifest` → `get_doc`/`get_doc_section`/`get_resource` → `run_workflow`), and the two knowledge formats.
- Improved all tool descriptions with usage guidance, cross-tool hints, and path format examples:
  - `search_docs`: clarified it should be called first before any task; documented scoring order.
  - `get_doc`: added hint to prefer `get_doc_section` for large documents.
  - `get_doc_section`: noted context efficiency and partial heading match support.
  - `get_resource`: added "use `get_manifest` first to discover paths" and path format example.
  - `get_manifest`: added "always call before `run_workflow`" guidance.
  - `run_workflow`: noted side effects (file creation, script execution).
- Improved all tool parameter descriptions with path format clarifications (relative to knowledge directory root) and concrete examples.

## [1.0.1] - 2026-05-30

### Security
- Fixed path traversal vulnerability in `get_doc`, `get_manifest`, and `run_workflow` — all tool inputs are now validated to stay inside the knowledge directory
- Fixed command injection in workflow `run` steps — replaced `execSync` string concatenation with `spawnSync` array args (shell is never invoked)
- Fixed command injection in CLI git operations (`add`, `update`) — replaced `execSync` string interpolation with `spawnSync` array args
- Fixed PowerShell command injection in `export` on Windows — single quotes in paths are now escaped with `''`
- Fixed symlink traversal in `get_resource`, `get_doc`, `get_manifest`, `run_workflow` — `realpathSync` is used to resolve symlinks before boundary check, and the resolved canonical path is returned to callers
- Fixed script path traversal in workflow `run` steps — script path is validated to stay inside the knowledge unit folder before execution
- Fixed missing cleanup of temporary clone directory on `add` failure
- Added interpreter whitelist for workflow scripts (`python`, `python3`, `node`, `pwsh`, `powershell`, `bash`, `sh`)

### Performance
- `walkDir` in both MCP server and CLI now skips `.git`, `.cache`, and `node_modules` directories

### Fixed
- Frontmatter parsing in MCP server now uses `\r?\n` split for consistent behavior on Windows (CRLF line endings)

### Changed
- Added `repository`, `homepage`, and `bugs` fields to `package.json` for npm registry display

## [1.0.0] - 2025-05-24

Initial release of Knowledge Shelf — a personal knowledge management system for AI coding assistants, built as an MCP server.

### MCP Server

Give your AI on-demand access to your local knowledge base through 7 tools:

- **`list_docs`** — Discover all available knowledge units and documents
- **`search_docs`** — Find relevant knowledge by keyword with relevance scoring
- **`get_doc`** — Read the main documentation of a knowledge unit
- **`get_doc_section`** — Read a specific section without loading the full document
- **`get_resource`** — Read code files, templates, and configs from a unit
- **`get_manifest`** — Inspect what a unit contains (modules, workflows, references)
- **`run_workflow`** — Execute multi-step automation (scaffold, copy files, run scripts)

**Knowledge formats supported:**
- Manifest-based units — folders with `manifest.json` for code patterns, templates, and workflows (supports modules, scripts, references, placeholders)
- Standalone `.md` documents — plain markdown files with optional YAML frontmatter (`description`, `tags`, `aliases`)

**Search scoring:** aliases (12) → title (10) → tags (8) → type (7) → modules/filename (6) → sections (4) → description (2)

**Security:** Path traversal protection on `get_resource`

**Default knowledge directory:** `~/.knowledge`

### Knowledge Shelf CLI

Manage knowledge sources from git repositories — like npm for documentation.

- **`init`** — Initialize knowledge directory with `.gitignore` and registry
- **`add`** — Clone from git repos; supports `--path`, `--name`, `--all`, and sparse checkout
- **`list`** — Show installed sources with origin and version
- **`info`** — Detailed view of a knowledge unit (type, modules, size, source)
- **`search`** — CLI keyword search using the same scoring as the MCP tool
- **`validate`** — Check manifest integrity (required fields, file references, workflow JSON)
- **`update`** — Pull latest from remotes (respects pinned sources)
- **`pin`** / **`unpin`** — Version locking to prevent unwanted updates
- **`export`** — Package a unit as `.zip` or `.tar.gz` for sharing
- **`remove`** — Delete a knowledge unit and its registry entry

**Directory resolution order:** `--dir` flag → `KNOWLEDGE_DIR` env → walk-up `.registry.json` → `~/.knowledge`

### Bundled Skill

- `knowledge-builder` — AI-assisted skill for scaffolding new knowledge units, generating reference docs from source code, converting loose docs into manifest-based units, and validating structure

### Documentation

- `docs/cli-reference.md` — Full CLI command reference (11 commands, options, exit codes)
- `docs/tools-reference.md` — MCP tool parameters, responses, and examples
- `docs/knowledge-folder-guide.md` — How to organize knowledge directories and write manifests
- `docs/publishing-knowledge.md` — Git repo layouts for team sharing
