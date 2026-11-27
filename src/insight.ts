// Tools that help an agent choose: a stack for a problem, what is rising, a map of one category, and
// whether one project fits the user's limits. All read-only, all from Archestack's own data: scores,
// reviews, GitHub facts, daily star counts, pinned start commands and safety checks.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Api, Index, Project, RiseRow, Row } from './api.js';
import {
  categoryKey,
  categoryTitles,
  checkList,
  filterFields,
  findCategory,
  findProject,
  listId,
  withStaleFlag,
  passesFilters,
  projectRef,
  READ_ONLY,
  relevance,
  reply,
  SOURCE,
  STOP_WORDS,
  wordsOf,
  type Filters,
} from './shared.js';

const categoryRef = z
  .string()
  .min(1)
  .max(100)
  .describe('Category id or title, e.g. "vector-db" or "Vector databases"');

const stackInput = z.object({
  problem: z
    .string()
    .min(3)
    .max(500)
    .describe(
      'What the user wants to build or solve, in their words, e.g. "chat with our PDFs on a laptop, no cloud"',
    ),
  layers: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(5)
    .optional()
    .describe(
      'The parts of the stack you already see, as category ids, titles or plain words, e.g. ["model serving", "vector database", "chat ui"]. Leave out and Archestack picks the categories the problem matches.',
    ),
  list: listId,
  ...filterFields,
  picks: z.number().int().min(1).max(5).default(3).describe('Picks per layer'),
});

const trendInput = z.object({
  window: z
    .enum(['week', 'month'])
    .default('week')
    .describe('week: the last 7 complete days; month: the last 30'),
  list: listId,
  category: categoryRef.optional().describe('Only this category: id or title'),
  limit: z.number().int().min(1).max(40).default(10),
});

const fitInput = z.object({
  project: projectRef,
  use_case: z
    .string()
    .max(500)
    .optional()
    .describe('What the user wants to do with it, to match against its strengths and weaknesses'),
  no_gpu: z.boolean().optional().describe('true: the machine has no GPU'),
  arm64: z.boolean().optional().describe('true: it must run on arm64 (Apple Silicon, Graviton)'),
  ram_gb: z.number().positive().max(4096).optional().describe('RAM the machine has, in GB'),
  permissive_only: z
    .boolean()
    .optional()
    .describe('true: only MIT, Apache-2.0, BSD and similar licenses are allowed'),
  no_outside_services: z
    .boolean()
    .optional()
    .describe('true: it must run without outside services (hosted APIs, a separate database)'),
  docker: z.boolean().optional().describe('true: it must ship Docker files'),
});

export function registerInsightTools(server: McpServer, api: Api) {
  server.registerTool(
    'recommend_stack',
    {
      title: 'Recommend a stack for a problem',
      description:
        "Turn a problem into an open-source stack: for each layer (model serving, vector database, chat UI, agent framework, coding agent, MCP server...) the best-ranked projects on Archestack (archestack.com) that pass the user's hard needs, each with why (review strengths), trade-offs (weaknesses), score, place, stars, license, GPU, arm64, RAM and outside services. Scores and facts are refreshed twice a day from GitHub, so picks include projects newer than your training data. Name the layers you see in `layers` for the sharpest answer; leave it out and the problem's words pick up to 4 categories. Put hard needs (no GPU, arm64, license) in the filters. Use it when the user asks what to build with, which tools to combine, or how to approach a problem with open source; then call how_to_apply on the pick you recommend.",
      inputSchema: stackInput,
      annotations: READ_ONLY,
    },
    async (args) => reply(await recommendStack(api, args)),
  );

  server.registerTool(
    'trending',
    {
      title: 'Rising open-source AI projects',
      description:
        "What is rising in open-source AI right now: the projects on Archestack (archestack.com) that gained the most GitHub stars in the last 7 or 30 days, from GitHub's daily star counts, with stars gained, growth, category, score and tagline, plus the categories gaining most. Filter by list or category. Use it when the user asks what is new, hot, trending or gaining traction, or wants to know where a field is moving before picking a tool; stars gained show attention, not quality, so weigh them with the score.",
      inputSchema: trendInput,
      annotations: READ_ONLY,
    },
    async (args) => reply(await trending(api, args)),
  );

  server.registerTool(
    'explain_category',
    {
      title: 'Map one category',
      description:
        'The landscape of one category on Archestack (archestack.com): what it covers, the leaders with their main strength and weakness, how many projects are permissive, copyleft, run without a GPU or have arm64 builds, the best pick for each need (permissive, no GPU, arm64, live demo, most stars), what is rising in it this week, and thin spots (needs no project meets). Use it when the user wants to understand a field before choosing ("what are my options for vector databases"); for the plain ranking use top_in_category, to pick across several layers use recommend_stack.',
      inputSchema: z.object({ category: categoryRef, list: listId }),
      annotations: READ_ONLY,
    },
    async ({ category, list }) => reply(await explainCategory(api, category, list)),
  );

  server.registerTool(
    'how_to_apply',
    {
      title: "Check a project against the user's limits",
      description:
        "Before recommending or setting up one open-source project: check it against the user's limits (no GPU, arm64, RAM, permissive license only, no outside services, Docker) fact by fact, with a verdict; the start command pinned to a release, variable names and ports; known pitfalls (review weaknesses, score penalties, stale releases, security advisories, failed safety checks, copyleft terms); what in its review matches the use case; and up to 3 projects in its category that fit better. From Archestack's (archestack.com) checked facts, not the project's own marketing. Use it after recommend_stack or whenever the user is about to adopt a named project for a specific job; it never installs or runs anything.",
      inputSchema: fitInput,
      annotations: READ_ONLY,
    },
    async (args) => reply(await howToApply(api, args)),
  );
}

