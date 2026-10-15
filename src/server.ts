// The MCP server: six read-only tools over the Archestack open data API.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Api, Index, Project, Row } from './api.js';

const SOURCE =
  "Archestack, https://archestack.com/ (data CC BY 4.0: link each project's source_url and give its checked_at date)";

const INSTRUCTIONS = `Archestack ranks open-source AI projects in two lists: best-of-ai (self-hosted AI apps and infrastructure: chat UIs, model servers, RAG, agents, vector databases) and best-of-vibe-coding (starters, coding agents, MCP servers, skills and plugins for building with AI). Every project has a score from 0 to 100, a place in its category, facts from GitHub (stars, license, last commit, Docker, arm64, GPU need) and a short review.
Use search_projects to find projects, top_in_category for a ranking, get_project for one project, deploy_facts for what it takes to run one, compare to put 2 to 4 side by side, and alternatives_to for open-source picks that replace a paid product. Every project carries source_url, its page on archestack.com, and checked_at, the date its GitHub facts were checked: link the first and give the second when you cite a project.`;

// Every tool only reads published data. openWorldHint is false: answers come from Archestack's
// own dataset, not from the open web.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const projectRef = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'Project id like "best-of-ai/qdrant", a GitHub repo like "qdrant/qdrant", or a name like "Qdrant"',
  );
const listId = z
  .string()
  .max(100)
  .optional()
  .describe('Only this list: "best-of-ai" or "best-of-vibe-coding"');

const searchInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Words to look for, e.g. "vector database" or "chat ui ollama". Leave out to rank by score.',
    ),
  list: listId,
  category: z
    .string()
    .max(100)
    .optional()
    .describe('Only this category: id or title, e.g. "vector-db" or "Vector databases"'),
  license: z
    .enum(['permissive', 'copyleft', 'custom'])
    .optional()
    .describe(
      'License family. permissive: MIT, Apache-2.0, BSD and similar. copyleft: GPL, AGPL, LGPL, MPL. custom: anything else, including no license',
    ),
  no_gpu: z.boolean().optional().describe('true: only projects that run without a GPU'),
  arm64: z
    .boolean()
    .optional()
    .describe('true: only projects with an arm64 build (Apple Silicon, Raspberry Pi, Graviton)'),
  has_demo: z.boolean().optional().describe('true: only projects with a live demo'),
  limit: z.number().int().min(1).max(25).default(10),
});

const categoryInput = z.object({
  category: z
    .string()
    .min(1)
    .max(100)
    .describe('Category id or title, e.g. "vector-db" or "Vector databases"'),
  list: listId,
  limit: z.number().int().min(1).max(50).default(10),
});

export function createServer(api: Api, version: string) {
  const server = new McpServer({ name: 'archestack', version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'search_projects',
    {
      title: 'Search projects',
      description:
        'Find open-source AI projects across both Archestack lists by words and filters. Words match names, repos, taglines, categories and the products a project replaces; results rank by how many words match, then exact names, then projects whose name or category holds the words, then by score. Put hard needs in the filters, not the words (no_gpu instead of "without a GPU").',
      inputSchema: searchInput,
      annotations: READ_ONLY,
    },
    async (args) => reply(await searchProjects(api, args)),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description:
        'Everything Archestack has on one project: score and the parts it is made of, place in its category, GitHub facts (stars, license, last commit and release, language, Docker, arm64, GPU, RAM, external services, port), project health, demo and docs links, and the review (summary, audience, strengths, weaknesses).',
      inputSchema: z.object({ project: projectRef }),
      annotations: READ_ONLY,
    },
    async ({ project }) => reply(await getProject(api, project)),
  );

  server.registerTool(
    'deploy_facts',
    {
      title: 'What it takes to run a project',
      description:
        'The facts an agent needs before installing or deploying one project: Docker files, arm64 build, GPU need, minimum RAM, outside services it needs, web port, what its README says it needs, docs and demo links, and upkeep (latest release, releases in 12 months, security advisories, its package). null means Archestack does not know. Archestack does not track hosting cost or deploy templates.',
      inputSchema: z.object({ project: projectRef }),
      annotations: READ_ONLY,
    },
    async ({ project }) => reply(await deployFacts(api, project)),
  );

  server.registerTool(
    'top_in_category',
    {
      title: 'Top projects in a category',
      description:
        'The ranking of one category, best first, with score and tagline. An unknown category returns the list of categories.',
      inputSchema: categoryInput,
      annotations: READ_ONLY,
    },
    async (args) => reply(await topInCategory(api, args)),
  );

  server.registerTool(
    'compare',
    {
      title: 'Compare projects',
      description:
        'Put 2 to 4 projects side by side: score and its parts, place, stars, license, last commit, Docker, arm64, GPU, RAM, external services, strengths and weaknesses.',
      inputSchema: z.object({ projects: z.array(projectRef).min(2).max(4) }),
      annotations: READ_ONLY,
    },
    async ({ projects }) => reply(await compareProjects(api, projects)),
  );

  server.registerTool(
    'alternatives_to',
    {
      title: 'Open-source alternatives',
      description:
        'Open-source projects that replace a paid or closed product (e.g. Cursor, ChatGPT, Notion), highest score first. own_claim is true when the project says so in its own README.',
      inputSchema: z.object({
        product: z.string().min(1).max(100).describe('Product name, e.g. "Cursor"'),
      }),
      annotations: READ_ONLY,
    },
    async ({ product }) => reply(await alternativesTo(api, product)),
  );

  return server;
}

