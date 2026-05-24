/**
 * Integration tests for Knowledge Shelf CLI.
 *
 * Tests init, list, add (local), remove commands using temp directories.
 * Note: 'add' from remote git is not tested here (requires network).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const CLI_PATH = path.resolve(__dirname, "..", "dist", "index.js");

function runCli(command: string, knowledgeDir: string): string {
  return execSync(`node "${CLI_PATH}" ${command} --dir "${knowledgeDir}"`, {
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

describe("CLI Commands", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-shelf-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("init", () => {
    it("should create knowledge directory and registry", () => {
      const result = runCli("init", tmpDir);
      expect(result).toContain("Initialized");
      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".registry.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".cache"))).toBe(true);
    });

    it("should create valid registry JSON", () => {
      runCli("init", tmpDir);
      const registry = JSON.parse(fs.readFileSync(path.join(tmpDir, ".registry.json"), "utf-8"));
      expect(registry.version).toBe("1.0");
      expect(registry.sources).toEqual([]);
    });
  });

  describe("list", () => {
    it("should show empty message when no sources installed", () => {
      runCli("init", tmpDir);
      const result = runCli("list", tmpDir);
      expect(result).toContain("No knowledge sources installed");
    });

    it("should show knowledge directory path", () => {
      runCli("init", tmpDir);
      const result = runCli("list", tmpDir);
      expect(result).toContain(tmpDir);
    });
  });

  describe("remove", () => {
    it("should error when name not found", () => {
      runCli("init", tmpDir);
      try {
        runCli("remove nonexistent", tmpDir);
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string };
        expect(err.stderr || err.stdout || "").toContain("not found");
      }
    });

    it("should remove directory and registry entry", () => {
      runCli("init", tmpDir);

      // Manually create a knowledge unit and registry entry
      const unitDir = path.join(tmpDir, "test-unit");
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, "doc.md"), "# Test", "utf-8");

      const registry = {
        version: "1.0",
        sources: [{
          name: "test-unit",
          url: "https://example.com/repo.git",
          commit: "abc1234",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, ".registry.json"), JSON.stringify(registry), "utf-8");

      const result = runCli("remove test-unit", tmpDir);
      expect(result).toContain("Removed");
      expect(fs.existsSync(unitDir)).toBe(false);

      const updatedRegistry = JSON.parse(fs.readFileSync(path.join(tmpDir, ".registry.json"), "utf-8"));
      expect(updatedRegistry.sources.length).toBe(0);
    });
  });

  describe("help", () => {
    it("should display help text", () => {
      const result = runCli("help", tmpDir);
      expect(result).toContain("Knowledge Shelf");
      expect(result).toContain("add");
      expect(result).toContain("list");
      expect(result).toContain("update");
      expect(result).toContain("remove");
      expect(result).toContain("--dir");
    });
  });

  describe("--dir flag", () => {
    it("should use specified directory", () => {
      const customDir = path.join(tmpDir, "custom-knowledge");
      runCli("init", customDir);
      expect(fs.existsSync(path.join(customDir, ".registry.json"))).toBe(true);
    });
  });

  describe("pin / unpin", () => {
    it("should pin a source to its current commit", () => {
      runCli("init", tmpDir);

      // Setup: create unit + registry entry
      const unitDir = path.join(tmpDir, "pinnable");
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, "doc.md"), "# Pinnable", "utf-8");
      const registry = {
        version: "1.0",
        sources: [{
          name: "pinnable",
          url: "https://example.com/repo.git",
          commit: "abc1234",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, ".registry.json"), JSON.stringify(registry), "utf-8");

      const result = runCli("pin pinnable", tmpDir);
      expect(result).toContain("Pinned");
      expect(result).toContain("abc1234");

      // Verify registry updated
      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".registry.json"), "utf-8"));
      expect(updated.sources[0].pin).toBe("abc1234");
    });

    it("should pin to a specific version", () => {
      runCli("init", tmpDir);

      const unitDir = path.join(tmpDir, "versioned");
      fs.mkdirSync(unitDir);
      const registry = {
        version: "1.0",
        sources: [{
          name: "versioned",
          url: "https://example.com/repo.git",
          commit: "def5678",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, ".registry.json"), JSON.stringify(registry), "utf-8");

      const result = runCli("pin versioned v2.0.0", tmpDir);
      expect(result).toContain("Pinned");
      expect(result).toContain("v2.0.0");

      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".registry.json"), "utf-8"));
      expect(updated.sources[0].pin).toBe("v2.0.0");
    });

    it("should unpin a source", () => {
      runCli("init", tmpDir);

      const unitDir = path.join(tmpDir, "locked");
      fs.mkdirSync(unitDir);
      const registry = {
        version: "1.0",
        sources: [{
          name: "locked",
          url: "https://example.com/repo.git",
          commit: "aaa1111",
          pin: "v1.0.0",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, ".registry.json"), JSON.stringify(registry), "utf-8");

      const result = runCli("unpin locked", tmpDir);
      expect(result).toContain("Unpinned");

      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".registry.json"), "utf-8"));
      expect(updated.sources[0].pin).toBeUndefined();
    });

    it("should show pinned status in list", () => {
      runCli("init", tmpDir);

      const unitDir = path.join(tmpDir, "show-pin");
      fs.mkdirSync(unitDir);
      const registry = {
        version: "1.0",
        sources: [{
          name: "show-pin",
          url: "https://example.com/repo.git",
          commit: "bbb2222",
          pin: "v3.0.0",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, ".registry.json"), JSON.stringify(registry), "utf-8");

      const result = runCli("list", tmpDir);
      expect(result).toContain("[pinned: v3.0.0]");
    });
  });

  describe("search", () => {
    it("should find documents by keyword", () => {
      runCli("init", tmpDir);

      // Create a standalone doc with tags
      fs.writeFileSync(
        path.join(tmpDir, "testing-guide.md"),
        "---\ndescription: Guide for testing\ntags: jest, vitest, unit-test\n---\n\n# Testing Guide\n\nContent here.",
        "utf-8"
      );

      const result = runCli("search jest", tmpDir);
      expect(result).toContain("testing-guide.md");
      expect(result).toContain("score:");
    });

    it("should show no results for non-matching query", () => {
      runCli("init", tmpDir);
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "# Simple Doc\n\nContent.", "utf-8");

      const result = runCli("search zzzznonexistent", tmpDir);
      expect(result).toContain("No results");
    });

    it("should find manifest-based units", () => {
      runCli("init", tmpDir);

      // Create manifest-based unit
      const unitDir = path.join(tmpDir, "my-toolkit");
      fs.mkdirSync(unitDir);
      fs.writeFileSync(
        path.join(unitDir, "manifest.json"),
        JSON.stringify({ name: "my-toolkit", version: "1.0.0", type: "toolkit", description: "A testing toolkit", tags: ["automation", "selenium"] }),
        "utf-8"
      );

      const result = runCli("search selenium", tmpDir);
      expect(result).toContain("my-toolkit");
    });
  });

  describe("export", () => {
    it("should create a zip archive", () => {
      runCli("init", tmpDir);

      // Create a unit to export
      const unitDir = path.join(tmpDir, "exportable");
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, "doc.md"), "# Exportable\n\nContent.", "utf-8");
      fs.writeFileSync(
        path.join(unitDir, "manifest.json"),
        JSON.stringify({ name: "exportable", version: "1.0.0", type: "cookbook", description: "Test export" }),
        "utf-8"
      );

      const outputPath = path.join(tmpDir, "export-test.zip");
      const result = runCli(`export exportable --output "${outputPath}"`, tmpDir);
      expect(result).toContain("Exported");
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
    });

    it("should error for non-existent unit", () => {
      runCli("init", tmpDir);
      try {
        runCli("export nonexistent", tmpDir);
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string };
        expect(err.stderr || err.stdout || "").toContain("not found");
      }
    });
  });

  describe("init .gitignore", () => {
    it("should create .gitignore at knowledge root", () => {
      runCli("init", tmpDir);
      const gitignorePath = path.join(tmpDir, ".gitignore");
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const content = fs.readFileSync(gitignorePath, "utf-8");
      expect(content).toContain(".cache/");
    });
  });
});
