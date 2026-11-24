/**
 * Regression tests for bug fixes v1.2.3:
 * 1. toolRunWorkflow cleanly handles null, array, or non-object workflow JSON
 * 2. loadManifest & toolGetManifest reject array or non-object manifest.json
 * 3. cmdAdd --pack installs standalone .md files without ENOTDIR crash
 * 4. Walk-up resolution prioritizes CWD .registry.json over parent .agents/knowledges
 * 5. cmdPublish --path . cleans up stale files in root repo without removing .git or shelf.json
 * 6. cmdInstall --all & cmdAdd --all install nested standalone .md files
 * 7. Deprecated status down-ranking factor applies to complete search score including content hits
 * 8. CLI supports export -o, rejects version unknown flags, and parses --key=val options
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  loadManifest,
  rankDocuments,
  resolveKnowledgeDir,
  resolveKnowledgeDirs,
  scanDocuments,
  toolGetManifest,
  toolRunWorkflow,
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

describe('Bug Fixes v1.2.3', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v123-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. toolRunWorkflow cleanly handles null, array, or non-object workflow JSON without crash', async () => {
    const kDir = path.join(tmpDir, 'kb');
    const unitDir = path.join(kDir, 'probe-unit');
    const wfDir = path.join(unitDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'probe-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'probe',
        workflows: {
          nullwf: { description: 'null' },
          arrwf: { description: 'arr' },
          nosteps: { description: 'no steps' },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(wfDir, 'nullwf.json'), 'null', 'utf-8');
    fs.writeFileSync(path.join(wfDir, 'arrwf.json'), '[1, 2, 3]', 'utf-8');
    fs.writeFileSync(path.join(wfDir, 'nosteps.json'), '{"name":"nosteps"}', 'utf-8');

    const resNull = await toolRunWorkflow(kDir, 'probe-unit', 'nullwf', {});
    expect(resNull.isError).toBe(true);
    expect(resNull.text).toContain('invalid definition');

    const resArr = await toolRunWorkflow(kDir, 'probe-unit', 'arrwf', {});
    expect(resArr.isError).toBe(true);
    expect(resArr.text).toContain('invalid definition');

    const resNoSteps = await toolRunWorkflow(kDir, 'probe-unit', 'nosteps', {});
    expect(resNoSteps.isError).toBe(true);
    expect(resNoSteps.text).toContain('invalid definition');
  });

  it('2. loadManifest & toolGetManifest reject array or non-object manifest.json', () => {
    const kDir = path.join(tmpDir, 'kb');
    const unitDir = path.join(kDir, 'arr-manifest');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'manifest.json'), '[1, 2, 3]', 'utf-8');

    expect(loadManifest(unitDir)).toBeNull();

    const getRes = toolGetManifest(kDir, 'arr-manifest');
    expect(getRes.isError).toBe(true);
    expect(getRes.text).toContain('expected a JSON object');
  });

  it('3. cmdAdd --pack installs standalone .md files without ENOTDIR crash', () => {
    const packRepo = path.join(tmpDir, 'pack-repo');
    fs.mkdirSync(packRepo, { recursive: true });
    git(packRepo, ['init']);
    git(packRepo, ['config', 'user.email', 'test@example.com']);
    git(packRepo, ['config', 'user.name', 'Test']);

    fs.writeFileSync(
      path.join(packRepo, 'guide.md'),
      '---\ndescription: Pack guide\ntags: [pack]\n---\n# Pack Guide\nContent',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(packRepo, 'shelf.json'),
      JSON.stringify({
        name: 'pack-repo',
        units: [{ name: 'guide.md', path: 'guide.md' }],
        packs: { docs: { units: ['guide.md'] } },
      }),
      'utf-8'
    );
    git(packRepo, ['add', '.']);
    git(packRepo, ['commit', '-m', 'init']);

    const targetKd = path.join(tmpDir, 'target-kd');
    const addRes = runCli(['add', packRepo, '--pack', 'docs', '--dir', targetKd]);
    expect(addRes.status).toBe(0);
    expect(addRes.stdout).toContain("Installed 'guide.md'");

    const reg = loadRegistry(targetKd);
    expect(reg.sources.some((s) => s.name === 'guide.md')).toBe(true);
    expect(fs.existsSync(path.join(targetKd, 'guide.md'))).toBe(true);
  });

  it('4. Walk-up resolution prioritizes CWD .registry.json over parent .agents/knowledges', () => {
    const parentDir = path.join(tmpDir, 'parent');
    const agentsDir = path.join(parentDir, '.agents', 'knowledges');
    const childProj = path.join(parentDir, 'child-proj');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(childProj, { recursive: true });
    fs.writeFileSync(path.join(childProj, '.registry.json'), '{"version":"1.0","sources":[]}', 'utf-8');

    const prevCwd = process.cwd();
    const prevDir = process.env.KNOWLEDGE_DIR;
    const prevDirs = process.env.KNOWLEDGE_DIRS;
    delete process.env.KNOWLEDGE_DIR;
    delete process.env.KNOWLEDGE_DIRS;

    try {
      process.chdir(childProj);
      const single = resolveKnowledgeDir();
      expect(single.toLowerCase()).toBe(path.resolve(childProj).toLowerCase());

      const multi = resolveKnowledgeDirs(undefined, { includeGlobal: false });
      expect(multi[0].toLowerCase()).toBe(path.resolve(childProj).toLowerCase());
      expect(multi.map((d) => d.toLowerCase())).toContain(path.resolve(agentsDir).toLowerCase());
    } finally {
      process.chdir(prevCwd);
      if (prevDir) process.env.KNOWLEDGE_DIR = prevDir;
      if (prevDirs) process.env.KNOWLEDGE_DIRS = prevDirs;
    }
  });

  it('5. cmdPublish --path . cleans up stale files in root repo without removing .git or shelf.json', () => {
    const bareRepo = path.join(tmpDir, 'bare.git');
    git(tmpDir, ['init', '--bare', bareRepo]);

    const seed = path.join(tmpDir, 'seed');
    git(tmpDir, ['clone', bareRepo, seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seed, 'stale-old-file.md'), '# stale', 'utf-8');
    fs.writeFileSync(
      path.join(seed, 'shelf.json'),
      JSON.stringify({ name: 'shared-catalog', units: [] }),
      'utf-8'
    );
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'initial']);
    const defBranch = git(seed, ['symbolic-ref', '--short', 'HEAD']);
    git(seed, ['push', '-u', 'origin', defBranch]);

    const localKd = path.join(tmpDir, 'local-kd');
    runCli(['init', '--dir', localKd]);
    runCli(['scaffold', 'demo-unit', '--output', localKd]);

    const pubRes = runCli([
      'publish',
      path.join(localKd, 'demo-unit'),
      '--to',
      bareRepo,
      '--path',
      '.',
      '--branch',
      defBranch,
      '--push',
    ]);
    expect(pubRes.status).toBe(0);

    const verify = path.join(tmpDir, 'verify');
    git(tmpDir, ['clone', '--branch', defBranch, bareRepo, verify]);
    const entries = fs.readdirSync(verify);
    expect(entries).not.toContain('stale-old-file.md');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('shelf.json');
  });

  it('6. cmdInstall --all & cmdAdd --all install nested standalone .md files', () => {
    const srcDir = path.join(tmpDir, 'src-nested');
    const nestedSub = path.join(srcDir, 'sub', 'nested');
    fs.mkdirSync(nestedSub, { recursive: true });
    fs.writeFileSync(
      path.join(nestedSub, 'deep.md'),
      '---\ndescription: Deep doc\ntags: [deep]\n---\n# Deep Doc\nHello',
      'utf-8'
    );

    const destKd = path.join(tmpDir, 'dest-kd');
    runCli(['init', '--dir', destKd]);
    const instRes = runCli(['install', srcDir, '--all', '--dir', destKd]);
    expect(instRes.status).toBe(0);
    expect(fs.existsSync(path.join(destKd, 'sub', 'nested', 'deep.md'))).toBe(true);

    const reg = loadRegistry(destKd);
    expect(reg.sources.some((s) => s.name === 'sub/nested/deep.md')).toBe(true);
  });

  it('7. Deprecated status down-ranking factor applies to complete search score including content hits', () => {
    const docs = [
      {
        name: 'active-unit',
        title: 'Alpha Widget Guide',
        description: 'Guide for widget',
        tags: ['widget'],
        has_manifest: false,
      },
      {
        name: 'deprecated-unit',
        title: 'Alpha Widget Guide',
        description: 'Guide for widget',
        tags: ['widget'],
        status: 'deprecated',
        has_manifest: false,
      },
    ];

    const results = rankDocuments(docs, 'Alpha Widget');
    expect(results.length).toBe(2);
    expect(results[0].name).toBe('active-unit');
    expect(results[1].name).toBe('deprecated-unit');
    expect(results[1].relevance_score).toBeLessThan(results[0].relevance_score);
  });

  it('8. CLI supports export -o, rejects version unknown flags, and parses --key=val options', () => {
    const localKd = path.join(tmpDir, 'local-flags');
    runCli(['init', '--dir', localKd]);
    runCli(['scaffold', 'unit-a', '--output', localKd]);

    const zipOut = path.join(tmpDir, 'out-short.zip');
    const expRes = runCli(['export', 'unit-a', '--dir', localKd, '-o', zipOut]);
    expect(expRes.status).toBe(0);
    expect(fs.existsSync(zipOut)).toBe(true);

    const verRes = runCli(['version', '--unknown-flag']);
    expect(verRes.status).toBe(1);
    expect(verRes.stderr).toContain("Unknown option '--unknown-flag' for 'version'");

    const searchRes = runCli(['search', '--type=boilerplate', 'unit', '--dir', localKd]);
    expect(searchRes.status).toBe(0);
    expect(searchRes.stdout).toContain('unit-a');
  });
});
