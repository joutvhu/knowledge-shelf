import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import crypto from 'node:crypto';
import {
  checkUnitPublishHygiene,
  checkFilePublishHygiene,
  validateManifestUnitDir,
  collectStepPlaceholders,
  SENSITIVE_NAME_RE,
  TOKEN_RULES,
  SECRET_ASSIGN_RE,
  isPlaceholderValue,
  hasLiteralSecretAssignment,
} from '../src/core/manifest.js';
import { walkUnitFiles } from '../src/core.js';
import { copyDirSync } from '../src/cli/git.js';
import {
  computeUnitChecksum,
  computeLegacyUnitChecksum,
  hasLocalModifications,
  saveRegistry,
  loadRegistry,
  type Registry,
} from '../src/cli/registry.js';
import {
  buildPublishPushArgs,
  installValidated,
  resolvePublishTarget,
  validateStaged,
} from '../src/cli/commands-git.js';
import { toolRunWorkflow, toolGetModule } from '../src/core/tools.js';
import { executeWorkflowSteps } from '../src/core/workflow.js';
import { DEFAULT_WORKFLOW_TIMEOUT_MS, MAX_WORKFLOW_TIMEOUT_MS } from '../src/core/config.js';

describe('B1: Sensitive files and hidden content detection in copy set', () => {
  it('detects sensitive files at depth > 0, in dot folders, and private keys / home paths in walkDir-skipped entries', () => {
    // Scoped concrete tree from design:
    // config/.secrets
    // sub/.npmrc
    // .env.local
    // .hidden/k.pem (PEM header)
    // node_modules/x/a.txt (home-directory path)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b1-'));
    try {
      // Subdirectories
      fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'node_modules', 'x'), { recursive: true });

      // Files
      fs.writeFileSync(path.join(tempDir, 'config', '.secrets'), 'api_key=placeholder\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'sub', '.npmrc'), '//registry.npmjs.org/:_authToken=dummy\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.env.local'), 'SECRET=placeholder\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.hidden', 'k.pem'),
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'node_modules', 'x', 'a.txt'),
        'path = /home/developer/project\n',
        'utf-8'
      );

      const warnings = checkUnitPublishHygiene(tempDir);

      // Assert warnings contain expected entries with '/' separators even on Windows
      expect(warnings).toContain('Sensitive file found: config/.secrets');
      expect(warnings).toContain('Sensitive file found: sub/.npmrc');
      expect(warnings).toContain('Sensitive file found: .env.local');

      const privateKeyWarning = warnings.find(
        (w) => w.includes('private key') && w.includes('.hidden/k.pem')
      );
      expect(privateKeyWarning).toBeDefined();

      const homePathWarning = warnings.find(
        (w) => w.includes('home directory') && w.includes('node_modules/x/a.txt')
      );
      expect(homePathWarning).toBeDefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('B2: Credentials and secret assignments detection', () => {
  // Positives built at runtime from string parts so the repo contains no real-looking secrets
  const ghpToken = ['ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'].join(''); // 36 alphanumerics
  const patToken = ['github_pat_', '1234567890abcdefghijkl'].join(''); // 22 word characters
  const awsKeyId = ['AKIA', 'IOSFODNN7EXAMPLE'].join(''); // 16 characters [0-9A-Z]
  const slackToken = ['xoxb-', '123456789012-1234567890123-abcdefghijklmnopqrstuvwx'].join('');
  const stripeKey = ['sk_live_', '51AbCdeFgHiJkLmNoPqRsTuVwXyZ'].join('');

  const positiveCases = [
    {
      name: 'GitHub token (ghp_ + 36 alphanumerics)',
      file: 'credentials/github-ghp.txt',
      content: `GITHUB_TOKEN=${ghpToken}\n`,
      expectedKind: 'GitHub token',
      secretValue: ghpToken,
    },
    {
      name: 'GitHub token (github_pat_ + 22 word characters)',
      file: 'credentials/github-pat.txt',
      content: `token: ${patToken}\n`,
      expectedKind: 'GitHub token',
      secretValue: patToken,
    },
    {
      name: 'AWS key id (AKIA + 16 characters)',
      file: 'credentials/aws.txt',
      content: `aws_access_key_id = ${awsKeyId}\n`,
      expectedKind: 'AWS access key id',
      secretValue: awsKeyId,
    },
    {
      name: 'Slack token (xoxb- + token characters)',
      file: 'credentials/slack.txt',
      content: `SLACK_BOT_TOKEN="${slackToken}"\n`,
      expectedKind: 'Slack token',
      secretValue: slackToken,
    },
    {
      name: 'password=hunter2 assignment',
      file: 'config/password.txt',
      content: 'password=hunter2\n',
      expectedKind: 'secret assignment',
      secretValue: 'hunter2',
    },
    {
      name: 'secret: "abc123xyz" assignment',
      file: 'config/secret.yaml',
      content: 'secret: "abc123xyz"\n',
      expectedKind: 'secret assignment',
      secretValue: 'abc123xyz',
    },
    {
      name: 'DB_PASSWORD="abc12345" assignment',
      file: 'config/db.conf',
      content: 'DB_PASSWORD="abc12345"\n',
      expectedKind: 'secret assignment',
      secretValue: 'abc12345',
    },
    {
      name: 'JSON "secret": "abc123xyz" assignment',
      file: 'config/settings.json',
      content: '{\n  "secret": "abc123xyz"\n}\n',
      expectedKind: 'secret assignment',
      secretValue: 'abc123xyz',
    },
    {
      name: 'api_key= + runtime-built sk_live_ value',
      file: 'config/api.txt',
      content: `api_key=${stripeKey}\n`,
      expectedKind: 'secret assignment',
      secretValue: stripeKey,
    },
  ];

  it.each(positiveCases)(
    'detects positive credential or secret assignment: $name',
    ({ file, content, expectedKind, secretValue }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b2-pos-'));
      try {
        const fullPath = path.join(tempDir, ...file.split('/'));
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');

        const warnings = checkUnitPublishHygiene(tempDir);

        // Warning must name the kind (or "secret assignment") and the file path
        const matchingWarning = warnings.find(
          (w) =>
            w.toLowerCase().includes(expectedKind.toLowerCase()) &&
            w.includes(file)
        );

        expect(
          matchingWarning,
          `Expected warning naming ${expectedKind} in '${file}', but received: ${JSON.stringify(warnings)}`
        ).toBeDefined();

        // No warning string may contain the credential value
        for (const w of warnings) {
          expect(w).not.toContain(secretValue);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it('detects all positive credentials and secret assignments when coexisting in a single unit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b2-all-'));
    try {
      for (const pos of positiveCases) {
        const fullPath = path.join(tempDir, ...pos.file.split('/'));
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, pos.content, 'utf-8');
      }

      const warnings = checkUnitPublishHygiene(tempDir);

      for (const pos of positiveCases) {
        const matchingWarning = warnings.find(
          (w) =>
            w.toLowerCase().includes(pos.expectedKind.toLowerCase()) &&
            w.includes(pos.file)
        );
        expect(
          matchingWarning,
          `Expected warning naming ${pos.expectedKind} in '${pos.file}', but got: ${JSON.stringify(warnings)}`
        ).toBeDefined();

        for (const w of warnings) {
          expect(w).not.toContain(pos.secretValue);
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps negative patterns warning-free (placeholders, references, short, empty)', () => {
    const negativeCases = [
      { file: 'config/pw-env-ref.txt', content: 'password=${PW}\n' },
      { file: 'config/pw-mustache.txt', content: 'password: {{PW}}\n' },
      { file: 'config/secret-bracket.txt', content: 'secret=<x>\n' },
      { file: 'config/apikey-percent.txt', content: 'api_key=%KEY%\n' },
      { file: 'config/pw-var.txt', content: 'password=$PW\n' },
      { file: 'config/pw-empty.txt', content: 'password=\n' },
      { file: 'config/pw-short.txt', content: 'password=abc\n' },
    ];

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b2-neg-'));
    try {
      for (const neg of negativeCases) {
        const fullPath = path.join(tempDir, ...neg.file.split('/'));
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, neg.content, 'utf-8');
      }

      // Also a single file combining all negative patterns
      fs.writeFileSync(
        path.join(tempDir, 'config', 'all-negatives.txt'),
        negativeCases.map((n) => n.content).join(''),
        'utf-8'
      );

      const warnings = checkUnitPublishHygiene(tempDir);
      expect(warnings).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Task 19.1 unit tests: hygiene rules, token boundaries, and secret assignment', () => {
  it('sensitive-name matrix: validates SENSITIVE_NAME_RE against case variants, dot folders, and negatives', () => {
    const positives = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.example',
      '.ENV',
      '.env.PROD',
      '.npmrc',
      '.NPMRC',
      '.NpmRc',
      '.netrc',
      '.NETRC',
      '.pypirc',
      '.PYPIRC',
      '.secrets',
      '.secret',
      '.secret.key',
      '.SECRET',
    ];
    for (const name of positives) {
      expect(SENSITIVE_NAME_RE.test(name), `Expected ${name} to match SENSITIVE_NAME_RE`).toBe(true);
    }

    const negatives = [
      'env.txt',
      'npmrc',
      'npmrc.txt',
      'secrets.json',
      '.environment',
      'main.js',
      'README.md',
      '.gitignore',
      '.eslintrc',
    ];
    for (const name of negatives) {
      expect(SENSITIVE_NAME_RE.test(name), `Expected ${name} not to match SENSITIVE_NAME_RE`).toBe(false);
    }
  });

  it('sensitive-name matrix in unit directory: flags nested, dot folders, and case variants with / paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-19-1-matrix-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'nested', 'config'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.hidden', 'sub'), { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'nested', 'config', '.ENV.PROD'), 'FOO=bar\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.hidden', 'sub', '.netrc'), 'machine example.com\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'nested', '.pypirc'), '[pypi]\n', 'utf-8');

      const warnings = checkUnitPublishHygiene(tempDir);
      expect(warnings).toContain('Sensitive file found: nested/config/.ENV.PROD');
      expect(warnings).toContain('Sensitive file found: .hidden/sub/.netrc');
      expect(warnings).toContain('Sensitive file found: nested/.pypirc');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('token regex boundaries: tests boundary conditions for GitHub, AWS, and Slack tokens', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-19-1-tokens-'));
    try {
      // GitHub token boundaries:
      // ghp_ + 35 alphanumerics (negative - too short)
      // ghp_ + 36 alphanumerics (positive)
      const ghpShort = 'ghp_' + 'a'.repeat(35);
      const ghpExact = 'ghp_' + 'a'.repeat(36);
      fs.writeFileSync(path.join(tempDir, 'ghp-short.txt'), `token=${ghpShort}\n`, 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'ghp-exact.txt'), `token=${ghpExact}\n`, 'utf-8');

      // github_pat_ + 21 chars (negative - too short)
      // github_pat_ + 22 chars (positive)
      const patShort = 'github_pat_' + 'a'.repeat(21);
      const patExact = 'github_pat_' + 'a'.repeat(22);
      fs.writeFileSync(path.join(tempDir, 'pat-short.txt'), `token=${patShort}\n`, 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'pat-exact.txt'), `token=${patExact}\n`, 'utf-8');

      // AWS access key id:
      // AKIA + 15 chars (negative)
      // AKIA + 16 chars (positive)
      // AKIA + 17 chars (negative)
      const awsShort = 'AKIA' + 'A'.repeat(15);
      const awsExact = 'AKIA' + 'A'.repeat(16);
      const awsLong = 'AKIA' + 'A'.repeat(17);
      fs.writeFileSync(path.join(tempDir, 'aws-short.txt'), `key=${awsShort}\n`, 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'aws-exact.txt'), `key=${awsExact}\n`, 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'aws-long.txt'), `key=${awsLong}\n`, 'utf-8');

      // Slack token:
      // xoxb- + 9 chars (negative)
      // xoxb- + 10 chars (positive)
      const slackShort = 'xoxb-' + 'a'.repeat(9);
      const slackExact = 'xoxb-' + 'a'.repeat(10);
      fs.writeFileSync(path.join(tempDir, 'slack-short.txt'), `token=${slackShort}\n`, 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'slack-exact.txt'), `token=${slackExact}\n`, 'utf-8');

      const warnings = checkUnitPublishHygiene(tempDir);

      // Positives must warn
      expect(warnings).toContain("Potential GitHub token detected in 'ghp-exact.txt'");
      expect(warnings).toContain("Potential GitHub token detected in 'pat-exact.txt'");
      expect(warnings).toContain("Potential AWS access key id detected in 'aws-exact.txt'");
      expect(warnings).toContain("Potential Slack token detected in 'slack-exact.txt'");

      // Negatives must not trigger token warnings
      expect(warnings.find((w) => w.includes('ghp-short.txt'))).toBeUndefined();
      expect(warnings.find((w) => w.includes('pat-short.txt'))).toBeUndefined();
      expect(warnings.find((w) => w.includes('aws-short.txt'))).toBeUndefined();
      expect(warnings.find((w) => w.includes('aws-long.txt'))).toBeUndefined();
      expect(warnings.find((w) => w.includes('slack-short.txt'))).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('secret-assignment value matrix: tests positive assignments and negative patterns', () => {
    // Positives
    expect(hasLiteralSecretAssignment('password=hunter2')).toBe(true);
    expect(hasLiteralSecretAssignment('secret: "abc123xyz"')).toBe(true);
    expect(hasLiteralSecretAssignment('DB_PASSWORD="abc12345"')).toBe(true);
    expect(hasLiteralSecretAssignment('"secret": "abc123xyz"')).toBe(true);
    expect(hasLiteralSecretAssignment('api_key=sk_live_123456789')).toBe(true);
    expect(hasLiteralSecretAssignment("client_secret = 'supersecret'")).toBe(true);
    expect(hasLiteralSecretAssignment('apiKey: "validValue"')).toBe(true);

    // Negatives
    expect(hasLiteralSecretAssignment('password=${PW}')).toBe(false);
    expect(hasLiteralSecretAssignment('password: {{PW}}')).toBe(false);
    expect(hasLiteralSecretAssignment('secret=<x>')).toBe(false);
    expect(hasLiteralSecretAssignment('api_key=%KEY%')).toBe(false);
    expect(hasLiteralSecretAssignment('password=$PW')).toBe(false);
    expect(hasLiteralSecretAssignment('password=')).toBe(false);
    expect(hasLiteralSecretAssignment('password=abc')).toBe(false);
    expect(hasLiteralSecretAssignment('password="   "')).toBe(false);
    expect(hasLiteralSecretAssignment('password=""')).toBe(false);
    expect(hasLiteralSecretAssignment('password: string')).toBe(false);
    expect(hasLiteralSecretAssignment('secret: boolean')).toBe(false);
    expect(hasLiteralSecretAssignment('api_key: number')).toBe(false);
    expect(hasLiteralSecretAssignment('password: null')).toBe(false);
    expect(hasLiteralSecretAssignment('secret: undefined')).toBe(false);
    expect(hasLiteralSecretAssignment('secret: process.env.JWT_SECRET')).toBe(false);
    expect(hasLiteralSecretAssignment('api_key: import.meta.env.VITE_API_KEY')).toBe(false);
    expect(hasLiteralSecretAssignment('api_key: os.getenv("API_KEY")')).toBe(false);
    expect(hasLiteralSecretAssignment('password: System.getenv("DB_PASS")')).toBe(false);
    expect(hasLiteralSecretAssignment('password: dto.password')).toBe(false);
    expect(hasLiteralSecretAssignment('password: "********"')).toBe(false);
    expect(hasLiteralSecretAssignment('secret: "REDACTED"')).toBe(false);
  });

  it('binary .npmrc is still flagged as sensitive file, but content scanning is skipped', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-19-1-bin-'));
    try {
      // Binary .npmrc containing NUL byte in first 8192 bytes
      const binData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x04]);
      fs.writeFileSync(path.join(tempDir, '.npmrc'), binData);

      const warnings = checkUnitPublishHygiene(tempDir);
      expect(warnings).toContain('Sensitive file found: .npmrc');
      expect(warnings.length).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkFilePublishHygiene checks a standalone file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-19-1-file-'));
    try {
      const cleanPath = path.join(tempDir, 'clean.md');
      fs.writeFileSync(cleanPath, '# Hello World\nJust docs.\n', 'utf-8');
      expect(checkFilePublishHygiene(cleanPath)).toEqual([]);

      const secretPath = path.join(tempDir, 'secret-doc.md');
      fs.writeFileSync(secretPath, '# Docs\npassword=hunter2\n', 'utf-8');
      const secretWarnings = checkFilePublishHygiene(secretPath);
      expect(secretWarnings).toContain("Possible hardcoded secret assignment detected in 'secret-doc.md'");

      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'FOO=bar\n', 'utf-8');
      const envWarnings = checkFilePublishHygiene(envPath);
      expect(envWarnings).toContain('Sensitive file found: .env');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('B5: shaMatches helper', () => {
  it('correctly compares SHAs by prefix and equality', async () => {
    let shaMatches: ((a: string, b: string) => boolean) | undefined;
    try {
      const gitMod = await import('../src/cli/git.js');
      shaMatches = (gitMod as any).shaMatches;
    } catch {
      // module resolution failure
    }

    expect(shaMatches, 'shaMatches should be exported from git module').toBeDefined();
    if (!shaMatches) return;

    const table = [
      { a: '0123456789abcdef0123456789abcdef01234567', b: '0123456', expected: true, desc: 'full vs short prefix' },
      { a: '0123456', b: '0123456789abcdef0123456789abcdef01234567', expected: true, desc: 'short vs full prefix' },
      { a: '0123456', b: '0123456', expected: true, desc: 'exact equal short' },
      { a: '0123456789abcdef0123456789abcdef01234567', b: '0123456789abcdef0123456789abcdef01234567', expected: true, desc: 'exact equal full' },
      { a: '0123456789abcdef0123456789abcdef01234567', b: 'fedcba9876543210fedcba9876543210fedcba98', expected: false, desc: 'different' },
      { a: '', b: '0123456789abcdef0123456789abcdef01234567', expected: false, desc: 'empty a' },
      { a: '0123456789abcdef0123456789abcdef01234567', b: '', expected: false, desc: 'empty b' },
      { a: '', b: '', expected: false, desc: 'both empty' },
      { a: '012345', b: '0123456789abcdef0123456789abcdef01234567', expected: false, desc: '6-character prefix gives false (a)' },
      { a: '0123456789abcdef0123456789abcdef01234567', b: '012345', expected: false, desc: '6-character prefix gives false (b)' },
      { a: '0123456789ABCDEF0123456789ABCDEF01234567', b: '0123456789abcdef0123456789abcdef01234567', expected: true, desc: 'uppercase equal' },
      { a: '0123456789ABCDEF', b: '0123456789abcdef0123456789abcdef01234567', expected: true, desc: 'uppercase prefix' },
    ];

    for (const row of table) {
      expect(
        shaMatches(row.a, row.b),
        `${row.desc}: shaMatches("${row.a}", "${row.b}") should be ${row.expected}`
      ).toBe(row.expected);
    }
  });

  it('is symmetric and reflexive on random hex, and false when either side is under 7 chars and they differ', async () => {
    const gitMod = await import('../src/cli/git.js');
    const shaMatches = gitMod.shaMatches;
    expect(shaMatches).toBeDefined();

    // Reflexive for non-empty hex strings
    for (let len = 1; len <= 40; len++) {
      const hex = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
      expect(shaMatches(hex, hex), `shaMatches("${hex}", "${hex}") should be true`).toBe(true);
    }

    // Symmetric on random hex pairs
    for (let i = 0; i < 50; i++) {
      const lenA = Math.floor(Math.random() * 40) + 1;
      const lenB = Math.floor(Math.random() * 40) + 1;
      const a = crypto.randomBytes(Math.ceil(lenA / 2)).toString('hex').slice(0, lenA);
      const b = crypto.randomBytes(Math.ceil(lenB / 2)).toString('hex').slice(0, lenB);
      expect(shaMatches(a, b)).toBe(shaMatches(b, a));

      // False when either side is under 7 characters and they differ
      if ((a.length < 7 || b.length < 7) && a.toLowerCase() !== b.toLowerCase()) {
        expect(shaMatches(a, b)).toBe(false);
      }
    }
  });
});

describe('B8: Checksum covers the whole copy set', () => {
  it('case 1: modifying .hidden/cfg.json changes computeUnitChecksum', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b8-core-case1-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'overview.md'), '# Overview\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.hidden', 'cfg.json'), '{"key": "value1"}\n', 'utf-8');

      const initial = computeUnitChecksum(tempDir);
      expect(initial).toBeTruthy();

      fs.writeFileSync(path.join(tempDir, '.hidden', 'cfg.json'), '{"key": "value2"}\n', 'utf-8');
      const afterDot = computeUnitChecksum(tempDir);
      expect(afterDot).not.toBe(initial);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('case 2: modifying node_modules/x/a.txt changes computeUnitChecksum', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b8-core-case2-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'overview.md'), '# Overview\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'node_modules', 'x', 'a.txt'), 'version 1.0.0\n', 'utf-8');

      const initial = computeUnitChecksum(tempDir);
      expect(initial).toBeTruthy();

      fs.writeFileSync(path.join(tempDir, 'node_modules', 'x', 'a.txt'), 'version 2.0.0\n', 'utf-8');
      const afterNm = computeUnitChecksum(tempDir);
      expect(afterNm).not.toBe(initial);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('case 3: adding or removing files inside dot folders or node_modules changes computeUnitChecksum', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b8-core-case3-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'overview.md'), '# Overview\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.hidden', 'cfg.json'), '{"key": "value1"}\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'node_modules', 'x', 'a.txt'), 'version 1.0.0\n', 'utf-8');

      const initial = computeUnitChecksum(tempDir);
      expect(initial).toBeTruthy();

      // Adding a file inside .hidden
      const newDotFile = path.join(tempDir, '.hidden', 'extra.json');
      fs.writeFileSync(newDotFile, '{"extra": true}\n', 'utf-8');
      const afterAddDot = computeUnitChecksum(tempDir);
      expect(afterAddDot).not.toBe(initial);
      fs.rmSync(newDotFile);

      // Removing a file inside .hidden
      const existingDotFile = path.join(tempDir, '.hidden', 'cfg.json');
      fs.rmSync(existingDotFile);
      const afterRemoveDot = computeUnitChecksum(tempDir);
      expect(afterRemoveDot).not.toBe(initial);

      // Restore .hidden/cfg.json
      fs.writeFileSync(existingDotFile, '{"key": "value1"}\n', 'utf-8');

      // Adding a file inside node_modules
      const newNmFile = path.join(tempDir, 'node_modules', 'x', 'b.txt');
      fs.writeFileSync(newNmFile, 'module b\n', 'utf-8');
      const afterAddNm = computeUnitChecksum(tempDir);
      expect(afterAddNm).not.toBe(initial);
      fs.rmSync(newNmFile);

      // Removing a file inside node_modules
      const existingNmFile = path.join(tempDir, 'node_modules', 'x', 'a.txt');
      fs.rmSync(existingNmFile);
      const afterRemoveNm = computeUnitChecksum(tempDir);
      expect(afterRemoveNm).not.toBe(initial);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe('B9: Atomic registry writes', () => {
  // **Validates: Requirements 1.14, 2.14**
  it('case 1: writes via dot-prefixed temporary file and renames atomically to .registry.json', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b9-case1-'));
    try {
      const now = new Date().toISOString();
      const reg: Registry = {
        version: '1.0',
        sources: [
          {
            name: 'unit-a',
            url: './units/unit-a',
            commit: 'abc1234',
            installedAt: now,
            updatedAt: now,
          },
        ],
      };

      saveRegistry(tempDir, reg);

      // On unfixed code: renameSync is never called because saveRegistry writes directly to .registry.json
      expect(renameSpy).toHaveBeenCalled();
      const [source, destination] = renameSpy.mock.calls[0];
      expect(path.resolve(String(destination))).toBe(path.resolve(path.join(tempDir, '.registry.json')));
      expect(path.resolve(path.dirname(String(source)))).toBe(path.resolve(tempDir));
      expect(path.basename(String(source))).toMatch(/^\.registry\.json\..+\.tmp$/);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('case 2: throws when target is a directory, leaving target intact and cleaning up temporary files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b9-case2-'));
    try {
      const targetDir = path.join(tempDir, '.registry.json');
      fs.mkdirSync(targetDir);
      const sentinel = path.join(targetDir, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'intact', 'utf-8');

      const reg: Registry = {
        version: '1.0',
        sources: [],
      };

      expect(() => saveRegistry(tempDir, reg)).toThrow();
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.statSync(targetDir).isDirectory()).toBe(true);

      const files = fs.readdirSync(tempDir);
      const tmpFiles = files.filter((f) => /^\.registry\.json\..*\.tmp$/.test(f));
      expect(tmpFiles).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('case 3: normal save leaves no temp file and produces valid parsable registry JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b9-case3-'));
    try {
      const reg: Registry = {
        version: '1.0',
        sources: [
          {
            name: 'unit-a',
            url: './units/unit-a',
            commit: 'abc1234',
            installedAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      };

      saveRegistry(tempDir, reg);

      const targetPath = path.join(tempDir, '.registry.json');
      expect(fs.existsSync(targetPath)).toBe(true);

      const content = fs.readFileSync(targetPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(reg);
      expect(parsed.version).toBe('1.0');
      expect(Array.isArray(parsed.sources)).toBe(true);

      const files = fs.readdirSync(tempDir);
      const tmpFiles = files.filter((f) => /^\.registry\.json\..*\.tmp$/.test(f));
      expect(tmpFiles).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('B10: `type` handling across schema, validator, and server', () => {
  // **Validates: Requirements 1.15, 1.16, 2.15, 2.16**

  it('asserts schemas/manifest-v1.schema.json type has no enum and has minLength: 1', () => {
    const schemaPath = path.resolve(__dirname, '../schemas/manifest-v1.schema.json');
    const raw = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(raw);
    const typeProp = schema.properties?.type;

    expect(typeProp).toBeDefined();
    expect(typeProp.type).toBe('string');
    expect(typeProp.minLength).toBe(1);
    expect(typeProp.enum).toBeUndefined();
  });

  it('asserts validateManifestUnitDir accepts playbook and rejects "", "  ", 5, and missing type', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b10-val-'));
    try {
      const manifestPath = path.join(tempDir, 'manifest.json');

      const makeManifest = (typeVal?: any) => {
        const m: any = {
          name: path.basename(tempDir),
          version: '1.0.0',
          description: 'A test unit for B10',
        };
        if (typeVal !== undefined) {
          m.type = typeVal;
        }
        return m;
      };

      // 1. Accepts 'playbook'
      fs.writeFileSync(manifestPath, JSON.stringify(makeManifest('playbook'), null, 2), 'utf-8');
      const resPlaybook = validateManifestUnitDir(tempDir);
      expect(resPlaybook.errors).toEqual([]);

      // 2. Rejects missing type
      fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(), null, 2), 'utf-8');
      const resMissing = validateManifestUnitDir(tempDir);
      expect(resMissing.errors.some((e) => e.includes('type'))).toBe(true);
      expect(resMissing.errors).toContain('Missing required field: type');

      // 3. Rejects empty string ''
      fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(''), null, 2), 'utf-8');
      const resEmpty = validateManifestUnitDir(tempDir);
      expect(resEmpty.errors.some((e) => e.includes('type'))).toBe(true);

      // 4. Rejects whitespace string '  '
      fs.writeFileSync(manifestPath, JSON.stringify(makeManifest('   '), null, 2), 'utf-8');
      const resWhitespace = validateManifestUnitDir(tempDir);
      expect(resWhitespace.errors.some((e) => e.includes('type'))).toBe(true);
      expect(resWhitespace.errors).toContain('Field "type" must be a non-empty string');

      // 5. Rejects non-string number 5
      fs.writeFileSync(manifestPath, JSON.stringify(makeManifest(5), null, 2), 'utf-8');
      const resNumber = validateManifestUnitDir(tempDir);
      expect(resNumber.errors.some((e) => e.includes('type'))).toBe(true);
      expect(resNumber.errors).toContain('Field "type" must be a non-empty string');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('asserts in-memory MCP client calling search_docs with type: playbook returns the unit and type: "" is rejected', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b10-server-'));
    try {
      // Create a unit with type: "playbook"
      const unitDir = path.join(tempDir, 'incident-playbook');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify(
          {
            name: 'incident-playbook',
            version: '1.0.0',
            type: 'playbook',
            description: 'Incident response playbook unit',
          },
          null,
          2
        ),
        'utf-8'
      );
      fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Incident Playbook\nHandling incidents.\n', 'utf-8');

      const { createKnowledgeServer } = await import('../src/server.js');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

      const server = createKnowledgeServer(tempDir);
      const client = new Client({ name: 'test-b10-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      try {
        // 1. search_docs { query: 'incident', type: 'playbook' } should succeed and return matching unit
        const resPlaybook = await client.callTool({
          name: 'search_docs',
          arguments: {
            query: 'incident',
            type: 'playbook',
          },
        });
        expect((resPlaybook as any).isError).toBeFalsy();
        const contentText = ((resPlaybook.content as any[])?.[0]?.text) ?? '';
        expect(contentText).toContain('incident-playbook');

        // 2. search_docs { query: 'incident', type: '' } should be rejected
        let emptyTypeFailed = false;
        try {
          const resEmpty = await client.callTool({
            name: 'search_docs',
            arguments: {
              query: 'incident',
              type: '',
            },
          });
          if ((resEmpty as any).isError) {
            emptyTypeFailed = true;
          }
        } catch {
          emptyTypeFailed = true;
        }
        expect(emptyTypeFailed).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('B11: Manifest placeholders are enforced for used placeholders', () => {
  // **Validates: Requirements 1.17, 1.18, 2.17, 2.18**

  let tempDir: string;
  let unitDir: string;
  let workflowsDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b11-'));
    unitDir = path.join(tempDir, 'unit-b11');
    workflowsDir = path.join(unitDir, 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    // Temp unit with manifest.placeholders:
    // NAME={default: "x"}, TOKEN={required: true}, CODE={pattern: "^[A-Z]{3}$"}
    // Plus UNUSED_REQ={required: true}, FLAG={required: true}, BAD_RE={pattern: "[a-z("}
    const manifest = {
      name: 'unit-b11',
      version: '1.0.0',
      description: 'Unit for testing manifest placeholder enforcement (B11)',
      placeholders: {
        NAME: { default: 'x' },
        TOKEN: { required: true },
        CODE: { pattern: '^[A-Z]{3}$' },
        UNUSED_REQ: { required: true },
        FLAG: { required: true },
        BAD_RE: { pattern: '[a-z(' },
      },
    };
    fs.writeFileSync(path.join(unitDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Workflow 1: default-test - uses {{NAME}}, no inputs
    fs.writeFileSync(
      path.join(workflowsDir, 'default-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              action: 'message',
              text: 'Greeting: Hello {{NAME}}',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 2: required-test - uses {{TOKEN}}, no inputs
    fs.writeFileSync(
      path.join(workflowsDir, 'required-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              action: 'message',
              text: 'Token is {{TOKEN}}',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 3: pattern-test - uses {{CODE}}, no inputs
    fs.writeFileSync(
      path.join(workflowsDir, 'pattern-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              action: 'message',
              text: 'Code is {{CODE}}',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 4: unused-test - does not reference UNUSED_REQ
    fs.writeFileSync(
      path.join(workflowsDir, 'unused-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              action: 'message',
              text: 'Workflow without unused placeholder',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 5: precedence-test - declares workflow.inputs.NAME overriding manifest.placeholders.NAME
    fs.writeFileSync(
      path.join(workflowsDir, 'precedence-test.json'),
      JSON.stringify(
        {
          inputs: {
            NAME: {
              default: 'workflow_override',
            },
          },
          steps: [
            {
              action: 'message',
              text: 'Greeting: Hello {{NAME}}',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 6: when-input-test - references FLAG in when.input
    fs.writeFileSync(
      path.join(workflowsDir, 'when-input-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              when: {
                input: 'FLAG',
                equals: 'true',
              },
              action: 'message',
              text: 'Flag was true',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    // Workflow 7: invalid-regex-test - uses BAD_RE with invalid regex syntax
    fs.writeFileSync(
      path.join(workflowsDir, 'invalid-regex-test.json'),
      JSON.stringify(
        {
          steps: [
            {
              action: 'message',
              text: 'Value is {{BAD_RE}}',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('default: NAME defaults to "x" in the step execution message', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'default-test', {}, { dryRun: true });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.text);
    expect(data.messages).toBeDefined();
    expect(data.messages).toContain('Greeting: Hello x');
  });

  it('required: missing TOKEN gives error Missing required inputs: ["TOKEN"] with isError: true', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'required-test', {}, { dryRun: true });
    expect(res.isError).toBe(true);
    const data = JSON.parse(res.text);
    expect(data.error).toBe('Missing required inputs: ["TOKEN"]');
  });

  it('pattern: CODE=ab1 gives isError: true naming CODE and pattern in dryRun, without rejected value in error text', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'pattern-test', { CODE: 'ab1' }, { dryRun: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('CODE');
    expect(res.text).toContain('^[A-Z]{3}$');
    expect(res.text).not.toContain('ab1');
  });

  it('unused required placeholder in manifest.placeholders does not block a workflow that does not reference it', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'unused-test', {}, { dryRun: true });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.text);
    expect(data.messages).toContain('Workflow without unused placeholder');
  });

  it('precedence: workflow.inputs.NAME wins over manifest.placeholders.NAME', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'precedence-test', {}, { dryRun: true });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.text);
    expect(data.messages).toContain('Greeting: Hello workflow_override');
    expect(data.messages).not.toContain('Greeting: Hello x');
  });

  it('when.input counts as used: missing FLAG required placeholder produces error', async () => {
    const res = await toolRunWorkflow(tempDir, 'unit-b11', 'when-input-test', {}, { dryRun: true });
    expect(res.isError).toBe(true);
    const data = JSON.parse(res.text);
    expect(data.error).toBe('Missing required inputs: ["FLAG"]');
  });

  it('invalid regex string in pattern gives an error with isError: true naming placeholder and pattern', async () => {
    const res = await toolRunWorkflow(
      tempDir,
      'unit-b11',
      'invalid-regex-test',
      { BAD_RE: 'some-value' },
      { dryRun: true }
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain('BAD_RE');
    expect(res.text).toContain('[a-z(');
  });

  it('collectStepPlaceholders collects all inspected fields and validateManifestUnitDir warns for undeclared placeholders', () => {
    const stepWithAllFields: Record<string, unknown> = {
      action: 'patch',
      when: {
        exists: '{{WHEN_EXISTS}}/file.txt',
        not_exists: '{{WHEN_NOT_EXISTS}}/file.txt',
      },
      target: '{{TARGET}}/file.txt',
      content: 'Hello {{CONTENT_PH}}',
    };
    const out = new Set<string>();
    collectStepPlaceholders(stepWithAllFields, out);
    expect([...out].sort()).toEqual(['CONTENT_PH', 'TARGET', 'WHEN_EXISTS', 'WHEN_NOT_EXISTS']);

    const copyStep: Record<string, unknown> = { action: 'copy', target: '{{COPY_TARGET}}/dest.txt' };
    collectStepPlaceholders(copyStep, out);
    expect(out.has('COPY_TARGET')).toBe(true);

    const mkdirStep: Record<string, unknown> = { action: 'mkdir', path: '{{MKDIR_PATH}}/dir' };
    collectStepPlaceholders(mkdirStep, out);
    expect(out.has('MKDIR_PATH')).toBe(true);

    const runStep: Record<string, unknown> = { action: 'run', cwd: '{{RUN_CWD}}', args: ['--opt', '{{RUN_ARG}}'] };
    collectStepPlaceholders(runStep, out);
    expect(out.has('RUN_CWD')).toBe(true);
    expect(out.has('RUN_ARG')).toBe(true);

    const msgStep: Record<string, unknown> = { action: 'message', text: 'Msg {{MSG_TEXT}}' };
    collectStepPlaceholders(msgStep, out);
    expect(out.has('MSG_TEXT')).toBe(true);

    // Verify validateManifestUnitDir generates warnings for undeclared placeholders in workflow steps
    const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b11-warnings-'));
    try {
      const sampleWfDir = path.join(sampleDir, 'workflows');
      fs.mkdirSync(sampleWfDir, { recursive: true });
      fs.writeFileSync(
        path.join(sampleDir, 'manifest.json'),
        JSON.stringify(
          {
            name: path.basename(sampleDir),
            version: '1.0.0',
            description: 'Test warnings',
            type: 'toolkit',
            placeholders: {
              DECLARED_KEY: { default: 'val' },
            },
            workflows: {
              sample: {},
            },
          },
          null,
          2
        ),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(sampleWfDir, 'sample.json'),
        JSON.stringify(
          {
            steps: [
              { action: 'message', text: 'Hello {{DECLARED_KEY}} and {{UNKNOWN_KEY}}' },
            ],
          },
          null,
          2
        ),
        'utf-8'
      );
      const valRes = validateManifestUnitDir(sampleDir);
      expect(valRes.warnings.some((w) => w.includes('UNKNOWN_KEY'))).toBe(true);
      expect(valRes.warnings.some((w) => w.includes('DECLARED_KEY'))).toBe(false);
    } finally {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    }
  });
});

describe('B12: scripts.*.args shape is validated', () => {
  // **Validates: Requirements 1.19, 2.19**

  const invalidCases = [
    {
      name: 'args as array',
      args: [],
      expectedField: 'scripts.test-script.args',
    },
    {
      name: 'args as string',
      args: 'foo',
      expectedField: 'scripts.test-script.args',
    },
    {
      name: 'entry as string',
      args: { '--flag': 'value' },
      expectedField: 'scripts.test-script.args.--flag',
    },
    {
      name: 'required is string ("yes")',
      args: { '--flag': { required: 'yes' } },
      expectedField: 'scripts.test-script.args.--flag.required',
    },
    {
      name: 'type is number (5)',
      args: { '--flag': { type: 5 } },
      expectedField: 'scripts.test-script.args.--flag.type',
    },
    {
      name: 'description is number (1)',
      args: { '--flag': { description: 1 } },
      expectedField: 'scripts.test-script.args.--flag.description',
    },
  ];

  for (const tc of invalidCases) {
    it(`rejects invalid args shape: ${tc.name}`, () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b12-inv-'));
      try {
        fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

        const manifest = {
          name: path.basename(tempDir),
          version: '1.0.0',
          type: 'cookbook',
          description: 'A test unit for B12',
          scripts: {
            'test-script': {
              file: 'scripts/run.sh',
              args: tc.args,
            },
          },
        };
        fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

        const result = validateManifestUnitDir(tempDir);
        const hasMatchingError = result.errors.some((err) => err.includes(tc.expectedField) || err.includes('scripts.test-script.args'));
        expect(hasMatchingError, `Expected error naming ${tc.expectedField}, got errors: ${JSON.stringify(result.errors)}`).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  const validCases = [
    {
      name: 'args is empty object ({})',
      args: {},
    },
    {
      name: 'valid entries with boolean required, string type, string description, default',
      args: {
        '--flag': {
          required: true,
          type: 'string',
          description: 'A test flag',
          default: 'opt',
        },
        '--count': {
          required: false,
          type: 'number',
          description: 'A count',
          default: 10,
        },
      },
    },
  ];

  for (const tc of validCases) {
    it(`accepts valid args shape: ${tc.name}`, () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b12-val-'));
      try {
        fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

        const manifest = {
          name: path.basename(tempDir),
          version: '1.0.0',
          type: 'cookbook',
          description: 'A test unit for B12',
          scripts: {
            'test-script': {
              file: 'scripts/run.sh',
              args: tc.args,
            },
          },
        };
        fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

        const result = validateManifestUnitDir(tempDir);
        expect(result.errors).toEqual([]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

describe('B13: timeout_ms range is an integer in 1000..600000', () => {
  // **Validates: Requirements 1.20, 2.20**

  const invalidValues: Array<{ label: string; val: any }> = [
    { label: '0', val: 0 },
    { label: '500', val: 500 },
    { label: '999', val: 999 },
    { label: '1500.5', val: 1500.5 },
    { label: '600001', val: 600001 },
    { label: "'1000' (string)", val: '1000' },
    { label: 'null', val: null },
  ];

  const validValues: Array<{ label: string; val: any }> = [
    { label: '1000', val: 1000 },
    { label: '120000', val: 120000 },
    { label: '600000', val: 600000 },
    { label: 'omitted', val: undefined },
  ];

  describe('scripts.<name>.timeout_ms', () => {
    for (const { label, val } of invalidValues) {
      it(`rejects invalid timeout_ms: ${label}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b13-script-inv-'));
        try {
          fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

          const manifest: any = {
            name: path.basename(tempDir),
            version: '1.0.0',
            type: 'cookbook',
            description: 'A test unit for B13',
            scripts: {
              'test-script': {
                file: 'scripts/run.sh',
                timeout_ms: val,
              },
            },
          };
          fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

          const result = validateManifestUnitDir(tempDir);
          const hasError = result.errors.some((err) => err.includes('between 1000 and 600000'));
          expect(
            hasError,
            `Expected error containing "between 1000 and 600000", got errors: ${JSON.stringify(result.errors)}`
          ).toBe(true);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }

    for (const { label, val } of validValues) {
      it(`accepts valid timeout_ms: ${label}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b13-script-val-'));
        try {
          fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

          const scriptEntry: any = {
            file: 'scripts/run.sh',
          };
          if (val !== undefined) {
            scriptEntry.timeout_ms = val;
          }

          const manifest = {
            name: path.basename(tempDir),
            version: '1.0.0',
            type: 'cookbook',
            description: 'A test unit for B13',
            scripts: {
              'test-script': scriptEntry,
            },
          };
          fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

          const result = validateManifestUnitDir(tempDir);
          expect(result.errors).toEqual([]);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }
  });

  describe('workflow run step timeout_ms', () => {
    for (const { label, val } of invalidValues) {
      it(`rejects invalid workflow step timeout_ms: ${label}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b13-wf-inv-'));
        try {
          fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
          fs.mkdirSync(path.join(tempDir, 'workflows'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

          const manifest = {
            name: path.basename(tempDir),
            version: '1.0.0',
            type: 'cookbook',
            description: 'A test unit for B13',
            workflows: {
              'test-wf': {},
            },
          };
          fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

          const workflowDef = {
            name: 'Test Workflow',
            steps: [
              {
                action: 'run',
                script: 'scripts/run.sh',
                timeout_ms: val,
              },
            ],
          };
          fs.writeFileSync(
            path.join(tempDir, 'workflows', 'test-wf.json'),
            JSON.stringify(workflowDef, null, 2),
            'utf-8'
          );

          const result = validateManifestUnitDir(tempDir);
          const hasError = result.errors.some((err) => err.includes('between 1000 and 600000'));
          expect(
            hasError,
            `Expected error containing "between 1000 and 600000", got errors: ${JSON.stringify(result.errors)}`
          ).toBe(true);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }

    for (const { label, val } of validValues) {
      it(`accepts valid workflow step timeout_ms: ${label}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b13-wf-val-'));
        try {
          fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
          fs.mkdirSync(path.join(tempDir, 'workflows'), { recursive: true });
          fs.writeFileSync(path.join(tempDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf-8');

          const manifest = {
            name: path.basename(tempDir),
            version: '1.0.0',
            type: 'cookbook',
            description: 'A test unit for B13',
            workflows: {
              'test-wf': {},
            },
          };
          fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

          const step: any = {
            action: 'run',
            script: 'scripts/run.sh',
          };
          if (val !== undefined) {
            step.timeout_ms = val;
          }

          const workflowDef = {
            name: 'Test Workflow',
            steps: [step],
          };
          fs.writeFileSync(
            path.join(tempDir, 'workflows', 'test-wf.json'),
            JSON.stringify(workflowDef, null, 2),
            'utf-8'
          );

          const result = validateManifestUnitDir(tempDir);
          expect(result.errors).toEqual([]);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }
  });
});

describe('preservation: hygiene and publish', () => {
  // **Validates: Requirements 3.1**
  it('checkUnitPublishHygiene on sample-knowledge/my-unit returns []', () => {
    const fixturePath = path.resolve('tests/fixtures/sample-knowledge/my-unit');
    const warnings = checkUnitPublishHygiene(fixturePath);
    expect(warnings).toEqual([]);
  });

  it('PEM key and home-path samples at unit root and in regular folders return today warning text', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-hyg-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });

      // Root samples
      fs.writeFileSync(
        path.join(tempDir, 'root.pem'),
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'root-path.txt'),
        'config_dir = /home/developer/configs\n',
        'utf-8'
      );

      // Subfolder samples (regular folder visited by walkDir)
      fs.writeFileSync(
        path.join(tempDir, 'sub', 'nested.pem'),
        '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI...\n-----END EC PRIVATE KEY-----\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'sub', 'nested-path.txt'),
        'user_data = /Users/developer/data\n',
        'utf-8'
      );

      const warnings = checkUnitPublishHygiene(tempDir);

      // Assert today's warning text
      expect(warnings).toContain("Potential private key detected in 'root.pem'");
      expect(warnings).toContain("Hardcoded local home directory path detected in 'root-path.txt'");
      expect(warnings).toContain("Potential private key detected in 'sub/nested.pem'");
      expect(warnings).toContain("Hardcoded local home directory path detected in 'sub/nested-path.txt'");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('seeded property-style tests: random clean text lines never generate warnings', () => {
    // Seeded pseudo-random generator (LCG)
    let seed = 123456789;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    const words = [
      'apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'honeydew',
      'function', 'variable', 'return', 'interface', 'class', 'method', 'component',
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'omega',
      'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
      'database', 'network', 'protocol', 'payload', 'request', 'response', 'status',
      'document', 'section', 'article', 'heading', 'paragraph', 'table', 'listing'
    ];

    function randomCleanLine(): string {
      const lineWords: string[] = [];
      const numWords = 3 + Math.floor(rand() * 8);
      for (let i = 0; i < numWords; i++) {
        const idx = Math.floor(rand() * words.length);
        lineWords.push(words[idx]);
        if (rand() > 0.6) {
          lineWords.push(String(Math.floor(rand() * 10000)));
        }
      }
      return lineWords.join(' ');
    }

    function randomCleanJson(): string {
      const obj: Record<string, any> = {};
      const numKeys = 2 + Math.floor(rand() * 5);
      for (let i = 0; i < numKeys; i++) {
        const k = words[Math.floor(rand() * words.length)] + '_' + i;
        const vType = Math.floor(rand() * 4);
        if (vType === 0) obj[k] = Math.floor(rand() * 1000);
        else if (vType === 1) obj[k] = rand() > 0.5;
        else if (vType === 2) obj[k] = words[Math.floor(rand() * words.length)];
        else obj[k] = [words[Math.floor(rand() * words.length)], Math.floor(rand() * 100)];
      }
      return JSON.stringify(obj, null, 2);
    }

    // Run 25 iterations of seeded random clean units
    for (let iter = 0; iter < 25; iter++) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ks-pres-clean-${iter}-`));
      try {
        fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });

        // Random text file
        const textLines = Array.from({ length: 15 }, () => randomCleanLine());
        fs.writeFileSync(path.join(tempDir, 'docs', 'readme.txt'), textLines.join('\n'), 'utf-8');

        // Random json file without trigger names
        fs.writeFileSync(path.join(tempDir, 'data', 'clean.json'), randomCleanJson(), 'utf-8');

        // Clean source code file
        fs.writeFileSync(
          path.join(tempDir, 'main.js'),
          'function calculateSum(a, b) {\n  return a + b;\n}\nmodule.exports = { calculateSum };\n',
          'utf-8'
        );

        const warnings = checkUnitPublishHygiene(tempDir);
        expect(warnings).toEqual([]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});

describe('preservation: checksum and registry', () => {
  // **Validates: Requirements 3.8, 3.9**

  it('a single file checksum equals sha256(name + "\\0" + content) truncated to 16 hex characters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-single-file-'));
    try {
      const testCases = [
        { name: 'hello.txt', content: 'Hello, world!\n' },
        { name: 'config.json', content: '{"active": true, "version": 1}\n' },
        { name: 'empty.md', content: '' },
        { name: 'unicode.txt', content: 'Tiếng Việt & emoji 🚀\n' },
      ];

      for (const tc of testCases) {
        const filePath = path.join(tempDir, tc.name);
        fs.writeFileSync(filePath, tc.content, 'utf-8');

        // Independent calculation: sha256(name + '\0' + content) truncated to 16 hex
        const independentHash = crypto
          .createHash('sha256')
          .update(tc.name)
          .update('\0')
          .update(Buffer.from(tc.content, 'utf-8'))
          .digest('hex')
          .slice(0, 16);

        const actualChecksum = computeUnitChecksum(filePath);
        expect(actualChecksum).toBe(independentHash);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('seeded random trees without dot or node_modules entries produce identical golden checksums', () => {
    // Golden checksum values recorded from seeded trees on unfixed code
    const GOLDEN_CHECKSUMS = [
      'cfe5ca2dc3a35888',
      'da4bf5c0049d844b',
      'df5c3d1610ec29ff',
      '7ac182a0d16896ab',
      'd0342a20a12bdfab',
    ];

    const words = ['alpha', 'beta', 'gamma', 'delta', 'docs', 'src', 'utils', 'guide', 'readme', 'index'];

    for (let i = 0; i < GOLDEN_CHECKSUMS.length; i++) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ks-pres-seed-assert-${i}-`));
      try {
        fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, 'manifest.json'),
          JSON.stringify({ name: `unit-${i}`, version: '1.0.0' }),
          'utf-8'
        );
        fs.writeFileSync(
          path.join(tempDir, 'docs', 'readme.md'),
          `# Docs for unit ${i}\n` + words.slice(0, 3 + i).join(' ') + '\n',
          'utf-8'
        );
        fs.writeFileSync(
          path.join(tempDir, 'src', 'index.js'),
          `console.log("hello from unit ${i}");\n`,
          'utf-8'
        );

        const cs = computeUnitChecksum(tempDir);
        expect(cs).toBe(GOLDEN_CHECKSUMS[i]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('saveRegistry writes exactly JSON.stringify(registry, null, 2) in UTF-8; garbage .registry.json makes loadRegistry exit 1', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-reg-'));
    try {
      const registry: Registry = {
        version: '1.0',
        sources: [
          {
            name: 'unit-alpha',
            url: 'https://github.com/example/unit-alpha.git',
            path: 'units/alpha',
            branch: 'main',
            commit: 'a1b2c3d',
            installedAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-02T00:00:00.000Z',
            checksum: '1234567890abcdef',
          },
        ],
      };

      saveRegistry(tempDir, registry);

      const registryPath = path.join(tempDir, '.registry.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const fileContent = fs.readFileSync(registryPath, 'utf-8');
      const expectedContent = JSON.stringify(registry, null, 2);
      expect(fileContent).toBe(expectedContent);

      // Verify loadRegistry reads it back correctly
      const loaded = loadRegistry(tempDir);
      expect(loaded).toEqual(registry);

      // Verify garbage .registry.json causes loadRegistry to exit 1
      fs.writeFileSync(registryPath, '{ this is not valid JSON !!!', 'utf-8');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit(1) called');
      }) as any);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => loadRegistry(tempDir)).toThrow('process.exit(1) called');
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        exitSpy.mockRestore();
        errSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('legacy-style stored checksum of an untouched install without dot-prefixed files reads as unmodified', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-untouched-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), '{"name":"untouched","version":"1.0.0"}', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'overview.md'), '# Overview\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'sub', 'doc.md'), '# Doc\n', 'utf-8');

      // The unit has no dot-prefixed or node_modules files.
      // Its checksum under computeUnitChecksum represents the legacy-style stored checksum.
      const legacyChecksum = computeUnitChecksum(tempDir);
      expect(legacyChecksum).toBeTruthy();

      // Check current checksum matches stored legacy checksum
      const currentChecksum = computeUnitChecksum(tempDir);
      expect(currentChecksum).toBe(legacyChecksum);

      // If hasLocalModifications is available (post-fix), verify it returns false for untouched
      let hasLocalModifications: ((dir: string, stored?: string) => boolean) | undefined;
      try {
        const regMod = await import('../src/cli/registry.js');
        hasLocalModifications = (regMod as any).hasLocalModifications;
      } catch {}

      if (typeof hasLocalModifications === 'function') {
        expect(hasLocalModifications(tempDir, legacyChecksum)).toBe(false);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('preservation: types, placeholders, scripts, interfaces', () => {
  // **Validates: Requirements 3.10, 3.11, 3.12, 3.13, 3.14**

  it('the four documented types validate (boilerplate, template, toolkit, cookbook); a missing type fails', () => {
    const documentedTypes = ['boilerplate', 'template', 'toolkit', 'cookbook'];
    for (const type of documentedTypes) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ks-pres-type-${type}-`));
      try {
        fs.writeFileSync(
          path.join(tempDir, 'manifest.json'),
          JSON.stringify({
            name: path.basename(tempDir),
            version: '1.0.0',
            type,
            description: `A unit of type ${type}`,
          }),
          'utf-8'
        );
        const res = validateManifestUnitDir(tempDir);
        expect(res.errors).toEqual([]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    // Missing type fails
    const tempDirMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-missing-type-'));
    try {
      fs.writeFileSync(
        path.join(tempDirMissing, 'manifest.json'),
        JSON.stringify({
          name: path.basename(tempDirMissing),
          version: '1.0.0',
          description: 'A unit with missing type',
        }),
        'utf-8'
      );
      const res = validateManifestUnitDir(tempDirMissing);
      expect(res.errors).toContain('Missing required field: type');
    } finally {
      fs.rmSync(tempDirMissing, { recursive: true, force: true });
    }
  });

  it('search_docs with each of boilerplate|template|toolkit|cookbook|standalone works without zod schema errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-search-types-'));
    try {
      const types = ['boilerplate', 'template', 'toolkit', 'cookbook'] as const;
      for (const t of types) {
        const uDir = path.join(tempDir, `unit-${t}`);
        fs.mkdirSync(uDir, { recursive: true });
        fs.writeFileSync(
          path.join(uDir, 'manifest.json'),
          JSON.stringify({
            name: `unit-${t}`,
            version: '1.0.0',
            type: t,
            tags: ['common-topic'],
            doc: 'overview.md',
            description: `Searchable unit with type ${t}`,
          }),
          'utf-8'
        );
        fs.writeFileSync(path.join(uDir, 'overview.md'), `# Unit ${t}\nSearchable unique content for ${t}.\n`, 'utf-8');
      }

      // Standalone markdown
      fs.writeFileSync(
        path.join(tempDir, 'solo-doc.md'),
        '---\ndescription: Standalone document\ntags: [common-topic]\n---\n# Solo Doc\nSearchable unique content for standalone.\n',
        'utf-8'
      );

      const { createKnowledgeServer } = await import('../src/server.js');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

      const server = createKnowledgeServer(tempDir);
      const client = new Client({ name: 'test-search-pres', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      try {
        const allTypes = ['boilerplate', 'template', 'toolkit', 'cookbook', 'standalone'] as const;
        for (const t of allTypes) {
          const res = await client.callTool({
            name: 'search_docs',
            arguments: {
              query: 'common-topic',
              type: t,
            },
          });
          expect((res as any).isError).toBeFalsy();
          const contentText = ((res.content as any[])?.[0]?.text) ?? '';
          const parsed = JSON.parse(contentText);
          expect(parsed.total).toBeGreaterThanOrEqual(1);
          if (t === 'standalone') {
            expect(contentText).toContain('solo-doc.md');
          } else {
            expect(contentText).toContain(`unit-${t}`);
          }
        }
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('workflow inputs defaults, error shape, precedence, template-only enforcement, and get_module placeholders', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-wf-'));
    try {
      const unitDir = path.join(tempDir, 'wf-unit');
      const workflowsDir = path.join(unitDir, 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });

      const manifest = {
        name: 'wf-unit',
        version: '1.0.0',
        type: 'cookbook',
        description: 'Workflow inputs baseline unit',
        modules: {
          core: {
            description: 'Core module',
            files: ['core.js'],
          },
        },
        placeholders: {
          PRE_KEY: { default: 'manifest-default' },
          API_KEY: { description: 'API Key documentation', example: 'secret123' },
        },
      };
      fs.writeFileSync(path.join(unitDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      fs.writeFileSync(path.join(unitDir, 'core.js'), '// core module\n', 'utf-8');

      // 1. Workflow with defaults in workflow.inputs
      const defaultWf = {
        name: 'Default Workflow',
        inputs: {
          GREET: { default: 'Hello' },
          WHO: { default: 'World' },
        },
        steps: [
          { action: 'message', text: '{{GREET}} {{WHO}}!' },
        ],
      };
      fs.writeFileSync(path.join(workflowsDir, 'default-wf.json'), JSON.stringify(defaultWf, null, 2), 'utf-8');

      const resDefault = await toolRunWorkflow(tempDir, 'wf-unit', 'default-wf', {}, { dryRun: true });
      expect(resDefault.isError).toBeFalsy();
      const dataDefault = JSON.parse(resDefault.text);
      expect(dataDefault.messages).toContain('Hello World!');

      // 2. Workflow with required input in workflow.inputs -> missing required error shape
      const reqWf = {
        name: 'Required Workflow',
        inputs: {
          REQ_INP: { required: true, description: 'Mandatory input' },
        },
        steps: [
          { action: 'message', text: 'Value is {{REQ_INP}}' },
        ],
      };
      fs.writeFileSync(path.join(workflowsDir, 'req-wf.json'), JSON.stringify(reqWf, null, 2), 'utf-8');

      const resReq = await toolRunWorkflow(tempDir, 'wf-unit', 'req-wf', {}, { dryRun: true });
      expect(resReq.isError).toBe(true);
      const dataReq = JSON.parse(resReq.text);
      expect(dataReq.error).toBe('Missing required inputs: ["REQ_INP"]');
      expect(dataReq.workflow_inputs).toEqual(reqWf.inputs);

      // 3. Precedence: workflow.inputs wins over manifest.placeholders
      const precWf = {
        name: 'Precedence Workflow',
        inputs: {
          PRE_KEY: { default: 'workflow-override' },
        },
        steps: [
          { action: 'message', text: 'Val: {{PRE_KEY}}' },
        ],
      };
      fs.writeFileSync(path.join(workflowsDir, 'prec-wf.json'), JSON.stringify(precWf, null, 2), 'utf-8');

      const resPrec = await toolRunWorkflow(tempDir, 'wf-unit', 'prec-wf', {}, { dryRun: true });
      expect(resPrec.isError).toBeFalsy();
      const dataPrec = JSON.parse(resPrec.text);
      expect(dataPrec.messages).toContain('Val: workflow-override');

      // 4. Input declared only in workflow.inputs and used only in template file is still enforced
      fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(unitDir, 'templates', 'sample.txt'), 'Config: {{TMPL_SECRET}}\n', 'utf-8');

      const tmplWf = {
        name: 'Template Workflow',
        inputs: {
          TMPL_SECRET: { required: true },
        },
        steps: [
          { action: 'copy', from: 'templates/sample.txt', to: 'sample.txt' },
        ],
      };
      fs.writeFileSync(path.join(workflowsDir, 'tmpl-wf.json'), JSON.stringify(tmplWf, null, 2), 'utf-8');

      const resTmplMissing = await toolRunWorkflow(tempDir, 'wf-unit', 'tmpl-wf', {}, { dryRun: true });
      expect(resTmplMissing.isError).toBe(true);
      const dataTmpl = JSON.parse(resTmplMissing.text);
      expect(dataTmpl.error).toBe('Missing required inputs: ["TMPL_SECRET"]');

      // 5. get_module returns manifest.placeholders unchanged
      const modRes = toolGetModule(tempDir, 'wf-unit', 'core');
      expect(modRes.isError).toBeFalsy();
      const modData = JSON.parse(modRes.text);
      expect(modData.placeholders).toEqual(manifest.placeholders);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('valid scripts with/without args, script_ref inheritance, timeout values, and executeWorkflowSteps default and clamp', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-scripts-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'scripts', 'noop.js'), 'process.exit(0);\n', 'utf-8');

      // 1. Valid scripts with and without args pass validation
      const manifestWithoutArgs = {
        name: path.basename(tempDir),
        version: '1.0.0',
        type: 'cookbook',
        description: 'Unit with scripts without args',
        scripts: {
          task1: {
            file: 'scripts/noop.js',
            interpreter: 'node',
          },
        },
      };
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifestWithoutArgs, null, 2), 'utf-8');
      expect(validateManifestUnitDir(tempDir).errors).toEqual([]);

      const manifestWithArgs = {
        name: path.basename(tempDir),
        version: '1.0.0',
        type: 'cookbook',
        description: 'Unit with scripts with args',
        scripts: {
          task2: {
            file: 'scripts/noop.js',
            interpreter: 'node',
            args: {
              '--flag': { required: true, type: 'string', description: 'flag', default: 'val' },
            },
          },
        },
      };
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifestWithArgs, null, 2), 'utf-8');
      expect(validateManifestUnitDir(tempDir).errors).toEqual([]);

      // 2. Timeouts 1000, 120000, 600000, and omitted pass
      for (const t of [1000, 120000, 600000, undefined]) {
        const scriptDef: any = { file: 'scripts/noop.js' };
        if (t !== undefined) scriptDef.timeout_ms = t;
        const m = {
          name: path.basename(tempDir),
          version: '1.0.0',
          type: 'cookbook',
          description: 'Timeout testing unit',
          scripts: { testTask: scriptDef },
        };
        fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf-8');
        expect(validateManifestUnitDir(tempDir).errors).toEqual([]);
      }

      // 3. script_ref inherits file, interpreter, timeout_ms only (args from manifest script are NOT inherited)
      const manifestWithScriptRef = {
        name: path.basename(tempDir),
        version: '1.0.0',
        type: 'cookbook',
        description: 'Testing script_ref inheritance',
        scripts: {
          'base-job': {
            file: 'scripts/noop.js',
            interpreter: 'node',
            timeout_ms: 45000,
            args: { '--should-not-inherit': { required: true } },
          },
        },
      };
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifestWithScriptRef, null, 2), 'utf-8');

      const dryRunRes = await executeWorkflowSteps(
        'test-script-ref',
        tempDir,
        [{ action: 'run', script_ref: 'base-job' }],
        {},
        { dryRun: true, manifest: manifestWithScriptRef as any }
      );
      expect(dryRunRes.errors).toEqual([]);
      expect(dryRunRes.scripts_run.length).toBe(1);
      expect(dryRunRes.scripts_run[0].script).toBe('scripts/noop.js');
      expect(dryRunRes.scripts_run[0].stdout).toContain('[dry-run] Would run: node scripts/noop.js');
      expect(dryRunRes.scripts_run[0].stdout).not.toContain('--should-not-inherit');

      // 4. Config constants: DEFAULT_WORKFLOW_TIMEOUT_MS is 120000, MAX_WORKFLOW_TIMEOUT_MS is 600000
      expect(DEFAULT_WORKFLOW_TIMEOUT_MS).toBe(120000);
      expect(MAX_WORKFLOW_TIMEOUT_MS).toBe(600000);

      // 5. Execution through executeWorkflowSteps with setTimeout spy confirms default 120000 and clamp 600000
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      try {
        // Default 120000 when timeout_ms is omitted
        await executeWorkflowSteps(
          'test-default-timeout',
          tempDir,
          [{ action: 'run', script: 'scripts/noop.js' }],
          {},
          { manifest: manifestWithScriptRef as any }
        );
        const calls1 = setTimeoutSpy.mock.calls.map((c) => c[1]);
        expect(calls1).toContain(120000);

        setTimeoutSpy.mockClear();

        // Clamped to 600000 when timeout_ms is 700000 (> MAX_WORKFLOW_TIMEOUT_MS)
        await executeWorkflowSteps(
          'test-clamp-timeout',
          tempDir,
          [{ action: 'run', script: 'scripts/noop.js', timeout_ms: 700000 }],
          {},
          { manifest: manifestWithScriptRef as any }
        );
        const calls2 = setTimeoutSpy.mock.calls.map((c) => c[1]);
        expect(calls2).toContain(600000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('MCP tool names and parameters match baseline interface', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pres-mcp-tools-'));
    try {
      const { createKnowledgeServer } = await import('../src/server.js');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

      const server = createKnowledgeServer(tempDir);
      const client = new Client({ name: 'test-tools-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      try {
        const { tools } = await client.listTools();
        const toolNames = tools.map((t) => t.name).sort();
        const expectedTools = [
          'get_doc',
          'get_doc_section',
          'get_manifest',
          'get_module',
          'get_resource',
          'list_docs',
          'run_workflow',
          'search_docs',
        ].sort();
        expect(toolNames).toEqual(expectedTools);

        // Verify key tool schemas
        const searchTool = tools.find((t) => t.name === 'search_docs');
        expect(searchTool?.inputSchema?.properties?.query).toBeDefined();
        expect(searchTool?.inputSchema?.properties?.type).toBeDefined();
        expect(searchTool?.inputSchema?.properties?.tags).toBeDefined();
        expect(searchTool?.inputSchema?.properties?.unit).toBeDefined();

        const runWorkflowTool = tools.find((t) => t.name === 'run_workflow');
        expect(runWorkflowTool?.inputSchema?.properties?.name).toBeDefined();
        expect(runWorkflowTool?.inputSchema?.properties?.workflow).toBeDefined();
        expect(runWorkflowTool?.inputSchema?.properties?.inputs).toBeDefined();
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('walkUnitFiles parity with copyDirSync', () => {
  // **Validates: Requirements 2.2, 2.13, 3.8**
  it('seeded random trees (dot names, node_modules, .git, depth 0-3, symlinks where host allows): set(walkUnitFiles) == set(files copyDirSync writes)', () => {
    // Simple LCG PRNG for deterministic reproducibility
    let seed = 42;
    function rand(): number {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    const dirNames = ['.hidden', 'node_modules', '.git', 'src', 'docs', '.config', 'sub', 'assets'];
    const fileNames = ['.env', 'regular.txt', '.secrets', 'a.js', 'README.md', '.npmrc', 'config.json'];

    // Helper to recursively collect relative paths of all files in a directory
    function collectAllFiles(dir: string, baseDir: string = dir): string[] {
      if (!fs.existsSync(dir)) return [];
      const res: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          res.push(...collectAllFiles(full, baseDir));
        } else if (entry.isFile()) {
          res.push(path.relative(baseDir, full).replace(/\\/g, '/'));
        }
      }
      return res;
    }

    for (let treeIdx = 0; treeIdx < 10; treeIdx++) {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), `ks-walk-src-${treeIdx}-`));
      const destDir = fs.mkdtempSync(path.join(os.tmpdir(), `ks-walk-dest-${treeIdx}-`));

      try {
        // Create tree with depth 0-3
        function buildTree(currentDir: string, currentDepth: number) {
          // Add 1-3 files at this level
          const fileCount = 1 + Math.floor(rand() * 3);
          for (let f = 0; f < fileCount; f++) {
            const fname = fileNames[Math.floor(rand() * fileNames.length)] + `_${f}`;
            fs.writeFileSync(path.join(currentDir, fname), `content ${f} at depth ${currentDepth}\n`, 'utf-8');
          }

          if (currentDepth < 3) {
            // Add 1-2 subdirectories
            const dirCount = 1 + Math.floor(rand() * 2);
            for (let d = 0; d < dirCount; d++) {
              const dname = dirNames[Math.floor(rand() * dirNames.length)] + `_${d}`;
              const subDir = path.join(currentDir, dname);
              if (!fs.existsSync(subDir)) {
                fs.mkdirSync(subDir, { recursive: true });
                buildTree(subDir, currentDepth + 1);
              }
            }
          }
        }

        buildTree(srcDir, 0);

        // Try creating a symlink if the platform/privileges allow
        try {
          const target = path.join(srcDir, 'regular.txt_0');
          const link = path.join(srcDir, 'symlink.txt');
          if (fs.existsSync(target)) {
            fs.symlinkSync(target, link);
          }
        } catch {
          // Symlink creation might require admin on Windows; ignore if not permitted
        }

        // 1. Collect files visited by walkUnitFiles
        const visited: string[] = [];
        walkUnitFiles(srcDir, (fp) => {
          visited.push(path.relative(srcDir, fp).replace(/\\/g, '/'));
        });

        // 2. Perform copyDirSync
        copyDirSync(srcDir, destDir);

        // 3. Collect files actually copied to destDir
        const copied = collectAllFiles(destDir);

        // Assert set(walkUnitFiles) == set(files copyDirSync writes)
        expect(new Set(visited)).toEqual(new Set(copied));
        expect(visited.length).toBe(copied.length);
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(destDir, { recursive: true, force: true });
      }
    }
  });
});

describe('18.2: checksum and hasLocalModifications', () => {
  // **Validates: Requirements 2.13, 3.8**

  it('edits to .hidden/cfg.json, node_modules/x/a.txt and a regular file each change computeUnitChecksum', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-18-2-edits-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'node_modules', 'x'), { recursive: true });

      const manifestPath = path.join(tempDir, 'manifest.json');
      const regularPath = path.join(tempDir, 'overview.md');
      const dotPath = path.join(tempDir, '.hidden', 'cfg.json');
      const nmPath = path.join(tempDir, 'node_modules', 'x', 'a.txt');

      fs.writeFileSync(manifestPath, JSON.stringify({ name: 'test-unit', version: '1.0.0' }), 'utf-8');
      fs.writeFileSync(regularPath, '# Overview\nInitial content\n', 'utf-8');
      fs.writeFileSync(dotPath, '{"config": "initial"}\n', 'utf-8');
      fs.writeFileSync(nmPath, 'initial module data\n', 'utf-8');

      const baseline = computeUnitChecksum(tempDir);
      expect(baseline).toHaveLength(16);

      // 1. Edit .hidden/cfg.json changes checksum
      fs.writeFileSync(dotPath, '{"config": "modified"}\n', 'utf-8');
      const afterDotEdit = computeUnitChecksum(tempDir);
      expect(afterDotEdit).not.toBe(baseline);

      // Restore dot file -> returns to baseline
      fs.writeFileSync(dotPath, '{"config": "initial"}\n', 'utf-8');
      expect(computeUnitChecksum(tempDir)).toBe(baseline);

      // 2. Edit node_modules/x/a.txt changes checksum
      fs.writeFileSync(nmPath, 'modified module data\n', 'utf-8');
      const afterNmEdit = computeUnitChecksum(tempDir);
      expect(afterNmEdit).not.toBe(baseline);

      // Restore node_modules file -> returns to baseline
      fs.writeFileSync(nmPath, 'initial module data\n', 'utf-8');
      expect(computeUnitChecksum(tempDir)).toBe(baseline);

      // 3. Edit regular file overview.md changes checksum
      fs.writeFileSync(regularPath, '# Overview\nModified content\n', 'utf-8');
      const afterRegularEdit = computeUnitChecksum(tempDir);
      expect(afterRegularEdit).not.toBe(baseline);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('order independence: identical trees created in different order produce identical checksums', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-18-2-order-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-18-2-order-b-'));
    try {
      // dirA: create files in order z, a, .hidden, node_modules, sub
      fs.mkdirSync(path.join(dirA, '.hidden'), { recursive: true });
      fs.mkdirSync(path.join(dirA, 'node_modules', 'm'), { recursive: true });
      fs.mkdirSync(path.join(dirA, 'sub'), { recursive: true });

      fs.writeFileSync(path.join(dirA, 'z.txt'), 'content z\n', 'utf-8');
      fs.writeFileSync(path.join(dirA, 'a.txt'), 'content a\n', 'utf-8');
      fs.writeFileSync(path.join(dirA, '.hidden', 'b.txt'), 'content b\n', 'utf-8');
      fs.writeFileSync(path.join(dirA, 'node_modules', 'm', 'c.txt'), 'content c\n', 'utf-8');
      fs.writeFileSync(path.join(dirA, 'sub', 'nested.txt'), 'content nested\n', 'utf-8');

      // dirB: create directories and files in reversed order
      fs.mkdirSync(path.join(dirB, 'sub'), { recursive: true });
      fs.mkdirSync(path.join(dirB, 'node_modules', 'm'), { recursive: true });
      fs.mkdirSync(path.join(dirB, '.hidden'), { recursive: true });

      fs.writeFileSync(path.join(dirB, 'sub', 'nested.txt'), 'content nested\n', 'utf-8');
      fs.writeFileSync(path.join(dirB, 'node_modules', 'm', 'c.txt'), 'content c\n', 'utf-8');
      fs.writeFileSync(path.join(dirB, '.hidden', 'b.txt'), 'content b\n', 'utf-8');
      fs.writeFileSync(path.join(dirB, 'a.txt'), 'content a\n', 'utf-8');
      fs.writeFileSync(path.join(dirB, 'z.txt'), 'content z\n', 'utf-8');

      expect(computeUnitChecksum(dirA)).toBe(computeUnitChecksum(dirB));
      expect(computeLegacyUnitChecksum(dirA)).toBe(computeLegacyUnitChecksum(dirB));
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('legacy fallback for an untouched unit with dot files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-18-2-legacy-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'legacy-unit', version: '1.0.0' }), 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'overview.md'), '# Overview\nUntouched content\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.hidden', 'cfg.json'), '{"dot": true}\n', 'utf-8');

      const modernChecksum = computeUnitChecksum(tempDir);
      const legacyChecksum = computeLegacyUnitChecksum(tempDir);

      // Because the unit contains .hidden, modern differs from legacy
      expect(modernChecksum).not.toBe(legacyChecksum);

      // If registry stored the legacy checksum, untouched unit must NOT be flagged as modified
      expect(hasLocalModifications(tempDir, legacyChecksum)).toBe(false);

      // If registry stored modern checksum, untouched unit is also NOT modified
      expect(hasLocalModifications(tempDir, modernChecksum)).toBe(false);

      // Missing stored checksum or missing directory returns false
      expect(hasLocalModifications(tempDir, undefined)).toBe(false);
      expect(hasLocalModifications(tempDir, '')).toBe(false);
      expect(hasLocalModifications(path.join(tempDir, 'nonexistent'), legacyChecksum)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('modification of a regular file is detected', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-18-2-mod-'));
    try {
      fs.mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
      const overviewPath = path.join(tempDir, 'overview.md');
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'mod-unit', version: '1.0.0' }), 'utf-8');
      fs.writeFileSync(overviewPath, '# Overview\nUntouched content\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, '.hidden', 'cfg.json'), '{"dot": true}\n', 'utf-8');

      const legacyChecksum = computeLegacyUnitChecksum(tempDir);
      const modernChecksum = computeUnitChecksum(tempDir);

      // Modify the regular file
      fs.writeFileSync(overviewPath, '# Overview\nLocally edited content\n', 'utf-8');

      // Modifying regular file is detected whether stored was legacy or modern
      expect(hasLocalModifications(tempDir, legacyChecksum)).toBe(true);
      expect(hasLocalModifications(tempDir, modernChecksum)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('20.1: publish target and push args helpers', () => {
  // **Validates: Requirements 2.5, 2.6**
  it("buildPublishPushArgs('feat', true) -> ['push', '-u', 'origin', 'feat']", () => {
    const args = buildPublishPushArgs('feat', true);
    expect(args).toEqual(['push', '-u', 'origin', 'feat']);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('-f');
    expect(args).not.toContain('--force-with-lease');
    expect(args.some((a) => a.includes('+'))).toBe(false);
  });

  it("buildPublishPushArgs('feat', false) -> ['push', 'origin', 'feat']", () => {
    const args = buildPublishPushArgs('feat', false);
    expect(args).toEqual(['push', 'origin', 'feat']);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('-f');
    expect(args).not.toContain('--force-with-lease');
    expect(args.some((a) => a.includes('+'))).toBe(false);
  });

  it("buildPublishPushArgs('b') defaults to first publish when called with single arg", () => {
    const args = buildPublishPushArgs('b');
    expect(args).toEqual(['push', '-u', 'origin', 'b']);
  });

  describe('resolvePublishTarget', () => {
    let tempDir: string;
    let knowledgeDir: string;
    let directDir: string;
    let directMd: string;
    let directTxt: string;
    let relDir: string;
    let relMd: string;
    let bareMd: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-20-1-target-'));
      knowledgeDir = path.join(tempDir, 'knowledge');
      fs.mkdirSync(knowledgeDir, { recursive: true });

      // Direct directory and files outside knowledgeDir
      directDir = path.join(tempDir, 'direct-unit');
      fs.mkdirSync(directDir, { recursive: true });
      fs.writeFileSync(path.join(directDir, 'manifest.json'), JSON.stringify({ name: 'direct-unit', version: '1.0.0' }));

      directMd = path.join(tempDir, 'direct.md');
      fs.writeFileSync(directMd, '# Direct Markdown\n');

      directTxt = path.join(tempDir, 'direct.txt');
      fs.writeFileSync(directTxt, 'Some text\n');

      // Inside knowledgeDir
      relDir = path.join(knowledgeDir, 'rel-unit');
      fs.mkdirSync(relDir, { recursive: true });
      fs.writeFileSync(path.join(relDir, 'manifest.json'), JSON.stringify({ name: 'rel-unit', version: '1.0.0' }));

      relMd = path.join(knowledgeDir, 'rel-file.md');
      fs.writeFileSync(relMd, '# Relative Markdown\n');

      bareMd = path.join(knowledgeDir, 'bare-doc.md');
      fs.writeFileSync(bareMd, '# Bare doc\n');
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('resolves direct directory path as unit', () => {
      const res = resolvePublishTarget(directDir, knowledgeDir);
      expect(res).not.toBeNull();
      expect(res?.kind).toBe('unit');
      expect(res?.path).toBe(path.resolve(directDir));
    });

    it('resolves direct .md file path as file', () => {
      const res = resolvePublishTarget(directMd, knowledgeDir);
      expect(res).not.toBeNull();
      expect(res?.kind).toBe('file');
      expect(res?.path).toBe(path.resolve(directMd));
    });

    it('returns null for direct file not ending in .md', () => {
      const res = resolvePublishTarget(directTxt, knowledgeDir);
      expect(res).toBeNull();
    });

    it('resolves knowledge-relative directory name as unit', () => {
      const res = resolvePublishTarget('rel-unit', knowledgeDir);
      expect(res).not.toBeNull();
      expect(res?.kind).toBe('unit');
      expect(res?.path).toBe(path.resolve(relDir));
    });

    it('resolves knowledge-relative .md file name as file', () => {
      const res = resolvePublishTarget('rel-file.md', knowledgeDir);
      expect(res).not.toBeNull();
      expect(res?.kind).toBe('file');
      expect(res?.path).toBe(path.resolve(relMd));
    });

    it('resolves bare name (without .md) to knowledge-relative .md file as file', () => {
      const res = resolvePublishTarget('bare-doc', knowledgeDir);
      expect(res).not.toBeNull();
      expect(res?.kind).toBe('file');
      expect(res?.path).toBe(path.resolve(bareMd));
    });

    it('returns null for nonexistent target', () => {
      const res = resolvePublishTarget('nonexistent-target', knowledgeDir);
      expect(res).toBeNull();
    });

    it('returns null for empty string', () => {
      const res = resolvePublishTarget('', knowledgeDir);
      expect(res).toBeNull();
    });
  });
});

describe('21.4: validateStaged and installValidated (B7)', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-b7-test-'));
    knowledgeDir = path.join(tempDir, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getStageDirs(kDir: string): string[] {
    const cacheDir = path.join(kDir, '.cache');
    if (!fs.existsSync(cacheDir)) return [];
    return fs.readdirSync(cacheDir).filter((name) => name.startsWith('.vstage-'));
  }

  describe('validateStaged', () => {
    it('validates valid standalone .md file', () => {
      const mdPath = path.join(tempDir, 'valid.md');
      fs.writeFileSync(
        mdPath,
        '---\ndescription: A valid guide\ntags: [test]\n---\n# Valid Guide\n\nContent here.\n',
        'utf-8'
      );

      const resBool = validateStaged(mdPath, false);
      expect(resBool.ok).toBe(true);
      expect(resBool.errors).toEqual([]);

      const resUnit = validateStaged(mdPath, 'valid.md', false);
      expect(resUnit).toBe(true);
    });

    it('rejects invalid (empty) standalone .md file', () => {
      const mdPath = path.join(tempDir, 'empty.md');
      fs.writeFileSync(mdPath, '', 'utf-8');

      const resBool = validateStaged(mdPath, false);
      expect(resBool.ok).toBe(false);
      expect(resBool.errors.length).toBeGreaterThan(0);

      const resUnit = validateStaged(mdPath, 'empty.md', false);
      expect(resUnit).toBe(false);
    });

    it('validates directory with valid manifest.json', () => {
      const unitDir = path.join(tempDir, 'valid-unit');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({
          name: 'valid-unit',
          version: '1.0.0',
          description: 'A valid unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );

      const resBool = validateStaged(unitDir, true);
      expect(resBool.ok).toBe(true);
      expect(resBool.errors).toEqual([]);

      const resUnit = validateStaged(unitDir, 'valid-unit', false);
      expect(resUnit).toBe(true);
    });

    it('rejects directory with invalid manifest.json (missing version)', () => {
      const unitDir = path.join(tempDir, 'invalid-unit');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({
          name: 'invalid-unit',
          description: 'Missing version unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );

      const resBool = validateStaged(unitDir, true);
      expect(resBool.ok).toBe(false);
      expect(resBool.errors.length).toBeGreaterThan(0);

      const resUnit = validateStaged(unitDir, 'invalid-unit', false);
      expect(resUnit).toBe(false);
    });

    it('accepts directory without manifest.json', () => {
      const noManifestDir = path.join(tempDir, 'no-manifest-folder');
      fs.mkdirSync(noManifestDir, { recursive: true });
      fs.writeFileSync(path.join(noManifestDir, 'notes.txt'), 'hello', 'utf-8');

      const resBool = validateStaged(noManifestDir, true);
      expect(resBool.ok).toBe(true);
      expect(resBool.errors).toEqual([]);

      const resUnit = validateStaged(noManifestDir, 'no-manifest-folder', false);
      expect(resUnit).toBe(true);
    });

    it('returns true immediately when noVerify is true', () => {
      const unitDir = path.join(tempDir, 'broken-unit');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(path.join(unitDir, 'manifest.json'), '{}', 'utf-8');

      expect(validateStaged(unitDir, 'broken-unit', true)).toBe(true);
    });
  });

  describe('installValidated', () => {
    it('installs valid directory unit, atomically replaces destDir, and removes staging directory', () => {
      const srcDir = path.join(tempDir, 'src-unit');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'manifest.json'),
        JSON.stringify({
          name: 'my-unit',
          version: '1.0.0',
          description: 'A valid unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(srcDir, 'file.txt'), 'version 1', 'utf-8');

      const destDir = path.join(knowledgeDir, 'my-unit');

      const ok = installValidated(knowledgeDir, srcDir, destDir, 'my-unit', false);
      expect(ok).toBe(true);
      expect(fs.existsSync(destDir)).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'file.txt'), 'utf-8')).toBe('version 1');
      expect(getStageDirs(knowledgeDir)).toEqual([]);
    });

    it('on validation failure, keeps existing installed version and leaves no staging dir', () => {
      const destDir = path.join(knowledgeDir, 'my-unit');
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(
        path.join(destDir, 'manifest.json'),
        JSON.stringify({
          name: 'my-unit',
          version: '1.0.0',
          description: 'Original unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(destDir, 'file.txt'), 'original content', 'utf-8');

      // Broken incoming source (missing version)
      const srcDir = path.join(tempDir, 'src-broken');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'manifest.json'),
        JSON.stringify({
          name: 'my-unit',
          description: 'Broken unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(srcDir, 'file.txt'), 'broken content', 'utf-8');

      const ok = installValidated(knowledgeDir, srcDir, destDir, 'my-unit', false);
      expect(ok).toBe(false);
      // Existing directory remains untouched
      expect(fs.readFileSync(path.join(destDir, 'file.txt'), 'utf-8')).toBe('original content');
      expect(getStageDirs(knowledgeDir)).toEqual([]);
    });

    it('installs broken incoming unit when noVerify is true', () => {
      const destDir = path.join(knowledgeDir, 'my-unit');
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'file.txt'), 'original', 'utf-8');

      const srcDir = path.join(tempDir, 'src-broken');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'manifest.json'),
        JSON.stringify({
          name: 'my-unit',
          description: 'Broken unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(srcDir, 'file.txt'), 'new broken content', 'utf-8');

      const ok = installValidated(knowledgeDir, srcDir, destDir, 'my-unit', true);
      expect(ok).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'file.txt'), 'utf-8')).toBe('new broken content');
      expect(getStageDirs(knowledgeDir)).toEqual([]);
    });

    it('installs standalone .md file and keeps existing on validation failure', () => {
      const destFile = path.join(knowledgeDir, 'guide.md');
      fs.writeFileSync(
        destFile,
        '---\ndescription: Original guide\ntags: [guide]\n---\n# Original\n',
        'utf-8'
      );

      // Broken incoming (empty)
      const emptyFile = path.join(tempDir, 'empty.md');
      fs.writeFileSync(emptyFile, '', 'utf-8');

      const failRes = installValidated(knowledgeDir, emptyFile, destFile, 'guide.md', false);
      expect(failRes).toBe(false);
      expect(fs.readFileSync(destFile, 'utf-8')).toContain('Original');
      expect(getStageDirs(knowledgeDir)).toEqual([]);

      // Valid incoming
      const validFile = path.join(tempDir, 'new-guide.md');
      fs.writeFileSync(
        validFile,
        '---\ndescription: Updated guide\ntags: [guide]\n---\n# Updated\n',
        'utf-8'
      );

      const successRes = installValidated(knowledgeDir, validFile, destFile, 'guide.md', false);
      expect(successRes).toBe(true);
      expect(fs.readFileSync(destFile, 'utf-8')).toContain('Updated');
      expect(getStageDirs(knowledgeDir)).toEqual([]);
    });

    it('supports options object form and invokes onSuccess callback', () => {
      const srcDir = path.join(tempDir, 'src-opts');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'manifest.json'),
        JSON.stringify({
          name: 'opt-unit',
          version: '1.0.0',
          description: 'Opt unit',
          type: 'cookbook',
        }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(srcDir, 'hello.txt'), 'world', 'utf-8');

      const destDir = path.join(knowledgeDir, 'opt-unit');
      let successCalled = false;

      const ok = installValidated({
        incomingSourcePath: srcDir,
        destDir,
        isDirectory: true,
        noVerify: false,
        onSuccess: () => {
          successCalled = true;
        },
      });

      expect(ok).toBe(true);
      expect(successCalled).toBe(true);
      expect(fs.existsSync(destDir)).toBe(true);
      expect(getStageDirs(knowledgeDir)).toEqual([]);
    });
  });
});
