// MCP Server Card (SEP-2127) and AI Catalog for the remote endpoint: the static documents a client
// or registry crawler reads before it connects. Same identity as server.json in the MCP Registry,
// so a test keeps the two from drifting. No tools are listed: a card leaves them to tools/list.
const ORIGIN = 'https://mcp.archestack.com';

export const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_TYPE = 'application/ai-catalog+json';
export const SERVER_CARD_PATH = '/mcp/server-card';

export function serverCard(version: string) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'io.github.archestack/mcp',
    version,
    title: 'Archestack',
    description: "Search, rank and compare open-source AI projects with Archestack's open data",
    websiteUrl: 'https://archestack.com/api/',
    repository: { url: 'https://github.com/archestack/mcp', source: 'github' },
    remotes: [
      {
        type: 'streamable-http',
        url: `${ORIGIN}/mcp`,
        supportedProtocolVersions: ['2025-11-25', '2026-07-28'],
      },
    ],
  };
}

export function aiCatalog() {
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: 'urn:air:archestack.com:mcp:archestack',
        type: SERVER_CARD_TYPE,
        url: `${ORIGIN}${SERVER_CARD_PATH}`,
      },
    ],
  };
}
