// The remote server: MCP over streamable HTTP at /mcp, for clients that take a URL instead of a
// command (Claude and ChatGPT connectors, the MCP Inspector). Read-only, no accounts, no cookies,
// nothing stored. Both protocol eras are served: 2026-07-28 per-request calls and the 2025
// handshake (initialize, then calls), the latter statelessly, one fresh server per request.
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Api } from './api.js';
import { claudeResponse, createRegistry, registryResponse, type Registry } from './registry.js';
import { createServer } from './server.js';

// Cloudflare's rate limiting binding: a count per key per minute in each location.
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const DOCS = 'https://archestack.com/api/#mcp';
const MAX_BODY = 64 * 1024; // the largest tool call is a few hundred bytes

// Any web page may call it: there is no login or cookie to steal, and the data is public.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

// What the ChatGPT plugin portal asks the MCP host to serve to prove it is ours (a public token).
export interface Options {
  limiter?: Limiter | undefined;
  openaiChallenge?: string | undefined;
}

export function createHttpHandler(api: Api, version: string, officialRegistry?: string) {
  const mcp = createMcpHandler(() => createServer(api, version), { maxRequestBodySize: MAX_BODY });
  const registry = createRegistry(api, officialRegistry);

  return async (
    request: Request,
    { limiter, openaiChallenge }: Options = {},
  ): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/' && request.method === 'GET') return Response.redirect(DOCS, 302);
    if (pathname === '/health') return text(200, `ok ${version}`);
    if (pathname === '/.well-known/openai-apps-challenge' && openaiChallenge) {
      return text(200, openaiChallenge);
    }
    const lists = pathname.startsWith('/registry/') || pathname.startsWith('/allowlist/');
    if (pathname !== '/mcp' && !lists) {
      return text(404, `Not found. The MCP endpoint is /mcp, docs: ${DOCS}`);
    }
    if (limiter && !(await allowed(request, limiter))) return tooMany();
    if (!lists) return withCors(await mcp.fetch(request));
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'GET only');
    const answer = await allowlistAnswer(registry, url);
    return answer ? withCors(answer) : text(404, `Not found. Docs: ${DOCS}`);
  };
}

// A registry or Claude Code file; 503 when the Archestack API or the MCP Registry does not answer.
async function allowlistAnswer(registry: Registry, url: URL) {
  try {
    return (await registryResponse(registry, url)) ?? (await claudeResponse(registry, url));
  } catch {
    return text(503, 'The allowlist could not be read just now. Try again in a minute.');
  }
}

// One count per client address, so one busy client cannot use up the day's free requests.
async function allowed(request: Request, limiter: Limiter) {
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return (await limiter.limit({ key })).success;
}

function tooMany() {
  const body = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Too many requests from this address. Try again in a minute.' },
  };
  return withCors(
    new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    }),
  );
}

const text = (status: number, body: string) =>
  withCors(new Response(body, { status, headers: { 'content-type': 'text/plain' } }));

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
