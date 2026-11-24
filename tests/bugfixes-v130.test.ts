/**
 * Regression tests for bug fixes:
 * 1. validate <missing-local-path> reports Path not found instead of Access denied.
 * 2. add / sync / install block nesting a unit inside an existing manifest unit or overwriting a namespace holding nested units.
 * 3. search_docs reports total_matches & truncated; CLI search displays total count when truncated.
 * 4. search_docs & CLI search --unit matches standalone .md documents with or without .md extension.
 * 5. validateManifestUnitDir catches missing message.text and non-array copy_dir.exclude.
 * 6. remove across multiple --dir layers skips corrupted secondary layer registries with warning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  toolSearchDocs,
  validateManifestUnitDir,
} from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(dir: string, args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('Bug fixes v1.3.0', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v130-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. validate reports Path not found for nonexistent explicit local paths', () => {
    const kDir = path.join(tmpDir, 'shelf');
    fs.mkdirSync(kDir, { recursive: true });

    const relRes = runCli(['validate', './does-not-exist', '--dir', kDir, '--no-global'], tmpDir);
    expect(relRes.status).toBe(1);
    expect(relRes.stderr).toContain('Path not found');
    expect(relRes.stderr).not.toContain('Access denied');

    const absMissing = path.join(tmpDir, 'definitely-missing-12345');
    const absRes = runCli(['validate', absMissing, '--dir', kDir, '--no-global'], tmpDir);
    expect(absRes.status).toBe(1);
    expect(absRes.stderr).toContain('Path not found');
    expect(absRes.stderr).not.toContain('Access denied');

    // Internal dot-prefixed paths without ./ still report Access denied
    const dotRes = runCli(['validate', '.registry.json', '--dir', kDir, '--no-global'], tmpDir);
    expect(dotRes.status).toBe(1);
    expect(dotRes.stderr).toContain('Access denied');
  });

  it('2. add and sync block nesting inside an existing manifest unit and overwriting namespace with nested units', () => {
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'u1', '--output', repoDir]).status).toBe(0);
    expect(runCli(['scaffold', 'u2', '--output', repoDir]).status).toBe(0);
    git(tmpDir, ['init', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    const kDir = path.join(tmpDir, 'shelf');
    expect(
      runCli(['add', repoDir, '--path', 'u1', '--name', 'parent', '--dir', kDir, '--no-global']).status
    ).toBe(0);

    // Nesting inside existing manifest unit 'parent' must fail
    const nestedRes = runCli([
      'add',
      repoDir,
      '--path',
      'u2',
      '--name',
      'parent/child',
      '--dir',
      kDir,
      '--no-global',
    ]);
    expect(nestedRes.status).toBe(1);
    expect(nestedRes.stderr).toContain("inside existing manifest unit 'parent'");
    expect(fs.existsSync(path.join(kDir, 'parent', 'child'))).toBe(false);

    // Namespace 'team/foo' works, and overwriting 'team' as a unit must fail
    expect(
      runCli(['add', repoDir, '--path', 'u1', '--name', 'team/foo', '--dir', kDir, '--no-global']).status
    ).toBe(0);
    const overwriteNs = runCli([
      'add',
      repoDir,
      '--path',
      'u2',
      '--name',
      'team',
      '--force',
      '--dir',
      kDir,
      '--no-global',
    ]);
    expect(overwriteNs.status).toBe(1);
    expect(overwriteNs.stderr).toContain("nested unit 'team/foo' is already installed under it");
    expect(fs.existsSync(path.join(kDir, 'team', 'foo', 'manifest.json'))).toBe(true);

    // sync into parent/child must also fail
    const syncCfg = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      syncCfg,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'parent/child', url: repoDir, path: 'u2' }],
      }),
      'utf-8'
    );
    const syncRes = runCli(['sync', '--file', syncCfg, '--dir', kDir, '--no-global']);
    expect(syncRes.status).toBe(1);
    expect(syncRes.stderr).toContain("inside existing manifest unit 'parent'");
  });

  it('3. search_docs and CLI search report total_matches / truncated when capped by max_results', () => {
    const kDir = path.join(tmpDir, 'search-shelf');
    fs.mkdirSync(kDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(
        path.join(kDir, `doc-${i}.md`),
        `---\ntitle: Doc ${i}\ndescription: Shared alpha topic\ntags: [alpha]\n---\n# Doc ${i}\nBody\n`,
        'utf-8'
      );
    }

    const mcpRes = toolSearchDocs(kDir, 'alpha', 5);
    expect(mcpRes.isError).toBeFalsy();
    const parsed = JSON.parse(mcpRes.text);
    expect(parsed.total).toBe(5);
    expect(parsed.total_matches).toBe(12);
    expect(parsed.truncated).toBe(true);

    const cliRes = runCli(['search', 'alpha', '--max', '5', '--dir', kDir, '--no-global']);
    expect(cliRes.status).toBe(0);
    expect(cliRes.stdout).toContain('(5 found) [showing top 5 of 12]');
  });

  it('4. search_docs and CLI search --unit match standalone .md files with or without .md extension', () => {
    const kDir = path.join(tmpDir, 'unit-filter-shelf');
    fs.mkdirSync(path.join(kDir, 'guides'), { recursive: true });
    fs.writeFileSync(
      path.join(kDir, 'guides', 'deploy.md'),
      '---\ntitle: Deploy Guide\ndescription: Deployment steps\ntags: [deploy]\n---\n# Deploy\nRun build.\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(kDir, 'guides', 'other.md'),
      '---\ntitle: Other Guide\ndescription: Deployment notes\ntags: [deploy]\n---\n# Other\nNotes.\n',
      'utf-8'
    );

    const mcpRes = JSON.parse(toolSearchDocs(kDir, 'deployment', 10, { unit: 'guides/deploy' }).text);
    expect(mcpRes.total).toBe(1);
    expect(mcpRes.results[0].name).toBe('guides/deploy.md');

    const cliRes = runCli([
      'search',
      'deployment',
      '--unit',
      'guides/deploy',
      '--dir',
      kDir,
      '--no-global',
    ]);
    expect(cliRes.status).toBe(0);
    expect(cliRes.stdout).toContain('guides/deploy.md');
    expect(cliRes.stdout).not.toContain('guides/other.md');
  });

  it('5. validateManifestUnitDir catches missing message.text and non-array copy_dir.exclude', () => {
    const unitDir = path.join(tmpDir, 'bad-wf');
    expect(runCli(['scaffold', 'bad-wf', '--output', tmpDir]).status).toBe(0);
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        name: 'setup',
        steps: [
          { action: 'message' },
          { action: 'copy_dir', source: 'templates', target: '{{TARGET}}/out', exclude: 'bad' },
        ],
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('(message): missing string "text"'))).toBe(true);
    expect(val.errors.some((e) => e.includes('(copy_dir): "exclude" must be an array of strings'))).toBe(
      true
    );
  });

  it('6. cmdRemove skips corrupted registry in another layer with warning and removes valid unit', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    const layer3 = path.join(tmpDir, 'layer3');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });
    fs.mkdirSync(layer3, { recursive: true });

    fs.writeFileSync(path.join(layer1, '.registry.json'), '{"version":"1.0","sources":[]}', 'utf-8');
    fs.writeFileSync(path.join(layer2, '.registry.json'), '{ broken json', 'utf-8');

    const draft = path.join(tmpDir, 'draft');
    expect(runCli(['scaffold', 'clean-unit', '--output', draft]).status).toBe(0);
    expect(
      runCli(['install', path.join(draft, 'clean-unit'), '--dir', layer3, '--no-global']).status
    ).toBe(0);

    const rmRes = runCli([
      'remove',
      'clean-unit',
      '--dir',
      layer1,
      '--dir',
      layer2,
      '--dir',
      layer3,
      '--no-global',
    ]);
    expect(rmRes.status).toBe(0);
    expect(rmRes.stderr).toContain('Warning: Skipping invalid registry');
    expect(rmRes.stdout).toContain("✓ Removed 'clean-unit'");
    expect(fs.existsSync(path.join(layer3, 'clean-unit'))).toBe(false);
  });
});
