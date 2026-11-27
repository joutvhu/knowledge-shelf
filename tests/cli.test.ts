/**
 * Integration tests for Knowledge Shelf CLI.
 *
 * Tests init, list, add/update/pin (against local git repos), validate, info,
 * search, export, remove, version, and entrypoint arg handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

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
      const v1 = execSync(`node "${CLI_PATH}" --version`, { encoding: 'utf-8', timeout: 25_000 }).trim();
      const v2 = execSync(`node "${CLI_PATH}" -v`, { encoding: 'utf-8', timeout: 25_000 }).trim();
      expect(v1).toBe(pkg.version);
      expect(v2).toBe(pkg.version);
    });

    it('should accept --dir placed BEFORE the subcommand', () => {
      execSync(`node "${CLI_PATH}" --dir "${tmpDir}" init`, { encoding: 'utf-8', timeout: 25_000 });
      const out = execSync(`node "${CLI_PATH}" --dir "${tmpDir}" list`, {
        encoding: 'utf-8',
        timeout: 25_000,
      }).trim();
      expect(out).toContain('No knowledge sources installed');
      expect(out).toContain(tmpDir);
    });

    it('should reject unknown flags or missing --dir value with exit code 1', () => {
      const res = spawnSync(process.execPath, [CLI_PATH, '--unknown-flag'], {
        encoding: 'utf-8',
        timeout: 25_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Unknown command');

      const missingDir = spawnSync(process.execPath, [CLI_PATH, 'list', '--dir'], {
        encoding: 'utf-8',
        timeout: 25_000,
      });
      expect(missingDir.status).toBe(1);
      expect(missingDir.stderr).toContain('--dir requires a directory path');
    });

    it('should show help when run in interactive TTY mode without arguments without hanging', () => {
      const targetUrl = JSON.stringify(pathToFileURL(CLI_PATH).href);
      const res = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `process.stdin.isTTY = true; import(${targetUrl})`],
        { encoding: 'utf-8', timeout: 25_000 }
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Knowledge Shelf');
      expect(res.stdout).toContain('Commands:');
    });

    it('should show help when run with help subcommand or --help flag', () => {
      const res1 = spawnSync(process.execPath, [CLI_PATH, 'help'], {
        encoding: 'utf-8',
        timeout: 25_000,
      });
      expect(res1.status).toBe(0);
      expect(res1.stdout).toContain('Commands:');

      const res2 = spawnSync(process.execPath, [CLI_PATH, '--help'], {
        encoding: 'utf-8',
        timeout: 25_000,
      });
      expect(res2.status).toBe(0);
      expect(res2.stdout).toContain('Commands:');
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

    it('should validate an external draft path directly without installing it', () => {
      const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-staging-'));
      try {
        const draftDir = path.join(stagingRoot, '.agents', 'knowledges', 'draft-unit');
        fs.mkdirSync(draftDir, { recursive: true });
        fs.writeFileSync(path.join(draftDir, 'overview.md'), '# Overview\n\nBody.', 'utf-8');
        fs.writeFileSync(
          path.join(draftDir, 'manifest.json'),
          JSON.stringify({
            name: 'draft-unit',
            version: '1.0.0',
            type: 'cookbook',
            description: 'Drafted in workspace',
            doc: 'overview.md',
          }),
          'utf-8'
        );

        const out = runCli(`validate "${draftDir}"`, tmpDir);
        expect(out).toContain('draft-unit — OK');
        expect(out).toContain('0 error(s)');
      } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
    });
  });

  describe('install from local staging path', () => {
    it('should validate and install a staged manifest unit, block invalid units, and support --force & --all', () => {
      const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-install-staging-'));
      try {
        runCli('init', tmpDir);

        const stagedKnowledges = path.join(stagingRoot, '.agents', 'knowledges');
        const unitADir = path.join(stagedKnowledges, 'unit-a');
        fs.mkdirSync(unitADir, { recursive: true });
        fs.writeFileSync(path.join(unitADir, 'overview.md'), '# Unit A v1\n\nContent.', 'utf-8');
        fs.writeFileSync(
          path.join(unitADir, 'manifest.json'),
          JSON.stringify({
            name: 'unit-a',
            version: '1.0.0',
            type: 'cookbook',
            description: 'Staged unit A',
            doc: 'overview.md',
          }),
          'utf-8'
        );

        // Install single manifest unit
        const installOut = runCli(`install "${unitADir}"`, tmpDir);
        expect(installOut).toContain('unit-a — OK');
        expect(installOut).toContain("Installed 'unit-a'");
        expect(fs.existsSync(path.join(tmpDir, 'unit-a', 'manifest.json'))).toBe(true);

        // Re-installing without --force fails
        const dupRes = spawnSync(process.execPath, [CLI_PATH, 'install', unitADir, '--dir', tmpDir], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        expect(dupRes.status).toBe(1);
        expect(dupRes.stderr).toContain('Use --force to overwrite');

        // Modify in staging and re-install with --force
        fs.writeFileSync(path.join(unitADir, 'overview.md'), '# Unit A v2\n\nUpdated.', 'utf-8');
        const forceOut = runCli(`install "${unitADir}" --force`, tmpDir);
        expect(forceOut).toContain("Installed 'unit-a'");
        expect(fs.readFileSync(path.join(tmpDir, 'unit-a', 'overview.md'), 'utf-8')).toContain('Unit A v2');

        // Standalone .md file in staging
        const standaloneMd = path.join(stagedKnowledges, 'api-conventions.md');
        fs.writeFileSync(
          standaloneMd,
          '---\ndescription: REST API conventions\ntags: [api, rest]\n---\n\n# API Conventions\n\nUse JSON.',
          'utf-8'
        );

        // Install all from .agents/knowledges with --all --force
        const allOut = runCli(`install "${stagedKnowledges}" --all --force`, tmpDir);
        expect(allOut).toContain("Installed 'unit-a'");
        expect(allOut).toContain("Installed 'api-conventions.md'");
        expect(fs.existsSync(path.join(tmpDir, 'api-conventions.md'))).toBe(true);

        // Info works on standalone .md too
        const infoOut = runCli('info api-conventions.md', tmpDir);
        expect(infoOut).toContain('standalone (.md)');
        expect(infoOut).toContain('REST API conventions');

        // Invalid unit is blocked from installation
        const invalidDir = path.join(stagedKnowledges, 'invalid-unit');
        fs.mkdirSync(invalidDir, { recursive: true });
        fs.writeFileSync(
          path.join(invalidDir, 'manifest.json'),
          JSON.stringify({
            name: 'invalid-unit',
            version: '1.0.0',
            type: 'boilerplate',
            description: 'Missing referenced file',
            doc: 'nonexistent.md',
          }),
          'utf-8'
        );

        const badInstall = spawnSync(process.execPath, [CLI_PATH, 'install', invalidDir, '--dir', tmpDir], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        expect(badInstall.status).toBe(1);
        expect(badInstall.stdout).toContain('doc file not found: nonexistent.md');
        expect(badInstall.stderr).toContain('Aborting install');
        expect(fs.existsSync(path.join(tmpDir, 'invalid-unit'))).toBe(false);
      } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
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

        // Pinning to a non-existent ref must fail and not record a bogus pin
        const badPin = spawnSync(process.execPath, [CLI_PATH, 'pin', 'demo-lib', 'v99.99.99', '--dir', tmpDir], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        expect(badPin.status).toBe(1);
        expect(badPin.stderr).toContain('Failed to checkout');
        const regAfterBadPin = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
        expect(regAfterBadPin.sources[0].pin).toBeUndefined();
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

    it('should reject missing --output value and unknown flags', () => {
      runCli('init', tmpDir);
      const missingOut = spawnSync(process.execPath, [CLI_PATH, 'export', 'exportable', '--output', '--dir', tmpDir], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      expect(missingOut.status).toBe(1);
      expect(missingOut.stderr).toContain('--output requires a file path');

      const unknownFlag = spawnSync(process.execPath, [CLI_PATH, 'export', 'exportable', '--bogus', '--dir', tmpDir], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      expect(unknownFlag.status).toBe(1);
      expect(unknownFlag.stderr).toContain('Unknown option');
    });
  });
  describe('safety regressions', () => {
    const run = (args: string[], dir: string) =>
      spawnSync(process.execPath, [CLI_PATH, ...args, '--dir', dir], {
        encoding: 'utf-8',
        timeout: 20_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

    const writeUnit = (dir: string, name: string, extra: Record<string, unknown> = {}) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'overview.md'), `# ${name}\n\nBody.`, 'utf-8');
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ name, version: '1.0.0', type: 'cookbook', description: name, doc: 'overview.md', ...extra }),
        'utf-8'
      );
    };

    it('add must never delete the knowledge directory when the URL ends with ".." or ".git"', () => {
      runCli('init', tmpDir);
      const keep = path.join(tmpDir, 'precious-unit');
      fs.mkdirSync(keep);
      fs.writeFileSync(path.join(keep, 'data.md'), 'important', 'utf-8');

      for (const url of ['https://invalid.invalid/..', 'https://invalid.invalid/.', 'https://invalid.invalid/.git']) {
        run(['add', url], tmpDir);
        expect(fs.existsSync(path.join(keep, 'data.md')), url).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.registry.json')), url).toBe(true);
      }
    });

    it('should refuse to run when .registry.json is corrupt instead of resetting it', () => {
      runCli('init', tmpDir);
      const registryPath = path.join(tmpDir, '.registry.json');
      const corrupt = '{ "version": "1.0", "sources": [ {oops';
      fs.writeFileSync(registryPath, corrupt, 'utf-8');

      const res = run(['list'], tmpDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Cannot read registry');

      const staged = path.join(tmpDir, 'staged');
      writeUnit(staged, 'staged');
      const install = run(['install', staged], tmpDir);
      expect(install.status).toBe(1);
      expect(fs.readFileSync(registryPath, 'utf-8')).toBe(corrupt);
    });

    it('remove must not delete internal files such as .registry.json or .cache', () => {
      runCli('init', tmpDir);
      for (const name of ['.registry.json', '.cache']) {
        const res = run(['remove', name], tmpDir);
        expect(res.status, name).toBe(1);
        expect(res.stderr).toContain('reserved');
      }
      expect(fs.existsSync(path.join(tmpDir, '.registry.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.cache'))).toBe(true);
    });

    it('pin <name> <ref> must fail clearly for sources installed from a local path', () => {
      runCli('init', tmpDir);
      const staged = path.join(tmpDir, '..', `ks-local-pin-${Date.now()}`);
      try {
        writeUnit(staged, path.basename(staged));
        runCli(`install "${staged}"`, tmpDir);
        const name = path.basename(staged);

        const res = run(['pin', name, 'v1.0.0'], tmpDir);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('local path');

        const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
        expect(reg.sources[0].pin).toBeUndefined();
        expect(run(['pin', name], tmpDir).status).toBe(0);
      } finally {
        fs.rmSync(staged, { recursive: true, force: true });
      }
    });

    it('install --all must report duplicate unit names and install nested units only once', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-all-'));
      try {
        runCli('init', tmpDir);

        // Two different units that would both be installed as "core"
        writeUnit(path.join(root, 'dupes', 'a', 'core'), 'core');
        writeUnit(path.join(root, 'dupes', 'b', 'core'), 'core');
        const dup = run(['install', path.join(root, 'dupes'), '--all'], tmpDir);
        expect(dup.status).toBe(1);
        expect(dup.stderr).toContain('share the same folder name');
        expect(fs.existsSync(path.join(tmpDir, 'core'))).toBe(false);

        // A unit nested inside another unit is part of the parent, not a separate install
        writeUnit(path.join(root, 'nest', 'parent'), 'parent');
        writeUnit(path.join(root, 'nest', 'parent', 'examples', 'child'), 'child');
        const nested = run(['install', path.join(root, 'nest'), '--all'], tmpDir);
        expect(nested.status).toBe(0);
        expect(fs.existsSync(path.join(tmpDir, 'parent', 'manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'child'))).toBe(false);
        const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
        expect(reg.sources.map((s: { name: string }) => s.name)).toEqual(['parent']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('install --force replaces a unit atomically and leaves no staging leftovers', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-atomic-'));
      try {
        runCli('init', tmpDir);
        const unit = path.join(root, 'unit-x');
        writeUnit(unit, 'unit-x');
        runCli(`install "${unit}"`, tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'unit-x', 'stale.md'), 'stale', 'utf-8');

        fs.writeFileSync(path.join(unit, 'overview.md'), '# unit-x v2', 'utf-8');
        runCli(`install "${unit}" --force`, tmpDir);

        expect(fs.readFileSync(path.join(tmpDir, 'unit-x', 'overview.md'), 'utf-8')).toContain('v2');
        expect(fs.existsSync(path.join(tmpDir, 'unit-x', 'stale.md'))).toBe(false);
        expect(fs.readdirSync(path.join(tmpDir, '.cache')).filter((f) => f.startsWith('.stage') || f.startsWith('.backup'))).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('add --name and update keep manifest.name synced so validate passes', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sync-name-'));
      try {
        const git = (args: string[]) =>
          execSync(`git ${args.join(' ')}`, { cwd: repoDir, stdio: 'pipe', encoding: 'utf-8' });
        git(['init']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test User']);
        fs.writeFileSync(
          path.join(repoDir, 'manifest.json'),
          JSON.stringify({ name: 'orig-name', version: '1.0.0', type: 'cookbook', description: 'v1' }),
          'utf-8'
        );
        git(['add', '.']);
        git(['commit', '-m', '"v1"']);

        runCli('init', tmpDir);
        runCli(`add "${repoDir}" --name custom-alias`, tmpDir);
        expect(runCli('validate custom-alias', tmpDir)).toContain('custom-alias — OK');

        fs.writeFileSync(
          path.join(repoDir, 'manifest.json'),
          JSON.stringify({ name: 'orig-name', version: '2.0.0', type: 'cookbook', description: 'v2' }),
          'utf-8'
        );
        git(['add', '.']);
        git(['commit', '-m', '"v2"']);

        runCli('update custom-alias', tmpDir);
        expect(runCli('validate custom-alias', tmpDir)).toContain('custom-alias — OK');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('validate catches invalid workflow steps and install blocks --name README', () => {
      runCli('init', tmpDir);
      const badUnit = path.join(tmpDir, 'bad-wf-unit');
      fs.mkdirSync(path.join(badUnit, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(badUnit, 'manifest.json'),
        JSON.stringify({
          name: 'bad-wf-unit',
          version: '1.0.0',
          type: 'toolkit',
          description: 'Bad workflow',
          workflows: { broken: { description: 'Broken' } },
        }),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(badUnit, 'workflows', 'broken.json'),
        JSON.stringify({
          name: 'broken',
          steps: [
            { action: 'copy', source: 'missing.txt', target: 'relative/path.txt' },
            { action: 'run', script: 'missing.sh', interpreter: 'ruby' },
          ],
        }),
        'utf-8'
      );

      const valRes = run(['validate', 'bad-wf-unit'], tmpDir);
      expect(valRes.status).toBe(1);
      expect(valRes.stdout).toContain('source not found: missing.txt');
      expect(valRes.stdout).toContain('must start with a root placeholder');
      expect(valRes.stdout).toContain("interpreter 'ruby' is not allowed");

      const mdFile = path.join(tmpDir, '..', `ks-readme-test-${Date.now()}.md`);
      try {
        fs.writeFileSync(mdFile, '# Doc\n\nBody.', 'utf-8');
        const instRes = run(['install', mdFile, '--name', 'README'], tmpDir);
        expect(instRes.status).toBe(1);
        expect(instRes.stderr).toContain('README.md');
      } finally {
        if (fs.existsSync(mdFile)) fs.unlinkSync(mdFile);
      }
    });

    it('export creates missing parent directories for --output', () => {
      runCli('init', tmpDir);
      const unitDir = path.join(tmpDir, 'exp-unit');
      fs.mkdirSync(unitDir);
      fs.writeFileSync(path.join(unitDir, 'doc.md'), '# Export', 'utf-8');
      const nestedOut = path.join(tmpDir, 'nested', 'dir', 'out.zip');
      runCli(`export exp-unit --output "${nestedOut}"`, tmpDir);
      expect(fs.existsSync(nestedOut)).toBe(true);
    });

    it('pin <name> <ref> keeps manifest.name synced for aliased units', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pin-alias-'));
      try {
        const git = (args: string[]) =>
          execSync(`git ${args.join(' ')}`, { cwd: repoDir, stdio: 'pipe', encoding: 'utf-8' });
        git(['init']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test User']);
        fs.writeFileSync(
          path.join(repoDir, 'manifest.json'),
          JSON.stringify({ name: 'orig-name', version: '1.0.0', type: 'cookbook', description: 'v1' }),
          'utf-8'
        );
        git(['add', '.']);
        git(['commit', '-m', '"v1"']);
        git(['tag', 'v1.0.0']);

        fs.writeFileSync(
          path.join(repoDir, 'manifest.json'),
          JSON.stringify({ name: 'orig-name', version: '2.0.0', type: 'cookbook', description: 'v2' }),
          'utf-8'
        );
        git(['add', '.']);
        git(['commit', '-m', '"v2"']);

        runCli('init', tmpDir);
        runCli(`add "${repoDir}" --name my-alias`, tmpDir);
        runCli('pin my-alias v1.0.0', tmpDir);
        expect(runCli('validate my-alias', tmpDir)).toContain('my-alias — OK');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('validate detects circular module dependencies and malformed manifest objects without crashing', () => {
      runCli('init', tmpDir);
      const cyclicDir = path.join(tmpDir, 'cyclic-unit');
      fs.mkdirSync(cyclicDir);
      fs.writeFileSync(
        path.join(cyclicDir, 'manifest.json'),
        JSON.stringify({
          name: 'cyclic-unit',
          version: '1.0.0',
          type: 'boilerplate',
          description: 'Cyclic deps and null module',
          modules: {
            a: { dependencies: ['b'] },
            b: { dependencies: ['a'] },
            broken: null,
          },
          scripts: 'invalid',
        }),
        'utf-8'
      );

      const res = run(['validate', 'cyclic-unit'], tmpDir);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('circular dependency detected');
      expect(res.stdout).toContain('modules.broken: must be an object');
      expect(res.stdout).toContain('Field "scripts" must be an object');
    });

    it('info shows single-value tags/aliases, update exits 1 on failure, and install --all skips self', () => {
      runCli('init', tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'single-meta.md'),
        '---\ndescription: Single tag doc\ntags: cucumber\naliases: cuke\n---\n\n# Single Meta\n\nBody.',
        'utf-8'
      );
      const infoOut = runCli('info single-meta.md', tmpDir);
      expect(infoOut).toContain('Tags:         cucumber');
      expect(infoOut).toContain('Aliases:      cuke');

      // install --all --force pointing at knowledgeDir itself skips self cleanly
      const selfInstall = run(['install', tmpDir, '--all', '--force'], tmpDir);
      expect(selfInstall.status).toBe(0);
      expect(selfInstall.stdout).toContain('0 installed, 1 skipped');
      expect(fs.readFileSync(path.join(tmpDir, 'single-meta.md'), 'utf-8')).toContain('Single tag doc');

      // update rejects unknown flags and exits 1 when a remote source fails
      const badFlag = run(['update', '--all'], tmpDir);
      expect(badFlag.status).toBe(1);
      expect(badFlag.stderr).toContain('Unknown option');

      fs.writeFileSync(
        path.join(tmpDir, '.registry.json'),
        JSON.stringify({
          version: '1.0',
          sources: [
            {
              name: 'broken-remote',
              url: 'https://invalid.invalid/nonexistent.git',
              commit: '0000000',
              installedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
        'utf-8'
      );
      const failUpdate = run(['update'], tmpDir);
      expect(failUpdate.status).toBe(1);
      expect(failUpdate.stdout).toContain('1 failed');
    });
  });
});