// Words that say what the user wants to do rather than what the tool is.
const INTENT_WORDS = new Set(
  'about any build building can could create data do does from get help how into just let like local locally make my need needs our over private send sending should some something team using use want we work works would you your'.split(
    ' ',
  ),
);
const MATCH_ONLY = 'its projects match the problem';
const NEGATIONS = new Set(['no', 'not', 'non', 'without', 'never', 'avoid', 'except']);
// The words that say what a problem is about; a word right after "no", "without" or "not" is a
// thing the user does not want ("no cloud"), so it never picks a category.
function problemWords(text: string) {
  const all = wordsOf(text);
  // "on my own server" says where it runs, not what it is: "server" points at the MCP server
  // categories only next to "mcp".
  const mcp = all.some((w) => w.startsWith('mcp'));
  const kept = all.filter(
    (w, i) =>
      !NEGATIONS.has(w) && !NEGATIONS.has(all[i - 1] ?? '') && (mcp || !/^servers?$/.test(w)),
  );
  return [...new Set(kept)].filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w) && !INTENT_WORDS.has(w),
  );
}

// Speech tools come in two directions that share every word: "text to speech" asks for a voice,
// "speech to text" for a transcript. 1 when the project says it does what the problem asks, -1
// when it says only the opposite, 0 when the problem names no direction or the project is silent.
const SAYS = /text[- ]to[- ]speech|\btts\b|voice clon|speech synthesis|read\w* aloud/i;
const HEARS = /speech[- ]to[- ]text|\bstt\b|\basr\b|transcri|speech recognition|dictation/i;
// "generate images" is the same trap in a category that also holds video makers, camera tools and
// upscalers: a project that names diffusion or image generation first, one that is about video,
// cameras, clips or training a model last.
const MAKES_IMAGES =
  /generat\w*\s+(?:\w+\s+)?(?:images?|pictures?|art|photos?)|image generat|text[- ]to[- ]image|txt2img/i;
const IMAGE_TOOL = /diffusion|\bflux\b|text[- ]to[- ]image|image generat|generat\w* images?/i;
const TRAINS = /\btrain\w*|fine-tun/i;
const NOT_IMAGES = /\bvideos?\b|camera|\bnvr\b|\bclips?\b|footage|upscal|face ?swap/i;
function directionFit(problem: string, p: Row) {
  const text = `${p.name} ${p.tagline}`;
  if (MAKES_IMAGES.test(problem) && !/\bvideos?\b/i.test(problem)) {
    if (TRAINS.test(text) || NOT_IMAGES.test(text)) return -1;
    return IMAGE_TOOL.test(text) ? 1 : 0;
  }
  const wantsSay = SAYS.test(problem);
  const wantsHear = HEARS.test(problem);
  if (wantsSay === wantsHear) return 0;
  const says = SAYS.test(text);
  const hears = HEARS.test(text);
  if (says === hears) return 0;
  return says === wantsSay ? 1 : -1;
}

