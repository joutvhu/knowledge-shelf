# Source Code Analysis Reference

Detailed guide for generating reference documentation from library/framework source code.

## Project Type Detection

| File | Project Type | Language |
|---|---|---|
| `pom.xml` | Maven | Java |
| `build.gradle` / `build.gradle.kts` | Gradle | Java/Kotlin |
| `package.json` | npm | TypeScript/JavaScript |
| `setup.py` / `pyproject.toml` | pip | Python |
| `Cargo.toml` | Cargo | Rust |
| `go.mod` | Go modules | Go |
| `*.csproj` / `*.sln` | .NET | C# |

## Metadata Extraction

From the build file, extract:
- **Name / ArtifactId** — the library's identifier
- **Version** — current version
- **Description** — if available
- **Dependencies** — key third-party libraries (with versions)
- **Runtime version** — minimum required (Java 17, Node 18, Python 3.11, etc.)

## Source Scanning

Focus on **public API only**.  Identify:

| Category | What to look for |
|---|---|
| Public API surface | Classes, interfaces, methods, functions exported for consumers |
| Base classes | Abstract classes meant to be extended |
| Utility classes | Static helper methods |
| Configuration | Properties files, env vars, config classes |
| Enums/constants | Important enumerated values |
| DTOs/Models | Data structures passed between components |
| Annotations | Custom annotations and their effects |
| Entry points | Main classes, CLI commands, server bootstraps |

**Skip:**  Internal/private implementation, test code, build scripts.

## Pattern Identification

Look for:
- **Design patterns** — Factory, Builder, Strategy, Singleton, Template Method
- **Naming conventions** — how classes/methods are named
- **Error handling** — exceptions, Result types, error codes
- **Configuration approach** — properties, env vars, builder pattern, annotations
- **Extension points** — where consumers plug in custom behavior
- **Lifecycle** — initialization, usage, cleanup/shutdown

## Output Structure

```markdown
# <Library Name> (`<artifact-id>`)

## Overview
<2-3 sentences>

- **Package/GroupId:**  `<identifier>`
- **Version:**  `<version>`
- **Language:**  <language + version>

### Dependency Declaration
<how to add as dependency>

---

## Package Structure
<main packages and their purpose>

---

## Public API

### <Category>

#### `<ClassName>`
<one sentence>

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `method` | `Type param` | `ReturnType` | What it does |

---

## Configuration
| Property | Type | Default | Description |
|---|---|---|---|

---

## Common Patterns
### Pattern 1: <name>
<code example>

---

## Common Mistakes
1. **<mistake>** — <why wrong + what to do>

---

## Extension Points
<where/how to extend>
```

## Adaptation Rules

- **Not all sections required** — skip empty sections
- **Scale to library size** — 5-class utility → short doc; 50-class framework → detailed
- **Multi-module projects** — one doc per independently-consumable module
- **Non-Java** — adapt terminology:  "package" not "groupId", "module" not "artifactId"
- **Code examples** — minimal but complete, copy-paste ready

## Quality Checklist

1. ✅ All class/method names verified in source (no hallucination)
2. ✅ Parameter types and return types accurate
3. ✅ Examples would compile/run
4. ✅ Side effects documented (logging, exceptions, network calls, state changes)
5. ✅ Uses library's own terminology
6. ✅ Uncertainty flagged with "appears to"
7. ✅ Tags cover key search terms (8-12 tags ideal)

## Output Location Decision

| Context | Write to | Frontmatter? |
|---|---|---|
| Standalone reference doc | `knowledge/<artifact-id>.md` | ✅ Yes (description, tags, aliases) |
| Part of manifest-based knowledge | `knowledge/<name>/references/<artifact-id>.md` | ❌ No (manifest handles metadata) |

When writing into manifest-based knowledge, also update `manifest.json`:
```json
"references": {
  "<artifact-id>": {"file": "references/<artifact-id>.md", "description": "<one sentence>"}
}
```
