# Integration Guide Template

Use this template when creating integration guides for knowledge modules that need to be wired into existing projects.

## When to Create an Integration Guide

Create one when a module:
- Has code files that need to be **called from** other classes (not just exist independently)
- Requires modifications to existing project files (Hooks, config, base classes)
- Has methods that consumers need to know about (API surface)
- Needs specific setup order (dependencies, initialization)

## Template

````markdown
# <Module Name> Integration

## Quick Setup

Run workflow `<workflow-name>`:
```
Inputs:
  TARGET: <project root>
  PACKAGE: <java package or equivalent>
```

Or follow manual steps below.

## Files to Add

| Source (in knowledge) | Destination (in project) |
|---|---|
| `<path/File.java>` | `{{TARGET}}/src/.../{{PACKAGE_PATH}}/<path/File.java>` |

## Modifications to Existing Files

### <FileName.java> — <what to add>

**Location:** After `<anchor text or annotation>`

```java
// Code to inject
<ClassName> instance = new <ClassName>(driver);
scenarioContext.set("<key>", instance);
```

### <AnotherFile.java> — Add import

**Location:** Import section

```java
import {{PACKAGE_NAME}}.<path>.<ClassName>;
```

## API Reference

### `<ClassName>`

<One sentence: what this class does>

| Method | Parameters | Returns | Use when |
|---|---|---|---|
| `method1()` | — | `void` | Before interacting with X |
| `method2(param)` | `String param` | `boolean` | To check if Y |
| `method3(a, b)` | `int a, String b` | `String` | To get Z |

### Usage Example

```java
// Full working example showing typical usage flow
<ClassName> obj = scenarioContext.get("<key>", <ClassName>.class);
obj.method1();
if (obj.method2("value")) {
    String result = obj.method3(0, "column");
    // use result...
}
```

## Prerequisites

- Module `<dependency>` must be set up first
- Library `<external-lib>` must be in dependencies

## Common Mistakes

1. **Forgetting to call `method1()` first** — other methods will timeout without it
2. **Wrong context key** — must match exactly what's registered in Hooks
````

## Tips for Writing Good Integration Guides

1. **Test the guide yourself** — follow your own steps on a fresh project
2. **Use real class/method names** — not placeholders for the API surface
3. **Show error messages** — what happens if setup is wrong, so AI can diagnose
4. **Keep snippets small** — one concern per snippet file
5. **Version the guide** — update when API changes