const reply = (body: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(body) }],
});

async function searchProjects(api: Api, args: z.output<typeof searchInput>) {
  const [index, { projects, updated }] = await Promise.all([api.index(), api.projects()]);
  checkList(index, args.list);
  const category = args.category ? findCategory(index, args.category, args.list) : undefined;
  const titles = categoryTitles(index);
  const words = wordsOf(args.query ?? '').filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const exact = squash(args.query ?? '');
  const hits = projects
    .filter((p) => passesFilters(p, args, category))
    .map((p) => ({ p, ...relevance(p, words, titles.get(categoryKey(p)) ?? '', exact) }))
    .filter((h) => words.length === 0 || h.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.tier - a.tier || b.p.score - a.p.score);
  return {
    updated,
    total: hits.length,
    results: hits.slice(0, args.limit).map((h) => brief(h.p, titles.get(categoryKey(h.p)) ?? '')),
    source: SOURCE,
  };
}

async function getProject(api: Api, ref: string) {
  const { projects } = await api.projects();
  const { version, license, ...doc } = await api.project(findProject(projects, ref).url);
  return { ...doc, source: SOURCE };
}

async function deployFacts(api: Api, ref: string) {
  const { projects } = await api.projects();
  const d = await api.project(findProject(projects, ref).url);
  const health = d.health ?? null;
  return {
    id: d.id,
    name: d.name,
    repo: d.repo,
    docker: d.facts.docker,
    arm64: d.facts.arm64,
    gpu: d.facts.gpu,
    ram_min_gb: d.facts.ram_min_gb,
    external_deps: d.facts.external_deps,
    web_port: d.facts.web_port ?? null,
    needs: d.review.needs ?? [],
    language: d.facts.language,
    license: d.facts.license_words,
    docs: d.links.docs,
    website: d.links.website,
    demo: d.links.demo,
    last_commit: d.facts.last_commit,
    last_release: d.facts.last_release,
    releases_12m: health?.releases_12m ?? null,
    days_since_release: health?.days_since_release ?? null,
    advisories_12m: health?.advisories ?? null,
    package: health?.package ?? null,
    checked: d.checked,
    source_url: d.source_url,
    checked_at: d.checked_at,
    source: SOURCE,
  };
}

async function topInCategory(api: Api, args: z.output<typeof categoryInput>) {
  const index = await api.index();
  checkList(index, args.list);
  const { version, license, projects, ...doc } = await api.category(
    findCategory(index, args.category, args.list).url,
  );
  return {
    ...doc,
    total: projects.length,
    projects: projects.slice(0, args.limit).map(({ url, ...p }) => p),
    source: SOURCE,
  };
}

async function compareProjects(api: Api, refs: string[]) {
  const { projects } = await api.projects();
  const rows = refs.map((ref) => findProject(projects, ref));
  const docs = await Promise.all(rows.map((p) => api.project(p.url)));
  return { projects: docs.map(sideBySide), source: SOURCE };
}

async function alternativesTo(api: Api, product: string) {
  const index = await api.index();
  const { version, license, ...doc } = await api.alternative(findProduct(index, product).url);
  return { ...doc, updated: index.updated, source: SOURCE };
}

// Words a question carries that every project matches, or that belong in a filter.
const STOP_WORDS = new Set(
  'a ai alternative alternatives an and app apps are best for free good hosted i in is it me of on open or project projects run runs self selfhosted source that the to tool tools top what which with without'.split(
    ' ',
  ),
);

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/[^a-z0-9]/g, '');
const categoryKey = (p: Row) => `${p.list}/${p.category}`;

const categoryTitles = (index: Index) =>
  new Map<string, string>(
    index.lists.flatMap((l) => l.categories.map((c) => [`${l.id}/${c.id}`, c.title])),
  );

// How many query words start a word in the project's text, and a tier: 2 when the query is the
// project's name or repo, 1 when every word is in what the project is (name, repo, category, a
// product it replaces) rather than only in its tagline, else 0.
function relevance(p: Row, words: string[], categoryTitle: string, exact: string) {
  const identity = wordsOf(
    `${p.name} ${p.repo} ${p.alternative_to.join(' ')} ${p.category} ${categoryTitle}`,
  );
  const hits = (pool: string[]) => words.filter((w) => pool.some((x) => x.startsWith(w))).length;
  const matched = hits([...identity, ...wordsOf(p.tagline)]);
  const named =
    exact !== '' && [p.name, p.repo, p.repo.split('/')[1] ?? ''].some((k) => squash(k) === exact);
  const tier = named ? 2 : matched === words.length && hits(identity) === words.length ? 1 : 0;
  return { matched, tier };
}

