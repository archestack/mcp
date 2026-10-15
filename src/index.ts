#!/usr/bin/env node
// archestack-mcp: a local MCP server (stdio) over the Archestack open data API.
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createApi, DEFAULT_API_URL } from './api.js';
import { compile } from './ajv.js';
import { createServer } from './server.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};
// ARCHESTACK_API_URL points the server at a local copy of the API (the tests use it).
const api = createApi(process.env.ARCHESTACK_API_URL ?? DEFAULT_API_URL, version, compile);
await createServer(api, version).connect(new StdioServerTransport());