// Everyday words for what a category holds, so "our PDFs" points at RAG and "ollama" at model
// serving. Used only to pick categories, never to rank projects.
const HINTS: [RegExp, string][] = [
  [/^(pdfs?|documents?|docs|files|knowledge|wiki|notes|notion|obsidian|confluence)$/, 'rag'],
  [/^(embeddings?|similarity|semantic)$/, 'vector'],
  [/^(llms?|models?|ollama|inference|gguf|weights)$/, 'serving'],
  [/^(chatbots?|chatgpts?)$/, 'chat'],
  [/^(rag|retrieval)$/, 'vector'],
  [/^(scrape|scraping|crawl|crawler|crawling)$/, 'scraping'],
  [/^(speech|tts|stt|transcribe|transcription)$/, 'voice'],
  [/^(workflows?|automate|automating|zapier)$/, 'automation'],
  [/^(tracing|traces|evals?|monitoring|monitor)$/, 'observability'],
  [/^(coding|ide|copilot|refactor)$/, 'coding'],
  [/^(images?|videos?|diffusion)$/, 'image'],
  [/^(finetune|finetuning|finetuned|fine|tune|tuning|lora)$/, 'training'],
];
const withHints = (words: string[]) => [
  ...new Set([
    ...words,
    ...words.flatMap((w) => HINTS.filter(([re]) => re.test(w)).map(([, h]) => h)),
  ]),
];

type Cat = Index['lists'][number]['categories'][number] & { list: string };
const allCategories = (index: Index, list?: string): Cat[] =>
  index.lists
    .filter((l) => !list || l.id === list)
    .flatMap((l) => l.categories.map((c) => ({ ...c, list: l.id })));
const catLabel = (c: { list: string; id: string; title: string }) =>
  `${c.list}/${c.id} (${c.title})`;
const startsAny = (pool: string[], w: string) => pool.some((x) => x.startsWith(w));

// How strongly words point at a category: words in its id or title count most, then the best five
// matches among its projects.
function categoryWeight(c: Cat, words: string[], rows: Row[], titles: Map<string, string>) {
  const own = wordsOf(`${c.id} ${c.title}`);
  const inTitle = words.filter((w) => startsAny(own, w)).length;
  const matched = rows
    .filter((p) => p.list === c.list && p.category === c.id)
    .map((p) => relevance(p, words, titles.get(categoryKey(p)) ?? '', '').matched)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((n, m) => n + m, 0);
  return { inTitle, weight: inTitle * 4 + matched };
}

// A layer the agent named: an exact category, else the one its words point at most.
function resolveLayer(index: Index, rows: Row[], layer: string, list?: string) {
  try {
    return { category: findCategory(index, layer, list), others: [] as Cat[] };
  } catch {
    const words = withHints(problemWords(layer));
    const titles = categoryTitles(index);
    const ranked = allCategories(index, list)
      .map((c) => ({ c, ...categoryWeight(c, words, rows, titles) }))
      .filter((x) => x.weight > 0)
      .sort((a, b) => b.weight - a.weight || b.c.projects - a.c.projects);
    if (!ranked.length) return null;
    return { category: ranked[0]!.c, others: ranked.slice(1, 3).map((x) => x.c) };
  }
}

