// Cloudflare Worker entry: the remote server at https://mcp.archestack.com/mcp (wrangler.jsonc).
// Built by wrangler, not by tsc, so it is not in the npm package.
import pkg from '../package.json' with { type: 'json' };
import { createApi, DEFAULT_API_URL } from './api.js';
import { createHttpHandler, type Limiter } from './http.js';

interface Env {
  LIMIT?: Limiter;
}

// Module scope, so an isolate keeps its hour of cached API files across requests.
const handle = createHttpHandler(createApi(DEFAULT_API_URL, pkg.version), pkg.version);

export default {
  fetch: (request: Request, env: Env) => handle(request, env.LIMIT),
};
