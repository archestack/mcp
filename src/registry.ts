// Archestack's safety allowlist in the formats MCP admin tools load:
// - a GitHub Copilot "Registry only" registry: the v0.1 MCP Registry API under /registry
//   (GET /v0.1/servers, /v0.1/servers/{name}/versions/{version|latest});
// - Claude Code managed settings: managed-mcp.json (a fixed server set) and an allowedMcpServers
//   list (an approved catalog).
// The list is https://archestack.com/api/v1/allowlist.json: MCP servers whose latest Archestack
// safety run passed every applicable check, pinned to the package versions it read. How to run each
// one is the official MCP Registry's record of that exact version; a server whose checked version is
// not there is left out.
import ky from 'ky';
import type { Allowlist, AllowlistServer, Api } from './api.js';

export const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io/';
const HOUR_MS = 60 * 60 * 1000;

interface Argument {
  type?: 'positional' | 'named';
  name?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
}

interface Package {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
  environmentVariables?: { name: string; isRequired?: boolean; default?: string }[];
}

interface ServerJson {
  name: string;
  version: string;
  packages?: Package[];
  [key: string]: unknown;
}

interface Entry {
  server: ServerJson;
  _meta: Record<string, unknown>;
}

export function createRegistry(api: Api, officialUrl = OFFICIAL_REGISTRY) {
  const http = ky.create({
    prefix: officialUrl,
    timeout: 8_000,
    retry: { limit: 2, jitter: true, backoffLimit: 2_000, retryOnTimeout: true },
  });
  let built: { at: number; value: Promise<Entry[]> } | null = null;

  // The official record of the version Archestack checked, or null when the registry has none.
  async function official(s: AllowlistServer): Promise<Entry | null> {
    for (const pkg of s.packages) {
      const path = `v0.1/servers/${encodeURIComponent(s.registry_name)}/versions/${encodeURIComponent(pkg.version)}`;
      const res = await http.get(path, { throwHttpErrors: false });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`MCP Registry answered ${res.status} for ${s.registry_name}`);
      const entry = await res.json<Entry>();
      const same = entry.server.packages?.some(
        (p) => p.identifier === pkg.name && p.version === pkg.version,
      );
      if (same) return entry;
    }
    return null;
  }

  function entries(): Promise<Entry[]> {
    if (built && Date.now() - built.at < HOUR_MS) return built.value;
    const value = api.allowlist().then(async (list) => {
      const found = await Promise.all(list.servers.map(async (s) => ({ s, e: await official(s) })));
      return found.flatMap(({ s, e }) => (e ? [withVerdict(e, s, list)] : []));
    });
    built = { at: Date.now(), value };
    value.catch(() => built?.value === value && (built = null));
    return value;
  }

  return { entries };
}

export type Registry = ReturnType<typeof createRegistry>;

const withVerdict = (e: Entry, s: AllowlistServer, list: Allowlist): Entry => ({
  server: e.server,
  _meta: {
    ...e._meta,
    'com.archestack/safety': {
      rule: list.rule,
      checked: s.checked,
      commit: s.commit,
      content_hash: s.content_hash,
      passed: s.passed,
      applicable: s.applicable,
      packages: s.packages,
      details: s.url,
      page: s.source_url,
    },
  },
});

// GET /registry/v0.1/... ; null for any other path.
export async function registryResponse(registry: Registry, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/registry/v0.1/servers') {
    const search = url.searchParams.get('search')?.toLowerCase() ?? '';
    const servers = (await registry.entries()).filter((e) =>
      e.server.name.toLowerCase().includes(search),
    );
    return json(200, { servers, metadata: { count: servers.length } });
  }
  const one = path.match(/^\/registry\/v0\.1\/servers\/(.+)\/versions\/([^/]+)$/);
  if (!one) return null;
  const name = decodeURIComponent(one[1]!);
  const version = decodeURIComponent(one[2]!);
  const entry = (await registry.entries()).find(
    (e) => e.server.name === name && (version === 'latest' || e.server.version === version),
  );
  return entry
    ? json(200, entry)
    : json(404, { title: 'Not Found', status: 404, detail: 'Server not found' });
}

// GET /allowlist/claude/managed-mcp.json and /allowlist/claude/managed-settings.json.
export async function claudeResponse(registry: Registry, url: URL): Promise<Response | null> {
  const which = url.pathname.match(/^\/allowlist\/claude\/(managed-mcp|managed-settings)\.json$/);
  if (!which) return null;
  const servers = (await registry.entries()).flatMap((e) => {
    const run = stdioCommand(e.server);
    return run ? [{ key: e.server.name.split('/').pop()!.toLowerCase(), ...run }] : [];
  });
  if (which[1] === 'managed-mcp') {
    const mcpServers = Object.fromEntries(
      servers.map(({ key, command, args, env }) => [
        key,
        { type: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) },
      ]),
    );
    return json(200, { mcpServers });
  }
  return json(200, {
    allowManagedMcpServersOnly: true,
    allowedMcpServers: servers.map(({ command, args }) => ({ serverCommand: [command, ...args] })),
  });
}

// The pinned command a client runs for a stdio package; null when an argument has no fixed value.
function stdioCommand(server: ServerJson) {
  const pkg = server.packages?.find((p) => (p.transport?.type ?? 'stdio') === 'stdio');
  if (!pkg?.version) return null;
  const runtime = values(pkg.runtimeArguments);
  const rest = values(pkg.packageArguments);
  if (!runtime || !rest) return null;
  const env = Object.fromEntries(
    (pkg.environmentVariables ?? [])
      .filter((v) => v.isRequired && v.default === undefined)
      .map((v) => [v.name, `\${${v.name}}`]),
  );
  if (pkg.registryType === 'npm') {
    const flags =
      runtime.includes('-y') || runtime.includes('--yes') ? runtime : ['-y', ...runtime];
    return { command: 'npx', args: [...flags, `${pkg.identifier}@${pkg.version}`, ...rest], env };
  }
  if (pkg.registryType === 'pypi') {
    return {
      command: 'uvx',
      args: [...runtime, `${pkg.identifier}==${pkg.version}`, ...rest],
      env,
    };
  }
  return null;
}

function values(args: Argument[] = []): string[] | null {
  const out: string[] = [];
  for (const a of args) {
    const value = a.value ?? a.default;
    if (value === undefined) {
      if (a.isRequired) return null;
      continue;
    }
    if (a.type === 'named' && a.name) out.push(a.name);
    out.push(value);
  }
  return out;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
