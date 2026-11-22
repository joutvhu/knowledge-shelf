#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Read package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const args = process.argv.slice(2);
const isPackOnly = args.includes('--pack-only');
const isUninstall = args.includes('--uninstall');
const noBuild = args.includes('--no-build');
const keepTarball = args.includes('--keep-tarball');
const showHelp = args.includes('--help') || args.includes('-h');

// ANSI escape codes for prettier output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function run(command, cwd = rootDir) {
  log(`> ${command}`, colors.gray);
  execSync(command, { cwd, stdio: 'inherit', shell: true });
}

function getExpectedTarballName() {
  const safeName = pkg.name.startsWith('@')
    ? pkg.name.slice(1).replace('/', '-')
    : pkg.name;
  return `${safeName}-${pkg.version}.tgz`;
}

function printHelp() {
  log('\nLocal Publishing & Testing Helper', colors.bold);
  log('Usage: node scripts/publish-local.mjs [options]\n');
  log('Options:');
  log('  (no args)        Build, pack, and install package globally (npm install -g <tarball>)');
  log('  --pack-only      Build and pack package into a .tgz file without installing');
  log('  --uninstall      Uninstall the globally installed package (npm uninstall -g <pkg>)');
  log('  --no-build       Skip the build step before packing');
  log('  --keep-tarball   Do not delete the .tgz file after global installation');
  log('  --help, -h       Show this help message\n');
}

function handleUninstall() {
  log(`\n📦 Uninstalling ${colors.bold}${pkg.name}${colors.reset} globally...`, colors.cyan);
  try {
    run(`npm uninstall -g ${pkg.name}`);
    log(`\n✅ Successfully uninstalled ${pkg.name} globally!`, colors.green);
  } catch (error) {
    log(`\n❌ Failed to uninstall ${pkg.name} globally.`, colors.red);
    process.exit(1);
  }
}

function handlePackOnly() {
  if (!noBuild) {
    log('\n🔨 Building package...', colors.cyan);
    run('npm run build');
  }

  log('\n📦 Packing package into tarball...', colors.cyan);
  run('npm pack');

  const tarballName = getExpectedTarballName();
  const tarballPath = path.join(rootDir, tarballName);

  if (fs.existsSync(tarballPath)) {
    log(`\n✅ Pack completed successfully!`, colors.green);
    log(`Tarball location: ${colors.bold}${tarballPath}${colors.reset}`, colors.cyan);
  } else {
    log(`\n⚠️  Tarball created, expected: ${tarballName}`, colors.yellow);
  }
}

function handlePublishLocal() {
  if (!noBuild) {
    log('\n🔨 Building package...', colors.cyan);
    run('npm run build');
  }

  log('\n📦 Creating package tarball for local installation...', colors.cyan);
  run('npm pack');

  const tarballName = getExpectedTarballName();
  const tarballPath = path.join(rootDir, tarballName);

  if (!fs.existsSync(tarballPath)) {
    log(`\n❌ Could not find generated tarball: ${tarballName}`, colors.red);
    process.exit(1);
  }

  log(`\n🚀 Installing ${colors.bold}${tarballName}${colors.reset} globally...`, colors.cyan);
  try {
    run(`npm install -g "${tarballPath}"`);
  } catch (error) {
    log(`\n❌ Global installation failed.`, colors.red);
    process.exit(1);
  } finally {
    if (!keepTarball && fs.existsSync(tarballPath)) {
      log(`\n🧹 Cleaning up temporary tarball: ${tarballName}...`, colors.gray);
      fs.unlinkSync(tarballPath);
    }
  }

  log(`\n✅ Successfully installed ${colors.bold}${pkg.name}@${pkg.version}${colors.reset} globally!`, colors.green);

  // Display available binary names if defined
  if (pkg.bin) {
    const binNames = Object.keys(pkg.bin);
    log('\nAvailable global CLI commands:', colors.bold);
    for (const bin of binNames) {
      log(`  - ${colors.green}${bin}${colors.reset}`);
    }
    log(`\nTry testing: ${colors.cyan}${binNames[0]} --version${colors.reset} or ${colors.cyan}${binNames[0]} --help${colors.reset}\n`);
  }
}

function main() {
  if (showHelp) {
    printHelp();
    return;
  }

  if (isUninstall) {
    handleUninstall();
    return;
  }

  if (isPackOnly) {
    handlePackOnly();
    return;
  }

  handlePublishLocal();
}

main();
