/**
 * Knowledge Shelf CLI — Dispatcher & Help.
 */

import { getPackageVersion, resolveKnowledgeDir, resolveKnowledgeDirs } from './core.js';
import {
  cmdAdd,
  cmdCatalog,
  cmdIndex,
  cmdOutdated,
  cmdPin,
  cmdPublish,
  cmdScaffold,
  cmdSync,
  cmdUnpin,
  cmdUpdate,
} from './cli/commands-git.js';
import {
  cmdExport,
  cmdImport,
  cmdInfo,
  cmdInit,
  cmdInstall,
  cmdList,
  cmdRemove,
  cmdSearch,
  cmdTrust,
  cmdValidate,
  rejectUnknownFlags,
} from './cli/commands-manage.js';

const VAL_OPTIONS = new Set([
  '-m',
  '--message',
  '--name',
  '--path',
  '--ref',
  '--pack',
  '--output',
  '-o',
  '--type',
  '-t',
  '--branch',
  '--to',
  '--file',
  '-f',
  '--unit',
  '-u',
  '--tag',
  '--tags',
  '--max',
]);

function printHelp(): void {
  console.log(`
Knowledge Shelf v${getPackageVersion()} — manage knowledge sources and MCP server.

Usage:
  knowledge-shelf <command> [--dir <knowledge-path> ...] [options]

Commands:
  add <url> [--path <subfolder>] [--name <alias>] [--ref <ref>] [--pack <name>] [--all] [--force] [--no-verify] [--trust] [--pin]
      Clone a git repository and install knowledge into the local folder.

  install <path> [--name <alias>] [--force] [--all]
      Validate and install drafted knowledge from a local path (e.g. ./.agents/knowledges/<name>).

  sync [--file <knowledge-shelf.json>] [--frozen] [--force] [--no-verify]
      Synchronize all knowledge sources declared in knowledge-shelf.json (or .registry.json).

  catalog <url> [--ref <ref>]
      Inspect available units and packs inside a remote git repository before installing.

  index [dir] [--output <shelf.json>]
      Scan a knowledge repository and generate/update shelf.json catalog.

  scaffold <name> [--type boilerplate|template|toolkit|cookbook|repo] [--output <dir>]
      Generate a starter knowledge unit or shareable knowledge repository with CI workflow.

  publish <unit> --to <git-url> [--path <subpath>] [--branch <branch>] [--message <message>] [--push] [--force]
      Validate, hygiene-check, and commit/push a unit to a shared git repository branch.

  info <name>
      Show detailed information about an installed knowledge unit.

  search <keywords> [--type <type>] [--tag <tag>] [--unit <unit>] [--content] [--max <n>]
      Search installed knowledge by keyword (same scoring as MCP search_docs tool).

  list
      List tracked sources and local/unmanaged units.

  outdated
      Check remote commits and local modifications for installed sources.

  validate [name|path]
      Validate knowledge unit structure (manifest, globs, workflows, or standalone .md).

  update [name] [--force] [--no-verify]
      Update all installed sources (or a specific one) from their remote repos.

  pin <name> [tag|commit] [--no-verify]
      Lock a source to its current version (or checkout & lock a specific tag/commit).

  unpin <name>
      Unlock a pinned source so it can be updated again.

  trust <name> / untrust <name>
      Mark/unmark a remote source as trusted for script execution under --strict-trust.

  export <name> [--output <path>] [--format zip|tar]
      Package a knowledge unit or standalone .md file as a zip or tar.gz archive.

  import <archive> [--name <alias>] [--force] [--all] [--trust]
      Validate and install a knowledge unit from a .zip or .tar.gz archive.

  remove <name>
      Remove an installed knowledge source.

  init
      Initialize the knowledge directory and registry.

  version, --version, -v
      Print installed version.

Global Options:
  --dir <path>       Explicit knowledge directory (repeatable for layered MCP/search/list).
  --read-only        (MCP server) Disable side-effecting workflow execution (dry_run still allowed).
  --strict-trust     (MCP server) Block script execution in untrusted remote units.
  --include-global   (MCP server / CLI) Append ~/.knowledge after explicit --dir layers.
  --no-global        (MCP server / CLI) Do not auto-append ~/.knowledge.

Resolution Order:
  1. --dir flag(s) (highest priority; first dir is primary writable dir)
  2. KNOWLEDGE_DIRS (delimited) or KNOWLEDGE_DIR environment variable
  3. Walk up from CWD looking for .agents/knowledges or .registry.json
  4. ~/.knowledge (global default)
`);
}

