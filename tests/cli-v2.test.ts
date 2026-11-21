/**
 * Integration tests for new CLI capabilities:
 * list unmanaged units, add (--ref, --pack, --force, --all with .md, validation),
 * update (drift protection, ls-remote, clone dedup), outdated, sync, catalog,
 * index, scaffold, publish, import/export, and trust/untrust.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], dir?: string, cwd?: string) {
  const fullArgs = [CLI_PATH, ...args, ...(dir ? ['--dir', dir] : [])];
  return spawnSync(process.execPath, fullArgs, {
    cwd,
    encoding: 'utf-8',
    timeout: 25_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function git(repoDir: string, args: string[]) {
  return execSync(`git ${args.join(' ')}`, {
    cwd: repoDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

describe('CLI v2 Ecosystem & Git Sharing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cliv2-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('list should display local/unmanaged units alongside tracked sources', () => {
    expect(runCli(['init'], tmpDir).status).toBe(0);
    const localUnit = path.join(tmpDir, 'manual-unit');
    fs.mkdirSync(localUnit);
    fs.writeFileSync(
      path.join(localUnit, 'manifest.json'),
      JSON.stringify({ name: 'manual-unit', version: '1.0.0', type: 'cookbook', description: 'Manual local' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(tmpDir, 'quick-note.md'), '# Quick Note\n\nBody.', 'utf-8');

    const res = runCli(['list'], tmpDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('manual-unit');
    expect(res.stdout).toContain('quick-note.md');
    expect(res.stdout).toContain('Local / unmanaged');
  });

  it('scaffold, index, catalog, add (--pack, --ref, --all), outdated, update drift protection, and sync should work end-to-end', () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-share-'));
    try {
      // 1. Scaffold a shareable repo
      const repoDir = path.join(workRoot, 'team-knowledge');
      const scafRes = runCli(['scaffold', 'team-knowledge', '--type', 'repo', '--output', workRoot]);
      expect(scafRes.status).toBe(0);
      expect(fs.existsSync(path.join(repoDir, '.github', 'workflows', 'validate-knowledge.yml'))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, 'shelf.json'))).toBe(true);

      // Add a second unit + standalone doc + packs to shelf.json
      const unitB = path.join(repoDir, 'unit-b');
      fs.mkdirSync(path.join(unitB, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(unitB, 'overview.md'), '# Unit B', 'utf-8');
      fs.writeFileSync(path.join(unitB, 'scripts', 'run.js'), 'console.log("ok")', 'utf-8');
      fs.writeFileSync(
        path.join(unitB, 'manifest.json'),
        JSON.stringify({
          name: 'unit-b',
          version: '1.0.0',
          type: 'toolkit',
          doc: 'overview.md',
          description: 'Toolkit unit B',
          scripts: { run: { file: 'scripts/run.js' } },
        }),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(repoDir, 'team-guide.md'),
        '---\ndescription: Team guide\ntags: [guide]\n---\n\n# Team Guide\n\nRules.',
        'utf-8'
      );

      expect(runCli(['index', repoDir]).status).toBe(0);
      const shelf = JSON.parse(fs.readFileSync(path.join(repoDir, 'shelf.json'), 'utf-8'));
      shelf.packs = { starter: { description: 'Starter pack', units: ['sample-unit', 'unit-b'] } };
      fs.writeFileSync(path.join(repoDir, 'shelf.json'), JSON.stringify(shelf, null, 2), 'utf-8');

      git(repoDir, ['init']);
      git(repoDir, ['config', 'user.email', 'test@example.com']);
      git(repoDir, ['config', 'user.name', 'Test User']);
      git(repoDir, ['add', '.']);
      git(repoDir, ['commit', '-m', '"v1"']);
      git(repoDir, ['tag', 'v1.0.0']);

      // 2. Catalog inspects remote repo before installing
      const catRes = runCli(['catalog', repoDir], tmpDir);
      expect(catRes.status).toBe(0);
      expect(catRes.stdout).toContain('sample-unit');
      expect(catRes.stdout).toContain('unit-b');
      expect(catRes.stdout).toContain('starter: sample-unit, unit-b');

      // 3. Add pack
      expect(runCli(['init'], tmpDir).status).toBe(0);
      const packRes = runCli(['add', repoDir, '--pack', 'starter'], tmpDir);
      expect(packRes.status).toBe(0);
      expect(packRes.stdout).toContain("Installed 'sample-unit'");
      expect(packRes.stdout).toContain("Installed 'unit-b'");
      expect(packRes.stdout).toContain('Security notice'); // unit-b has scripts/run.js

      // 4. Trust & untrust
      expect(runCli(['trust', 'unit-b'], tmpDir).status).toBe(0);
      let reg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
      expect(reg.sources.find((s: { name: string }) => s.name === 'unit-b').trusted).toBe(true);
      expect(runCli(['untrust', 'unit-b'], tmpDir).status).toBe(0);
      reg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.registry.json'), 'utf-8'));
      expect(reg.sources.find((s: { name: string }) => s.name === 'unit-b').trusted).toBeUndefined();

      // 5. Modify remote repo to v2; check outdated & local drift protection
      fs.writeFileSync(path.join(repoDir, 'sample-unit', 'overview.md'), '# Sample v2', 'utf-8');
      fs.writeFileSync(path.join(repoDir, 'unit-b', 'overview.md'), '# Unit B v2', 'utf-8');
      git(repoDir, ['add', '.']);
      git(repoDir, ['commit', '-m', '"v2"']);

      // Make a local edit inside sample-unit
      fs.writeFileSync(path.join(tmpDir, 'sample-unit', 'local-note.md'), 'do not lose me', 'utf-8');

      const outRes = runCli(['outdated'], tmpDir);
      expect(outRes.status).toBe(0);
      expect(outRes.stdout).toContain('sample-unit: outdated');
      expect(outRes.stdout).toContain('[modified-locally]');

      // Update without --force skips locally modified sample-unit, updates unmodified unit-b
      const upRes = runCli(['update'], tmpDir);
      expect(upRes.status).toBe(0);
      expect(upRes.stdout).toContain("Skipping 'sample-unit' (local modifications detected");
      expect(fs.existsSync(path.join(tmpDir, 'sample-unit', 'local-note.md'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'unit-b', 'overview.md'), 'utf-8')).toContain('Unit B v2');

      // Update with --force overwrites sample-unit
      const forceUp = runCli(['update', 'sample-unit', '--force'], tmpDir);
      expect(forceUp.status).toBe(0);
      expect(fs.readFileSync(path.join(tmpDir, 'sample-unit', 'overview.md'), 'utf-8')).toContain('Sample v2');

      // 6. add --all --force also installs standalone team-guide.md
      const allRes = runCli(['add', repoDir, '--all', '--force'], tmpDir);
      expect(allRes.status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'team-guide.md'))).toBe(true);

      // 7. Team sync via knowledge-shelf.json (into a brand new dir)
      const devBDir = path.join(workRoot, 'dev-b-knowledge');
      const syncConfig = path.join(workRoot, 'knowledge-shelf.json');
      fs.writeFileSync(
        syncConfig,
        JSON.stringify({
          version: '1.0',
          sources: [
            { name: 'sample-unit', url: repoDir, path: 'sample-unit', pin: 'v1.0.0' },
            { name: 'unit-b', url: repoDir, path: 'unit-b' },
          ],
        }),
        'utf-8'
      );

      const syncRes = runCli(['sync', '--file', syncConfig], devBDir);
      expect(syncRes.status).toBe(0);
      expect(fs.readFileSync(path.join(devBDir, 'sample-unit', 'overview.md'), 'utf-8')).not.toContain('Sample v2');
      expect(fs.readFileSync(path.join(devBDir, 'unit-b', 'overview.md'), 'utf-8')).toContain('Unit B v2');
      expect(runCli(['sync', '--file', syncConfig, '--frozen'], devBDir).status).toBe(0);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('publish should validate, block .env hygiene issues, commit to branch, and update shelf.json', () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pub-'));
    try {
      // Bare remote repo with initial commit & shelf.json
      const seedRepo = path.join(workRoot, 'seed');
      fs.mkdirSync(seedRepo, { recursive: true });
      fs.writeFileSync(path.join(seedRepo, 'shelf.json'), JSON.stringify({ units: [] }), 'utf-8');
      git(seedRepo, ['init']);
      git(seedRepo, ['config', 'user.email', 'test@example.com']);
      git(seedRepo, ['config', 'user.name', 'Test User']);
      git(seedRepo, ['add', '.']);
      git(seedRepo, ['commit', '-m', '"init"']);

      const bareRepo = path.join(workRoot, 'remote.git');
      execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

      // Draft a unit
      const draftDir = path.join(workRoot, 'drafts', 'new-unit');
      expect(runCli(['scaffold', 'new-unit', '--type', 'cookbook', '--output', path.join(workRoot, 'drafts')]).status).toBe(0);

      // Put .env inside draft -> publish must block it
      fs.writeFileSync(path.join(draftDir, '.env'), 'SECRET=123', 'utf-8');
      const blockedPub = runCli(['publish', draftDir, '--to', bareRepo, '--push'], tmpDir);
      expect(blockedPub.status).toBe(1);
      expect(blockedPub.stdout).toContain('Sensitive file found');

      // Remove .env and publish with --push
      fs.unlinkSync(path.join(draftDir, '.env'));
      const okPub = runCli(['publish', draftDir, '--to', bareRepo, '--push'], tmpDir);
      expect(okPub.status).toBe(0);
      expect(okPub.stdout).toContain("Published 'new-unit'");

      // Verify branch exists on bareRepo and shelf.json was updated
      const checkClone = path.join(workRoot, 'verify');
      execSync(`git clone --branch knowledge/new-unit-1.0.0 "${bareRepo}" "${checkClone}"`, { stdio: 'pipe' });
      expect(fs.existsSync(path.join(checkClone, 'new-unit', 'manifest.json'))).toBe(true);
      const shelf = JSON.parse(fs.readFileSync(path.join(checkClone, 'shelf.json'), 'utf-8'));
      expect(shelf.units.some((u: { name: string }) => u.name === 'new-unit')).toBe(true);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('export and import should round-trip both manifest units and standalone .md files', () => {
    expect(runCli(['init'], tmpDir).status).toBe(0);
    const unitDir = path.join(tmpDir, 'pkg-unit');
    fs.mkdirSync(unitDir);
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Pkg Unit\n\nBody.', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'pkg-unit', version: '1.0.0', type: 'cookbook', doc: 'overview.md', description: 'Pkg' }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'solo.md'),
      '---\ndescription: Solo doc\ntags: [solo]\n---\n\n# Solo\n\nText.',
      'utf-8'
    );

    const zipUnit = path.join(tmpDir, 'out', 'pkg-unit.zip');
    const zipSolo = path.join(tmpDir, 'out', 'solo.zip');
    expect(runCli(['export', 'pkg-unit', '--output', zipUnit], tmpDir).status).toBe(0);
    expect(runCli(['export', 'solo.md', '--output', zipSolo], tmpDir).status).toBe(0);

    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-imp-'));
    try {
      expect(runCli(['init'], importDir).status).toBe(0);
      expect(runCli(['import', zipUnit], importDir).status).toBe(0);
      expect(runCli(['import', zipSolo], importDir).status).toBe(0);
      expect(fs.existsSync(path.join(importDir, 'pkg-unit', 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(importDir, 'solo.md'))).toBe(true);
      const reg = JSON.parse(fs.readFileSync(path.join(importDir, '.registry.json'), 'utf-8'));
      const pkgEntry = reg.sources.find((s: { name: string }) => s.name === 'pkg-unit');
      expect(pkgEntry.url).toBe(`archive:${zipUnit}`);
      expect(pkgEntry.trusted).toBeUndefined();
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true });
    }
  });
});
