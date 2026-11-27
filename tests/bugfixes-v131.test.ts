/**
 * Regression tests for bug fixes v1.3.1:
 * 1. Archive import/inspection rejects symbolic and hard links in .tar.gz archives.
 * 2. sync with a failing/invalid entry still saves previously synced entries to .registry.json and cleans .cache.
 * 3. export refuses to write the output archive inside the exported unit directory.
 * 4. publish of a standalone .md with --path <dir> (no trailing slash) places the file inside that directory.
 * 5. validateManifestUnitDir catches type errors on tags, aliases, placeholders, workflow.inputs, and run step args.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  resolveWindowsExecutable,
  toolRunWorkflow,
  toolSearchDocs,
  validateManifestUnitDir,
} from '../src/core.js';
import { assertNoSymlinks, assertSafeArchivePaths } from '../src/cli/git.js';

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

describe('Bug fixes v1.3.1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v131-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. import and assertSafeArchivePaths reject symlinks and hardlinks in archives', () => {
    const stage = path.join(tmpDir, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    const secretFile = path.join(tmpDir, 'secret-outside.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_DATA\n', 'utf-8');
    const regularFile = path.join(stage, 'normal.md');
    fs.writeFileSync(regularFile, '# Normal\nContent\n', 'utf-8');

    // Hardlink test (works without elevated privileges on Windows & Unix)
    const hardlinkPath = path.join(stage, 'hardlink.md');
    fs.linkSync(regularFile, hardlinkPath);
    const hardTar = path.join(tmpDir, 'hard.tar.gz');
    const tarHardRes = spawnSync('tar', ['-czf', hardTar, '-C', stage, 'normal.md', 'hardlink.md'], {
      stdio: 'pipe',
    });
    expect(tarHardRes.status).toBe(0);
    expect(() => assertSafeArchivePaths(hardTar)).toThrow(/symbolic or hard link/i);

    const kb = path.join(tmpDir, 'shelf');
    const impHardRes = runCli(['import', hardTar, '--dir', kb, '--no-global']);
    expect(impHardRes.status).toBe(1);
    expect(impHardRes.stderr).toMatch(/symbolic or hard link/i);

    // Symlink test (if OS permissions allow creating symlinks)
    const symStage = path.join(tmpDir, 'sym-stage');
    fs.mkdirSync(symStage, { recursive: true });
    let symlinkCreated = false;
    try {
      fs.symlinkSync(secretFile, path.join(symStage, 'evil.md'));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      expect(() => assertNoSymlinks(symStage)).toThrow(/symbolic link/i);

      const symTar = path.join(tmpDir, 'sym.tar.gz');
      const tarSymRes = spawnSync('tar', ['-czf', symTar, '-C', symStage, 'evil.md'], {
        stdio: 'pipe',
      });
      expect(tarSymRes.status).toBe(0);
      expect(() => assertSafeArchivePaths(symTar)).toThrow(/symbolic or hard link/i);

      const impSymRes = runCli(['import', symTar, '--dir', kb, '--no-global']);
      expect(impSymRes.status).toBe(1);
      expect(fs.existsSync(path.join(kb, 'evil.md'))).toBe(false);
    }
  });

  it('2. sync persists valid units in .registry.json and cleans .cache when another entry has an unsafe name', () => {
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'good-unit', '--output', repoDir]).status).toBe(0);
    git(tmpDir, ['init', '-b', 'main', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    const kDir = path.join(tmpDir, 'shelf');
    const cfgPath = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [
          { name: 'good-unit', url: repoDir, path: 'good-unit' },
          { name: '../evil-unit', url: repoDir, path: 'good-unit' },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']);
    expect(syncRes.status).toBe(1);
    expect(syncRes.stderr).toContain('outside the knowledge directory');

    // good-unit must be installed AND recorded in .registry.json
    expect(fs.existsSync(path.join(kDir, 'good-unit', 'manifest.json'))).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    expect(reg.sources.some((s: { name: string }) => s.name === 'good-unit')).toBe(true);

    // .cache must not leak temporary clone directories
    const cacheEntries = fs.existsSync(path.join(kDir, '.cache'))
      ? fs.readdirSync(path.join(kDir, '.cache'))
      : [];
    expect(cacheEntries).toHaveLength(0);
  });

  it('3. export refuses to write archive inside the exported unit directory', () => {
    const kDir = path.join(tmpDir, 'shelf');
    const draft = path.join(tmpDir, 'draft');
    expect(runCli(['scaffold', 'demo-unit', '--output', draft]).status).toBe(0);
    expect(runCli(['install', path.join(draft, 'demo-unit'), '--dir', kDir, '--no-global']).status).toBe(0);

    const unitDir = path.join(kDir, 'demo-unit');
    const resCwdInside = runCli(['export', 'demo-unit', '--dir', kDir, '--no-global'], unitDir);
    expect(resCwdInside.status).toBe(1);
    expect(resCwdInside.stderr).toContain('cannot be inside the exported unit directory');
    expect(fs.existsSync(path.join(unitDir, 'demo-unit.zip'))).toBe(false);

    const resExplicitInside = runCli([
      'export',
      'demo-unit',
      '--output',
      path.join(unitDir, 'sub', 'out.zip'),
      '--dir',
      kDir,
      '--no-global',
    ]);
    expect(resExplicitInside.status).toBe(1);
    expect(resExplicitInside.stderr).toContain('cannot be inside the exported unit directory');
    expect(fs.existsSync(path.join(unitDir, 'sub', 'out.zip'))).toBe(false);
  });

  it('4. publish standalone .md with --path <dir> (no trailing slash) writes <dir>/<file>.md', () => {
    const bareRepo = path.join(tmpDir, 'remote.git');
    const seedDir = path.join(tmpDir, 'seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Repo\n', 'utf-8');
    git(seedDir, ['add', '.']);
    git(seedDir, ['commit', '-m', 'init']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    const mdFile = path.join(tmpDir, 'deploy-guide.md');
    fs.writeFileSync(
      mdFile,
      '---\ntitle: Deploy Guide\ndescription: Deployment notes\ntags: [deploy]\n---\n# Deploy\nRun.\n',
      'utf-8'
    );

    const pubRes = runCli([
      'publish',
      mdFile,
      '--to',
      bareRepo,
      '--branch',
      'main',
      '--path',
      'guides',
      '--push',
    ]);
    expect(pubRes.status).toBe(0);

    const verifyDir = path.join(tmpDir, 'verify');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir]);
    expect(fs.existsSync(path.join(verifyDir, 'guides', 'deploy-guide.md'))).toBe(true);
    expect(fs.statSync(path.join(verifyDir, 'guides')).isDirectory()).toBe(true);

    // Explicit .md destination path still works as a rename
    const pubRenameRes = runCli([
      'publish',
      mdFile,
      '--to',
      bareRepo,
      '--branch',
      'main',
      '--path',
      'guides/custom-name.md',
      '--push',
    ]);
    expect(pubRenameRes.status).toBe(0);
    const verifyDir2 = path.join(tmpDir, 'verify2');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir2]);
    expect(fs.existsSync(path.join(verifyDir2, 'guides', 'custom-name.md'))).toBe(true);
  });

  it('5. validateManifestUnitDir rejects invalid types for tags, aliases, placeholders, inputs, and run args', () => {
    const unitDir = path.join(tmpDir, 'bad-types');
    expect(runCli(['scaffold', 'bad-types', '--output', tmpDir]).status).toBe(0);
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'scripts', 'echo.js'), 'console.log("ok");\n', 'utf-8');

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'bad-types',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Bad types test',
        tags: 'not-an-array',
        aliases: [123],
        placeholders: ['not-an-object'],
        workflows: { setup: { description: 'run' } },
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: ['not-an-object'],
        steps: [{ action: 'run', script: 'scripts/echo.js', args: '--flag value' }],
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('Field "tags" must be an array of strings'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "aliases" must be an array of strings'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "placeholders" must be an object'))).toBe(true);
    expect(val.errors.some((e) => e.includes('field "inputs" must be an object'))).toBe(true);
    expect(val.errors.some((e) => e.includes('(run): "args" must be an array of strings'))).toBe(true);
  });

  it('6. sync updates unit when source path changes at the same commit and --frozen detects path/url mismatches', () => {
    const repoDir = path.join(tmpDir, 'mono-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'unit-a', '--output', repoDir]).status).toBe(0);
    expect(runCli(['scaffold', 'unit-b', '--output', repoDir]).status).toBe(0);
    git(tmpDir, ['init', '-b', 'main', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init monorepo']);

    const kDir = path.join(tmpDir, 'shelf');
    const cfgPath = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'my-slot', url: repoDir, path: 'unit-a' }],
      }),
      'utf-8'
    );

    const sync1 = runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']);
    expect(sync1.status).toBe(0);
    expect(fs.readFileSync(path.join(kDir, 'my-slot', 'overview.md'), 'utf-8')).toContain('# unit-a');

    // Change path to unit-b at the exact same commit
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'my-slot', url: repoDir, path: 'unit-b' }],
      }),
      'utf-8'
    );

    const frozenMismatch = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kDir, '--no-global']);
    expect(frozenMismatch.status).toBe(1);
    expect(frozenMismatch.stderr).toContain('path mismatch');

    const sync2 = runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']);
    expect(sync2.status).toBe(0);
    expect(fs.readFileSync(path.join(kDir, 'my-slot', 'overview.md'), 'utf-8')).toContain('# unit-b');

    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    expect(reg.sources.find((s: { name: string }) => s.name === 'my-slot')?.path).toBe('unit-b');

    const frozenOk = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kDir, '--no-global']);
    expect(frozenOk.status).toBe(0);
  });

  it('7. sync --frozen detects branch mismatch', () => {
    const bareRepo = path.join(tmpDir, 'branch-repo.git');
    const seed = path.join(tmpDir, 'branch-seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    expect(runCli(['scaffold', 'unit-a', '--output', seed]).status).toBe(0);
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'main init']);
    git(seed, ['push', '-u', 'origin', 'main']);

    git(seed, ['checkout', '-b', 'v2']);
    fs.appendFileSync(path.join(seed, 'unit-a', 'overview.md'), '\n## v2\n', 'utf-8');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'v2 branch']);
    git(seed, ['push', '-u', 'origin', 'v2']);

    const kDir = path.join(tmpDir, 'shelf-branch');
    const cfgPath = path.join(tmpDir, 'branch-sync.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'unit-a', url: bareRepo, path: 'unit-a', branch: 'main' }],
      }),
      'utf-8'
    );
    expect(runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']).status).toBe(0);
    expect(runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kDir, '--no-global']).status).toBe(0);

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'unit-a', url: bareRepo, path: 'unit-a', branch: 'v2' }],
      }),
      'utf-8'
    );
    const mismatch = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kDir, '--no-global']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('branch mismatch');
  });

  it('8. index cache invalidates when non-markdown code reference files change', () => {
    const kDir = path.join(tmpDir, 'cache-java');
    const unitDir = path.join(kDir, 'java-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    const refPath = path.join(unitDir, 'Guide.java');
    fs.writeFileSync(refPath, '// alphaUniqueToken\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'java-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Java reference unit',
        references: { guide: { file: 'Guide.java', description: 'Java guide' } },
      }),
      'utf-8'
    );

    const before = JSON.parse(toolSearchDocs(kDir, 'betaUniqueToken', 10, { includeContent: true }).text);
    expect(before.total).toBe(0);

    fs.writeFileSync(refPath, '// betaUniqueToken updated content\n', 'utf-8');
    const after = JSON.parse(toolSearchDocs(kDir, 'betaUniqueToken', 10, { includeContent: true }).text);
    expect(after.total).toBe(1);
  });

  it('9. dry_run simulates sequential copy and patch steps and rejects non-object workflow steps cleanly', async () => {
    const kDir = path.join(tmpDir, 'wf-dry');
    const unitDir = path.join(kDir, 'demo');
    const targetDir = path.join(tmpDir, 'wf-target');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Dry run test',
        workflows: { chain: {}, bad: {} },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'host.txt'), 'header\nANCHOR_ONE\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'chain.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [
          { action: 'copy', source: 'templates/host.txt', target: '{{TARGET}}/host.txt' },
          { action: 'patch', target: '{{TARGET}}/host.txt', mode: 'replace', anchor: 'ANCHOR_ONE', content: 'ANCHOR_TWO' },
          { action: 'patch', target: '{{TARGET}}/host.txt', mode: 'replace', anchor: 'ANCHOR_TWO', content: 'FINAL_OK' },
        ],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'bad.json'),
      JSON.stringify({ steps: [null] }),
      'utf-8'
    );

    const dryRes = await toolRunWorkflow(kDir, 'demo', 'chain', { TARGET: targetDir }, { dryRun: true });
    expect(dryRes.isError).toBe(false);
    const dryJson = JSON.parse(dryRes.text);
    expect(dryJson.files_created).toHaveLength(1);
    expect(dryJson.files_patched).toHaveLength(2);
    expect(fs.existsSync(path.join(targetDir, 'host.txt'))).toBe(false);

    const realRes = await toolRunWorkflow(kDir, 'demo', 'chain', { TARGET: targetDir });
    expect(realRes.isError).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, 'host.txt'), 'utf-8')).toBe('header\nFINAL_OK\n');

    const badRes = await toolRunWorkflow(kDir, 'demo', 'bad', {});
    expect(badRes.isError).toBe(true);
    const badJson = JSON.parse(badRes.text);
    expect(badJson.errors[0]).toContain('Step 1: Step must be a JSON object.');
  });

  it('10. workflow run timeout terminates spawned child processes', async () => {
    const kDir = path.join(tmpDir, 'wf-timeout');
    const unitDir = path.join(kDir, 'timeout-unit');
    const targetDir = path.join(tmpDir, 'wf-timeout-target');
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'timeout-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Timeout tree kill test',
        workflows: { hang: {} },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'scripts', 'spawn-child.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "const out = process.argv[2];",
        "const code = 'setTimeout(() => require(\"node:fs\").writeFileSync(process.argv[1], \"survived\"), 2000)';",
        "spawn(process.execPath, ['-e', code, out], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'hang.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [
          {
            action: 'run',
            script: 'scripts/spawn-child.mjs',
            args: ['{{TARGET}}/survived.txt'],
            timeout_ms: 1000,
          },
        ],
      }),
      'utf-8'
    );

    const res = await toolRunWorkflow(kDir, 'timeout-unit', 'hang', { TARGET: targetDir });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.errors[0]).toContain('timed out');

    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(path.join(targetDir, 'survived.txt'))).toBe(false);
  });

  it('11. validateManifestUnitDir validates and warns on undeclared workflows/*.json files', () => {
    const unitDir = path.join(tmpDir, 'undeclared-wf');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'undeclared-wf',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Test undeclared workflow validation',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'sneaky.json'),
      JSON.stringify({
        steps: [{ action: 'copy', source: '../outside.txt', target: '/abs/no-placeholder' }],
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir, 'undeclared-wf');
    expect(val.warnings.some((w) => w.includes('workflows/sneaky.json') && w.includes('not declared'))).toBe(true);
    expect(val.errors.some((e) => e.includes('workflows/sneaky.json') && e.includes('escapes unit folder'))).toBe(true);
    expect(val.errors.some((e) => e.includes('workflows/sneaky.json') && e.includes('root placeholder'))).toBe(true);
  });

  it('12. cmdRemove does not delete lower-layer tracked unit when primary layer holds an unmanaged unit of the same name', () => {
    const layer1 = path.join(tmpDir, 'rm-l1');
    const layer2 = path.join(tmpDir, 'rm-l2');
    fs.mkdirSync(path.join(layer1, 'shared'), { recursive: true });
    fs.writeFileSync(
      path.join(layer1, 'shared', 'manifest.json'),
      JSON.stringify({ name: 'shared', version: '1.0.0', type: 'toolkit', description: 'L1 unmanaged' }),
      'utf-8'
    );

    const draft2 = path.join(tmpDir, 'rm-draft2');
    fs.mkdirSync(draft2, { recursive: true });
    fs.writeFileSync(
      path.join(draft2, 'manifest.json'),
      JSON.stringify({ name: 'shared', version: '1.0.0', type: 'toolkit', description: 'L2 tracked' }),
      'utf-8'
    );
    expect(runCli(['install', draft2, '--dir', layer2, '--no-global']).status).toBe(0);

    const rmRes = runCli(['remove', 'shared', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(rmRes.status).toBe(0);
    expect(fs.existsSync(path.join(layer1, 'shared'))).toBe(false);
    expect(fs.existsSync(path.join(layer2, 'shared', 'manifest.json'))).toBe(true);
  });

  it('13. sync --frozen succeeds when config sets both branch and pin/tag ref', () => {
    const bareRepo = path.join(tmpDir, 'pin-branch-repo.git');
    const seed = path.join(tmpDir, 'pin-branch-seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    expect(runCli(['scaffold', 'unit-p', '--output', seed]).status).toBe(0);
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'v1']);
    git(seed, ['tag', 'v1.0.0']);
    git(seed, ['push', '-u', 'origin', 'main', '--tags']);

    const kDir = path.join(tmpDir, 'shelf-pin-branch');
    const cfgPath = path.join(tmpDir, 'pin-branch-sync.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'unit-p', url: bareRepo, path: 'unit-p', branch: 'main', pin: 'v1.0.0' }],
      }),
      'utf-8'
    );

    expect(runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']).status).toBe(0);
    const frozenOk = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kDir, '--no-global']);
    expect(frozenOk.status).toBe(0);
  });

  it('14. dry_run tracks patch create_if_missing for subsequent when.exists and when.not_exists', async () => {
    const kDir = path.join(tmpDir, 'wf-dry-patch-when');
    const unitDir = path.join(kDir, 'demo');
    const targetDir = path.join(tmpDir, 'wf-dry-patch-target');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Dry run patch when test',
        workflows: { check: {} },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'check.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [
          {
            action: 'patch',
            target: '{{TARGET}}/created.txt',
            mode: 'append',
            content: 'hello',
            create_if_missing: true,
          },
          { action: 'message', text: 'EXISTS_OK', when: { exists: '{{TARGET}}/created.txt' } },
          { action: 'message', text: 'NOT_EXISTS_FAIL', when: { not_exists: '{{TARGET}}/created.txt' } },
        ],
      }),
      'utf-8'
    );

    const dryRes = await toolRunWorkflow(kDir, 'demo', 'check', { TARGET: targetDir }, { dryRun: true });
    expect(dryRes.isError).toBe(false);
    const dryJson = JSON.parse(dryRes.text);
    expect(dryJson.messages).toEqual(['EXISTS_OK']);
    expect(fs.existsSync(path.join(targetDir, 'created.txt'))).toBe(false);
  });

  it('15. update, outdated, pin, unpin, and trust fail on corrupted single-layer registry and warn on multi-layer', () => {
    const corruptLayer = path.join(tmpDir, 'corrupt-single');
    fs.mkdirSync(corruptLayer, { recursive: true });
    fs.writeFileSync(path.join(corruptLayer, '.registry.json'), '{ invalid json', 'utf-8');

    for (const cmdArgs of [
      ['update', '--dir', corruptLayer, '--no-global'],
      ['outdated', '--dir', corruptLayer, '--no-global'],
      ['pin', 'foo', '--dir', corruptLayer, '--no-global'],
      ['unpin', 'foo', '--dir', corruptLayer, '--no-global'],
      ['trust', 'foo', '--dir', corruptLayer, '--no-global'],
    ]) {
      const res = runCli(cmdArgs);
      expect(res.status, cmdArgs.join(' ')).toBe(1);
      expect(res.stderr, cmdArgs.join(' ')).toContain('Cannot read registry');
    }

    const okLayer = path.join(tmpDir, 'valid-layer');
    const draft = path.join(tmpDir, 'draft-multi');
    expect(runCli(['scaffold', 'u-ok', '--output', draft]).status).toBe(0);
    expect(runCli(['install', path.join(draft, 'u-ok'), '--dir', okLayer, '--no-global']).status).toBe(0);

    const outMulti = runCli(['outdated', '--dir', corruptLayer, '--dir', okLayer, '--no-global']);
    expect(outMulti.status).toBe(0);
    expect(outMulti.stderr).toContain('Warning: Skipping invalid registry');
    expect(outMulti.stdout).toContain('u-ok: local');
  });

  it('16. sync does not inherit trusted or branch when unit URL changes to a different repository', () => {
    const bare1 = path.join(tmpDir, 'sync-url1.git');
    const seed1 = path.join(tmpDir, 'sync-seed1');
    git(tmpDir, ['init', '--bare', '-b', 'main', bare1]);
    git(tmpDir, ['clone', bare1, seed1]);
    git(seed1, ['config', 'user.email', 'test@example.com']);
    git(seed1, ['config', 'user.name', 'Test']);
    expect(runCli(['scaffold', 'swap-unit', '--output', seed1]).status).toBe(0);
    git(seed1, ['add', '.']);
    git(seed1, ['commit', '-m', 'init 1']);
    git(seed1, ['push', '-u', 'origin', 'main']);

    const bare2 = path.join(tmpDir, 'sync-url2.git');
    const seed2 = path.join(tmpDir, 'sync-seed2');
    git(tmpDir, ['init', '--bare', '-b', 'trunk', bare2]);
    git(tmpDir, ['clone', bare2, seed2]);
    git(seed2, ['config', 'user.email', 'test@example.com']);
    git(seed2, ['config', 'user.name', 'Test']);
    expect(runCli(['scaffold', 'swap-unit', '--output', seed2]).status).toBe(0);
    git(seed2, ['add', '.']);
    git(seed2, ['commit', '-m', 'init 2']);
    git(seed2, ['tag', 'v2.0.0']);
    git(seed2, ['push', '-u', 'origin', 'trunk', '--tags']);

    const kDir = path.join(tmpDir, 'shelf-url-swap');
    expect(runCli(['add', bare1, '--path', 'swap-unit', '--trust', '--dir', kDir, '--no-global']).status).toBe(0);

    const cfgPath = path.join(tmpDir, 'swap-sync.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'swap-unit', url: bare2, path: 'swap-unit', pin: 'v2.0.0' }],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']);
    expect(syncRes.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    expect(reg.sources).toHaveLength(1);
    expect(reg.sources[0].url).toBe(bare2);
    expect(reg.sources[0].trusted).toBeUndefined();
    expect(reg.sources[0].branch).toBeUndefined();
    expect(reg.sources[0].pin).toBe('v2.0.0');
  });

  it('17. validate --dir prioritizes installed unit/doc over same-named file in CWD', () => {
    const kDir = path.join(tmpDir, 'val-dir');
    const draftDir = path.join(tmpDir, 'val-draft');
    const cwdDir = path.join(tmpDir, 'val-cwd');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });

    const validMd = path.join(draftDir, 'guide.md');
    fs.writeFileSync(
      validMd,
      '---\ntitle: Guide\ndescription: Valid guide\ntags: [docs]\n---\n# Guide\nContent.\n',
      'utf-8'
    );
    expect(runCli(['install', validMd, '--dir', kDir, '--no-global']).status).toBe(0);

    // Put an empty file with the same name in CWD
    fs.writeFileSync(path.join(cwdDir, 'guide.md'), '', 'utf-8');

    const resInstalled = runCli(['validate', 'guide.md', '--dir', kDir, '--no-global'], cwdDir);
    expect(resInstalled.status).toBe(0);
    expect(resInstalled.stdout).toContain('guide.md — OK');

    // Explicit ./ path still targets CWD
    const resExplicitLocal = runCli(['validate', './guide.md', '--dir', kDir, '--no-global'], cwdDir);
    expect(resExplicitLocal.status).toBe(1);
    expect(resExplicitLocal.stdout).toContain('Markdown file is empty');
  });

  it('18. info warns on corrupted registry in multi-layer mode and still displays unit metadata', () => {
    const layer1 = path.join(tmpDir, 'info-corrupt');
    const layer2 = path.join(tmpDir, 'info-ok');
    expect(runCli(['scaffold', 'info-unit', '--output', layer1]).status).toBe(0);
    fs.writeFileSync(path.join(layer1, '.registry.json'), '{ invalid json', 'utf-8');
    fs.mkdirSync(layer2, { recursive: true });

    const infoRes = runCli(['info', 'info-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(infoRes.status).toBe(0);
    expect(infoRes.stderr).toContain('Warning: Skipping invalid registry');
    expect(infoRes.stdout).toContain('info-unit');
    expect(infoRes.stdout).toContain('boilerplate');
  });

  it('19. CLI rejects --read-only after subcommand while allowing it before subcommand', () => {
    const kDir = path.join(tmpDir, 'cli-flag-dir');
    expect(runCli(['init', '--dir', kDir, '--no-global']).status).toBe(0);

    const beforeRes = runCli(['--read-only', 'list', '--dir', kDir, '--no-global']);
    expect(beforeRes.status).toBe(0);

    const afterRes = runCli(['search', '--read-only', '--dir', kDir, '--no-global']);
    expect(afterRes.status).toBe(1);
    expect(afterRes.stderr).toContain("Unknown option '--read-only' for 'search'");
  });

  it('20. -f acts as --force without swallowing following --dir or --name=val options', () => {
    const kDir = path.join(tmpDir, 'cli-f-dir');
    const draftDir = path.join(tmpDir, 'cli-f-draft');
    fs.mkdirSync(draftDir, { recursive: true });
    expect(runCli(['scaffold', 'force-unit', '--output', draftDir]).status).toBe(0);
    const unitSrc = path.join(draftDir, 'force-unit');

    const res1 = runCli(['install', '-f', '--dir', kDir, '--no-global', unitSrc]);
    expect(res1.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'force-unit', 'manifest.json'))).toBe(true);

    const res2 = runCli(['--dir', kDir, '--no-global', 'install', '-f', '--name=aliased-unit', unitSrc]);
    expect(res2.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'aliased-unit', 'manifest.json'))).toBe(true);
  });

  it('21. add --path rejects non-markdown single files unless --no-verify is passed', () => {
    const repoDir = path.join(tmpDir, 'non-md-repo');
    const kDir = path.join(tmpDir, 'non-md-kb');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'config.json'), '{"a":1}', 'utf-8');
    git(tmpDir, ['init', '-b', 'main', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    const failRes = runCli(['add', repoDir, '--path', 'config.json', '--dir', kDir, '--no-global']);
    expect(failRes.status).toBe(1);
    expect(failRes.stdout + failRes.stderr).toContain('File is not a Markdown (.md) document');
    expect(fs.existsSync(path.join(kDir, 'config.json'))).toBe(false);

    const bypassRes = runCli(['add', repoDir, '--path', 'config.json', '--no-verify', '--dir', kDir, '--no-global']);
    expect(bypassRes.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'config.json'))).toBe(true);
  });

  it('22. publish --dir prioritizes explicit knowledge directory over same-named CWD folder', () => {
    const kDir = path.join(tmpDir, 'pub-kb');
    const draftDir = path.join(tmpDir, 'pub-draft');
    const cwdDir = path.join(tmpDir, 'pub-cwd');
    const bareRepo = path.join(tmpDir, 'pub-bare.git');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(path.join(cwdDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(cwdDir, 'auth', 'index.ts'), 'export const app = true;\n', 'utf-8');

    expect(runCli(['scaffold', 'auth', '--output', draftDir]).status).toBe(0);
    expect(runCli(['install', path.join(draftDir, 'auth'), '--dir', kDir, '--no-global']).status).toBe(0);
    git(tmpDir, ['init', '--bare', '--initial-branch=main', bareRepo]);

    const res = runCli(
      ['publish', 'auth', '--dir', kDir, '--no-global', '--to', bareRepo, '--branch', 'main', '--push'],
      cwdDir
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Published 'auth'");

    // Explicit ./ path still targets CWD
    const explicitRes = runCli(
      ['publish', './auth', '--dir', kDir, '--no-global', '--to', bareRepo, '--branch', 'main'],
      cwdDir
    );
    expect(explicitRes.status).toBe(1);
    expect(explicitRes.stdout + explicitRes.stderr).toContain('manifest.json not found');
  });

  it('23. toolRunWorkflow skips manifest.placeholders required checks for steps skipped by when.input', async () => {
    const kDir = path.join(tmpDir, 'cond-kb');
    const unitDir = path.join(kDir, 'cond-unit');
    const targetDir = path.join(tmpDir, 'cond-target');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'cond-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Conditional placeholder test',
        placeholders: {
          TARGET: { required: true, type: 'path' },
          USE_AUTH: { default: 'false', type: 'string' },
          AUTH_PROVIDER: { required: true, type: 'string' },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'base.txt'), 'Base\n', 'utf-8');
    fs.writeFileSync(path.join(unitDir, 'templates', 'auth.txt'), 'Provider: {{AUTH_PROVIDER}}\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: {
          TARGET: { required: true },
          USE_AUTH: { default: 'false' },
        },
        steps: [
          { action: 'copy', source: 'templates/base.txt', target: '{{TARGET}}/base.txt' },
          {
            action: 'copy',
            when: { input: 'USE_AUTH', equals: 'true' },
            source: 'templates/auth.txt',
            target: '{{TARGET}}/auth.txt',
          },
        ],
      }),
      'utf-8'
    );

    // When USE_AUTH is false, AUTH_PROVIDER is not needed
    const resFalse = await toolRunWorkflow(kDir, 'cond-unit', 'setup', {
      TARGET: targetDir,
      USE_AUTH: 'false',
    });
    expect(resFalse.isError).toBeFalsy();
    expect(fs.existsSync(path.join(targetDir, 'base.txt'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'auth.txt'))).toBe(false);

    // When USE_AUTH is true, AUTH_PROVIDER becomes required
    const resTrueMissing = await toolRunWorkflow(kDir, 'cond-unit', 'setup', {
      TARGET: targetDir,
      USE_AUTH: 'true',
    });
    expect(resTrueMissing.isError).toBe(true);
    expect(resTrueMissing.text).toContain('Missing required inputs: [\\"AUTH_PROVIDER\\"]');

    const resTrueOk = await toolRunWorkflow(kDir, 'cond-unit', 'setup', {
      TARGET: targetDir,
      USE_AUTH: 'true',
      AUTH_PROVIDER: 'jwt',
    });
    expect(resTrueOk.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(targetDir, 'auth.txt'), 'utf-8')).toBe('Provider: jwt\n');
  });

  it('24. import unwraps single unit containing nested templates/manifest.json with --name', () => {
    const wrapRoot = path.join(tmpDir, 'wrap');
    const extUnit = path.join(wrapRoot, 'release-bundle', 'chrome-ext');
    fs.mkdirSync(path.join(extUnit, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(extUnit, 'manifest.json'),
      JSON.stringify({
        name: 'chrome-ext',
        version: '1.0.0',
        type: 'boilerplate',
        doc: 'overview.md',
        description: 'Chrome extension starter',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(extUnit, 'overview.md'), '# Chrome Ext\n', 'utf-8');
    fs.writeFileSync(
      path.join(extUnit, 'templates', 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'My Ext', version: '1.0' }),
      'utf-8'
    );

    const tarPath = path.join(tmpDir, 'bundle.tar.gz');
    const tarRes = spawnSync('tar', ['-czf', tarPath, '-C', wrapRoot, 'release-bundle'], { stdio: 'pipe' });
    expect(tarRes.status).toBe(0);

    const kDir = path.join(tmpDir, 'kb-import');
    const impRes = runCli(['import', tarPath, '--name', 'my-ext', '--dir', kDir, '--no-global']);
    expect(impRes.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'my-ext', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(kDir, 'my-ext', 'templates', 'manifest.json'))).toBe(true);
  });

  it('25. publish --path . preserves existing repository README.md when unit has no README.md', () => {
    const bareRepo = path.join(tmpDir, 'root-readme.git');
    const seedDir = path.join(tmpDir, 'root-seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Team Repo\nKeep me.\n', 'utf-8');
    fs.writeFileSync(path.join(seedDir, 'LICENSE'), 'Apache-2.0\n', 'utf-8');
    git(seedDir, ['add', '.']);
    git(seedDir, ['commit', '-m', 'init']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    const unitSrc = path.join(tmpDir, 'src');
    fs.mkdirSync(unitSrc, { recursive: true });
    expect(runCli(['scaffold', 'solo-unit', '--output', unitSrc]).status).toBe(0);

    const pubRes = runCli([
      'publish',
      path.join(unitSrc, 'solo-unit'),
      '--to',
      bareRepo,
      '--path',
      '.',
      '--branch',
      'main',
      '--push',
    ]);
    expect(pubRes.status).toBe(0);

    const verifyDir = path.join(tmpDir, 'verify-readme');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir]);
    expect(fs.existsSync(path.join(verifyDir, 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(verifyDir, 'README.md'), 'utf-8')).toContain('Keep me.');
    expect(fs.existsSync(path.join(verifyDir, 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(verifyDir, 'manifest.json'))).toBe(true);
  });

  it('26. toolRunWorkflow under strictTrust allows execution when run step is skipped by when.input', async () => {
    const kDir = path.join(tmpDir, 'trust-cond-kb');
    const unitDir = path.join(kDir, 'cond-script-unit');
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'cond-script-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Conditional run step trust test',
        scripts: {
          hello: { file: 'scripts/hello.mjs', interpreter: 'node' },
        },
        workflows: {
          setup: { description: 'Optional script run' },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'scripts', 'hello.mjs'), 'console.log("RAN");\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: {
          DO_RUN: { default: 'no' },
        },
        steps: [
          { action: 'message', text: 'Setup message' },
          { action: 'run', script_ref: 'hello', when: { input: 'DO_RUN', equals: 'yes' } },
        ],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(kDir, '.registry.json'),
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'cond-script-unit',
            url: 'https://example.com/cond-script-unit.git',
            commit: 'abc1234',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      'utf-8'
    );

    const resSkipped = await toolRunWorkflow(
      kDir,
      'cond-script-unit',
      'setup',
      { DO_RUN: 'no' },
      { strictTrust: true, dryRun: false }
    );
    expect(resSkipped.isError).toBeFalsy();
    const parsedSkipped = JSON.parse(resSkipped.text);
    expect(parsedSkipped.messages).toContain('Setup message');
    expect(parsedSkipped.scripts_run).toHaveLength(0);

    const resActive = await toolRunWorkflow(
      kDir,
      'cond-script-unit',
      'setup',
      { DO_RUN: 'yes' },
      { strictTrust: true, dryRun: false }
    );
    expect(resActive.isError).toBe(true);
    expect(resActive.text).toContain('strict trust policy');
  });

  it('27. add --path strips leading ./ or .\\ for sparse checkout and subsequent update', () => {
    const bareRepo = path.join(tmpDir, 'sparse-dot.git');
    const workDir = path.join(tmpDir, 'sparse-dot-work');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, workDir]);
    git(workDir, ['config', 'user.email', 'test@example.com']);
    git(workDir, ['config', 'user.name', 'Test']);

    const unitInRepo = path.join(workDir, 'units', 'my-unit');
    fs.mkdirSync(unitInRepo, { recursive: true });
    fs.writeFileSync(
      path.join(unitInRepo, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'cookbook',
        description: 'Sparse path normalization test',
      }),
      'utf-8'
    );
    git(workDir, ['add', '.']);
    git(workDir, ['commit', '-m', 'init']);
    git(workDir, ['push', '-u', 'origin', 'main']);

    const kb1 = path.join(tmpDir, 'kb1');
    const addForward = runCli(['add', bareRepo, '--path', './units/my-unit', '--dir', kb1, '--no-global']);
    expect(addForward.status).toBe(0);
    expect(fs.existsSync(path.join(kb1, 'my-unit', 'manifest.json'))).toBe(true);

    const kb2 = path.join(tmpDir, 'kb2');
    const addBackslash = runCli(['add', bareRepo, '--path', '.\\units\\my-unit', '--dir', kb2, '--no-global']);
    expect(addBackslash.status).toBe(0);
    expect(fs.existsSync(path.join(kb2, 'my-unit', 'manifest.json'))).toBe(true);

    // Push a new commit and verify update succeeds
    fs.writeFileSync(path.join(unitInRepo, 'notes.md'), '# Notes\nUpdated.\n', 'utf-8');
    git(workDir, ['add', '.']);
    git(workDir, ['commit', '-m', 'update unit']);
    git(workDir, ['push', 'origin', 'main']);

    const updRes = runCli(['update', '--dir', kb1, '--no-global']);
    expect(updRes.status).toBe(0);
    expect(fs.existsSync(path.join(kb1, 'my-unit', 'notes.md'))).toBe(true);
  });

  it('28. copy_dir with render_filenames: false preserves {{...}} placeholders in filenames', async () => {
    const kDir = path.join(tmpDir, 'literal-fn-kb');
    const unitDir = path.join(kDir, 'literal-fn-unit');
    const targetDir = path.join(tmpDir, 'literal-fn-target');
    fs.mkdirSync(path.join(unitDir, 'templates', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'literal-fn-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Literal filename copy_dir test',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'sub', '{{MODEL}}.txt'), 'App={{APP}}\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true }, APP: { required: true } },
        steps: [
          {
            action: 'copy_dir',
            source: 'templates',
            target: '{{TARGET}}/out',
            render_filenames: false,
          },
        ],
      }),
      'utf-8'
    );

    const res = await toolRunWorkflow(kDir, 'literal-fn-unit', 'setup', {
      TARGET: targetDir,
      APP: 'Demo',
    });
    expect(res.isError).toBeFalsy();
    const outFile = path.join(targetDir, 'out', 'sub', '{{MODEL}}.txt');
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, 'utf-8')).toBe('App=Demo\n');
  });

  it('29. resolveWindowsExecutable finds .bat shims in PATH order and run_workflow executes via cmd shim safely', async () => {
    const dirA = path.join(tmpDir, 'shim-first');
    const dirB = path.join(tmpDir, 'exe-second');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const shimPath = path.join(dirA, 'mytool.bat');
    const laterExePath = path.join(dirB, 'mytool.exe');
    fs.writeFileSync(shimPath, '@echo off\r\necho SHIM_RAN\r\n', 'utf-8');
    fs.writeFileSync(laterExePath, '', 'utf-8');

    const resolved = resolveWindowsExecutable('mytool', {
      PATH: `${dirA}${path.delimiter}${dirB}`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });
    expect(resolved).toBe(shimPath);

    if (process.platform === 'win32') {
      // Test real run_workflow execution using a .bat shim placed ahead on PATH
      const shimBin = path.join(tmpDir, 'py-shim');
      fs.mkdirSync(shimBin, { recursive: true });
      fs.writeFileSync(
        path.join(shimBin, 'python.bat'),
        `@echo off\r\n"${process.execPath}" -e "console.log('SHIM_NODE:' + process.argv.slice(1).join(','))" %*\r\n`,
        'utf-8'
      );

      const kDir = path.join(tmpDir, 'shim-kb');
      const unitDir = path.join(kDir, 'shim-unit');
      fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({
          name: 'shim-unit',
          version: '1.0.0',
          type: 'toolkit',
          description: 'Windows bat shim test',
          workflows: { run_py: { description: 'Run py script' } },
        }),
        'utf-8'
      );
      fs.writeFileSync(path.join(unitDir, 'scripts', 'hello.py'), 'print("ok")\n', 'utf-8');
      fs.writeFileSync(
        path.join(unitDir, 'workflows', 'run_py.json'),
        JSON.stringify({
          steps: [{ action: 'run', script: 'scripts/hello.py', args: ['alpha'] }],
        }),
        'utf-8'
      );

      const origPath = process.env.PATH;
      process.env.PATH = `${shimBin}${path.delimiter}${origPath || ''}`;
      try {
        const res = await toolRunWorkflow(kDir, 'shim-unit', 'run_py', {});
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.text);
        expect(parsed.scripts_run[0].stdout).toContain('SHIM_NODE:');
        expect(parsed.scripts_run[0].stdout).toContain('alpha');

        // Dangerous cmd metacharacter must be blocked before cmd.exe invocation (BatBadBut protection)
        fs.writeFileSync(
          path.join(unitDir, 'workflows', 'run_py.json'),
          JSON.stringify({
            steps: [{ action: 'run', script: 'scripts/hello.py', args: ['a&calc'] }],
          }),
          'utf-8'
        );
        const unsafeRes = await toolRunWorkflow(kDir, 'shim-unit', 'run_py', {});
        expect(unsafeRes.isError).toBe(true);
        expect(unsafeRes.text).toContain('cmd.exe cannot pass safely');
      } finally {
        process.env.PATH = origPath;
      }
    }
  });

  it('30. patch step matches LF multi-line anchor/skip_if_contains on CRLF files and preserves CRLF', async () => {
    const kDir = path.join(tmpDir, 'crlf-patch-kb');
    const unitDir = path.join(kDir, 'crlf-patch-unit');
    const targetDir = path.join(tmpDir, 'crlf-target');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const targetFile = path.join(targetDir, 'app.config.ts');
    fs.writeFileSync(
      targetFile,
      'export const cfg = {\r\n  plugins: [\r\n    // ANCHOR\r\n  ],\r\n};\r\n',
      'utf-8'
    );

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'crlf-patch-unit',
        version: '1.0.0',
        type: 'cookbook',
        description: 'CRLF patch test',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'apply.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [
          {
            action: 'patch',
            target: '{{TARGET}}/app.config.ts',
            mode: 'insert_after',
            anchor: '  plugins: [\n    // ANCHOR',
            content: '    "pluginA",\n    "pluginB",',
            skip_if_contains: '  plugins: [\n    // ANCHOR\n    "pluginA",',
          },
        ],
      }),
      'utf-8'
    );

    const res1 = await toolRunWorkflow(kDir, 'crlf-patch-unit', 'apply', { TARGET: targetDir });
    expect(res1.isError).toBeFalsy();
    const afterFirst = fs.readFileSync(targetFile, 'utf-8');
    expect(afterFirst).toBe(
      'export const cfg = {\r\n  plugins: [\r\n    // ANCHOR\r\n    "pluginA",\r\n    "pluginB",\r\n  ],\r\n};\r\n'
    );

    // Re-running must be skipped via skip_if_contains despite LF vs CRLF difference
    const res2 = await toolRunWorkflow(kDir, 'crlf-patch-unit', 'apply', { TARGET: targetDir });
    expect(res2.isError).toBeFalsy();
    const parsed2 = JSON.parse(res2.text);
    expect(parsed2.files_skipped).toContain(targetFile);
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe(afterFirst);
  });

  it('31. install --name and export/import --name support nested unit names', () => {
    const drafts = path.join(tmpDir, 'drafts');
    const unitSrc = path.join(drafts, 'my-unit');
    const kb1 = path.join(tmpDir, 'kb1');
    const kb2 = path.join(tmpDir, 'kb2');
    const archivePath = path.join(tmpDir, 'nested.zip');

    expect(runCli(['scaffold', 'my-unit', '--output', drafts]).status).toBe(0);

    const installNested = runCli(['install', unitSrc, '--name', 'team/nested-unit', '--dir', kb1, '--no-global']);
    expect(installNested.status).toBe(0);
    expect(fs.existsSync(path.join(kb1, 'team', 'nested-unit', 'manifest.json'))).toBe(true);

    // Traversal or dot segments still rejected
    const badInstall = runCli(['install', unitSrc, '--name', 'team/.hidden', '--dir', kb1, '--no-global']);
    expect(badInstall.status).toBe(1);
    expect(badInstall.stderr).toContain('Invalid unit name');

    const expRes = runCli(['export', 'team/nested-unit', '--dir', kb1, '--no-global', '--output', archivePath]);
    expect(expRes.status).toBe(0);

    const impRes = runCli([
      'import',
      archivePath,
      '--name',
      'org/imported-unit',
      '--dir',
      kb2,
      '--no-global',
    ]);
    expect(impRes.status).toBe(0);
    expect(fs.existsSync(path.join(kb2, 'org', 'imported-unit', 'manifest.json'))).toBe(true);
    const listRes = runCli(['list', '--dir', kb2, '--no-global']);
    expect(listRes.stdout).toContain('org/imported-unit');
  });

  it('32. sync and sync --frozen normalize repeated ./ prefixes in source path', () => {
    const bareRepo = path.join(tmpDir, 'sync-norm.git');
    const workDir = path.join(tmpDir, 'sync-norm-work');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, workDir]);
    git(workDir, ['config', 'user.email', 'test@example.com']);
    git(workDir, ['config', 'user.name', 'Test']);

    const unitInRepo = path.join(workDir, 'units', 'alpha');
    fs.mkdirSync(unitInRepo, { recursive: true });
    fs.writeFileSync(
      path.join(unitInRepo, 'manifest.json'),
      JSON.stringify({ name: 'alpha', version: '1.0.0', type: 'cookbook', description: 'Sync norm test' }),
      'utf-8'
    );
    git(workDir, ['add', '.']);
    git(workDir, ['commit', '-m', 'init']);
    git(workDir, ['push', '-u', 'origin', 'main']);

    const kb = path.join(tmpDir, 'kb-sync-norm');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(
      path.join(kb, 'knowledge-shelf.json'),
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'alpha', url: bareRepo, branch: 'main', path: '././units/alpha' }],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--dir', kb, '--no-global']);
    expect(syncRes.status).toBe(0);
    const frozenRes = runCli(['sync', '--frozen', '--dir', kb, '--no-global']);
    expect(frozenRes.status).toBe(0);
  });
});
