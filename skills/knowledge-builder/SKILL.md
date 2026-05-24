---
name: knowledge-builder
description: "Build, scaffold, and maintain knowledge base units.  Also generates reference documentation from library/framework source code.  Use when: creating new knowledge from scratch, converting existing docs into manifest-based knowledge, adding modules/workflows/scripts, generating docs from source code, or validating knowledge structure.  Triggers on: 'create knowledge', 'build knowledge', 'new knowledge', 'add module to knowledge', 'add workflow', 'scaffold knowledge', 'knowledge manifest', 'convert to knowledge', 'generate knowledge from source', 'write knowledge docs', 'analyze library for knowledge'."
---

# Knowledge Builder

Helps users create and maintain knowledge base units for the Knowledge Base MCP Server.

## What This Skill Does

1. **Scaffold new knowledge** — Create manifest.json + folder structure from scratch
2. **Add modules** — Add new modules (with files, dependencies, guide) to existing knowledge
3. **Add workflows** — Create workflow JSON definitions for automation
4. **Add scripts** — Create automation scripts with proper conventions
5. **Add references** — Create reference documentation
6. **Add integration guides** — Write step-by-step instructions for wiring code into projects
7. **Convert legacy** — Upgrade loose .md files into manifest-based knowledge units
8. **Validate** — Check knowledge structure for completeness and consistency
9. **Generate docs from source** — Analyze library source code and produce reference documentation

## References (load on demand)

For detailed schemas, templates, and guidelines, read these files:

| Reference | When to read |
|---|---|
| `references/manifest-schema.md` | Creating/modifying manifest.json |
| `references/workflow-schema.md` | Creating workflow JSON files |
| `references/integration-guide-template.md` | Writing integration guides for modules |
| `references/writing-for-ai.md` | Best practices for AI-consumable content |
| `references/source-code-analysis.md` | Generating docs from library source code |

## Workflow

### Step 1:  Understand what user wants

Ask:
- What type of knowledge?  (boilerplate, template, toolkit, cookbook)
- What language/framework?
- What's the purpose?
- Does it already exist (upgrade) or start from scratch?

### Step 2:  Determine knowledge directory

Find where knowledge lives:
- Check if `KNOWLEDGE_DIR` env var is set
- Look for `~/.knowledge/` (global default)
- Or ask user for the path

### Step 3:  Read relevant references

Before creating content, **always** read `references/writing-for-ai.md` first, then read the task-specific reference:
- Scaffolding → read `references/manifest-schema.md`
- Adding workflow → read `references/workflow-schema.md`
- Module with integration needs → read `references/integration-guide-template.md`
- Generating from source → read `references/source-code-analysis.md`

### Step 4:  Scaffold or modify

Based on user's needs, create/modify files in the knowledge directory.

### Step 5:  Validate

After creating/modifying, run validation:
```bash
knowledge-mcp validate <name>
knowledge-mcp info <name>
```

## Quick Reference

### Minimum viable knowledge

```
<knowledge-dir>/<name>/
├── manifest.json              ← only required file
└── (resources, references, scripts, workflows — all optional)
```

### manifest.json template

> `$schema` is a convention — not validated by the server.

```json
{
  "$schema": "knowledge-manifest/1.0",
  "name": "<name>",
  "version": "1.0.0",
  "type": "<boilerplate|template|toolkit|cookbook>",
  "doc": "<optional-doc-file.md>",
  "description": "<1-2 sentence description for search>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "modules": {},
  "scripts": {},
  "workflows": {},
  "references": {},
  "placeholders": {}
}
```

### Required fields

| Field | Rules |
|---|---|
| `name` | Must match folder name.  Lowercase, hyphens, numbers only. |
| `version` | Semantic version (e.g., `"1.0.0"`) |
| `type` | One of: `boilerplate`, `template`, `toolkit`, `cookbook` |
| `description` | 1-2 sentences.  Drives search relevance — be specific. |

### Knowledge Types (guidelines, not enforced)

| Type | Modules | Scripts | Code | Primary use |
|---|---|---|---|---|
| `boilerplate` | ✅ | ✅ | ✅ | Copy code partially into projects |
| `template` | ❌ | ✅ | ✅ | Scaffold entire projects |
| `toolkit` | ❌ | ✅ | ❌ | Run scripts for tasks |
| `cookbook` | ✅ | ❌ | ⚠️ | Patterns and guides |

### Adding components (quick syntax)

**Module:**
```json
"modules": {
  "<name>": {
    "description": "<what it provides>",
    "files": ["<path/File>"],
    "guide": "references/<name>-guide.md",
    "dependencies": ["<other-module>"],
    "tags": ["<keyword>"]
  }
}
```

**Workflow:**  Create `workflows/<name>.json` (see `references/workflow-schema.md`), then:
```json
"workflows": { "<name>": {"description": "<what it does>"} }
```

**Script:**
```json
"scripts": {
  "<name>": {
    "file": "scripts/<name>.py",
    "description": "<what it does>",
    "args": { "--target": {"required": true, "type": "path", "description": "Target dir"} }
  }
}
```

**Reference:**
```json
"references": { "<name>": {"file": "references/<name>.md", "description": "<what it covers>"} }
```

### Placeholder convention

Format: `{{UPPER_SNAKE_CASE}}` — declared in manifest `placeholders` field:
```json
"placeholders": {
  "PACKAGE_NAME": {"description": "Target Java package", "example": "com.example.qa"}
}
```

## Converting Legacy to Manifest-Based

1. Identify the legacy .md file(s)
2. Create a subfolder with the knowledge name
3. Move .md files into the subfolder (as references or doc)
4. Create `manifest.json` with metadata extracted from frontmatter
5. Set `"doc"` field to the main .md file
6. Validate: `knowledge-mcp validate <name>`

## Important Rules

1. **manifest.json is the only required file** — everything else is optional
2. **Folder name must match manifest `name`**
3. **Scripts must be self-contained** — no imports from outside the knowledge folder
4. **Placeholders only for project-specific values** — not for logic
5. **Workflows reference files relative to knowledge folder root**
6. **Always write integration guides** when modules need to be wired into existing code
7. **Always read `references/writing-for-ai.md`** before creating content — follow its guidelines
8. **Test with CLI** — `knowledge-mcp validate`, `knowledge-mcp info`

## Validation Checklist

- [ ] Required fields present: `name`, `version`, `type`, `description`
- [ ] `name` matches folder name
- [ ] All `modules.*.files` exist on disk
- [ ] All `scripts.*.file` exist on disk
- [ ] All `references.*.file` exist on disk
- [ ] Workflow JSON files valid with `steps` array
- [ ] Module `dependencies` reference valid module names
- [ ] `doc` file exists (if specified)
- [ ] Placeholders use `{{UPPER_SNAKE_CASE}}` format
- [ ] Tags: 8-12 keywords covering language, framework, domain
- [ ] Description: specific, searchable terms
- [ ] Integration guide exists for modules that need wiring
