#!/usr/bin/env node
/**
 * Knowledge Shelf — Entrypoint for both MCP Server and CLI.
 */

import * as fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPackageVersion, resolveKnowledgeDirs } from './core.js';
import { createKnowledgeServer } from './server.js';

const CLI_COMMANDS = new Set([
  'add',
  'install',
  'sync',
  'catalog',
  'index',
  'scaffold',
  'publish',
  'info',
  'search',
  'list',
  'ls',
  'outdated',
  'status',
  'update',
  'up',
  'pin',
  'unpin',
  'trust',
  'untrust',
  'export',
  'import',
  'remove',
  'rm',
  'init',
  'validate',
  'help',
  '--help',
  '-h',
  'version',
  '--version',
  '-v',
]);

async function main() {
  const rawArgs = process.argv.slice(2);

  const cliDirs: string[] = [];
  const rest: string[] = [];
  let readOnly = process.env.KNOWLEDGE_READ_ONLY === '1' || process.env.KNOWLEDGE_READ_ONLY === 'true';
  let strictTrust =
    process.env.KNOWLEDGE_STRICT_TRUST === '1' || process.env.KNOWLEDGE_STRICT_TRUST === 'true';
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
    } else if (arg === '--read-only') {
      readOnly = true;
    } else if (arg === '--strict-trust') {
      strictTrust = true;
    } else if (arg === '--include-global') {
      includeGlobal = true;
    } else if (arg === '--no-global') {
      includeGlobal = false;
    } else {
      rest.push(arg);
    }
  }

  const first = rest[0];

  if (first === 'version' || first === '--version' || first === '-v') {
    console.log(getPackageVersion());
    return;
  }

  if (first && CLI_COMMANDS.has(first)) {
    const { runCli } = await import('./cli.js');
    runCli(rawArgs);
    return;
  }

  if (first) {
    const looksLikePath =
      fs.existsSync(first) ||
      /[\\/]/.test(first) ||
      /^[a-zA-Z]:/.test(first) ||
      first.startsWith('.') ||
      first.startsWith('~');

    if (
      first.startsWith('-') ||
      rest.length > 1 ||
      !looksLikePath
    ) {
      const { runCli } = await import('./cli.js');
      runCli(rawArgs);
      return;
    }
  }

  // Interactive terminal (TTY) with no command or path: show CLI help instead of hanging on MCP stdio
  if (process.stdin.isTTY && !first) {
    const { runCli } = await import('./cli.js');
    runCli(rawArgs);
    return;
  }

  const explicitDirs =
    cliDirs.length > 0
      ? rest.length > 0
        ? [...cliDirs, ...rest]
        : cliDirs
      : rest.length > 0
        ? rest
        : undefined;
  const knowledgeDirs = resolveKnowledgeDirs(explicitDirs, { includeGlobal });
  const server = createKnowledgeServer(knowledgeDirs, { readOnly, strictTrust });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Knowledge Shelf MCP server running (knowledge_dirs: ${knowledgeDirs.join(', ')})`
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
