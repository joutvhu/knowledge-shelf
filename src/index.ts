#!/usr/bin/env node
/**
 * Knowledge Shelf — Entrypoint for both MCP Server and CLI.
 */

import * as fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPackageVersion, resolveKnowledgeDir } from './core.js';
import { createKnowledgeServer } from './server.js';

const CLI_COMMANDS = new Set([
  'add',
  'info',
  'search',
  'list',
  'ls',
  'update',
  'up',
  'pin',
  'unpin',
  'export',
  'install-skill',
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

  // Extract global --dir flag while inspecting remaining positional/flag args
  let cliDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--dir') {
      if (i + 1 >= rawArgs.length || rawArgs[i + 1].startsWith('-')) {
        console.error('Error: --dir requires a directory path.');
        process.exit(1);
      }
      cliDir = rawArgs[++i];
    } else {
      rest.push(rawArgs[i]);
    }
  }

  const first = rest[0];

  // Handle version flags directly
  if (first === 'version' || first === '--version' || first === '-v') {
    console.log(getPackageVersion());
    return;
  }

  // Dispatch known CLI commands (even if --dir appeared before the command)
  if (first && CLI_COMMANDS.has(first)) {
    const { runCli } = await import('./cli.js');
    runCli(rawArgs);
    return;
  }

  // Reject unknown flags, multi-arg non-CLI invocations, or interactive typos
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
      cliDir !== undefined ||
      (process.stdin.isTTY && !looksLikePath)
    ) {
      const { runCli } = await import('./cli.js');
      runCli(rawArgs);
      return;
    }
  }

  // Start MCP server over stdio
  const knowledgeDir = resolveKnowledgeDir(cliDir || first);
  const server = createKnowledgeServer(knowledgeDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Knowledge Shelf MCP server running (knowledge_dir: ${knowledgeDir})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
