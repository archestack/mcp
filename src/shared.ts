// What every tool shares: the citation line, the read-only annotations, input pieces, the reply
// shape, and the matching of words, categories and projects against the API documents.
import { z } from 'zod';
import type { Index, Row } from './api.js';

export const SOURCE =
  "Archestack, https://archestack.com/ (data CC BY 4.0: link each project's source_url and give its checked_at date)";

// Every tool only reads published data. openWorldHint is false: answers come from Archestack's
// own dataset, not from the open web.
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const projectRef = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'Project id like "best-of-ai/qdrant", a GitHub repo like "qdrant/qdrant", or a name like "Qdrant"',
  );
export const listId = z
  .string()
  .max(100)
  .optional()
  .describe('Only this list: "best-of-ai" or "best-of-vibe-coding"');

// Hard needs a user can state; every tool that picks projects reads the same ones.
export const filterFields = {
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
};

export interface Filters {
  list?: string | undefined;
  license?: 'permissive' | 'copyleft' | 'custom' | undefined;
  no_gpu?: boolean | undefined;
  arm64?: boolean | undefined;
  has_demo?: boolean | undefined;
}

// The same answer twice: structuredContent for clients that read objects, and the JSON text block
// the spec asks tools to keep for clients that only read text.
export const reply = (body: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(body) }],
  structuredContent: body,
});

// Words a question carries that every project matches, or that belong in a filter.
export const STOP_WORDS = new Set(
  'a ai alternative alternatives an and app apps are best for free good hosted i in is it me of on open or project projects run runs self selfhosted source that the to tool tools top what which with without'.split(
    ' ',
  ),
);

export const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
export const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/[^a-z0-9]/g, '');
export const categoryKey = (p: Row) => `${p.list}/${p.category}`;

export const categoryTitles = (index: Index) =>
  new Map<string, string>(
    index.lists.flatMap((l) => l.categories.map((c) => [`${l.id}/${c.id}`, c.title])),
  );

// How many query words start a word in the project's text, and a tier: 2 when the query is the
// project's name or repo, 1 when every word is in what the project is (name, repo, category, a
// product it replaces) rather than only in its tagline, else 0.
export function relevance(p: Row, words: string[], categoryTitle: string, exact: string) {
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

export function passesFilters(p: Row, f: Filters, category?: { list: string; id: string }) {
  return (
    (!f.list || p.list === f.list) &&
    (!category || (p.list === category.list && p.category === category.id)) &&
    (!f.license || p.license_family === f.license) &&
    (!f.no_gpu || p.gpu === 'none' || p.gpu === 'optional') &&
    (!f.arm64 || p.arm64) &&
    (!f.has_demo || p.demo !== null)
  );
}

export function checkList(index: Index, list?: string) {
  if (list && !index.lists.some((l) => l.id === list)) {
    throw new Error(`No list "${list}". Lists: ${index.lists.map((l) => l.id).join(', ')}.`);
  }
}

export function findCategory(index: Index, ref: string, list?: string) {
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
export function findProduct(index: Index, product: string) {
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

export function findProject(projects: Row[], ref: string) {
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
