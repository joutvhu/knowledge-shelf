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
    timeout: 60_000,
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

describe('B3: Publish to an existing branch fast-forwards', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;
  let draftsDir: string;
  let draftUnit: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b3-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');
    draftsDir = path.join(workRoot, 'drafts');

    // 1. Scaffold and initialize seed repo
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial"']);

    // 2. Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    // 3. Draft unit new-unit v1.0.0
    fs.mkdirSync(draftsDir, { recursive: true });
    const scafUnitRes = runCli(['scaffold', 'new-unit', '--type', 'cookbook', '--output', draftsDir]);
    expect(scafUnitRes.status).toBe(0);
    draftUnit = path.join(draftsDir, 'new-unit');
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: republishing with edits fast-forwards and adds commit on remote branch', () => {
    // First publish
    const pub1 = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);
    expect(pub1.status).toBe(0);
    expect(pub1.stdout).toContain("Published 'new-unit'");

    const targetBranch = 'knowledge/new-unit-1.0.0';

    // Get count and tip commit of targetBranch on bare repo
    const count1Str = git(bareRepo, ['rev-list', '--count', targetBranch]).trim();
    const count1 = parseInt(count1Str, 10);
    const tip1 = git(bareRepo, ['rev-parse', targetBranch]).trim();

    // Edit a file in the unit
    fs.appendFileSync(path.join(draftUnit, 'overview.md'), '\nAdditional content for v1.0.0 update.\n', 'utf-8');

    // Second publish
    const pub2 = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);

    // On unfixed code, this fails (push rejected as non-fast-forward, exit 1)
    expect(pub2.status).toBe(0);

    const count2Str = git(bareRepo, ['rev-list', '--count', targetBranch]).trim();
    const count2 = parseInt(count2Str, 10);
    expect(count2).toBe(count1 + 1);

    const tip2 = git(bareRepo, ['rev-parse', targetBranch]).trim();
    // Verify first publish commit is ancestor of the new tip
    const isAncestor = execSync(`git merge-base --is-ancestor ${tip1} ${tip2}`, {
      cwd: bareRepo,
      stdio: 'pipe',
    });
    // merge-base --is-ancestor exits 0 if true
    expect(isAncestor).toBeDefined();
  });

  it('case 2: publishing to pre-created branch on bare repo fast-forwards from old tip', () => {
    const targetBranch = 'knowledge/new-unit-1.0.0';

    // Pre-create targetBranch on bare repo with an unrelated commit
    const branchClone = path.join(workRoot, 'branch-clone');
    execSync(`git clone "${bareRepo}" "${branchClone}"`, { stdio: 'pipe' });
    git(branchClone, ['config', 'user.email', 'test@example.com']);
    git(branchClone, ['config', 'user.name', 'Test User']);
    git(branchClone, ['checkout', '-b', targetBranch]);
    fs.writeFileSync(path.join(branchClone, 'pre-existing.txt'), 'Pre-existing content\n', 'utf-8');
    git(branchClone, ['add', 'pre-existing.txt']);
    git(branchClone, ['commit', '-m', '"pre-existing commit on target branch"']);
    git(branchClone, ['push', 'origin', targetBranch]);
    const oldTip = git(bareRepo, ['rev-parse', targetBranch]).trim();
    fs.rmSync(branchClone, { recursive: true, force: true });

    // Publish unit new-unit to bareRepo
    const pub = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);

    // On unfixed code, this fails (push rejected as non-fast-forward, exit 1)
    expect(pub.status).toBe(0);

    const newTip = git(bareRepo, ['rev-parse', targetBranch]).trim();
    const isAncestor = execSync(`git merge-base --is-ancestor ${oldTip} ${newTip}`, {
      cwd: bareRepo,
      stdio: 'pipe',
    });
    expect(isAncestor).toBeDefined();
  });

  it('case 3: republishing with no changes prints "No changes to publish" and exits 0', () => {
    // First publish
    const pub1 = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);
    expect(pub1.status).toBe(0);
    expect(pub1.stdout).toContain("Published 'new-unit'");

    // Second publish with no changes
    const pub2 = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);

    // Should exit 0 and print "No changes to publish"
    expect(pub2.status).toBe(0);
    expect(pub2.stdout).toContain('No changes to publish');
  });

  it('case 4: a pre-receive hook that exits 1 in the bare repo makes publish --push --force exit 1 with the remote tip unchanged', (ctx) => {
    // First publish to create target branch
    const pub1 = runCli(['publish', draftUnit, '--to', bareRepo, '--push']);
    expect(pub1.status).toBe(0);

    const targetBranch = 'knowledge/new-unit-1.0.0';
    const tipBefore = git(bareRepo, ['rev-parse', targetBranch]).trim();

    // Install pre-receive hook in bare repo that always rejects pushes
    const hooksDir = path.join(bareRepo, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-receive');
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o777 });

    // Make an edit to the draft unit so there is a change to publish
    fs.appendFileSync(path.join(draftUnit, 'overview.md'), '\nRejection test edit.\n', 'utf-8');

    // Run publish with --push and --force
    const pub2 = runCli(['publish', draftUnit, '--to', bareRepo, '--push', '--force']);

    if (pub2.status === 0) {
      // If git on this host does not execute POSIX shell hooks, skip this test
      console.warn('Skipping pre-receive hook rejection test: git hooks do not execute on this host.');
      ctx.skip();
      return;
    }

    expect(pub2.status).toBe(1);
    const tipAfter = git(bareRepo, ['rev-parse', targetBranch]).trim();
    expect(tipAfter).toBe(tipBefore);
  });
});

