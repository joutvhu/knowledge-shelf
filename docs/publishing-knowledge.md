# Publishing Knowledge to Git

How to organize a git repository so others can install knowledge with `knowledge-mcp add`.

---

## Repository Layouts

### Layout 1:  One repo = one knowledge unit

The simplest approach.  The repo root IS the knowledge unit.

```
my-qa-knowledge/              ← git repo root
├── manifest.json             ← required
├── overview.md
├── references/
│   └── setup-guide.md
├── scripts/
│   └── validate.py
├── workflows/
│   └── setup-project.json
└── src/
    └── BasePage.java
```

**Install command:**
```bash
knowledge-mcp add https://github.com/team/my-qa-knowledge.git
```

**Result:**  `~/.knowledge/my-qa-knowledge/` contains the full repo (minus `.git/`).

**Best for:**  Single-purpose knowledge (one boilerplate, one toolkit, one cookbook).

---

### Layout 2:  Monorepo with multiple knowledge units

Multiple knowledge units in one repo.  Each subfolder is a self-contained unit.

```
shared-knowledge/             ← git repo root
├── README.md                 ← repo docs (not installed)
├── cucumber-boilerplate/
│   ├── manifest.json
│   ├── overview.md
│   ├── references/
│   └── src/
├── spring-boot-patterns/
│   ├── manifest.json
│   ├── overview.md
│   └── references/
└── angular-testing/
    ├── manifest.json
    └── references/
```

**Install individual units (uses sparse checkout — fast):**
```bash
knowledge-mcp add https://github.com/team/shared-knowledge.git --path cucumber-boilerplate
knowledge-mcp add https://github.com/team/shared-knowledge.git --path spring-boot-patterns
```

**Install ALL units at once (auto-detects manifest.json):**
```bash
knowledge-mcp add https://github.com/team/shared-knowledge.git --all
```

**Install entire repo as one unit:**
```bash
knowledge-mcp add https://github.com/team/shared-knowledge.git --name shared
```

**Best for:**  Teams sharing multiple related knowledge units from one repo.

---

### Layout 3:  Knowledge inside a project repo

Knowledge lives in a subfolder of a larger project.

```
my-project/                   ← git repo root
├── src/
├── tests/
├── docs/
├── knowledge/                ← knowledge subfolder
│   ├── api-patterns/
│   │   ├── manifest.json
│   │   └── references/
│   └── db-migrations/
│       ├── manifest.json
│       └── scripts/
└── package.json
```

**Install:**
```bash
knowledge-mcp add https://github.com/team/my-project.git --path knowledge/api-patterns --name api-patterns
knowledge-mcp add https://github.com/team/my-project.git --path knowledge/db-migrations --name db-migrations
```

**Best for:**  Project-specific knowledge that lives alongside the code.

---

## Standalone Documents (no manifest)

For simple documentation repos without manifest.json:

```
team-docs/                    ← git repo root
├── getting-started.md
├── deployment-guide.md
├── coding-standards.md
└── architecture/
    ├── microservices.md
    └── event-driven.md
```

**Install:**
```bash
knowledge-mcp add https://github.com/team/team-docs.git --name team-docs
```

The MCP server indexes each `.md` file individually (standalone mode).  Add YAML frontmatter for better search:

```markdown
---
description: "How to deploy services to production"
tags: deployment, kubernetes, ci-cd
aliases: deploy-guide
---

# Deployment Guide
...
```

---

## Recommended Conventions

### For repo maintainers

1. **Always include `manifest.json`** at the root of each knowledge unit
2. **Add a `README.md`** — it's ignored by the MCP server but helps humans browsing the repo
3. **Use descriptive `tags`** in manifest — they drive search relevance
4. **Pin versions** — update `manifest.version` when making breaking changes
5. **Keep units focused** — one topic per unit, split large topics into separate units

### For consumers

1. **Use `--name`** to give short, memorable names:
   ```bash
   knowledge-mcp add https://long-url.git --path some/deep/path --name short-name
   ```
2. **Run `knowledge-mcp update`** periodically to pull latest changes
3. **Pin critical sources** to prevent breaking changes:
   ```bash
   knowledge-mcp pin cucumber v2.1.0
   ```
4. **Check `knowledge-mcp list`** to see what's installed and where it came from
5. **Validate after install** to catch missing files:
   ```bash
   knowledge-mcp validate cucumber
   ```

---

## Registry File

After installing, `.registry.json` in the knowledge directory root tracks all sources:

```json
{
  "version": "1.0",
  "sources": [
    {
      "name": "cucumber-boilerplate",
      "url": "https://github.com/team/shared-knowledge.git",
      "path": "cucumber-boilerplate",
      "commit": "a1b2c3d",
      "pin": "v2.1.0",
      "installedAt": "2025-01-15T10:30:00.000Z",
      "updatedAt": "2025-01-20T14:00:00.000Z"
    },
    {
      "name": "team-docs",
      "url": "https://github.com/team/team-docs.git",
      "commit": "f4e5d6c",
      "installedAt": "2025-02-01T09:00:00.000Z",
      "updatedAt": "2025-02-10T16:30:00.000Z"
    }
  ]
}
```

Fields:
- `name` — local folder name
- `url` — git remote URL
- `path` — subfolder within repo (if `--path` was used)
- `commit` — short hash of installed commit
- `pin` — (optional) locked version; `update` skips pinned sources
- `installedAt` / `updatedAt` — ISO timestamps

This file should be committed to version control if you want to share the same knowledge setup across a team (similar to a lockfile).

---

## Private Repos

For private/enterprise repos, ensure git credentials are configured:

```bash
# HTTPS with credential helper
git config --global credential.helper manager

# SSH key
knowledge-mcp add git@github.com:team/private-knowledge.git
```

The CLI uses `git clone` under the hood, so any auth method git supports will work.