async function recommendStack(api: Api, args: z.output<typeof stackInput>) {
  const [index, { projects, updated }] = await Promise.all([api.index(), api.projects()]);
  checkList(index, args.list);
  const titles = categoryTitles(index);
  const words = problemWords(args.problem);

  const layers: { asked: string; category: Cat; why: string; others: Cat[] }[] = [];
  const unmatched: string[] = [];
  if (args.layers) {
    for (const asked of args.layers) {
      const hit = resolveLayer(index, projects, asked, args.list);
      if (!hit) unmatched.push(asked);
      else if (!layers.some((l) => l.category === hit.category))
        layers.push({ asked, category: hit.category, why: 'you named it', others: hit.others });
    }
  } else {
    const rankFor = (hinted: string[]) =>
      allCategories(index, args.list)
        .map((c) => ({ c, ...categoryWeight(c, hinted, projects, titles) }))
        .filter((x) => x.weight >= 2 || x.inTitle > 0)
        .sort((a, b) => b.weight - a.weight || b.c.projects - a.c.projects);
    let hinted = withHints(words);
    let ranked = rankFor(hinted);
    // "offline" or "on my laptop" points at model serving only when nothing else names a layer:
    // next to "transcribe meetings" it would add an LLM runtime nobody asked for.
    if (!ranked.length && words.some((w) => /^(offline|airgapped|laptop)$/.test(w))) {
      hinted = [...hinted, 'serving'];
      ranked = rankFor(hinted);
    }
    // The two lists hold the same kind of category under one first word ("RAG and knowledge" apps,
    // "RAG and search" starters): keep the stronger one as the layer, name the other.
    const kind = (c: Cat) => wordsOf(c.title)[0] ?? c.id;
    const wantsStarter = words.some((w) =>
      /^(starters?|templates?|boilerplates?|scaffold\w*|kits?)$/.test(w),
    );
    const top = ranked[0]?.weight ?? 0;
    for (const { c, weight } of ranked) {
      if (weight * 2 < top) break; // under half the strongest match: noise, not a layer
      const twin = layers.find((l) => l.category.list !== c.list && kind(l.category) === kind(c));
      if (twin) {
        // best-of-ai holds apps to run, best-of-vibe-coding starters to build from: the app wins
        // unless the user asks for a starter or template.
        if (c.list === 'best-of-ai' && !wantsStarter) {
          twin.others.push(twin.category);
          twin.category = c;
          twin.asked = c.title;
        } else twin.others.push(c);
        continue;
      }
      if (layers.length === 4) break;
      const own = wordsOf(`${c.id} ${c.title}`);
      const named = hinted.filter((w) => startsAny(own, w));
      layers.push({
        asked: c.title,
        category: c,
        why: named.length ? `the problem names it (${named.join(', ')})` : MATCH_ONLY,
        others: [],
      });
    }
    // A layer only its projects point at ("chatbot for customer support" matching coding agents)
    // is a guess: with a layer the problem names, the guesses are dropped.
    if (layers.some((l) => l.why !== MATCH_ONLY)) {
      const named = layers.filter((l) => l.why !== MATCH_ONLY);
      layers.splice(0, layers.length, ...named);
    }
  }
  if (!layers.length) {
    const cats = allCategories(index, args.list).map(catLabel).join(', ');
    throw new Error(
      `No category on Archestack matches "${args.problem}"${unmatched.length ? ` or the layers ${unmatched.join(', ')}` : ''}. Pass layers with category ids from: ${cats}.`,
    );
  }

  const chosen = layers.map((l) => {
    const inCat = projects.filter(
      (p) => p.list === l.category.list && p.category === l.category.id,
    );
    const passing = inCat
      .filter((p) => passesFilters(p, args))
      .sort((a, b) => a.place - b.place)
      // Archestack's ranking decides who is in the running (the top 10 that pass the filters);
      // among those, projects whose own words match the problem come first.
      .slice(0, 10)
      .map((p) => ({
        p,
        matched: relevance(p, words, l.category.title, '').matched,
        fit: directionFit(args.problem, p),
      }))
      .sort((a, b) => b.fit - a.fit || b.matched - a.matched || a.p.place - b.p.place)
      .slice(0, args.picks);
    return { l, inCat, passing };
  });
  const docs = await projectDocs(
    api,
    chosen.flatMap((c) => c.passing.map((x) => x.p)),
  );

  return {
    updated,
    problem: args.problem,
    filters: filtersOf(args),
    layers: chosen.map(({ l, inCat, passing }) => ({
      layer: l.asked,
      category: catLabel(l.category),
      picked_because: l.why,
      ...(l.others.length ? { also_consider: l.others.map(catLabel) } : {}),
      projects_in_category: inCat.length,
      passing_filters: inCat.filter((p) => passesFilters(p, args)).length,
      picks: passing.map(({ p }) => pick(p, docs.get(p.id), words)),
    })),
    ...(unmatched.length ? { unmatched_layers: unmatched } : {}),
    next: 'Before recommending one, call how_to_apply with it and the user’s limits; deploy_facts gives the start command, compare weighs two picks.',
    source: SOURCE,
  };
}

const filtersOf = (f: Filters) =>
  Object.fromEntries(
    Object.entries({
      list: f.list,
      license: f.license,
      no_gpu: f.no_gpu,
      arm64: f.arm64,
      has_demo: f.has_demo,
    }).filter(([, v]) => v !== undefined),
  );

