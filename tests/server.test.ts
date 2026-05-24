/**
 * Integration tests for Knowledge Base MCP Server tools.
 *
 * Tests the tool implementations by calling the compiled server with
 * KNOWLEDGE_DIR pointing to test fixtures.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "sample-knowledge");
const SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

// Helper: call a tool via a small Node script that imports and invokes the server logic
// Since the server uses stdio transport, we test by setting KNOWLEDGE_DIR and importing
// the tool functions directly via a wrapper script.

// Instead, we'll create a small test harness that calls the tool functions.
// First, let's verify fixtures exist.

describe("Test Fixtures", () => {
  it("should have sample-knowledge directory", () => {
    expect(fs.existsSync(FIXTURES_DIR)).toBe(true);
  });

  it("should have manifest-based unit", () => {
    expect(fs.existsSync(path.join(FIXTURES_DIR, "my-unit", "manifest.json"))).toBe(true);
  });

  it("should have standalone document", () => {
    expect(fs.existsSync(path.join(FIXTURES_DIR, "standalone.md"))).toBe(true);
  });
});

// We'll test by creating a small inline script that sets KNOWLEDGE_DIR and calls tool functions
function callTool(toolName: string, args: Record<string, string> = {}): string {
  const helperScript = path.resolve(__dirname, "..", "tests", "tool-helper.mjs");

  // Build CLI args — for 'inputs' param, use env var to avoid quoting issues
  const cliArgs: string[] = [];
  const env: Record<string, string> = { ...process.env as Record<string, string>, KNOWLEDGE_DIR: FIXTURES_DIR };

  for (const [k, v] of Object.entries(args)) {
    if (k === "inputs") {
      // Pass complex JSON via env var
      env.TOOL_INPUTS = v;
      cliArgs.push(`--${k}`, "__ENV_TOOL_INPUTS__");
    } else {
      cliArgs.push(`--${k}`, `"${v}"`);
    }
  }

  const result = execSync(
    `node "${helperScript}" ${toolName} ${cliArgs.join(" ")}`,
    {
      encoding: "utf-8",
      env,
      timeout: 10_000,
    }
  );
  return result.trim();
}

describe("MCP Tools (via helper)", () => {
  beforeAll(() => {
    // Ensure the helper exists
    expect(fs.existsSync(path.resolve(__dirname, "..", "tests", "tool-helper.mjs"))).toBe(true);
  });

  describe("list_docs", () => {
    it("should list both manifest-based and standalone documents", () => {
      const result = JSON.parse(callTool("list_docs"));
      expect(result.total).toBe(2);
      const names = result.documents.map((d: { name: string }) => d.name);
      expect(names).toContain("my-unit");
      expect(names).toContain("standalone.md");
    });

    it("should include manifest metadata for manifest-based units", () => {
      const result = JSON.parse(callTool("list_docs"));
      const unit = result.documents.find((d: { name: string }) => d.name === "my-unit");
      expect(unit.has_manifest).toBe(true);
      expect(unit.type).toBe("boilerplate");
      expect(unit.modules).toContain("base");
      expect(unit.workflows).toContain("setup");
    });

    it("should include frontmatter metadata for standalone docs", () => {
      const result = JSON.parse(callTool("list_docs"));
      const doc = result.documents.find((d: { name: string }) => d.name === "standalone.md");
      expect(doc.has_manifest).toBe(false);
      expect(doc.tags).toContain("cucumber");
      expect(doc.aliases).toContain("standalone-test");
    });
  });

  describe("search_docs", () => {
    it("should find documents by tag", () => {
      const result = JSON.parse(callTool("search_docs", { query: "cucumber" }));
      expect(result.total).toBeGreaterThan(0);
      expect(result.results[0].name).toBe("standalone.md");
    });

    it("should find documents by alias (highest score)", () => {
      const result = JSON.parse(callTool("search_docs", { query: "st" }));
      expect(result.total).toBeGreaterThan(0);
      // "st" matches alias "st" → score 12
      const standalone = result.results.find((r: { name: string }) => r.name === "standalone.md");
      expect(standalone).toBeDefined();
      expect(standalone.relevance_score).toBeGreaterThanOrEqual(12);
    });

    it("should find manifest-based units by type", () => {
      const result = JSON.parse(callTool("search_docs", { query: "boilerplate" }));
      expect(result.total).toBeGreaterThan(0);
      const unit = result.results.find((r: { name: string }) => r.name === "my-unit");
      expect(unit).toBeDefined();
    });

    it("should return empty for non-matching query", () => {
      const result = JSON.parse(callTool("search_docs", { query: "zzzznonexistent" }));
      expect(result.total).toBe(0);
    });
  });

  describe("get_doc", () => {
    it("should return manifest doc file content for manifest-based unit", () => {
      const result = callTool("get_doc", { name: "my-unit" });
      expect(result).toContain("directory:");
      expect(result).toContain("My Unit Overview");
      expect(result).toContain("Getting Started");
    });

    it("should return body without frontmatter for standalone doc", () => {
      const result = callTool("get_doc", { name: "standalone.md" });
      expect(result).toContain("Standalone Test Document");
      expect(result).not.toContain("tags: cucumber");
    });

    it("should return error for non-existent document", () => {
      const result = JSON.parse(callTool("get_doc", { name: "nonexistent.md" }));
      expect(result.error).toContain("not found");
    });
  });

  describe("get_doc_section", () => {
    it("should return specific section content", () => {
      const result = callTool("get_doc_section", { name: "standalone.md", section: "Section One" });
      expect(result).toContain("Section One");
      expect(result).toContain("Content of section one");
      expect(result).not.toContain("Section Two");
    });

    it("should return error for non-existent section", () => {
      const result = JSON.parse(callTool("get_doc_section", { name: "standalone.md", section: "Nonexistent" }));
      expect(result.error).toContain("not found");
      expect(result.available_sections).toBeDefined();
    });
  });

  describe("get_resource", () => {
    it("should return file content", () => {
      const result = callTool("get_resource", { name: "my-unit/references/guide.md" });
      expect(result).toContain("Setup Guide");
      expect(result).toContain("Prerequisites");
    });

    it("should return error for non-existent resource", () => {
      const result = JSON.parse(callTool("get_resource", { name: "my-unit/nonexistent.txt" }));
      expect(result.error).toContain("not found");
    });
  });

  describe("get_manifest", () => {
    it("should return manifest content", () => {
      const result = JSON.parse(callTool("get_manifest", { name: "my-unit" }));
      expect(result.name).toBe("my-unit");
      expect(result.type).toBe("boilerplate");
      expect(result.modules.base).toBeDefined();
      expect(result._directory).toBeDefined();
    });

    it("should return error for non-manifest folder", () => {
      const result = JSON.parse(callTool("get_manifest", { name: "nonexistent" }));
      expect(result.error).toContain("not found");
    });
  });

  describe("run_workflow", () => {
    it("should execute workflow steps", () => {
      const tmpDir = path.join(FIXTURES_DIR, "..", "tmp-workflow-test");
      try {
        const result = JSON.parse(
          callTool("run_workflow", {
            name: "my-unit",
            workflow: "setup",
            inputs: JSON.stringify({ TARGET: tmpDir, NAME: "test-app" }),
          })
        );
        expect(result.workflow).toBe("setup");
        expect(result.steps_executed).toBe(3);
        expect(result.messages).toContain("Setting up test-app in " + tmpDir + "...");
        expect(result.messages).toContain("Done!");
        expect(result.errors.length).toBe(0);
        // Verify mkdir was executed
        expect(fs.existsSync(path.join(tmpDir, "src"))).toBe(true);
      } finally {
        // Cleanup
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it("should return error for missing required inputs", () => {
      const result = JSON.parse(
        callTool("run_workflow", { name: "my-unit", workflow: "setup", inputs: "{}" })
      );
      expect(result.error).toContain("Missing required inputs");
    });

    it("should return error for non-existent workflow", () => {
      const result = JSON.parse(
        callTool("run_workflow", { name: "my-unit", workflow: "nonexistent", inputs: "{}" })
      );
      expect(result.error).toContain("not found");
    });
  });
});
