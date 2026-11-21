# Changelog

## [1.1.1]

### Added
- Added `--no-verify` flag to `update`, `sync`, and `pin` commands to bypass validation of fetched content.
- Added `fullCommit` field to `.registry.json` source entries to store full 40-character commit SHAs for exact comparisons during frozen sync.

### Fixed
- **B1, B2**: Hygiene scanner enhancements: scanned copy set across dot-prefixed folders and `node_modules`, detecting sensitive files (`.env`, `.env.*`, `.npmrc`, `.netrc`, `.pypirc`, `.secret*`), token patterns (GitHub tokens `ghp_`/`gho_`/`github_pat_`, AWS access key IDs `AKIA...`, Slack tokens `xoxb-`/`xoxp-`, PEM private keys), and hardcoded secret assignments, while safely ignoring placeholder expressions.
- **B3**: Fast-forward publish on existing remote branches based on the remote branch tip (never force-pushes), with clean no-op handling reporting "No changes to publish" without creating empty commits if remote branch content already matches.
- **B4**: Direct publishing of standalone `.md` files into a remote target repo with frontmatter validation and hygiene checks.
- **B5**: Fixed `sync --frozen` to support 40-character full commit SHAs (prefix matching for hex SHAs >= 7 characters) and resolved git tags/branches against `regEntry.pin` and remote commits.
- **B6**: Fixed `sync` to detect local modifications via checksum comparison and skip modified units without overwriting unless `--force` is specified.
- **B7**: Staging validation and `--no-verify` flag on `update`, `sync`, and `pin` to stage and validate incoming content before replacing installed units, preventing broken remote versions from overwriting working local units.
- **B8**: Checksum coverage across dot-files and `node_modules` with backward-compatible legacy fallback for older checksums.
- **B9**: Atomic registry writes via tempfile + rename in `saveRegistry` to prevent corrupted `.registry.json` on unexpected process termination.
- **B10**: Support for custom `type` categories (any non-empty string) in manifests, schema, and MCP `search_docs` search filter in addition to built-in types.
- **B11**: Manifest placeholders resolution and enforcement (`default`, `required`, and regex `pattern` validation) in `toolRunWorkflow` for used placeholders.
- **B12**: Strict shape validation for `scripts.*.args` (`required: boolean`, string `type` and `description`, optional `default`) and documented the field as informational.
- **B13**: Integer range validation for `timeout_ms` (1000..600000 ms) in scripts and workflows.

## [1.1.0] - 2026-11-19

### Added
- Added `install <path> [--name <alias>] [--force] [--all]` CLI command to validate and install drafted knowledge units or standalone `.md` files from a local directory.
- Added support for passing direct local paths to `validate` before installing into the knowledge directory.

### Security
- Enforced strict path containment (`resolveInsideDir`) across `manifest.doc`, case-insensitive document lookups, workflow names, workflow `copy` sources, workflow `copy`/`mkdir` target paths, `.cache/` clone targets, and all CLI commands (`remove`, `add`, `update`, `info`, `export`, `validate`).
- Sanitized repository names derived from git URLs (`deriveNameFromUrl`) and verified `.cache/` containment (`getCloneTarget`) so URLs ending in `..`, `.`, or `.git` cannot delete the knowledge directory.
- Hardened Windows `.cmd`/`.bat` script execution (`isSafeCmdArg`) by rejecting arguments containing `cmd.exe` metacharacters (`" % ! ^ & | < >` or control characters) that could trigger command injection or environment variable expansion (BatBadBut class of issues).
- Protected internal dot-prefixed paths (`.registry.json`, `.cache`, `.git`) from removal via `knowledge-shelf remove`.

### Fixed
- Fixed data loss in `parseFrontmatter` where documents containing `---` horizontal rules in the body were truncated after the first rule.
- Fixed `extractSections` and `get_doc_section` to ignore `#` comment lines inside fenced code blocks (`` ``` `` / `~~~`) and prioritize exact heading matches over partial parent heading matches.
- Fixed binary file corruption in workflow `copy` steps (e.g., `.jar`, `.png`, `.woff2` files are now copied as raw buffers instead of UTF-8 text).
- Fixed binary detection in `get_resource` by checking buffer bytes for `NUL` instead of relying on an unreachable UTF-8 read exception, and set standard MCP `isError: true` on all error tool responses.
- Fixed `run_workflow` to apply `default` values defined in workflow input schemas when optional inputs are omitted.
- Fixed `knowledge-shelf pin <name> <tag|commit>` to check out the requested git ref so on-disk files match the pinned version, and report a clear error for `local:` sources without git history.
- Fixed `findCaseInsensitive` when looking up subfolder documents without the `.md` extension (`guides/deploy` now resolves to `guides/deploy.md` instead of colliding with same-named files in other folders).
- Fixed CLI entrypoint handling for `version`/`--version`/`-v`, `--dir` flag placement before subcommands, missing flag arguments, and unknown options.
- Fixed non-atomic directory replacement during `update`, `install --force`, and `pin` by staging into `.cache/` and swapping via rename with automatic rollback on failure.
- Fixed `loadRegistry` silently resetting `.registry.json` to empty on parse errors; it now exits with an error to prevent erasing existing entries.
- Fixed `add --all` and `install --all` to detect duplicate unit folder names across subdirectories and skip nested child units inside parent manifest units.
- Constrained `search_docs` `max_results` schema to integers between `1` and `100`.

### Changed
- Extracted shared core logic into `src/core.ts` and MCP server factory into `src/server.ts`, unifying search scoring (with whole-token priority and section heading support) between the MCP server and CLI.
- Updated `update` CLI command to use sparse checkout for subfolder sources (`--path`), and updated `validate` and `add --all` to discover nested manifest units recursively.
- Replaced duplicated `tests/tool-helper.mjs` test harness with direct MCP SDK `Client` + `InMemoryTransport` and `StdioClientTransport` integration tests against the real server, and added GitHub Actions CI workflow (`.github/workflows/ci.yml`).
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