// Project documents for the picks; one that fails to load leaves its pick without a review instead
// of failing the whole answer.
async function projectDocs(api: Api, rows: Row[]) {
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  const loaded = await Promise.all(
    unique.map(async (r) => [r.id, await api.project(r.url).catch(() => null)] as const),
  );
  return new Map(loaded);
}

const pick = (p: Row, d: Project | null | undefined, words: string[]) => {
  const own = wordsOf(`${p.name} ${p.tagline} ${p.alternative_to.join(' ')}`);
  return {
    id: p.id,
    name: p.name,
    repo: p.repo,
    place: p.place,
    score: p.score,
    tagline: p.tagline,
    stars: p.stars,
    license: p.license,
    gpu: p.gpu,
    arm64: p.arm64,
    ram_min_gb: d?.facts.ram_min_gb ?? null,
    external_deps: d?.facts.external_deps ?? null,
    last_commit: d?.facts.last_commit ?? null,
    matches: words.filter((w) => startsAny(own, w)),
    why: d?.review.strengths.slice(0, 2) ?? null,
    trade_offs: d?.review.weaknesses.slice(0, 2) ?? null,
    audience: d?.review.audience ?? null,
    demo: p.demo,
    source_url: p.source_url,
    checked_at: p.checked_at,
  };
};

const pct = (g: number | null) => (g === null ? null : Math.round(g * 1000) / 10);

async function trending(api: Api, args: z.output<typeof trendInput>) {
  const [index, rising] = await Promise.all([api.index(), api.rising()]);
  checkList(index, args.list);
  const win = rising[args.window];
  if (!win) throw new Error(`Archestack has no star history for the last ${args.window} yet.`);
  const category = args.category ? findCategory(index, args.category, args.list) : undefined;
  const inList = win.projects.filter((r) => !args.list || r.list === args.list);
  const rows = inList.filter(
    (r) => !category || (r.list === category.list && r.category.id === category.id),
  );
  return {
    window: args.window,
    from: win.from,
    to: win.to,
    rule: rising.rule,
    total: rows.length,
    projects: rows.slice(0, args.limit).map(riseBrief),
    categories_gaining: gaining(inList),
    note: 'Stars gained show attention, not quality: weigh them with the score and place.',
    source: SOURCE,
  };
}

const riseBrief = (r: RiseRow) => ({
  id: r.id,
  name: r.name,
  repo: r.repo,
  category: catLabel({ list: r.list, id: r.category.id, title: r.category.title }),
  stars_gained: r.gain,
  growth_pct: pct(r.growth),
  stars: r.stars,
  place: r.place,
  score: r.score,
  tagline: r.tagline,
  source_url: r.source_url,
  checked_at: r.checked_at,
});

// Categories by stars gained among the rising projects.
function gaining(rows: RiseRow[]) {
  const by = new Map<
    string,
    { category: string; projects: number; stars_gained: number; top: string }
  >();
  for (const r of rows) {
    const key = `${r.list}/${r.category.id}`;
    const hit = by.get(key) ?? {
      category: catLabel({ list: r.list, id: r.category.id, title: r.category.title }),
      projects: 0,
      stars_gained: 0,
      top: r.name, // rows come most gained first
    };
    hit.projects += 1;
    hit.stars_gained += r.gain;
    by.set(key, hit);
  }
  return [...by.values()].sort((a, b) => b.stars_gained - a.stars_gained).slice(0, 8);
}

