/**
 * Regression tests for bug fixes v1.3.2:
 * 1. add --name and sync normalize backslashes and trailing slashes in unit names (prevents --strict-trust bypass & registry drift).
 * 2. Legacy .registry.json entries with backslashes/trailing slashes are still blocked under --strict-trust and matched by CLI commands.
 * 3. publish of a manifest unit refuses to overwrite an existing container directory (holding sibling units/docs) or existing file when --path omits a trailing slash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache, toolRunWorkflow } from '../src/core.js';

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

function createScriptUnitRepo(tmpDir: string, repoName: string, unitName: string) {
  const bareRepo = path.join(tmpDir, `${repoName}.git`);
  const seedDir = path.join(tmpDir, `${repoName}-seed`);
  git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
  git(tmpDir, ['clone', bareRepo, seedDir]);
  git(seedDir, ['config', 'user.email', 'test@example.com']);
  git(seedDir, ['config', 'user.name', 'Test']);

  const unitDir = path.join(seedDir, unitName);
  fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(unitDir, 'manifest.json'),
    JSON.stringify(
      {
        name: unitName,
        version: '1.0.0',
        type: 'toolkit',
        doc: 'overview.md',
        description: 'Unit with executable script',
        scripts: { runme: { file: 'scripts/runme.js' } },
        workflows: { setup: { description: 'Run script' } },
      },
      null,
      2
    ),
    'utf-8'
  );
  fs.writeFileSync(path.join(unitDir, 'overview.md'), `# ${unitName}\n`, 'utf-8');
  fs.writeFileSync(path.join(unitDir, 'scripts', 'runme.js'), 'console.log("SCRIPT_EXECUTED");\n', 'utf-8');
  fs.writeFileSync(
    path.join(unitDir, 'workflows', 'setup.json'),
    JSON.stringify(
      {
        name: 'setup',
        steps: [{ action: 'run', script_ref: 'runme' }],
      },
      null,
      2
    ),
    'utf-8'
  );

  git(seedDir, ['add', '-A']);
  git(seedDir, ['commit', '-m', 'init']);
  git(seedDir, ['push', '-u', 'origin', 'main']);
  return bareRepo;
}

describe('Bug fixes v1.3.2', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v132-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. add --name normalizes backslashes and trailing slashes, keeping strict-trust and CLI operations consistent', async () => {
    const bareRepo = createScriptUnitRepo(tmpDir, 'remote1', 'script-unit');
    const shelfDir = path.join(tmpDir, 'shelf');

    // Backslash nested alias
    const addSlash = runCli(['add', bareRepo, '--path', 'script-unit', '--name', 'team\\nested-unit', '--dir', shelfDir]);
    expect(addSlash.status).toBe(0);

    // Trailing slash alias
    const addTrailing = runCli(['add', bareRepo, '--path', 'script-unit', '--name', 'my-alias/', '--dir', shelfDir]);
    expect(addTrailing.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(shelfDir, '.registry.json'), 'utf-8'));
    expect(reg.sources.map((s: { name: string }) => s.name)).toEqual(['team/nested-unit', 'my-alias']);

    // list must not report duplicate unmanaged entries
    const listRes = runCli(['list', '--dir', shelfDir, '--no-global']);
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).not.toContain('Local / unmanaged');
    expect(listRes.stdout).toContain('Total: 2 tracked source(s), 0 local/unmanaged unit(s)');

    // --strict-trust must block script execution for both remote units
    const blocked1 = await toolRunWorkflow(shelfDir, 'team/nested-unit', 'setup', {}, { strictTrust: true });
    expect(blocked1.isError).toBe(true);
    expect(blocked1.text).toContain('strict trust policy');

    const blocked2 = await toolRunWorkflow(shelfDir, 'my-alias', 'setup', {}, { strictTrust: true });
    expect(blocked2.isError).toBe(true);
    expect(blocked2.text).toContain('strict trust policy');

    // pin & remove work seamlessly with normalized or backslash names
    expect(runCli(['pin', 'team/nested-unit', '--dir', shelfDir, '--no-global']).status).toBe(0);
    expect(runCli(['remove', 'my-alias', '--dir', shelfDir, '--no-global']).status).toBe(0);

    const regAfter = JSON.parse(fs.readFileSync(path.join(shelfDir, '.registry.json'), 'utf-8'));
    expect(regAfter.sources.map((s: { name: string }) => s.name)).toEqual(['team/nested-unit']);
  });

  it('2. sync normalizes unit names from knowledge-shelf.json and enforces strict-trust', async () => {
    const bareRepo = createScriptUnitRepo(tmpDir, 'remote2', 'script-unit');
    const shelfDir = path.join(tmpDir, 'sync-shelf');
    const configPath = path.join(tmpDir, 'knowledge-shelf.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '1.0',
          sources: [{ name: 'org\\synced-unit/', url: bareRepo, path: 'script-unit' }],
        },
        null,
        2
      ),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', configPath, '--dir', shelfDir]);
    expect(syncRes.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(shelfDir, '.registry.json'), 'utf-8'));
    expect(reg.sources[0].name).toBe('org/synced-unit');

    const frozenRes = runCli(['sync', '--file', configPath, '--frozen', '--dir', shelfDir]);
    expect(frozenRes.status).toBe(0);

    const blocked = await toolRunWorkflow(shelfDir, 'org/synced-unit', 'setup', {}, { strictTrust: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('strict trust policy');
  });

  it('3. legacy .registry.json entries with backslashes or trailing slashes remain blocked under --strict-trust and match in list/remove', async () => {
    const bareRepo = createScriptUnitRepo(tmpDir, 'remote3', 'script-unit');
    const shelfDir = path.join(tmpDir, 'legacy-shelf');

    expect(runCli(['add', bareRepo, '--path', 'script-unit', '--name', 'team/legacy-unit', '--dir', shelfDir]).status).toBe(0);

    // Simulate a legacy .registry.json written with backslash + trailing slash
    const regPath = path.join(shelfDir, '.registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    reg.sources[0].name = 'team\\legacy-unit/';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');

    const blocked = await toolRunWorkflow(shelfDir, 'team/legacy-unit', 'setup', {}, { strictTrust: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('strict trust policy');

    const listRes = runCli(['list', '--dir', shelfDir, '--no-global']);
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).not.toContain('Local / unmanaged');

    const remRes = runCli(['remove', 'team/legacy-unit', '--dir', shelfDir, '--no-global']);
    expect(remRes.status).toBe(0);
    const regAfter = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    expect(regAfter.sources).toEqual([]);
  });

  it('4. publish refuses to wipe an existing container directory or overwrite a regular file when --path omits trailing slash', () => {
    const bareRepo = path.join(tmpDir, 'mono.git');
    const seedDir = path.join(tmpDir, 'mono-seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);

    // Seed monorepo with units/alpha-unit, docs/guide.md, and NOTES.txt
    expect(runCli(['scaffold', 'alpha-unit', '--output', path.join(seedDir, 'units')]).status).toBe(0);
    fs.mkdirSync(path.join(seedDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'docs', 'guide.md'), '# Guide\nExisting doc.\n', 'utf-8');
    fs.writeFileSync(path.join(seedDir, 'NOTES.txt'), 'Important notes\n', 'utf-8');
    git(seedDir, ['add', '-A']);
    git(seedDir, ['commit', '-m', 'seed']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    // Scaffold gamma-unit to publish
    expect(runCli(['scaffold', 'gamma-unit', '--output', tmpDir]).status).toBe(0);
    const gammaDir = path.join(tmpDir, 'gamma-unit');

    // A. --path units (no trailing slash) must FAIL and preserve units/alpha-unit
    const pubContainer = runCli(['publish', gammaDir, '--to', bareRepo, '--path', 'units', '--branch', 'main', '--push']);
    expect(pubContainer.status).toBe(1);
    expect(pubContainer.stderr).toContain('existing container directory');
    expect(pubContainer.stderr).toContain('--path units/');

    // B. --path docs (no trailing slash, contains standalone .md) must FAIL and preserve docs/guide.md
    const pubDocs = runCli(['publish', gammaDir, '--to', bareRepo, '--path', 'docs', '--branch', 'main', '--push']);
    expect(pubDocs.status).toBe(1);
    expect(pubDocs.stderr).toContain('existing container directory');

    // C. --path NOTES.txt (existing regular file) must FAIL
    const pubFile = runCli(['publish', gammaDir, '--to', bareRepo, '--path', 'NOTES.txt', '--branch', 'main', '--push']);
    expect(pubFile.status).toBe(1);
    expect(pubFile.stderr).toContain('existing file');

    // D. --path units/ (WITH trailing slash) succeeds and preserves units/alpha-unit
    const pubOk = runCli(['publish', gammaDir, '--to', bareRepo, '--path', 'units/', '--branch', 'main', '--push']);
    expect(pubOk.status).toBe(0);

    // E. Updating an existing unit directly via --path units/gamma-unit (no trailing slash) still works
    fs.appendFileSync(path.join(gammaDir, 'overview.md'), '\n## Updated\n', 'utf-8');
    const pubUpdate = runCli(['publish', gammaDir, '--to', bareRepo, '--path', 'units/gamma-unit', '--branch', 'main', '--push']);
    expect(pubUpdate.status).toBe(0);

    // Verify remote repository integrity
    const verifyDir = path.join(tmpDir, 'mono-verify');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir]);
    expect(fs.existsSync(path.join(verifyDir, 'units', 'alpha-unit', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(verifyDir, 'units', 'gamma-unit', 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(verifyDir, 'units', 'gamma-unit', 'overview.md'), 'utf-8')).toContain('## Updated');
    expect(fs.existsSync(path.join(verifyDir, 'docs', 'guide.md'))).toBe(true);
    expect(fs.readFileSync(path.join(verifyDir, 'NOTES.txt'), 'utf-8').trim()).toBe('Important notes');
  });

  it('5. workflow patch refuses to modify an existing binary file on disk in both dry_run and real runs', async () => {
    const shelfDir = path.join(tmpDir, 'patch-bin-shelf');
    const unitDir = path.join(shelfDir, 'bin-unit');
    const targetDir = path.join(tmpDir, 'patch-bin-target');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'bin-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Binary patch guard test',
        workflows: { patchbin: { description: 'Try patching a binary file' } },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'patchbin.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [{ action: 'patch', target: '{{TARGET}}/data.bin', mode: 'append', content: 'oops' }],
      }),
      'utf-8'
    );

    const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    const binFile = path.join(targetDir, 'data.bin');
    fs.writeFileSync(binFile, originalBytes);

    const dryRes = await toolRunWorkflow(shelfDir, 'bin-unit', 'patchbin', { TARGET: targetDir }, { dryRun: true });
    expect(dryRes.isError).toBe(true);
    expect(dryRes.text).toContain('is a binary file');

    const realRes = await toolRunWorkflow(shelfDir, 'bin-unit', 'patchbin', { TARGET: targetDir }, { dryRun: false });
    expect(realRes.isError).toBe(true);
    expect(realRes.text).toContain('is a binary file');
    expect(Buffer.compare(fs.readFileSync(binFile), originalBytes)).toBe(0);
  });

  it('6. remove without --dir uninstalls global copy instead of deleting workspace .agents/knowledges draft', () => {
    const fakeHome = path.join(tmpDir, 'home');
    const projDir = path.join(tmpDir, 'workspace');
    const stagingDir = path.join(projDir, '.agents', 'knowledges');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    expect(runCli(['scaffold', 'draft-unit', '--output', stagingDir]).status).toBe(0);

    const env = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      KNOWLEDGE_DIR: '',
      KNOWLEDGE_DIRS: '',
    };

    // install from .agents/knowledges without --dir installs into ~/.knowledge
    const instRes = runCli(['install', './.agents/knowledges/draft-unit'], projDir, env);
    expect(instRes.status).toBe(0);
    const globalUnit = path.join(fakeHome, '.knowledge', 'draft-unit');
    expect(fs.existsSync(path.join(globalUnit, 'manifest.json'))).toBe(true);

    // remove without --dir must uninstall ~/.knowledge/draft-unit and preserve the workspace draft
    const rmRes = runCli(['remove', 'draft-unit'], projDir, env);
    expect(rmRes.status).toBe(0);
    expect(fs.existsSync(globalUnit)).toBe(false);
    expect(fs.existsSync(path.join(stagingDir, 'draft-unit', 'manifest.json'))).toBe(true);
  });

  it('7. add --pack and sync normalize standalone .md names without .md suffix, and sync --frozen detects local checksum drift', () => {
    const bareRepo = path.join(tmpDir, 'md-pack.git');
    const seedDir = path.join(tmpDir, 'md-pack-seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);

    fs.mkdirSync(path.join(seedDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(seedDir, 'docs', 'guide.md'),
      '---\ndescription: Guide for pack and sync\ntags: [guide]\n---\n# Guide\nContent\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(seedDir, 'shelf.json'),
      JSON.stringify({
        name: 'md-pack',
        units: [{ name: 'guide-alias', path: 'docs/guide.md', type: 'standalone' }],
        packs: { docs: { units: ['guide-alias'] } },
      }),
      'utf-8'
    );
    expect(runCli(['scaffold', 'unit-a', '--output', path.join(seedDir, 'units')]).status).toBe(0);
    git(seedDir, ['add', '-A']);
    git(seedDir, ['commit', '-m', 'init']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    // A. add --pack with logical standalone name omitting .md
    const packShelf = path.join(tmpDir, 'pack-shelf');
    const packRes = runCli(['add', bareRepo, '--pack', 'docs', '--dir', packShelf]);
    expect(packRes.status).toBe(0);
    expect(fs.existsSync(path.join(packShelf, 'guide-alias.md'))).toBe(true);
    expect(runCli(['search', 'Guide', '--dir', packShelf, '--no-global']).stdout).toContain('guide-alias.md');
    expect(runCli(['info', 'guide-alias', '--dir', packShelf, '--no-global']).status).toBe(0);

    // B. sync + sync --frozen with standalone name omitting .md
    const syncShelf = path.join(tmpDir, 'sync-md-shelf');
    const cfgPath = path.join(tmpDir, 'sync-md.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [
          { name: 'remote-guide', url: bareRepo, path: 'docs/guide.md' },
          { name: 'unit-a', url: bareRepo, path: 'units/unit-a' },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', cfgPath, '--dir', syncShelf]);
    expect(syncRes.status).toBe(0);
    expect(fs.existsSync(path.join(syncShelf, 'remote-guide.md'))).toBe(true);

    // Subsequent sync recognizes the installed .md entry as up-to-date
    const secondSync = runCli(['sync', '--file', cfgPath, '--dir', syncShelf]);
    expect(secondSync.status).toBe(0);
    expect(secondSync.stdout).toContain("already at");

    // sync --frozen passes before local edits
    expect(runCli(['sync', '--file', cfgPath, '--frozen', '--dir', syncShelf]).status).toBe(0);

    // C. sync --frozen fails on local content modification (checksum mismatch)
    fs.writeFileSync(path.join(syncShelf, 'unit-a', 'overview.md'), '# Tampered locally\n', 'utf-8');
    const frozenTampered = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', syncShelf]);
    expect(frozenTampered.status).toBe(1);
    expect(frozenTampered.stderr).toContain('local modifications');
  });
});
