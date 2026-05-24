# Writing Knowledge for AI Consumers

Knowledge is consumed by AI, not just humans.  Write content that AI can act on immediately.

## Description and Tags

**Bad:**
```json
"description": "A useful testing utility",
"tags": ["java"]
```

**Good:**
```json
"description": "AG Grid page object for Cucumber Selenium tests on Angular apps — handles wait, click, filter, sort, cell read",
"tags": ["ag-grid", "cucumber", "selenium", "angular", "java", "page-object", "table", "grid", "testing"]
```

Rules:
- Description should contain the key nouns someone would search for
- Include 8-12 tags covering:  technology, framework, language, domain, pattern type
- Think "what would I type to find this?" — those words should be in tags/description

## Doc vs References — When to Use Which

| Content | Put in | Why |
|---|---|---|
| Overview + quick start (< 100 lines) | `doc` field (main doc) | First thing AI reads via `get_doc` |
| Detailed module guide | `references/<module>-guide.md` | AI loads on-demand via `get_resource` |
| Integration instructions | `references/<module>-integration.md` | Step-by-step for wiring into project |
| API surface / method list | `references/<module>-api.md` | Quick lookup |
| Full working example | `references/example-<scenario>.md` | AI copies and adapts |

Rule of thumb:  `doc` = "what is this and how to get started" (short).  `references/` = "deep details" (loaded only when needed).

## Making Code Files Self-Contained

Every code file in `files` must be copy-paste ready:
- ✅ All imports present (even if they seem obvious)
- ✅ Package declaration uses `{{PACKAGE_NAME}}` placeholder
- ✅ Base class is either included in the same module or listed as dependency
- ✅ No references to utilities/helpers that aren't in the knowledge unit
- ❌ Don't assume consumer has specific libraries unless listed in prerequisites

## Making Workflows Idempotent

Workflows may be run multiple times (user retries, partial failure).  Design for safety:
- Use `"skip_if_exists": true` on copy steps for files that shouldn't be overwritten
- mkdir steps are naturally idempotent (recursive, no error if exists)
- Scripts should check state before acting (don't blindly append to files)

## Structuring Content for AI

AI works best with:
- **Tables** over paragraphs (for method lists, config options, mappings)
- **Code blocks** over descriptions (show, don't tell)
- **Explicit file paths** over vague references ("add to Hooks.java" not "add to your setup")
- **Step numbers** over prose (1, 2, 3 not "first... then... finally...")
- **Conditional sections** clearly marked ("If using Spring Boot:" / "If using plain Java:")

## Common Mistakes to Avoid

When building knowledge, watch for these pitfalls:

1. **Vague descriptions** — AI can't find knowledge if description doesn't contain searchable terms
2. **Missing tags** — 2-3 tags is too few; aim for 8-12 covering all relevant dimensions
3. **Monolithic doc file** — one 500-line doc is worse than a short overview + focused references
4. **Code with missing imports** — consumer copies file, gets compile errors immediately
5. **Undeclared dependencies** — module uses base class from another module but doesn't list it in `dependencies`
6. **Workflows that fail on re-run** — no `skip_if_exists`, overwrites user's customized files
7. **Guide written for humans** — long narrative paragraphs instead of structured steps AI can execute
8. **No usage examples** — AI knows the method exists but not when/how to call it in context
9. **Placeholder in wrong format** — using `${VAR}` or `<VAR>` instead of `{{VAR}}`
10. **Forgetting integration guide** — files are copied but AI doesn't know how to wire them into existing code