function passesFilters(
  p: Row,
  f: z.output<typeof searchInput>,
  category?: { list: string; id: string },
) {
  return (
    (!f.list || p.list === f.list) &&
    (!category || (p.list === category.list && p.category === category.id)) &&
    (!f.license || p.license_family === f.license) &&
    (!f.no_gpu || p.gpu === 'none' || p.gpu === 'optional') &&
    (!f.arm64 || p.arm64) &&
    (!f.has_demo || p.demo !== null)
  );
}

function checkList(index: Index, list?: string) {
  if (list && !index.lists.some((l) => l.id === list)) {
    throw new Error(`No list "${list}". Lists: ${index.lists.map((l) => l.id).join(', ')}.`);
  }
}

function findCategory(index: Index, ref: string, list?: string) {
  const all = index.lists
    .filter((l) => !list || l.id === list)
    .flatMap((l) => l.categories.map((c) => ({ ...c, list: l.id })));
  const wanted = ref.trim().toLowerCase();
  const words = wordsOf(wanted);
  const exact = all.filter((c) =>
    [c.id, c.title.toLowerCase(), `${c.list}/${c.id}`].includes(wanted),
  );
  const hits = exact.length
    ? exact
    : all.filter(
        (c) =>
          words.length > 0 &&
          words.every((w) => wordsOf(`${c.id} ${c.title}`).some((x) => x.startsWith(w))),
      );
  if (hits.length === 1) return hits[0]!;
  const options = (hits.length ? hits : all)
    .map((c) => `${c.list}/${c.id} (${c.title})`)
    .join(', ');
  throw new Error(
    hits.length
      ? `"${ref}" matches more than one category: ${options}. Pass the list or a category id.`
      : `No category "${ref}". Categories: ${options}.`,
  );
}

// Exact name first ("GitHub Copilot"), then a single product the words name ("copilot studio").
function findProduct(index: Index, product: string) {
  const wanted = squash(product);
  const all = index.alternatives;
  const exact = all.find((a) => squash(a.product) === wanted);
  const hits = exact
    ? [exact]
    : all.filter((a) => wanted.length > 1 && squash(a.product).includes(wanted));
  if (hits.length === 1) return hits[0]!;
  throw new Error(
    hits.length
      ? `"${product}" matches ${hits.map((a) => a.product).join(', ')}. Pass the full name.`
      : `No open-source picks for "${product}" yet. Products with picks: ${all.map((a) => a.product).join(', ')}.`,
  );
}

function findProject(projects: Row[], ref: string) {
  const wanted = squash(ref);
  const keys = (p: Row) =>
    [p.id, p.repo, p.name, p.id.split('/')[1] ?? '', p.repo.split('/')[1] ?? ''].map(squash);
  const hits = projects.filter((p) => keys(p).includes(wanted));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new Error(`"${ref}" matches ${hits.map((p) => p.id).join(', ')}. Pass one of these ids.`);
  }
  const near =
    wanted.length < 3
      ? []
      : projects.filter((p) => keys(p).some((k) => k.includes(wanted))).slice(0, 5);
  throw new Error(
    `No project "${ref}" on Archestack.${near.length ? ` Close: ${near.map((p) => p.id).join(', ')}.` : ' Try search_projects.'}`,
  );
}

const brief = (p: Row, categoryTitle: string) => ({
  id: p.id,
  name: p.name,
  repo: p.repo,
  list: p.list,
  category: categoryTitle,
  place: p.place,
  score: p.score,
  tagline: p.tagline,
  stars: p.stars,
  license: p.license,
  gpu: p.gpu,
  arm64: p.arm64,
  demo: p.demo,
  page: p.page,
  source_url: p.source_url,
  checked_at: p.checked_at,
});

const sideBySide = (d: Project) => ({
  id: d.id,
  name: d.name,
  repo: d.repo,
  page: d.page,
  category: `${d.list}/${d.category.id} (${d.category.title})`,
  place: `${d.place} of ${d.of}`,
  score: d.score,
  score_parts: Object.fromEntries(d.score_parts.map((s) => [s.label, `${s.word} (${s.value})`])),
  penalties: d.penalties,
  stars: d.facts.stars,
  license: d.facts.license_words,
  last_commit: d.facts.last_commit,
  last_release: d.facts.last_release,
  language: d.facts.language,
  docker: d.facts.docker,
  arm64: d.facts.arm64,
  gpu: d.facts.gpu,
  ram_min_gb: d.facts.ram_min_gb,
  external_deps: d.facts.external_deps,
  demo: d.links.demo,
  audience: d.review.audience,
  strengths: d.review.strengths,
  weaknesses: d.review.weaknesses,
  checked: d.checked,
  source_url: d.source_url,
  checked_at: d.checked_at,
});
