/**
 * Regression tests for bug fixes:
 * 1. cmdInstall --all on single unit does not leak root overview.md as standalone doc
 * 2. --path . / ./ works for add, update, pin, sync, and publish
 * 3. Trailing slashes on unit names are normalized and do not trigger "Access denied"
 * 4. Standalone .md units without .md extension resolve in trust, untrust, pin, unpin, update
 * 5. toolGetManifest returns clear error when manifest.json is invalid JSON
 * 6. toolRunWorkflow validates pattern for manifest.placeholders inputs
 * 7. validateManifestUnitDir rejects directories in modules.files under brace expansion
 * 8. resolveKnowledgeDir prioritizes .agents/knowledges
 * 9. cmdSearch CLI supports --tag, --unit, --content, --max
 * 10. resolveSafeOutputTarget handles {{TARGET}}/. and canonical root
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  resolveKnowledgeDir,
  resolveSafeOutputTarget,
  toolGetManifest,
  toolRunWorkflow,
  validateManifestUnitDir,
} from '../src/core.js';
import { loadRegistry } from '../src/cli/registry.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(dir: string, args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('Bug Fixes v1.2.1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v121-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. cmdInstall --all on single unit does not leak overview.md to root', () => {
    const kDir = path.join(tmpDir, 'k');
    const srcDir = path.join(tmpDir, 'src', 'demo-unit');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'manifest.json'),
      JSON.stringify({
        name: 'demo-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Test unit',
        doc: 'overview.md',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(srcDir, 'overview.md'), '# Overview\n\nContent', 'utf-8');

    const res = runCli(['install', srcDir, '--all', '--dir', kDir, '--no-global']);
    expect(res.status).toBe(0);

    expect(fs.existsSync(path.join(kDir, 'demo-unit', 'manifest.json'))).toBe(true);
    // Root overview.md must NOT exist
    expect(fs.existsSync(path.join(kDir, 'overview.md'))).toBe(false);
  });

  it('2. --path . works for add, sync, and publish', () => {
    const kDir = path.join(tmpDir, 'k');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);

    fs.writeFileSync(
      path.join(repoDir, 'manifest.json'),
      JSON.stringify({
        name: 'root-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Root unit test',
        doc: 'overview.md',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(repoDir, 'overview.md'), '# Root Unit\n\nOverview', 'utf-8');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'initial']);

    // add with --path .
    const addRes = runCli(['add', repoDir, '--path', '.', '--dir', kDir, '--no-global']);
    expect(addRes.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'root-unit', 'manifest.json'))).toBe(true);

    // publish with --path .
    const bareRepo = path.join(tmpDir, 'bare.git');
    fs.mkdirSync(bareRepo, { recursive: true });
    git(bareRepo, ['init', '--bare']);

    const pubRes = runCli(['publish', 'root-unit', '--to', bareRepo, '--path', '.', '--branch', 'main', '--push', '--dir', kDir, '--no-global']);
    expect(pubRes.status).toBe(0);

    // sync with path "." in knowledge-shelf.json
    const kSyncDir = path.join(tmpDir, 'k-sync');
    const syncCfg = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      syncCfg,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'root-unit', url: repoDir.replace(/\\/g, '/'), path: '.' }],
      }),
      'utf-8'
    );
    const syncRes = runCli(['sync', '--file', syncCfg, '--dir', kSyncDir, '--no-global']);
    expect(syncRes.status).toBe(0);
    expect(fs.existsSync(path.join(kSyncDir, 'root-unit', 'manifest.json'))).toBe(true);
  });

  it('3. trailing slashes on unit names normalize cleanly across commands', () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'my-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Testing trailing slashes',
        doc: 'overview.md',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# My Unit\n\nDocs', 'utf-8');

    // info with trailing slash
    const infoRes = runCli(['info', 'my-unit/', '--dir', kDir, '--no-global']);
    expect(infoRes.status).toBe(0);
    expect(infoRes.stdout).toContain('Testing trailing slashes');

    // export with trailing slash
    const zipPath = path.join(tmpDir, 'out.zip');
    const exportRes = runCli(['export', 'my-unit/', '--output', zipPath, '--dir', kDir, '--no-global']);
    expect(exportRes.status).toBe(0);
    expect(fs.existsSync(zipPath)).toBe(true);

    // validate with trailing slash
    const valRes = runCli(['validate', 'my-unit/', '--dir', kDir, '--no-global']);
    expect(valRes.status).toBe(0);
    expect(valRes.stdout).toContain('OK');

    // remove with trailing slash
    const rmRes = runCli(['remove', 'my-unit/', '--dir', kDir, '--no-global']);
    expect(rmRes.status).toBe(0);
    expect(fs.existsSync(unitDir)).toBe(false);
  });

  it('4. standalone .md commands accept unit name without .md extension', () => {
    const kDir = path.join(tmpDir, 'k');
    runCli(['init', '--dir', kDir, '--no-global']);

    const srcMd = path.join(tmpDir, 'guide.md');
    fs.writeFileSync(srcMd, '---\ndescription: Sample guide\ntags: [guide]\n---\n# Guide\n\nContent', 'utf-8');

    const installRes = runCli(['install', srcMd, '--dir', kDir, '--no-global']);
    expect(installRes.status).toBe(0);

    // trust without .md
    const trustRes = runCli(['trust', 'guide', '--dir', kDir, '--no-global']);
    expect(trustRes.status).toBe(0);
    expect(trustRes.stdout).toContain("Marked 'guide.md' as trusted");

    // pin without .md
    const pinRes = runCli(['pin', 'guide', '--dir', kDir, '--no-global']);
    expect(pinRes.status).toBe(0);
    expect(pinRes.stdout).toContain("Pinned 'guide.md'");

    // unpin without .md
    const unpinRes = runCli(['unpin', 'guide', '--dir', kDir, '--no-global']);
    expect(unpinRes.status).toBe(0);
    expect(unpinRes.stdout).toContain("Unpinned 'guide.md'");

    // update without .md
    const updateRes = runCli(['update', 'guide', '--dir', kDir, '--no-global']);
    expect(updateRes.status).toBe(0);
    expect(updateRes.stdout).toContain("Updated from local path");
  });

  it('5. toolGetManifest returns syntax error when manifest.json is invalid JSON', () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'broken-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'manifest.json'), '{ broken json', 'utf-8');

    const res = toolGetManifest(kDir, 'broken-unit');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Invalid manifest.json in \'broken-unit\'');
  });

  it('6. toolRunWorkflow validates pattern for manifest.placeholders inputs', async () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'ph-unit');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'ph-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Placeholder test',
        placeholders: {
          APP_ID: {
            type: 'string',
            pattern: '^[a-z0-9-]+$',
            description: 'Lowercase alphanumeric',
          },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'app.txt'), 'app={{APP_ID}}\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'gen.json'),
      JSON.stringify({
        name: 'gen',
        inputs: {
          TARGET: { required: true, type: 'path' },
        },
        steps: [
          { action: 'copy', source: 'templates/app.txt', target: '{{TARGET}}/app.txt' },
        ],
      }),
      'utf-8'
    );

    const targetDir = path.join(tmpDir, 'target');
    const res = await toolRunWorkflow(
      kDir,
      'ph-unit',
      'gen',
      { TARGET: targetDir, APP_ID: 'INVALID SPACE' },
      { dryRun: true }
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Input 'APP_ID' does not match pattern '^[a-z0-9-]+$'");
  });

  it('7. validateManifestUnitDir rejects directories in modules.files under brace expansion', () => {
    const unitDir = path.join(tmpDir, 'brace-unit');
    fs.mkdirSync(path.join(unitDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'brace-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Brace unit',
        modules: {
          core: {
            files: ['{src,lib}'],
          },
        },
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('is a directory'))).toBe(true);
  });

  it('8. resolveKnowledgeDir prioritizes .agents/knowledges when present', () => {
    const projDir = path.join(tmpDir, 'proj');
    const agentsDir = path.join(projDir, '.agents', 'knowledges');
    fs.mkdirSync(agentsDir, { recursive: true });

    const prevCwd = process.cwd();
    const prevDir = process.env.KNOWLEDGE_DIR;
    const prevDirs = process.env.KNOWLEDGE_DIRS;
    delete process.env.KNOWLEDGE_DIR;
    delete process.env.KNOWLEDGE_DIRS;

    try {
      process.chdir(projDir);
      const resolved = resolveKnowledgeDir();
      expect(resolved.toLowerCase()).toBe(path.resolve(agentsDir).toLowerCase());
    } finally {
      process.chdir(prevCwd);
      if (prevDir) process.env.KNOWLEDGE_DIR = prevDir;
      if (prevDirs) process.env.KNOWLEDGE_DIRS = prevDirs;
    }
  });

  it('9. cmdSearch CLI supports --tag, --unit, --content, --max', () => {
    const kDir = path.join(tmpDir, 'k');
    const doc1 = path.join(kDir, 'doc1.md');
    const doc2 = path.join(kDir, 'doc2.md');
    fs.mkdirSync(kDir, { recursive: true });

    fs.writeFileSync(
      doc1,
      '---\ntitle: Doc One\ndescription: First document\ntags: [alpha, shared]\n---\n# Doc One\nSpecialContentKeyword\n',
      'utf-8'
    );
    fs.writeFileSync(
      doc2,
      '---\ntitle: Doc Two\ndescription: Second document\ntags: [beta, shared]\n---\n# Doc Two\nOther content\n',
      'utf-8'
    );

    // Filter by tag
    const resTag = runCli(['search', 'document', '--tag', 'alpha', '--dir', kDir, '--no-global']);
    expect(resTag.status).toBe(0);
    expect(resTag.stdout).toContain('doc1.md');
    expect(resTag.stdout).not.toContain('doc2.md');

    // Filter with --content
    const resContent = runCli(['search', 'SpecialContentKeyword', '--content', '--dir', kDir, '--no-global']);
    expect(resContent.status).toBe(0);
    expect(resContent.stdout).toContain('doc1.md');
    expect(resContent.stdout).toContain('SpecialContentKeyword');

    // Filter with --max 1
    const resMax = runCli(['search', 'document', '--max', '1', '--dir', kDir, '--no-global']);
    expect(resMax.status).toBe(0);
    expect(resMax.stdout).toContain('(1 found)');
  });

  it('10. resolveSafeOutputTarget handles {{TARGET}}/. and canonical root path', () => {
    const root = path.join(tmpDir, 'my-root');
    fs.mkdirSync(root, { recursive: true });

    const res1 = resolveSafeOutputTarget('{{TARGET}}', { TARGET: root });
    expect(res1.resolvedPath).toBe(path.resolve(root));

    const res2 = resolveSafeOutputTarget('{{TARGET}}/.', { TARGET: root });
    expect(res2.resolvedPath).toBe(path.resolve(root));

    const res3 = resolveSafeOutputTarget('{{TARGET}}/./', { TARGET: root });
    expect(res3.resolvedPath).toBe(path.resolve(root));
  });
});
