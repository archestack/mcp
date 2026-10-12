// Reads the Archestack open data API: static JSON files under https://archestack.com/api/v1/.
// Every document is checked against the JSON Schema the site publishes next to it
// (/api/v1/schema/<name>.json) and kept in memory for an hour.
import ky from 'ky';
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from '@modelcontextprotocol/server/validators/ajv';

export const DEFAULT_API_URL = 'https://archestack.com/api/v1/';
const HOUR_MS = 60 * 60 * 1000;

type SchemaName = 'index' | 'projects' | 'category' | 'project' | 'alternative';
type Gpu = 'none' | 'optional' | 'required' | 'unknown';

export interface Ref {
  id: string;
  name: string;
  url: string;
  page: string;
  place: number;
  score: number;
  tagline: string;
}

export interface Index {
  updated: string;
  lists: {
    id: string;
    title: string;
    categories: { id: string; title: string; url: string; projects: number }[];
  }[];
  alternatives: { product: string; url: string }[];
}

export interface Row extends Ref {
  repo: string;
  list: string;
  category: string;
  stars: number;
  license: string | null;
  license_family: 'permissive' | 'copyleft' | 'custom';
  gpu: Gpu;
  arm64: boolean;
  demo: string | null;
  alternative_to: string[];
}

export interface Projects {
  updated: string;
  projects: Row[];
}

export interface Category {
  version: string;
  license: string;
  list: string;
  id: string;
  title: string;
  intro: string;
  page: string;
  updated: string;
  projects: Ref[];
}

export interface Project {
  version: string;
  license: string;
  id: string;
  name: string;
  repo: string;
  page: string;
  list: string;
  category: { id: string; title: string; url: string };
  place: number;
  of: number;
  score: number;
  score_parts: { key: string; label: string; word: string; value: number }[];
  penalties: string[];
  facts: {
    stars: number;
    license_words: string;
    last_commit: string;
    last_release: string | null;
    language: string | null;
    docker: boolean;
    arm64: boolean;
    gpu: Gpu;
    ram_min_gb: number | null;
    external_deps: string[];
  };
  links: { demo: string | null; docs: string | null; website: string | null };
  review: { audience: string; strengths: string[]; weaknesses: string[] };
  checked: string;
}

export interface Alternative {
  version: string;
  license: string;
  product: string;
  page: string;
  categories: { list: string; id: string; title: string; url: string }[];
  picks: (Ref & { own_claim: boolean })[];
}

export type Api = ReturnType<typeof createApi>;

export function createApi(baseUrl: string, version: string) {
  const http = ky.create({
    prefix: baseUrl,
    timeout: 8_000,
    retry: { limit: 2, jitter: true, backoffLimit: 2_000, retryOnTimeout: true },
    headers: { 'user-agent': `archestack-mcp/${version} (+https://github.com/archestack/mcp)` },
  });
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();

  // One request per file per hour, shared by concurrent callers; a failure is not kept.
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < HOUR_MS) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.get(key)?.value === value && cache.delete(key));
    return value;
  }

  const validator = (name: SchemaName) =>
    cached(`schema/${name}.json`, async () =>
      compile(await http.get(`schema/${name}.json`).json<object>()),
    );

  const doc = <T>(name: SchemaName, path: string) =>
    cached(path, async () => {
      const [validate, data] = await Promise.all([validator(name), http.get(path).json()]);
      const result = validate(data);
      if (!result.valid) {
        throw new Error(
          `${path} does not match the published ${name} schema: ${result.errorMessage}`,
        );
      }
      return result.data as T;
    });

  return {
    index: () => doc<Index>('index', 'index.json'),
    projects: () => doc<Projects>('projects', 'projects.json'),
    category: (url: string) => doc<Category>('category', pathOf(url)),
    project: (url: string) => doc<Project>('project', pathOf(url)),
    alternative: (url: string) => doc<Alternative>('alternative', pathOf(url)),
  };
}

// A fresh engine per schema version, so hourly refetches do not pile up compiled schemas. The
// schemas use no keyword newer than draft-07. removeAdditional drops fields newer than a cached
// schema instead of failing: v1 only ever adds fields.
function compile(schema: object) {
  const ajv = new Ajv({
    strict: false,
    validateSchema: false,
    allErrors: true,
    removeAdditional: true,
  });
  return new AjvJsonSchemaValidator(addFormats(ajv)).getValidator<unknown>(schema);
}

// Documents link each other with absolute archestack.com URLs; requests follow them under the
// configured base URL, so a local copy of the API serves every file.
function pathOf(url: string) {
  const at = url.indexOf('/api/v1/');
  if (at < 0) throw new Error(`Not an Archestack API URL: ${url}`);
  return url.slice(at + '/api/v1/'.length);
}