export function runCli(rawArgs: string[]): void {
  const cliDirs: string[] = [];
  const args: string[] = [];
  let includeGlobal: boolean | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--dir=')) {
      const dirVal = arg.slice('--dir='.length);
      if (!dirVal) {
        console.error('Error: --dir requires a directory path.');
        process.exit(1);
      }
      cliDirs.push(dirVal);
    } else if (arg === '--dir') {
      if (i + 1 >= rawArgs.length || rawArgs[i + 1].startsWith('-')) {
        console.error('Error: --dir requires a directory path.');
        process.exit(1);
      }
      cliDirs.push(rawArgs[++i]);
    } else if (arg === '--include-global') {
      includeGlobal = true;
    } else if (arg === '--no-global') {
      includeGlobal = false;
    } else if (arg === '--read-only' || arg === '--strict-trust') {
      // Allowed global MCP flags ignored for CLI subcommands
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const opt = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      if (VAL_OPTIONS.has(opt)) {
        args.push(opt, val);
      } else {
        args.push(arg);
      }
    } else {
      args.push(arg);
    }
  }

  const command = args[0];

  const wantsHelp =
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    args.some((arg, idx) => (arg === '--help' || arg === '-h') && !VAL_OPTIONS.has(args[idx - 1]));

  if (wantsHelp) {
    printHelp();
    return;
  }
  const primaryDir = cliDirs.length > 0 ? resolveKnowledgeDir(cliDirs[0]) : resolveKnowledgeDir();
  const allDirs =
    cliDirs.length > 0
      ? resolveKnowledgeDirs(cliDirs, { includeGlobal })
      : resolveKnowledgeDirs(undefined, { includeGlobal });

  switch (command) {
    case 'add':
      cmdAdd(primaryDir, args.slice(1));
      break;
    case 'install':
      cmdInstall(primaryDir, args.slice(1), { isExplicitDir: cliDirs.length > 0 });
      break;
    case 'sync':
      cmdSync(primaryDir, args.slice(1));
      break;
    case 'catalog':
      cmdCatalog(primaryDir, args.slice(1));
      break;
    case 'index':
      cmdIndex(args.slice(1));
      break;
    case 'scaffold':
      cmdScaffold(args.slice(1));
      break;
    case 'publish':
      cmdPublish(primaryDir, args.slice(1));
      break;
    case 'info':
      cmdInfo(allDirs, args.slice(1));
      break;
    case 'search':
      cmdSearch(allDirs, args.slice(1));
      break;
    case 'list':
    case 'ls':
      cmdList(primaryDir, allDirs, args.slice(1));
      break;
    case 'outdated':
    case 'status':
      cmdOutdated(primaryDir, args.slice(1));
      break;
    case 'validate':
      cmdValidate(allDirs, args.slice(1));
      break;
    case 'update':
    case 'up':
      cmdUpdate(primaryDir, args.slice(1));
      break;
    case 'pin':
      cmdPin(primaryDir, args.slice(1));
      break;
    case 'unpin':
      cmdUnpin(primaryDir, args.slice(1));
      break;
    case 'trust':
      cmdTrust(primaryDir, args.slice(1), true);
      break;
    case 'untrust':
      cmdTrust(primaryDir, args.slice(1), false);
      break;
    case 'export':
      cmdExport(primaryDir, args.slice(1));
      break;
    case 'import':
      cmdImport(primaryDir, args.slice(1));
      break;
    case 'remove':
    case 'rm':
      cmdRemove(primaryDir, args.slice(1));
      break;
    case 'init':
      cmdInit(primaryDir, args.slice(1));
      break;
    case 'version':
    case '--version':
    case '-v':
      rejectUnknownFlags(args.slice(1), 'version');
      if (args.length > 1) {
        console.error(`Error: Unexpected argument '${args[1]}'.`);
        process.exit(1);
      }
      console.log(getPackageVersion());
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}