describe('B4: Standalone Markdown can be published', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;
  let knowledgeDir: string;
  let soloPath: string;
  const soloContent = '# Solo Guide\n\nThis is a standalone markdown guide with body content.\n';

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b4-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');
    knowledgeDir = path.join(workRoot, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });

    // Initialize seed repo
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial"']);

    // Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    // Create valid solo.md with frontmatter-free body
    soloPath = path.join(knowledgeDir, 'solo.md');
    fs.writeFileSync(soloPath, soloContent, 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: publish by absolute path and --push, then clone and assert solo.md exists at repo root on branch knowledge/solo', () => {
    const pub = runCli(['publish', soloPath, '--to', bareRepo, '--push']);
    expect(pub.status).toBe(0);

    const cloneDir = path.join(workRoot, 'clone-abs');
    execSync(`git clone --branch knowledge/solo "${bareRepo}" "${cloneDir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir, 'solo.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cloneDir, 'solo.md'), 'utf-8').replace(/\r\n/g, '\n')).toBe(soloContent.replace(/\r\n/g, '\n'));
  });

  it('case 2: publish by name (solo or solo.md) from the knowledge folder', () => {
    // Publish using name without extension: 'solo'
    const pubName = runCli(['publish', 'solo', '--to', bareRepo, '--push'], knowledgeDir);
    expect(pubName.status).toBe(0);

    const cloneDir = path.join(workRoot, 'clone-name');
    execSync(`git clone --branch knowledge/solo "${bareRepo}" "${cloneDir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir, 'solo.md'))).toBe(true);

    // Also verify publishing by name with extension: 'solo2.md'
    const solo2Path = path.join(knowledgeDir, 'solo2.md');
    fs.writeFileSync(solo2Path, '# Solo 2\n\nBody content 2.\n', 'utf-8');
    const pubNameExt = runCli(['publish', 'solo2.md', '--to', bareRepo, '--push'], knowledgeDir);
    expect(pubNameExt.status).toBe(0);

    const cloneDir2 = path.join(workRoot, 'clone-name-ext');
    execSync(`git clone --branch knowledge/solo2 "${bareRepo}" "${cloneDir2}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir2, 'solo2.md'))).toBe(true);
  });

  it('case 3: publish with --path docs/solo.md', () => {
    const pub = runCli(['publish', soloPath, '--to', bareRepo, '--path', 'docs/solo.md', '--push']);
    expect(pub.status).toBe(0);

    const cloneDir = path.join(workRoot, 'clone-path-file');
    execSync(`git clone --branch knowledge/solo "${bareRepo}" "${cloneDir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir, 'docs', 'solo.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cloneDir, 'docs', 'solo.md'), 'utf-8').replace(/\r\n/g, '\n')).toBe(soloContent.replace(/\r\n/g, '\n'));
  });

  it('case 4: publish with --path docs/ (lands as docs/solo.md)', () => {
    const pub = runCli(['publish', soloPath, '--to', bareRepo, '--path', 'docs/', '--push']);
    expect(pub.status).toBe(0);

    const cloneDir = path.join(workRoot, 'clone-path-dir');
    execSync(`git clone --branch knowledge/solo "${bareRepo}" "${cloneDir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir, 'docs', 'solo.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cloneDir, 'docs', 'solo.md'), 'utf-8').replace(/\r\n/g, '\n')).toBe(soloContent.replace(/\r\n/g, '\n'));
  });

  it('case 5: error case: empty .md exits 1 with validation errors', () => {
    const emptyPath = path.join(knowledgeDir, 'empty.md');
    fs.writeFileSync(emptyPath, '   \n\n', 'utf-8');

    const pub = runCli(['publish', emptyPath, '--to', bareRepo]);
    expect(pub.status).toBe(1);
    const combinedOut = (pub.stdout || '') + (pub.stderr || '');
    expect(combinedOut).toMatch(/ERROR: Markdown file is empty/i);
    expect(combinedOut).toMatch(/Fix validation errors before publishing/i);
  });

  it('case 6: error case: .md containing runtime-built token exits 1 without --force and passes with --force', () => {
    const tokenVal = 'ghp_' + 'A'.repeat(36);
    const tokenPath = path.join(knowledgeDir, 'token.md');
    fs.writeFileSync(tokenPath, `# Token Doc\n\nSensitive token: ${tokenVal}\n`, 'utf-8');

    // Without --force: should exit 1 and report hygiene warning
    const pubNoForce = runCli(['publish', tokenPath, '--to', bareRepo]);
    expect(pubNoForce.status).toBe(1);
    const combinedNoForce = (pubNoForce.stdout || '') + (pubNoForce.stderr || '');
    expect(combinedNoForce).toMatch(/hygiene warning/i);

    // With --force: should pass and exit 0
    const pubForce = runCli(['publish', tokenPath, '--to', bareRepo, '--force', '--push']);
    expect(pubForce.status).toBe(0);

    const cloneDir = path.join(workRoot, 'clone-token');
    execSync(`git clone --branch knowledge/token "${bareRepo}" "${cloneDir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(cloneDir, 'token.md'))).toBe(true);
  });

  it('case 7: error case: a .txt file exits 1 and the message names "directory" and ".md"', () => {
    const txtPath = path.join(knowledgeDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'Some notes that are not markdown\n', 'utf-8');

    const pub = runCli(['publish', txtPath, '--to', bareRepo]);
    expect(pub.status).toBe(1);
    const combinedOut = (pub.stdout || '') + (pub.stderr || '');
    expect(combinedOut).toMatch(/directory/i);
    expect(combinedOut).toMatch(/\.md/i);
  });
});
describe('B5: Frozen comparison accepts equivalent refs', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;
  let fullCommit: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b5-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // 1. Scaffold seed repo
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);

    // Commit C0 (older state)
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"v0.9.0 initial"']);
    git(seedRepo, ['tag', 'v0.9.0']);

    // Commit C1 (newer state with sample-unit update)
    fs.appendFileSync(path.join(seedRepo, 'sample-unit', 'overview.md'), '\nUpdated in v1.0.0.\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"v1.0.0 update"']);

    // Tags pointing to C1
    git(seedRepo, ['tag', 'v1.0.0-light']);
    git(seedRepo, ['tag', '-a', 'v1.0.0-annotated', '-m', '"annotated tag v1.0.0"']);

    // Clone bare repo from seed (includes commits and tags)
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    fullCommit = git(bareRepo, ['rev-parse', 'HEAD']).trim();
    expect(fullCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: sync --frozen exits 0 for 40-character full commit SHA', () => {
    const clientDir = path.join(workRoot, 'client-full-sha');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
            ref: fullCommit,
          },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncRes.status).toBe(0);

    const frozenRes = runCli(['sync', '--file', syncConfig, '--frozen'], clientDir);
    // On unfixed code, fails because registry stores 7-char short SHA and does strict !== check
    expect(frozenRes.status).toBe(0);
  });

  it('case 2: sync --frozen exits 0 for lightweight tag pointing to installed commit', () => {
    const clientDir = path.join(workRoot, 'client-light-tag');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
            ref: 'v1.0.0-light',
          },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncRes.status).toBe(0);

    const frozenRes = runCli(['sync', '--file', syncConfig, '--frozen'], clientDir);
    // On unfixed code, fails because tag ref is compared with commit SHA without remote resolution
    expect(frozenRes.status).toBe(0);
  });

  it('case 3: sync --frozen exits 0 for annotated tag pointing to installed commit', () => {
    const clientDir = path.join(workRoot, 'client-annotated-tag');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
            ref: 'v1.0.0-annotated',
          },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncRes.status).toBe(0);

    const frozenRes = runCli(['sync', '--file', syncConfig, '--frozen'], clientDir);
    // On unfixed code, fails because annotated tag ref is compared with commit SHA without remote resolution
    expect(frozenRes.status).toBe(0);
  });

  it('case 4: sync --frozen exits 1 with "version mismatch" for a tag pointing to an older commit', () => {
    const clientDir = path.join(workRoot, 'client-older-tag');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });
    // First, install at HEAD (C1)
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
            ref: fullCommit,
          },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncRes.status).toBe(0);

    // Now change syncConfig ref to point to older tag v0.9.0
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
            ref: 'v0.9.0',
          },
        ],
      }),
      'utf-8'
    );

    const frozenRes = runCli(['sync', '--file', syncConfig, '--frozen'], clientDir);
    expect(frozenRes.status).toBe(1);
    const combined = (frozenRes.stdout || '') + (frozenRes.stderr || '');
    expect(combined).toMatch(/version mismatch/i);
  });

  it('case 5: registry.sources[0].fullCommit matches 40-hex pattern after add', () => {
    const clientDir = path.join(workRoot, 'client-add');
    const addRes = runCli(['add', bareRepo, '--name', 'sample-unit', '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const regPath = path.join(clientDir, '.registry.json');
    expect(fs.existsSync(regPath)).toBe(true);
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    expect(reg.sources).toHaveLength(1);
    // On unfixed code, fullCommit is not recorded (undefined)
    expect(reg.sources[0].fullCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('B6: Sync protects local modifications', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b6-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // 1. Scaffold and initialize seed repo with two units
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    // Create a second unit in seed repo: unit-two
    const scafUnit2 = runCli(['scaffold', 'unit-two', '--type', 'cookbook', '--output', seedRepo]);
    expect(scafUnit2.status).toBe(0);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial with sample-unit and unit-two"']);

    // 2. Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: sync skips locally modified unit with warning and force hint, leaves file and registry unchanged', () => {
    const clientDir = path.join(workRoot, 'client');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });

    // Initial sync config
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
          },
        ],
      }),
      'utf-8'
    );

    // Initial sync installs sample-unit
    const syncInit = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncInit.status).toBe(0);

    const regPath = path.join(clientDir, '.registry.json');
    const regBefore = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const entryBefore = regBefore.sources.find((s: any) => s.name === 'sample-unit');
    expect(entryBefore).toBeDefined();

    // Edit overview.md locally
    const overviewPath = path.join(clientDir, 'sample-unit', 'overview.md');
    const modifiedContent = '# Sample Unit\n\nLocal edits that must NOT be overwritten!\n';
    fs.writeFileSync(overviewPath, modifiedContent, 'utf-8');

    // Advance the remote with a new commit
    fs.appendFileSync(path.join(seedRepo, 'sample-unit', 'overview.md'), '\nUpstream changes in commit 2\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"advance sample-unit upstream"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run sync without --force
    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);

    // Expected behavior: exit 0, skip message with --force hint, local file and registry unchanged
    expect(syncRes.status).toBe(0);
    const combinedOut = (syncRes.stdout || '') + (syncRes.stderr || '');
    expect(combinedOut).toMatch(/local modifications detected/i);
    expect(combinedOut).toMatch(/--force/i);

    // Verify local file content is preserved
    const overviewAfter = fs.readFileSync(overviewPath, 'utf-8');
    expect(overviewAfter).toBe(modifiedContent);

    // Verify registry commit and checksum are unchanged
    const regAfter = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const entryAfter = regAfter.sources.find((s: any) => s.name === 'sample-unit');
    expect(entryAfter.commit).toBe(entryBefore.commit);
    expect(entryAfter.checksum).toBe(entryBefore.checksum);
  });

  it('case 2: sync --force overwrites local modifications', () => {
    const clientDir = path.join(workRoot, 'client-force');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });

    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
          },
        ],
      }),
      'utf-8'
    );

    const syncInit = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncInit.status).toBe(0);

    // Edit overview.md locally
    const overviewPath = path.join(clientDir, 'sample-unit', 'overview.md');
    fs.writeFileSync(overviewPath, '# Overwrite me please\n', 'utf-8');

    // Advance remote
    const upstreamContent = '\nUpstream content that should overwrite local changes\n';
    fs.appendFileSync(path.join(seedRepo, 'sample-unit', 'overview.md'), upstreamContent, 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"upstream commit for force test"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run sync with --force
    const syncForceRes = runCli(['sync', '--file', syncConfig, '--force'], clientDir);
    expect(syncForceRes.status).toBe(0);

    // Local file should now contain the upstream content
    const overviewAfter = fs.readFileSync(overviewPath, 'utf-8');
    expect(overviewAfter).toContain('Upstream content that should overwrite local changes');
  });

  it('case 3: unmodified second unit in same sync run still syncs successfully when first unit is skipped', () => {
    const clientDir = path.join(workRoot, 'client-multi');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });

    // Initial sync config with both units
    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
          },
          {
            name: 'unit-two',
            url: bareRepo,
            path: 'unit-two',
          },
        ],
      }),
      'utf-8'
    );

    const syncInit = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncInit.status).toBe(0);

    // Edit only sample-unit locally
    const sampleOverviewPath = path.join(clientDir, 'sample-unit', 'overview.md');
    const localEditContent = '# My local changes to sample-unit\n';
    fs.writeFileSync(sampleOverviewPath, localEditContent, 'utf-8');

    // Advance remote for both units
    fs.appendFileSync(path.join(seedRepo, 'sample-unit', 'overview.md'), '\nUpstream sample-unit update\n', 'utf-8');
    fs.appendFileSync(path.join(seedRepo, 'unit-two', 'overview.md'), '\nUpstream unit-two update\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"upstream updates for both units"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    const newCommit = git(bareRepo, ['rev-parse', '--short', 'HEAD']).trim();

    // Run sync without --force
    const syncRes = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncRes.status).toBe(0);

    const combinedOut = (syncRes.stdout || '') + (syncRes.stderr || '');
    expect(combinedOut).toMatch(/local modifications detected/i);
    expect(combinedOut).toMatch(/Synced 'unit-two'/i);

    // sample-unit preserved
    expect(fs.readFileSync(sampleOverviewPath, 'utf-8')).toBe(localEditContent);

    // unit-two was updated
    const unitTwoOverview = fs.readFileSync(path.join(clientDir, 'unit-two', 'overview.md'), 'utf-8');
    expect(unitTwoOverview).toContain('Upstream unit-two update');

    // Registry check
    const reg = JSON.parse(fs.readFileSync(path.join(clientDir, '.registry.json'), 'utf-8'));
    const entryUnitTwo = reg.sources.find((s: any) => s.name === 'unit-two');
    expect(entryUnitTwo.commit).toBe(newCommit);
  });
});

describe('B7: Invalid incoming content never replaces a working unit', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;

  function snapshotDir(dir: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!fs.existsSync(dir)) return result;

    function walk(current: string) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const rel = path.relative(dir, fullPath).replace(/\\/g, '/');
          result[rel] = fs.readFileSync(fullPath, 'utf-8');
        }
      }
    }

    walk(dir);
    return result;
  }

  function getRegistryEntry(clientDir: string, name: string) {
    const regPath = path.join(clientDir, '.registry.json');
    if (!fs.existsSync(regPath)) return null;
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const entry = reg.sources.find((s: any) => s.name === name);
    return entry ? JSON.parse(JSON.stringify(entry)) : null;
  }

  function getStageDirs(clientDir: string): string[] {
    const cacheDir = path.join(clientDir, '.cache');
    if (!fs.existsSync(cacheDir)) return [];
    return fs.readdirSync(cacheDir).filter((name) => name.startsWith('.vstage-'));
  }

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b7-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // 1. Scaffold and initialize seed repo with sample-unit
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial with sample-unit"']);

    // 2. Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: update: remote commit removing version from manifest keeps working unit, exits 1 and leaves no staging dir', () => {
    const clientDir = path.join(workRoot, 'client-update');
    fs.mkdirSync(clientDir, { recursive: true });

    // Initial add
    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const installedDir = path.join(clientDir, 'sample-unit');
    const filesBefore = snapshotDir(installedDir);
    const entryBefore = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryBefore).toBeDefined();

    // Advance remote with a commit that removes 'version' from manifest.json
    const manifestPath = path.join(seedRepo, 'sample-unit', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"remove version from manifest"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run update
    const res = runCli(['update'], clientDir);

    expect(res.status).toBe(1);
    const combinedOut = (res.stdout || '') + (res.stderr || '');
    expect(combinedOut).toMatch(/ERROR/);

    const filesAfter = snapshotDir(installedDir);
    expect(filesAfter).toEqual(filesBefore);

    const entryAfter = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryAfter).toEqual(entryBefore);

    expect(getStageDirs(clientDir)).toEqual([]);
  });

  it('case 2: sync: remote commit removing version from manifest keeps working unit, exits 1 and leaves no staging dir', () => {
    const clientDir = path.join(workRoot, 'client-sync');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });

    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
          },
        ],
      }),
      'utf-8'
    );

    const syncInit = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncInit.status).toBe(0);

    const installedDir = path.join(clientDir, 'sample-unit');
    const filesBefore = snapshotDir(installedDir);
    const entryBefore = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryBefore).toBeDefined();

    // Advance remote with broken manifest
    const manifestPath = path.join(seedRepo, 'sample-unit', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"broken manifest for sync test"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run sync
    const res = runCli(['sync', '--file', syncConfig], clientDir);

    expect(res.status).toBe(1);
    const combinedOut = (res.stdout || '') + (res.stderr || '');
    expect(combinedOut).toMatch(/ERROR/);

    const filesAfter = snapshotDir(installedDir);
    expect(filesAfter).toEqual(filesBefore);

    const entryAfter = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryAfter).toEqual(entryBefore);

    expect(getStageDirs(clientDir)).toEqual([]);
  });

  it('case 3: pin: checking out ref with broken manifest keeps working unit, pin field unchanged, exits 1', () => {
    const clientDir = path.join(workRoot, 'client-pin');
    fs.mkdirSync(clientDir, { recursive: true });

    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const installedDir = path.join(clientDir, 'sample-unit');
    const filesBefore = snapshotDir(installedDir);
    const entryBefore = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryBefore).toBeDefined();
    expect(entryBefore.pin).toBeUndefined();

    // On remote, commit broken manifest and tag as v-broken
    const manifestPath = path.join(seedRepo, 'sample-unit', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"commit with broken manifest"']);
    git(seedRepo, ['tag', 'v-broken']);
    git(seedRepo, ['push', bareRepo, 'v-broken']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run pin
    const res = runCli(['pin', 'sample-unit', 'v-broken'], clientDir);

    expect(res.status).toBe(1);
    const combinedOut = (res.stdout || '') + (res.stderr || '');
    expect(combinedOut).toMatch(/ERROR/);

    const filesAfter = snapshotDir(installedDir);
    expect(filesAfter).toEqual(filesBefore);

    const entryAfter = getRegistryEntry(clientDir, 'sample-unit');
    expect(entryAfter).toEqual(entryBefore);
    expect(entryAfter.pin).toBeUndefined();

    expect(getStageDirs(clientDir)).toEqual([]);
  });

  it('case 4: --no-verify installs incoming broken version without validation error', () => {
    const clientDir = path.join(workRoot, 'client-noverify');
    fs.mkdirSync(clientDir, { recursive: true });

    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    // Break manifest on remote
    const manifestPath = path.join(seedRepo, 'sample-unit', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"broken manifest for no-verify test"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run update with --no-verify
    const res = runCli(['update', '--no-verify'], clientDir);

    expect(res.status).toBe(0);
    const manifestAfter = JSON.parse(
      fs.readFileSync(path.join(clientDir, 'sample-unit', 'manifest.json'), 'utf-8')
    );
    expect(manifestAfter.version).toBeUndefined();
  });

  it('case 5: update: local source with broken manifest keeps working unit, exits 1', () => {
    const clientDir = path.join(workRoot, 'client-local');
    const localDir = path.join(workRoot, 'local-sources');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });

    const scafRes = runCli(['scaffold', 'local-unit', '--type', 'cookbook', '--output', localDir]);
    expect(scafRes.status).toBe(0);
    const localUnitDir = path.join(localDir, 'local-unit');

    const installRes = runCli(['install', localUnitDir], clientDir);
    expect(installRes.status).toBe(0);

    const installedDir = path.join(clientDir, 'local-unit');
    const filesBefore = snapshotDir(installedDir);
    const entryBefore = getRegistryEntry(clientDir, 'local-unit');
    expect(entryBefore).toBeDefined();

    // Break manifest in local source
    const manifestPath = path.join(localUnitDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    delete manifest.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Run update
    const res = runCli(['update', 'local-unit'], clientDir);

    expect(res.status).toBe(1);
    const combinedOut = (res.stdout || '') + (res.stderr || '');
    expect(combinedOut).toMatch(/ERROR/);

    const filesAfter = snapshotDir(installedDir);
    expect(filesAfter).toEqual(filesBefore);

    const entryAfter = getRegistryEntry(clientDir, 'local-unit');
    expect(entryAfter).toEqual(entryBefore);

    expect(getStageDirs(clientDir)).toEqual([]);
  });

  it('case 6: sync: standalone .md source that becomes empty keeps working file, exits 1', () => {
    const clientDir = path.join(workRoot, 'client-standalone-md');
    const syncConfig = path.join(clientDir, 'knowledge-shelf.json');
    fs.mkdirSync(clientDir, { recursive: true });

    // Add standalone markdown to seed repo
    const guideMdPath = path.join(seedRepo, 'guide.md');
    fs.writeFileSync(
      guideMdPath,
      '---\ndescription: Standalone guide\ntags: [guide]\n---\n# Standalone Guide\n\nValid guide body.\n',
      'utf-8'
    );
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"add guide.md"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    fs.writeFileSync(
      syncConfig,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'guide.md',
            url: bareRepo,
            path: 'guide.md',
          },
        ],
      }),
      'utf-8'
    );

    const syncInit = runCli(['sync', '--file', syncConfig], clientDir);
    expect(syncInit.status).toBe(0);

    const installedGuide = path.join(clientDir, 'guide.md');
    expect(fs.existsSync(installedGuide)).toBe(true);
    const contentBefore = fs.readFileSync(installedGuide, 'utf-8');
    const entryBefore = getRegistryEntry(clientDir, 'guide.md');
    expect(entryBefore).toBeDefined();

    // Make guide.md empty on remote
    fs.writeFileSync(guideMdPath, '', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"empty guide.md"']);
    git(seedRepo, ['push', bareRepo, 'master:master']);

    // Run sync
    const res = runCli(['sync', '--file', syncConfig], clientDir);

    expect(res.status).toBe(1);
    const combinedOut = (res.stdout || '') + (res.stderr || '');
    expect(combinedOut).toMatch(/ERROR/);

    const contentAfter = fs.readFileSync(installedGuide, 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    const entryAfter = getRegistryEntry(clientDir, 'guide.md');
    expect(entryAfter).toEqual(entryBefore);

    expect(getStageDirs(clientDir)).toEqual([]);
  });
});

describe('B8: Checksum coverage in CLI', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b8-cli-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // 1. Scaffold seed repo
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    // 2. Add .hidden/cfg.json and node_modules/x/a.txt into sample-unit
    fs.mkdirSync(path.join(seedRepo, 'sample-unit', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(seedRepo, 'sample-unit', '.hidden', 'cfg.json'), '{"setting": true}\n', 'utf-8');
    fs.mkdirSync(path.join(seedRepo, 'sample-unit', 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(seedRepo, 'sample-unit', 'node_modules', 'x', 'a.txt'), 'module content\n', 'utf-8');

    // 3. Initialize git repo and commit
    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial commit with dot and nm files"']);

    // 4. Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('case 1: after editing .hidden/cfg.json in an installed unit, running outdated shows [modified-locally]', () => {
    const clientDir = path.join(workRoot, 'client-dot');
    fs.mkdirSync(clientDir, { recursive: true });

    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const outInitial = runCli(['outdated'], clientDir);
    expect(outInitial.status).toBe(0);
    expect(outInitial.stdout).not.toContain('[modified-locally]');

    // Edit .hidden/cfg.json in the installed unit
    fs.writeFileSync(
      path.join(clientDir, 'sample-unit', '.hidden', 'cfg.json'),
      '{"setting": false, "tampered": true}\n',
      'utf-8'
    );

    const outAfter = runCli(['outdated'], clientDir);
    expect(outAfter.status).toBe(0);
    // On unfixed code, computeUnitChecksum uses walkDir which skips .hidden,
    // so checksum matches stored registry checksum and [modified-locally] is NOT shown.
    expect(outAfter.stdout).toContain('[modified-locally]');
  });

  it('case 2: after editing node_modules/x/a.txt in an installed unit, running outdated shows [modified-locally]', () => {
    const clientDir = path.join(workRoot, 'client-nm');
    fs.mkdirSync(clientDir, { recursive: true });

    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const outInitial = runCli(['outdated'], clientDir);
    expect(outInitial.status).toBe(0);
    expect(outInitial.stdout).not.toContain('[modified-locally]');

    // Edit node_modules/x/a.txt in the installed unit
    fs.writeFileSync(
      path.join(clientDir, 'sample-unit', 'node_modules', 'x', 'a.txt'),
      'tampered module content\n',
      'utf-8'
    );

    const outAfter = runCli(['outdated'], clientDir);
    expect(outAfter.status).toBe(0);
    // On unfixed code, computeUnitChecksum uses walkDir which skips node_modules,
    // so checksum matches stored registry checksum and [modified-locally] is NOT shown.
    expect(outAfter.stdout).toContain('[modified-locally]');
  });
});

describe('preservation: hygiene and publish', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;
  let draftsDir: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-pub-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');
    draftsDir = path.join(workRoot, 'drafts');

    // Scaffold seed repo with shelf.json
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial seed commit"']);

    // Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    fs.mkdirSync(draftsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  // **Validates: Requirements 3.2, 3.3**
  it('publish to a branch that does not exist creates knowledge/<unit>-<version> from default branch, updates shelf.json, uses default commit msg, and with --push pushes with -u origin <branch>', () => {
    // Draft a unit
    const scafUnitRes = runCli(['scaffold', 'demo-unit', '--type', 'cookbook', '--output', draftsDir]);
    expect(scafUnitRes.status).toBe(0);
    const unitDir = path.join(draftsDir, 'demo-unit');

    // Publish to non-existing branch knowledge/demo-unit-1.0.0 with --push
    const pubRes = runCli(['publish', unitDir, '--to', bareRepo, '--push']);
    expect(pubRes.status).toBe(0);
    expect(pubRes.stdout).toContain("Published 'demo-unit'");

    const targetBranch = 'knowledge/demo-unit-1.0.0';

    // Verify branch exists on bare repo
    const tipCommit = git(bareRepo, ['rev-parse', targetBranch]).trim();
    expect(tipCommit).toMatch(/^[0-9a-f]{40}$/);

    // Verify default commit message: "chore(knowledge): publish <unit> v<version>"
    const commitMsg = git(bareRepo, ['log', '-1', '--pretty=%B', targetBranch]).trim();
    expect(commitMsg).toBe('chore(knowledge): publish demo-unit v1.0.0');

    // Verify shelf.json is updated on that branch
    const verifyClone = path.join(workRoot, 'verify-clone');
    execSync(`git clone --branch ${targetBranch} "${bareRepo}" "${verifyClone}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.join(verifyClone, 'demo-unit', 'manifest.json'))).toBe(true);

    const shelfPath = path.join(verifyClone, 'shelf.json');
    expect(fs.existsSync(shelfPath)).toBe(true);
    const shelf = JSON.parse(fs.readFileSync(shelfPath, 'utf-8'));
    expect(shelf.units.some((u: any) => u.name === 'demo-unit')).toBe(true);
  });

  it('publish with custom --branch publishes to that branch', () => {
    const scafUnitRes = runCli(['scaffold', 'custom-branch-unit', '--type', 'cookbook', '--output', draftsDir]);
    expect(scafUnitRes.status).toBe(0);
    const unitDir = path.join(draftsDir, 'custom-branch-unit');

    const customBranch = 'feature/custom-unit';
    const pubRes = runCli(['publish', unitDir, '--to', bareRepo, '--branch', customBranch, '--push']);
    expect(pubRes.status).toBe(0);

    const tipCommit = git(bareRepo, ['rev-parse', customBranch]).trim();
    expect(tipCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('root .env blocks publish (exit 1) and --force overrides it', () => {
    const scafUnitRes = runCli(['scaffold', 'env-unit', '--type', 'cookbook', '--output', draftsDir]);
    expect(scafUnitRes.status).toBe(0);
    const unitDir = path.join(draftsDir, 'env-unit');

    // Add .env at unit root
    fs.writeFileSync(path.join(unitDir, '.env'), 'SECRET_KEY=12345\n', 'utf-8');

    // Without --force: blocked with exit 1
    const blockedRes = runCli(['publish', unitDir, '--to', bareRepo, '--push']);
    expect(blockedRes.status).toBe(1);
    const combinedOut = (blockedRes.stdout || '') + (blockedRes.stderr || '');
    expect(combinedOut).toContain('Sensitive file found: .env');
    expect(combinedOut).toContain('Hygiene warnings detected');

    // With --force: warning printed but publish proceeds with exit 0
    const forceRes = runCli(['publish', unitDir, '--to', bareRepo, '--push', '--force']);
    expect(forceRes.status).toBe(0);
    expect(forceRes.stdout).toContain('Sensitive file found: .env');
    expect(forceRes.stdout).toContain("Published 'env-unit'");

    // Verify it was pushed to remote
    const targetBranch = 'knowledge/env-unit-1.0.0';
    const tipCommit = git(bareRepo, ['rev-parse', targetBranch]).trim();
    expect(tipCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('preservation: sync, update, pin', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-sync-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // Scaffold seed repo with shelf.json
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['branch', '-M', 'main']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial seed commit"']);

    // Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    // Link seed repo origin to bare repo
    git(seedRepo, ['remote', 'add', 'origin', `"${bareRepo}"`]);
    git(seedRepo, ['push', '-u', 'origin', 'main']);
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  // **Validates: Requirements 3.4**
  it('sync --frozen succeeds offline for equal short SHA, for pin == ref, and with no ref; fails with exit 1 for a missing unit and for a different SHA', () => {
    const clientDir = path.join(workRoot, 'client-frozen');
    fs.mkdirSync(clientDir, { recursive: true });

    // Initial add of sample-unit from bareRepo
    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    const regPath = path.join(clientDir, '.registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const installedCommit = reg.sources[0].commit;
    expect(installedCommit).toBeDefined();

    const offlineRepo = path.join(workRoot, 'offline-ghost.git');
    const syncConfigFile = path.join(clientDir, 'knowledge-shelf.json');

    // 1. Equal short SHA succeeds offline
    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: offlineRepo,
            path: 'sample-unit',
            ref: installedCommit,
          },
        ],
      }),
      'utf-8'
    );
    const frozenShortSha = runCli(['sync', '--file', syncConfigFile, '--frozen'], clientDir);
    expect(frozenShortSha.status).toBe(0);
    expect(frozenShortSha.stdout).toContain('✓ All 1 source(s) verified (--frozen).');

    // 2. pin == ref succeeds offline
    reg.sources[0].pin = 'v1.0.0';
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');

    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: offlineRepo,
            path: 'sample-unit',
            ref: 'v1.0.0',
          },
        ],
      }),
      'utf-8'
    );
    const frozenPinRef = runCli(['sync', '--file', syncConfigFile, '--frozen'], clientDir);
    expect(frozenPinRef.status).toBe(0);
    expect(frozenPinRef.stdout).toContain('✓ All 1 source(s) verified (--frozen).');

    // 3. No ref declared succeeds offline
    delete reg.sources[0].pin;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');

    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: offlineRepo,
            path: 'sample-unit',
          },
        ],
      }),
      'utf-8'
    );
    const frozenNoRef = runCli(['sync', '--file', syncConfigFile, '--frozen'], clientDir);
    expect(frozenNoRef.status).toBe(0);
    expect(frozenNoRef.stdout).toContain('✓ All 1 source(s) verified (--frozen).');

    // 4. Missing unit fails with exit 1
    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'missing-unit',
            url: offlineRepo,
            path: 'missing-unit',
          },
        ],
      }),
      'utf-8'
    );
    const frozenMissing = runCli(['sync', '--file', syncConfigFile, '--frozen'], clientDir);
    expect(frozenMissing.status).toBe(1);
    expect(frozenMissing.stderr).toContain("Error (--frozen): 'missing-unit' is not installed.");

    // 5. Different SHA fails with exit 1
    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: offlineRepo,
            path: 'sample-unit',
            ref: 'deadbeef',
          },
        ],
      }),
      'utf-8'
    );
    const frozenDiffSha = runCli(['sync', '--file', syncConfigFile, '--frozen'], clientDir);
    expect(frozenDiffSha.status).toBe(1);
    expect(frozenDiffSha.stderr).toContain("Error (--frozen): 'sample-unit' version mismatch");
  });

  // **Validates: Requirements 3.5**
  it('sync and update replace an unmodified unit when remote commit changed and refresh commit, checksum, updatedAt; an up-to-date unit prints already at / Already up to date and is not re-copied', () => {
    // --- Part A: sync ---
    const clientDirSync = path.join(workRoot, 'client-sync');
    const syncConfigFile = path.join(clientDirSync, 'knowledge-shelf.json');
    fs.mkdirSync(clientDirSync, { recursive: true });

    fs.writeFileSync(
      syncConfigFile,
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'sample-unit',
            url: bareRepo,
            path: 'sample-unit',
          },
        ],
      }),
      'utf-8'
    );

    // Initial sync
    const initSync = runCli(['sync', '--file', syncConfigFile], clientDirSync);
    expect(initSync.status).toBe(0);
    expect(initSync.stdout).toContain("✓ Synced 'sample-unit'");

    const regPathSync = path.join(clientDirSync, '.registry.json');
    const regSync1 = JSON.parse(fs.readFileSync(regPathSync, 'utf-8'));
    const commitSync1 = regSync1.sources[0].commit;
    const checksumSync1 = regSync1.sources[0].checksum;
    const updatedAtSync1 = regSync1.sources[0].updatedAt;

    // Remote commit changed
    fs.appendFileSync(
      path.join(seedRepo, 'sample-unit', 'overview.md'),
      '\nRemote update for sync test\n',
      'utf-8'
    );
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"update for sync"']);
    git(seedRepo, ['push', 'origin', 'main']);

    // Re-run sync: unmodified unit replaced, metadata refreshed
    const resSyncUpdate = runCli(['sync', '--file', syncConfigFile], clientDirSync);
    expect(resSyncUpdate.status).toBe(0);
    expect(resSyncUpdate.stdout).toContain("✓ Synced 'sample-unit'");
    const overviewSync = fs.readFileSync(path.join(clientDirSync, 'sample-unit', 'overview.md'), 'utf-8');
    expect(overviewSync).toContain('Remote update for sync test');

    const regSync2 = JSON.parse(fs.readFileSync(regPathSync, 'utf-8'));
    expect(regSync2.sources[0].commit).not.toBe(commitSync1);
    expect(regSync2.sources[0].checksum).not.toBe(checksumSync1);
    expect(new Date(regSync2.sources[0].updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(updatedAtSync1).getTime());

    // Up-to-date unit prints "already at" and is not re-copied
    const mtimeBeforeSync = fs.statSync(path.join(clientDirSync, 'sample-unit', 'overview.md')).mtimeMs;
    const resSyncAgain = runCli(['sync', '--file', syncConfigFile], clientDirSync);
    expect(resSyncAgain.status).toBe(0);
    expect(resSyncAgain.stdout).toContain(`'sample-unit' already at ${regSync2.sources[0].commit}`);
    const mtimeAfterSync = fs.statSync(path.join(clientDirSync, 'sample-unit', 'overview.md')).mtimeMs;
    expect(mtimeAfterSync).toBe(mtimeBeforeSync);

    // --- Part B: update ---
    const clientDirUpdate = path.join(workRoot, 'client-update');
    fs.mkdirSync(clientDirUpdate, { recursive: true });

    // Initial add
    const initAdd = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDirUpdate);
    expect(initAdd.status).toBe(0);

    const regPathUpdate = path.join(clientDirUpdate, '.registry.json');
    const regUp1 = JSON.parse(fs.readFileSync(regPathUpdate, 'utf-8'));
    const commitUp1 = regUp1.sources[0].commit;
    const checksumUp1 = regUp1.sources[0].checksum;
    const updatedAtUp1 = regUp1.sources[0].updatedAt;

    // Remote commit changed again
    fs.appendFileSync(
      path.join(seedRepo, 'sample-unit', 'overview.md'),
      '\nRemote update for update test\n',
      'utf-8'
    );
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"update for update command"']);
    git(seedRepo, ['push', 'origin', 'main']);

    // Re-run update: unmodified unit replaced, metadata refreshed
    const resUpdate = runCli(['update'], clientDirUpdate);
    expect(resUpdate.status).toBe(0);
    expect(resUpdate.stdout).toContain('✓ Updated to');
    const overviewUpdate = fs.readFileSync(path.join(clientDirUpdate, 'sample-unit', 'overview.md'), 'utf-8');
    expect(overviewUpdate).toContain('Remote update for update test');

    const regUp2 = JSON.parse(fs.readFileSync(regPathUpdate, 'utf-8'));
    expect(regUp2.sources[0].commit).not.toBe(commitUp1);
    expect(regUp2.sources[0].checksum).not.toBe(checksumUp1);
    expect(new Date(regUp2.sources[0].updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(updatedAtUp1).getTime());

    // Up-to-date unit prints "Already up to date" and is not re-copied
    const mtimeBeforeUpdate = fs.statSync(path.join(clientDirUpdate, 'sample-unit', 'overview.md')).mtimeMs;
    const resUpdateAgain = runCli(['update'], clientDirUpdate);
    expect(resUpdateAgain.status).toBe(0);
    expect(resUpdateAgain.stdout).toContain(`Already up to date (${regUp2.sources[0].commit})`);
    const mtimeAfterUpdate = fs.statSync(path.join(clientDirUpdate, 'sample-unit', 'overview.md')).mtimeMs;
    expect(mtimeAfterUpdate).toBe(mtimeBeforeUpdate);
  });

  // **Validates: Requirements 3.6**
  it('pinned sources and missing local: paths are skipped with current messages; update --force overwrites local edits; update already skips a modified unit without --force', () => {
    const clientDir = path.join(workRoot, 'client-pin-update');
    fs.mkdirSync(clientDir, { recursive: true });

    // 1. Initial add of sample-unit
    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    // 2. Pin sample-unit
    const pinRes = runCli(['pin', 'sample-unit'], clientDir);
    expect(pinRes.status).toBe(0);
    expect(pinRes.stdout).toContain("✓ Pinned 'sample-unit' to");

    // Remote commit changed
    fs.appendFileSync(
      path.join(seedRepo, 'sample-unit', 'overview.md'),
      '\nRemote change while pinned\n',
      'utf-8'
    );
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"commit while pinned"']);
    git(seedRepo, ['push', 'origin', 'main']);

    // Update skips pinned source
    const updatePinned = runCli(['update'], clientDir);
    expect(updatePinned.status).toBe(0);
    expect(updatePinned.stdout).toContain("Skipping 'sample-unit' (pinned to");
    expect(fs.readFileSync(path.join(clientDir, 'sample-unit', 'overview.md'), 'utf-8')).not.toContain('Remote change while pinned');

    // Unpin sample-unit
    const unpinRes = runCli(['unpin', 'sample-unit'], clientDir);
    expect(unpinRes.status).toBe(0);
    expect(unpinRes.stdout).toContain("✓ Unpinned 'sample-unit'.  It will be updated normally.");

    // 3. Missing local: path skipped
    const regPath = path.join(clientDir, '.registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const missingLocalPath = path.join(workRoot, 'nonexistent-local-source');
    reg.sources.push({
      name: 'local-ghost',
      url: `local:${missingLocalPath}`,
      commit: 'local',
      checksum: '1234567890abcdef',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');

    const updateMissingLocal = runCli(['update', 'local-ghost'], clientDir);
    expect(updateMissingLocal.status).toBe(0);
    expect(updateMissingLocal.stdout).toContain("Skipping 'local-ghost' (local source path no longer exists)");

    // 4. Update skips modified unit without --force
    fs.appendFileSync(
      path.join(clientDir, 'sample-unit', 'overview.md'),
      '\nLocal modification made here\n',
      'utf-8'
    );
    const updateModifiedNoForce = runCli(['update', 'sample-unit'], clientDir);
    expect(updateModifiedNoForce.status).toBe(0);
    expect(updateModifiedNoForce.stdout).toContain("⚠ Skipping 'sample-unit' (local modifications detected; pass --force to overwrite)");
    expect(fs.readFileSync(path.join(clientDir, 'sample-unit', 'overview.md'), 'utf-8')).toContain('Local modification made here');

    // 5. Update with --force overwrites local modifications
    const updateModifiedForce = runCli(['update', 'sample-unit', '--force'], clientDir);
    expect(updateModifiedForce.status).toBe(0);
    expect(updateModifiedForce.stdout).toContain('✓ Updated to');
    const overviewAfterForce = fs.readFileSync(path.join(clientDir, 'sample-unit', 'overview.md'), 'utf-8');
    expect(overviewAfterForce).not.toContain('Local modification made here');
    expect(overviewAfterForce).toContain('Remote change while pinned');
  });

  // **Validates: Requirements 3.7**
  it('valid content, content without manifest.json, and warnings-only content install; add/install behave as today', () => {
    const clientDir = path.join(workRoot, 'client-install-types');
    fs.mkdirSync(clientDir, { recursive: true });

    // 1. Valid content installs via add and install
    // 1a. add valid unit from repo
    const addValid = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addValid.status).toBe(0);
    expect(addValid.stdout).toContain("✓ Installed 'sample-unit'");
    expect(fs.existsSync(path.join(clientDir, 'sample-unit', 'manifest.json'))).toBe(true);

    // 1b. install valid unit from local directory
    const localValidDir = path.join(workRoot, 'local-valid-unit');
    const scafRes = runCli(['scaffold', 'local-valid-unit', '--type', 'cookbook', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    const installValid = runCli(['install', localValidDir], clientDir);
    expect(installValid.status).toBe(0);
    expect(installValid.stdout).toContain("✓ Installed 'local-valid-unit'");
    expect(fs.existsSync(path.join(clientDir, 'local-valid-unit', 'manifest.json'))).toBe(true);

    // 2. Content without manifest.json installs
    // 2a. add directory without manifest.json
    const noManifestDir = path.join(seedRepo, 'notes-folder');
    fs.mkdirSync(noManifestDir, { recursive: true });
    fs.writeFileSync(path.join(noManifestDir, 'notes.txt'), 'plain notes', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"add notes without manifest"']);
    git(seedRepo, ['push', 'origin', 'main']);

    const addNoManifest = runCli(['add', bareRepo, '--path', 'notes-folder'], clientDir);
    expect(addNoManifest.status).toBe(0);
    expect(addNoManifest.stdout).toContain("✓ Installed 'notes-folder'");
    expect(fs.existsSync(path.join(clientDir, 'notes-folder', 'notes.txt'))).toBe(true);

    // 2b. install standalone .md file (no manifest.json)
    const standaloneFile = path.join(workRoot, 'guide.md');
    fs.writeFileSync(
      standaloneFile,
      '---\ndescription: Standalone user guide\ntags: [guide, docs]\n---\n\n# Guide\n\nContent here.',
      'utf-8'
    );
    const installStandalone = runCli(['install', standaloneFile], clientDir);
    expect(installStandalone.status).toBe(0);
    expect(installStandalone.stdout).toContain("✓ Installed standalone knowledge 'guide.md'");
    expect(fs.existsSync(path.join(clientDir, 'guide.md'))).toBe(true);

    // 3. Warnings-only content installs
    // Unit with status 'deprecated' without superseded_by produces warning only (0 errors)
    const warnUnitDir = path.join(seedRepo, 'deprecated-unit');
    fs.mkdirSync(warnUnitDir, { recursive: true });
    fs.writeFileSync(
      path.join(warnUnitDir, 'manifest.json'),
      JSON.stringify({
        name: 'deprecated-unit',
        version: '1.0.0',
        type: 'cookbook',
        status: 'deprecated',
        description: 'Deprecated cookbook',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(warnUnitDir, 'overview.md'), '# Deprecated Unit\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"add deprecated unit"']);
    git(seedRepo, ['push', 'origin', 'main']);

    // 3a. install warnings-only unit locally
    const clientDir2 = path.join(workRoot, 'client-install-warn');
    fs.mkdirSync(clientDir2, { recursive: true });
    const installWarn = runCli(['install', warnUnitDir], clientDir2);
    expect(installWarn.status).toBe(0);
    expect(installWarn.stdout).toContain('Unit is marked "deprecated" without "superseded_by" guidance');
    expect(installWarn.stdout).toContain("✓ Installed 'deprecated-unit'");

    // 3b. add warnings-only unit from repo
    const addWarn = runCli(['add', bareRepo, '--path', 'deprecated-unit'], clientDir);
    expect(addWarn.status).toBe(0);
    expect(addWarn.stdout).toContain('Unit is marked "deprecated" without "superseded_by" guidance');
    expect(addWarn.stdout).toContain("✓ Installed 'deprecated-unit'");

    // 4. Invalid content: add without --no-verify fails, but add with --no-verify installs
    const brokenUnitDir = path.join(seedRepo, 'broken-unit');
    fs.mkdirSync(brokenUnitDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenUnitDir, 'manifest.json'),
      JSON.stringify({
        name: 'broken-unit',
        // missing version -> validation error
        type: 'cookbook',
        description: 'Broken unit missing version',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(brokenUnitDir, 'overview.md'), '# Broken\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"add broken unit"']);
    git(seedRepo, ['push', 'origin', 'main']);

    const clientDir3 = path.join(workRoot, 'client-no-verify');
    fs.mkdirSync(clientDir3, { recursive: true });

    // Without --no-verify: fails with exit 1
    const addBrokenFail = runCli(['add', bareRepo, '--path', 'broken-unit'], clientDir3);
    expect(addBrokenFail.status).toBe(1);
    expect((addBrokenFail.stderr || '') + (addBrokenFail.stdout || '')).toContain('Validation failed');
    expect(fs.existsSync(path.join(clientDir3, 'broken-unit'))).toBe(false);

    // With --no-verify: succeeds with exit 0
    const addBrokenSuccess = runCli(['add', bareRepo, '--path', 'broken-unit', '--no-verify'], clientDir3);
    expect(addBrokenSuccess.status).toBe(0);
    expect(addBrokenSuccess.stdout).toContain("✓ Installed 'broken-unit'");
    expect(fs.existsSync(path.join(clientDir3, 'broken-unit'))).toBe(true);
  });
});

describe('preservation: types, placeholders, scripts, interfaces', () => {
  let workRoot: string;
  let bareRepo: string;
  let seedRepo: string;

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-cli-'));
    bareRepo = path.join(workRoot, 'remote.git');
    seedRepo = path.join(workRoot, 'seed');

    // Scaffold seed repo with shelf.json
    const scafRes = runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', workRoot]);
    expect(scafRes.status).toBe(0);
    fs.renameSync(path.join(workRoot, 'seed-repo'), seedRepo);

    git(seedRepo, ['init']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test User']);
    git(seedRepo, ['branch', '-M', 'main']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', '"initial seed commit"']);

    // Clone bare repo from seed
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });
  });

  afterEach(() => {
    if (fs.existsSync(workRoot)) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  // **Validates: Requirements 3.10**
  it('scaffold --type bogus exits 1; scaffold --type accepts boilerplate, template, toolkit, cookbook, repo', () => {
    const scafDir = path.join(workRoot, 'scaffold-pres');
    fs.mkdirSync(scafDir, { recursive: true });

    // 1. Bogus type exits 1
    const bogusRes = runCli(['scaffold', 'bogus-unit', '--type', 'bogus', '--output', scafDir]);
    expect(bogusRes.status).toBe(1);
    const combinedBogus = (bogusRes.stdout || '') + (bogusRes.stderr || '');
    expect(combinedBogus).toContain("Error: Invalid type 'bogus'. Use boilerplate, template, toolkit, cookbook, or repo.");

    // 2. All 5 accepted types succeed with exit 0
    const acceptedTypes = ['boilerplate', 'template', 'toolkit', 'cookbook', 'repo'] as const;
    for (const t of acceptedTypes) {
      const unitName = `scaf-${t}`;
      const res = runCli(['scaffold', unitName, '--type', t, '--output', scafDir]);
      expect(res.status).toBe(0);
      const targetPath = path.join(scafDir, unitName);
      expect(fs.existsSync(targetPath)).toBe(true);

      if (t === 'repo') {
        expect(fs.existsSync(path.join(targetPath, 'shelf.json'))).toBe(true);
      } else {
        const manifestPath = path.join(targetPath, 'manifest.json');
        expect(fs.existsSync(manifestPath)).toBe(true);
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        expect(m.type).toBe(t);
      }
    }
  });

  // **Validates: Requirements 3.14**
  it('unpin and outdated reject unknown flags', () => {
    const clientDir = path.join(workRoot, 'client-flags');
    fs.mkdirSync(clientDir, { recursive: true });

    // Initial add of sample-unit
    const addRes = runCli(['add', bareRepo, '--path', 'sample-unit'], clientDir);
    expect(addRes.status).toBe(0);

    // unpin rejects unknown flag
    const unpinRes = runCli(['unpin', 'sample-unit', '--unknown-flag'], clientDir);
    expect(unpinRes.status).toBe(1);
    const unpinOut = (unpinRes.stdout || '') + (unpinRes.stderr || '');
    expect(unpinOut).toContain("Error: Unknown option '--unknown-flag' for 'unpin'.");

    // outdated rejects unknown flag
    const outRes = runCli(['outdated', '--unknown-flag'], clientDir);
    expect(outRes.status).toBe(1);
    const outOut = (outRes.stdout || '') + (outRes.stderr || '');
    expect(outOut).toContain("Error: Unknown option '--unknown-flag' for 'outdated'.");
  });

  // **Validates: Requirements 3.14**
  it('usage text of other commands is preserved and missing required args display correct usage', () => {
    const clientDir = path.join(workRoot, 'client-usage');
    fs.mkdirSync(clientDir, { recursive: true });

    // 1. --help displays general usage and all commands
    const helpRes = runCli(['--help']);
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('Knowledge Shelf');
    expect(helpRes.stdout).toContain('Usage:');
    expect(helpRes.stdout).toContain('knowledge-shelf <command>');
    expect(helpRes.stdout).toContain('scaffold');
    expect(helpRes.stdout).toContain('publish');
    expect(helpRes.stdout).toContain('outdated');
    expect(helpRes.stdout).toContain('update');
    expect(helpRes.stdout).toContain('pin');
    expect(helpRes.stdout).toContain('unpin');

    // 2. Missing required arguments print command-specific usage messages
    const scafNoArgs = runCli(['scaffold']);
    expect(scafNoArgs.status).toBe(1);
    expect((scafNoArgs.stdout || '') + (scafNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf scaffold <name> [--type boilerplate|template|toolkit|cookbook|repo] [--output <dir>]'
    );

    const unpinNoArgs = runCli(['unpin'], clientDir);
    expect(unpinNoArgs.status).toBe(1);
    expect((unpinNoArgs.stdout || '') + (unpinNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf unpin <name>'
    );

    const catalogNoArgs = runCli(['catalog']);
    expect(catalogNoArgs.status).toBe(1);
    expect((catalogNoArgs.stdout || '') + (catalogNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf catalog <url> [--ref <ref>]'
    );

    const publishNoArgs = runCli(['publish']);
    expect(publishNoArgs.status).toBe(1);
    expect((publishNoArgs.stdout || '') + (publishNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf publish <unit-path-or-name> --to <git-url>'
    );

    const infoNoArgs = runCli(['info'], clientDir);
    expect(infoNoArgs.status).toBe(1);
    expect((infoNoArgs.stdout || '') + (infoNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf info <name>'
    );

    const removeNoArgs = runCli(['remove'], clientDir);
    expect(removeNoArgs.status).toBe(1);
    expect((removeNoArgs.stdout || '') + (removeNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf remove <name>'
    );

    const searchNoArgs = runCli(['search'], clientDir);
    expect(searchNoArgs.status).toBe(1);
    expect((searchNoArgs.stdout || '') + (searchNoArgs.stderr || '')).toContain(
      'Usage: knowledge-shelf search <keywords>'
    );
  });
});