async function explainCategory(api: Api, ref: string, list?: string) {
  const index = await api.index();
  checkList(index, list);
  const found = findCategory(index, ref, list);
  const [doc, { projects }, rising] = await Promise.all([
    api.category(found.url),
    api.projects(),
    api.rising().catch(() => null), // the map stands without the star history
  ]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const rows = doc.projects.flatMap((r) => byId.get(r.id) ?? []);
  const leaders = doc.projects.slice(0, 5);
  const docs = await projectDocs(
    api,
    leaders.slice(0, 3).flatMap((r) => byId.get(r.id) ?? []),
  );
  const count = (f: (p: Row) => boolean) => rows.filter(f).length;
  const best = (f: (p: Row) => boolean) => {
    const p = rows.filter(f).sort((a, b) => a.place - b.place)[0];
    return p ? { name: p.name, id: p.id, place: p.place, score: p.score } : null;
  };
  const mostStars = [...rows].sort((a, b) => b.stars - a.stars)[0];
  const mix = {
    license: {
      permissive: count((p) => p.license_family === 'permissive'),
      copyleft: count((p) => p.license_family === 'copyleft'),
      custom: count((p) => p.license_family === 'custom'),
    },
    gpu: {
      none: count((p) => p.gpu === 'none'),
      optional: count((p) => p.gpu === 'optional'),
      required: count((p) => p.gpu === 'required'),
      unknown: count((p) => p.gpu === 'unknown'),
    },
    arm64: count((p) => p.arm64),
    live_demo: count((p) => p.demo !== null),
  };
  const thin: string[] = [];
  if (rows.length && mix.gpu.none + mix.gpu.optional === 0)
    thin.push('No project here is known to run without a GPU.');
  if (rows.length && mix.license.permissive === 0)
    thin.push('No project has a permissive license.');
  if (rows.length && mix.arm64 === 0) thin.push('No project ships an arm64 build.');
  if (rows.length && mix.live_demo === 0) thin.push('No project has a live demo.');
  if (doc.projects.length < 5) thin.push(`Only ${doc.projects.length} projects: a small field.`);
  if ((doc.projects[0]?.score ?? 100) < 50)
    thin.push(`The leader scores ${doc.projects[0]!.score} of 100: no mature pick yet.`);
  const week = rising?.week ?? null;
  return {
    category: catLabel({ list: doc.list, id: doc.id, title: doc.title }),
    intro: doc.intro,
    page: doc.page,
    updated: doc.updated,
    total: doc.projects.length,
    leaders: leaders.map((r, i) => {
      const p = byId.get(r.id);
      const d = i < 3 && p ? docs.get(p.id) : null;
      return {
        id: r.id,
        name: r.name,
        place: r.place,
        score: r.score,
        tagline: r.tagline,
        stars: p?.stars ?? null,
        license: p?.license ?? null,
        gpu: p?.gpu ?? null,
        arm64: p?.arm64 ?? null,
        ...(d
          ? { strength: d.review.strengths[0] ?? null, weakness: d.review.weaknesses[0] ?? null }
          : {}),
        source_url: r.source_url,
        checked_at: r.checked_at,
      };
    }),
    mix,
    best_for: {
      permissive: best((p) => p.license_family === 'permissive'),
      no_gpu: best((p) => p.gpu === 'none' || p.gpu === 'optional'),
      arm64: best((p) => p.arm64),
      live_demo: best((p) => p.demo !== null),
      most_stars: mostStars
        ? { name: mostStars.name, id: mostStars.id, place: mostStars.place, stars: mostStars.stars }
        : null,
    },
    rising_this_week: week
      ? {
          from: week.from,
          to: week.to,
          projects: week.projects
            .filter((r) => r.list === doc.list && r.category.id === doc.id)
            .slice(0, 5)
            .map((r) => ({ name: r.name, id: r.id, stars_gained: r.gain, place: r.place })),
        }
      : null,
    thin_spots: thin,
    next: 'recommend_stack picks across layers; how_to_apply checks one project against the user’s limits.',
    source: SOURCE,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

async function howToApply(api: Api, args: z.output<typeof fitInput>) {
  const { projects } = await api.projects();
  const row = findProject(projects, args.project);
  const d = await api.project(row.url);
  const f = d.facts;

  type Check = { need: string; ok: boolean | null; fact: string };
  const checks: Check[] = [];
  if (args.no_gpu)
    checks.push({
      need: 'runs without a GPU',
      ok: f.gpu === 'none' || f.gpu === 'optional' ? true : f.gpu === 'required' ? false : null,
      fact: `GPU: ${f.gpu}`,
    });
  if (args.arm64)
    checks.push({ need: 'arm64 build', ok: f.arm64, fact: f.arm64 ? 'has one' : 'none found' });
  if (args.ram_gb !== undefined)
    checks.push({
      need: `fits in ${args.ram_gb} GB RAM`,
      ok: f.ram_min_gb === null ? null : f.ram_min_gb <= args.ram_gb,
      fact: f.ram_min_gb === null ? 'minimum RAM not stated' : `needs ${f.ram_min_gb} GB or more`,
    });
  if (args.permissive_only)
    checks.push({
      need: 'permissive license',
      ok: row.license_family === 'permissive',
      fact: f.license_words,
    });
  if (args.no_outside_services)
    checks.push({
      need: 'no outside services',
      ok: f.external_deps.length === 0,
      fact: f.external_deps.length ? `needs ${f.external_deps.join(', ')}` : 'none listed',
    });
  if (args.docker)
    checks.push({
      need: 'Docker files',
      ok: f.docker,
      fact: f.docker ? 'ships them' : 'none found',
    });
  const misses = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const verdict = !checks.length
    ? 'no limits given: pass no_gpu, arm64, ram_gb, permissive_only, no_outside_services or docker to check them'
    : misses.length
      ? `does not fit: ${misses.map((c) => c.need).join(', ')}`
      : unknown.length
        ? `fits, but unknown: ${unknown.map((c) => c.need).join(', ')}`
        : 'fits every limit given';

  const pitfalls = [...d.review.weaknesses, ...d.penalties];
  const h = d.health;
  if (h?.days_since_release != null && h.days_since_release > 365)
    pitfalls.push(`No release in ${h.days_since_release} days.`);
  const idle = daysBetween(f.last_commit, d.checked);
  if (idle > 180) pitfalls.push(`Last commit ${f.last_commit}, ${idle} days before the check.`);
  if (h?.advisories?.critical_high)
    pitfalls.push(
      `${h.advisories.critical_high} critical or high security advisories in 12 months: ${h.advisories.url}`,
    );
  if (h?.package?.advisories.length)
    pitfalls.push(
      `${h.package.name}@${h.package.version} has known advisories: ${h.package.advisories.join(', ')}`,
    );
  for (const c of d.safety?.checks.filter((x) => x.status === 'fail') ?? [])
    pitfalls.push(`Failed safety check: ${c.title} (${c.note})`);
  if (/AGPL/i.test(row.license ?? ''))
    pitfalls.push('AGPL: serving it to others over a network obliges you to offer its source.');
  else if (row.license_family === 'copyleft')
    pitfalls.push(`${row.license}: changes you distribute must stay under the same license.`);
  else if (row.license_family === 'custom')
    pitfalls.push(`License: ${f.license_words}. Read it before commercial use.`);

  const useWords = problemWords(args.use_case ?? '').filter((w) => w.length > 3);
  const about = (lines: string[]) =>
    lines.filter((line) => useWords.some((w) => startsAny(wordsOf(line), w)));

  const fitsRow = (p: Row) =>
    (!args.no_gpu || p.gpu === 'none' || p.gpu === 'optional') &&
    (!args.arm64 || p.arm64) &&
    (!args.permissive_only || p.license_family === 'permissive');
  const better = projects
    .filter((p) => p.list === row.list && p.category === row.category && p.id !== row.id)
    .filter(fitsRow)
    .sort((a, b) => a.place - b.place)
    .slice(0, 3)
    .map((p) => ({
      id: p.id,
      name: p.name,
      place: p.place,
      score: p.score,
      tagline: p.tagline,
      gpu: p.gpu,
      arm64: p.arm64,
      license: p.license,
      source_url: p.source_url,
    }));

  return {
    id: d.id,
    name: d.name,
    repo: d.repo,
    category: `${d.list}/${d.category.id} (${d.category.title})`,
    place: `${d.place} of ${d.of}`,
    score: d.score,
    verdict,
    checks,
    ...(useWords.length
      ? {
          use_case: {
            words: useWords,
            strengths: about(d.review.strengths),
            weaknesses: about(d.review.weaknesses),
            needs: about(d.review.needs ?? []),
          },
        }
      : {}),
    setup: {
      command: withStaleFlag(d.setup, d.facts.last_release),
      docker: f.docker,
      arm64: f.arm64,
      gpu: f.gpu,
      ram_min_gb: f.ram_min_gb,
      external_deps: f.external_deps,
      web_port: f.web_port ?? null,
      needs: d.review.needs ?? [],
      docs: d.links.docs,
    },
    audience: d.review.audience,
    pitfalls,
    alternatives_that_fit: better,
    alternatives_note:
      'Ranked higher or lower in the same category and checked on GPU, arm64 and license only; run how_to_apply on one for RAM and outside services.',
    checked: d.checked,
    source_url: d.source_url,
    checked_at: d.checked_at,
    source: SOURCE,
  };
}
