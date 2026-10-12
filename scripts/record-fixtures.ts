// Records the API responses the tests replay into test/fixtures/: `npm run fixtures`.
// ARCHESTACK_API_URL records from another copy of the API.
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.ARCHESTACK_API_URL ?? 'https://archestack.com/api/v1/';
const paths = [
  'index.json',
  'projects.json',
  ...['index', 'projects', 'category', 'project', 'alternative'].map((n) => `schema/${n}.json`),
  'categories/best-of-ai/vector-db.json',
  'projects/best-of-ai/qdrant.json',
  'projects/best-of-ai/open-webui.json',
  'projects/best-of-ai/librechat.json',
  'alternatives/cursor.json',
];

await Promise.all(
  paths.map(async (path) => {
    const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const file = new URL(`../test/fixtures/${path}`, import.meta.url);
    await mkdir(new URL('.', file), { recursive: true });
    await writeFile(file, await res.text());
  }),
);
console.log(`recorded ${paths.length} files from ${base}`);
