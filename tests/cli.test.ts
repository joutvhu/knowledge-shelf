/**
 * Integration tests for Knowledge Shelf CLI.
 *
 * Tests init, list, add/update/pin (against local git repos), validate, info,
 * search, export, install-skill, remove, version, and entrypoint arg handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-knowledge');

function runCli(command: string, knowledgeDir: string): string {
  return execSync(`node "${CLI_PATH}" ${command} --dir "${knowledgeDir}"`, {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

describe('CLI Commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-shelf-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('version & entrypoint flags', () => {
    it('should print package version with --version and -v without hanging', () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));
      const v1 = execSync(`node "${CLI_PATH}" --version`, { encoding: 'utf-8', timeout: 5_000 }).trim();
      const v2 = execSync(`node "${CLI_PATH}" -v`, { encoding: 'utf-8', timeout: 5_000 }).trim();
      expect(v1).toBe(pkg.version);
      expect(v2).toBe(pkg.version);
    });

    it('should accept --dir placed BEFORE the subcommand', () => {
      execSync(`node "${CLI_PATH}" --dir "${tmpDir}" init`, { encoding: 'utf-8', timeout: 10_000 });
      const out = execSync(`node "${CLI_PATH}" --dir "${tmpDir}" list`, {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      expect(out).toContain('No knowledge sources installed');
      expect(out).toContain(tmpDir);
    });

    it('should reject unknown flags or missing --dir value with exit code 1', () => {
      const res = spawnSync(process.execPath, [CLI_PATH, '--unknown-flag'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Unknown command');

      const missingDir = spawnSync(process.execPath, [CLI_PATH, 'list', '--dir'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      expect(missingDir.status).toBe(1);
      expect(missingDir.stderr).toContain('--dir requires a directory path');
    });
  });

  describe('init', () => {
    it('should create knowledge directory, registry, and .gitignore', () => {
      const result = runCli('init', tmpDir);
      expect(result).toContain('Initialized');
      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.registry.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.cache'))).toBe(true);

      const registry = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
      expect(registry.version).toBe('1.0');
      expect(registry.sources).toEqual([]);

      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.cache/');
    });
  });

  describe('list', () => {
    it('should show empty message and knowledge directory path when no sources installed', () => {
      runCli('init', tmpDir);
      const result = runCli('list', tmpDir);
      expect(result).toContain('No knowledge sources installed');
      expect(result).toContain(tmpDir);
    });
  });

  describe('remove', () => {
    it('should error when name not found', () => {
      runCli('init', tmpDir);
      const res = spawnSync(process.execPath, [CLI_PATH, 'remove', 'nonexistent', '--dir', tmpDir], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('not found');
    });

    it('should block path traversal outside knowledge directory', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-outside-keep-'));
      try {
        runCli('init', tmpDir);
        const relEscape = path.relative(tmpDir, outsideDir);
        const res = spawnSync(process.execPath, [CLI_PATH, 'remove', relEscape, '--dir', tmpDir], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Access denied');
        expect(fs.existsSync(outsideDir)).toBe(true);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('should remove directory and registry entry', () => {
      runCli('init', tmpDir);

      const unitDir = path.join(tmpDir, 'test-unit');
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, 'doc.md'), '# Test', 'utf-8');

      const registry = {
        version: '1.0',
        sources: [
          {
            name: 'test-unit',
            url: 'https://example.com/repo.git',
            commit: 'abc1234',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      fs.writeFileSync(path.join(tmpDir, '.registry.json'), JSON.stringify(registry), 'utf-8');

      const result = runCli('remove test-unit', tmpDir);
      expect(result).toContain('Removed');
      expect(fs.existsSync(unitDir)).toBe(false);

      const updatedRegistry = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
      expect(updatedRegistry.sources.length).toBe(0);
    });
  });

  describe('validate & info', () => {
    it('should pass validation on sample-knowledge fixtures', () => {
      const out = runCli('validate', FIXTURES_DIR);
      expect(out).toContain('my-unit — OK');
      expect(out).toContain('0 error(s)');
    });

    it('should display unit details with info command', () => {
      const out = runCli('info my-unit', FIXTURES_DIR);
      expect(out).toContain('boilerplate');
      expect(out).toContain('1.0.0');
      expect(out).toContain('overview.md');
    });

    it('should fail validation with exit code 1 when referenced file is missing', () => {
      runCli('init', tmpDir);
      const brokenDir = path.join(tmpDir, 'broken-unit');
      fs.mkdirSync(brokenDir);
      fs.writeFileSync(
        path.join(brokenDir, 'manifest.json'),
        JSON.stringify({
          name: 'broken-unit',
          version: '1.0.0',
          type: 'boilerplate',
          description: 'Broken unit',
          doc: 'missing.md',
        }),
        'utf-8'
      );

      const res = spawnSync(process.execPath, [CLI_PATH, 'validate', '--dir', tmpDir], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('doc file not found: missing.md');
    });
  });

  describe('add, update, and pin with local git repository', () => {
    it('should add from git repo, update to new commit, and checkout exact ref on pin', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-git-origin-'));
      try {
        const git = (args: string[]) =>
          execSync(`git ${args.join(' ')}`, { cwd: repoDir, stdio: 'pipe', encoding: 'utf-8' });

        git(['init']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test User']);

        fs.writeFileSync(
          path.join(repoDir, 'manifest.json'),
          JSON.stringify({ name: 'demo-lib', version: '1.0.0', type: 'cookbook', description: 'v1 desc' }),
          'utf-8'
        );
        fs.writeFileSync(path.join(repoDir, 'guide.md'), '# Version 1.0.0', 'utf-8');
        git(['add', '.']);
        git(['commit', '-m', '"v1"']);
        git(['tag', 'v1.0.0']);

        runCli('init', tmpDir);
        const addOut = runCli(`add "${repoDir}" --name demo-lib`, tmpDir);
        expect(addOut).toContain("Installed 'demo-lib'");
        expect(fs.readFileSync(path.join(tmpDir, 'demo-lib', 'guide.md'), 'utf-8')).toContain('Version 1.0.0');

        // Advance remote repo to v2.0.0
        fs.writeFileSync(path.join(repoDir, 'guide.md'), '# Version 2.0.0', 'utf-8');
        git(['add', '.']);
        git(['commit', '-m', '"v2"']);
        git(['tag', 'v2.0.0']);

        const upOut = runCli('update demo-lib', tmpDir);
        expect(upOut).toContain('Updated to');
        expect(fs.readFileSync(path.join(tmpDir, 'demo-lib', 'guide.md'), 'utf-8')).toContain('Version 2.0.0');

        // Pin back to tag v1.0.0 -> must actually check out v1.0.0 files on disk!
        const pinOut = runCli('pin demo-lib v1.0.0', tmpDir);
        expect(pinOut).toContain('Pinned');
        expect(fs.readFileSync(path.join(tmpDir, 'demo-lib', 'guide.md'), 'utf-8')).toContain('Version 1.0.0');

        // Subsequent update skips pinned source
        const skipOut = runCli('update', tmpDir);
        expect(skipOut).toContain("Skipping 'demo-lib' (pinned to v1.0.0)");
        expect(fs.readFileSync(path.join(tmpDir, 'demo-lib', 'guide.md'), 'utf-8')).toContain('Version 1.0.0');

        // Unpin -> update brings back v2.0.0
        runCli('unpin demo-lib', tmpDir);
        runCli('update demo-lib', tmpDir);
        expect(fs.readFileSync(path.join(tmpDir, 'demo-lib', 'guide.md'), 'utf-8')).toContain('Version 2.0.0');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('search', () => {
    it('should find documents by keyword and section heading (matching MCP search_docs)', () => {
      runCli('init', tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'testing-guide.md'),
        '---\ndescription: Guide for testing\ntags: jest, vitest, unit-test\n---\n\n# Testing Guide\n\n## Mocking Strategies\n\nContent here.',
        'utf-8'
      );

      expect(runCli('search jest', tmpDir)).toContain('testing-guide.md');
      // Section heading match (+4 score), previously missing in CLI search
      expect(runCli('search Mocking', tmpDir)).toContain('testing-guide.md');
    });

    it('should show no results for non-matching query', () => {
      runCli('init', tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'doc.md'), '# Simple Doc\n\nContent.', 'utf-8');
      expect(runCli('search zzzznonexistent', tmpDir)).toContain('No results');
    });
  });

  describe('export', () => {
    it('should create a zip archive without noisy progress output', () => {
      runCli('init', tmpDir);
      const unitDir = path.join(tmpDir, 'exportable');
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, 'doc.md'), '# Exportable\n\nContent.', 'utf-8');
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({ name: 'exportable', version: '1.0.0', type: 'cookbook', description: 'Test export' }),
        'utf-8'
      );

      const outputPath = path.join(tmpDir, 'export-test.zip');
      const result = runCli(`export exportable --output "${outputPath}"`, tmpDir);
      expect(result).toContain('Exported');
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
    });
  });

  describe('install-skill', () => {
    it('should install and overwrite the bundled skill cleanly', () => {
      const skillsDir = path.join(tmpDir, 'my-skills');
      const res1 = execSync(`node "${CLI_PATH}" install-skill "${skillsDir}"`, {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      expect(res1).toContain('Successfully installed bundled skill');
      expect(fs.existsSync(path.join(skillsDir, 'knowledge-builder', 'SKILL.md'))).toBe(true);

      const res2 = execSync(`node "${CLI_PATH}" install-skill "${skillsDir}"`, {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      expect(res2).toContain('Overwriting');
      expect(res2).toContain('Successfully installed bundled skill');
    });
  });
});
