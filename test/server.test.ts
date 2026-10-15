// The server runs the way users run it: the built bin spawned over stdio by an MCP client, and the
// built HTTP handler the Worker serves. A local HTTP server stands in for archestack.com and
// answers with recorded responses (test/fixtures, refreshed with `npm run fixtures`).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type * as ApiModule from '../src/api.js';
import type * as HttpModule from '../src/http.js';

// The built files, as the Worker bundles them (typed from their sources).
const built = (file: string) => import(new URL(`../dist/${file}`, import.meta.url).href);
const { createApi } = (await built('api.js')) as typeof ApiModule;
const { createHttpHandler } = (await built('http.js')) as typeof HttpModule;

const fixtures = new URL('./fixtures/', import.meta.url);
const recorded = JSON.parse(await readFile(new URL('projects.json', fixtures), 'utf8')) as {
  projects: {
    id: string;
    list: string;
    category: string;
    score: number;
    license_family: string;
    arm64: boolean;
    demo: string | null;
  }[];
};
const failOnce = new Set<string>(); // paths that answer 503 the first time
const replace = new Map<string, unknown>(); // paths that answer this body instead of the recording

let api: Server;
let apiUrl: string;
let client: Client;

before(async () => {
  api = createServer(async (req, res) => {
    const path = (req.url ?? '').replace(/^\/api\/v1\//, '');
    if (failOnce.delete(path)) return void res.writeHead(503).end();
    const body = replace.has(path)
      ? JSON.stringify(replace.get(path))
      : await readFile(new URL(path, fixtures), 'utf8').catch(() => null);
    if (body === null) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
  const { port } = api.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}/api/v1/`;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      env: { PATH: process.env.PATH ?? '', ARCHESTACK_API_URL: apiUrl },
    }),
  );
});

after(async () => {
  await client.close();
  api.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: first!.text };
}

async function answer(name: string, args: Record<string, unknown>) {
  const { isError, text } = await call(name, args);
  assert.equal(isError, false, text);
  return JSON.parse(text);
}

describe('archestack-mcp over stdio', () => {
  it('lists six read-only tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'alternatives_to',
      'compare',
      'deploy_facts',
      'get_project',
      'search_projects',
      'top_in_category',
    ]);
    assert.ok(
      tools.every(
        (t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false,
      ),
    );
  });

  it('search_projects ranks word matches and keeps to the GPU filter', async () => {
    const body = await answer('search_projects', {
      query: 'vector database',
      no_gpu: true,
      limit: 5,
    });
    assert.equal(body.results[0].category, 'Vector databases');
    assert.ok(body.results.every((p: { gpu: string }) => ['none', 'optional'].includes(p.gpu)));
    assert.match(body.source, /archestack\.com/);
  });

  it('search_projects puts an exact name first, then what a project is over its tagline', async () => {
    const named = await answer('search_projects', { query: 'Qdrant', limit: 3 });
    assert.equal(named.results[0].id, 'best-of-ai/qdrant');
    const kind = await answer('search_projects', { query: 'coding agent', limit: 5 });
    assert.equal(kind.results[0].category, 'Coding agents and assistants');
    const top = recorded.projects
      .filter((p) => p.list === 'best-of-vibe-coding' && p.category === 'coding-agents')
      .sort((a, b) => b.score - a.score)[0]!;
    assert.equal(kind.results[0].id, top.id);
  });

  it('search_projects without words returns every project that passes the filters', async () => {
    const filters = { list: 'best-of-ai', license: 'permissive', arm64: true, has_demo: true };
    const body = await answer('search_projects', { ...filters, limit: 25 });
    const expected = recorded.projects.filter(
      (p) => p.list === 'best-of-ai' && p.license_family === 'permissive' && p.arm64 && p.demo,
    );
    const ids = new Set(expected.map((p) => p.id));
    const scores = body.results.map((p: { score: number }) => p.score);
    assert.ok(expected.length > 0);
    assert.equal(body.total, expected.length);
    assert.equal(body.results.length, Math.min(25, expected.length));
    assert.ok(body.results.every((p: { id: string }) => ids.has(p.id)));
    assert.deepEqual(
      scores,
      [...scores].sort((a, b) => b - a),
    );
  });

  it('get_project finds a project by name', async () => {
    const body = await answer('get_project', { project: 'Qdrant' });
    assert.equal(body.id, 'best-of-ai/qdrant');
    assert.equal(body.category.id, 'vector-db');
    assert.ok(body.review.summary.length > 0);
  });

  it('get_project names close matches for an unknown project', async () => {
    const { isError, text } = await call('get_project', { project: 'qdran' });
    assert.equal(isError, true);
    assert.match(text, /No project "qdran".*best-of-ai\/qdrant/);
  });

  it('deploy_facts gives what it takes to run a project, and null for what is not known', async () => {
    const body = await answer('deploy_facts', { project: 'Open WebUI' });
    assert.equal(body.id, 'best-of-ai/open-webui');
    assert.equal(typeof body.docker, 'boolean');
    assert.ok(Array.isArray(body.needs) && body.needs.length > 0);
    assert.ok('ram_min_gb' in body && 'web_port' in body && 'releases_12m' in body);
    assert.match(body.source_url, /^https:\/\/archestack\.com\//);
  });

  it('top_in_category takes a category title and a limit', async () => {
    const body = await answer('top_in_category', { category: 'Vector databases', limit: 3 });
    assert.equal(body.id, 'vector-db');
    assert.deepEqual(
      body.projects.map((p: { place: number }) => p.place),
      [1, 2, 3],
    );
  });

  it('top_in_category lists the categories when it does not know one', async () => {
    const { isError, text } = await call('top_in_category', { category: 'spreadsheets' });
    assert.equal(isError, true);
    assert.match(text, /No category "spreadsheets"\. Categories: .*best-of-ai\/vector-db/);
  });

  it('compare puts projects side by side', async () => {
    const body = await answer('compare', { projects: ['Open WebUI', 'librechat'] });
    assert.deepEqual(
      body.projects.map((p: { id: string }) => p.id),
      ['best-of-ai/open-webui', 'best-of-ai/librechat'],
    );
    assert.ok(
      body.projects.every((p: { score_parts: object }) => Object.keys(p.score_parts).length > 0),
    );
  });

  it('alternatives_to answers through one failed request', async () => {
    failOnce.add('alternatives/cursor.json');
    const body = await answer('alternatives_to', { product: 'cursor' });
    assert.equal(body.product, 'Cursor');
    assert.ok(body.picks.length > 0);
    assert.equal(failOnce.size, 0);
  });

  it('every tool gives each project its source_url and checked_at', async () => {
    const answers = await Promise.all([
      answer('search_projects', { query: 'vector database', limit: 5 }).then((b) => b.results),
      answer('get_project', { project: 'Qdrant' }).then((b) => [b]),
      answer('top_in_category', { category: 'vector-db', limit: 5 }).then((b) => b.projects),
      answer('compare', { projects: ['Open WebUI', 'librechat'] }).then((b) => b.projects),
      answer('alternatives_to', { product: 'Cursor' }).then((b) => b.picks),
    ]);
    for (const projects of answers) {
      assert.ok(projects.length > 0);
      for (const p of projects as { id: string; source_url: string; checked_at: string }[]) {
        const [list, id] = p.id.split('/');
        assert.equal(p.source_url, `https://archestack.com/${list}/projects/${id}/`);
        assert.match(p.checked_at, /^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('refuses a document that does not match the published schema', async () => {
    replace.set('projects/best-of-ai/chroma.json', { id: 'best-of-ai/chroma', score: 'high' });
    const { isError, text } = await call('get_project', { project: 'best-of-ai/chroma' });
    assert.equal(isError, true);
    assert.match(text, /does not match the published project schema/);
  });
});

describe('remote server over HTTP', () => {
  let limited = false;
  const handle = (request: Request) =>
    createHttpHandler(createApi(apiUrl, '0.0.0-test'), '0.0.0-test')(request, {
      limiter: { limit: async () => ({ success: !limited }) },
      openaiChallenge: 'token-123',
    });
  const endpoint = new URL('https://mcp.test/mcp');
  const post = (body: object, headers: Record<string, string> = {}) =>
    handle(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );

  it('answers an MCP client: list tools, then call one', async () => {
    const remote = new Client({ name: 'test', version: '1.0.0' });
    await remote.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: (url, init) => handle(new Request(url, init)),
      }),
    );
    const { tools } = await remote.listTools();
    assert.equal(tools.length, 6);
    const result = await remote.callTool({ name: 'get_project', arguments: { project: 'Qdrant' } });
    const [first] = result.content as { text: string }[];
    assert.equal(JSON.parse(first!.text).id, 'best-of-ai/qdrant');
    await remote.close();
  });

  it('answers the 2025 handshake a plain HTTP client sends', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'curl', version: '1' },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(await res.text(), /"serverInfo":\{"name":"archestack"/);
  });

  it('turns a client away with 429 past the rate limit', async () => {
    limited = true;
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    limited = false;
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
  });

  it('sends people who open the bare address to the docs', async () => {
    const res = await handle(new Request('https://mcp.test/'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://archestack.com/api/#mcp');
  });

  it('serves the ChatGPT domain challenge as the bare token', async () => {
    const res = await handle(new Request('https://mcp.test/.well-known/openai-apps-challenge'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'token-123');
  });
});
