import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionState } from './lib/session.js';
import { ApiClient } from './lib/api-client.js';
import { registerVerifyTools } from './tools/verify.js';
import { registerCustomerTools } from './tools/customer.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerCardTools } from './tools/cards.js';

export function createServer(state: SessionState, apiClient: ApiClient): McpServer {
  const server = new McpServer({
    name: 'pony-bank-mcp',
    version: '1.0.0',
  });

  registerVerifyTools(server, state, apiClient);
  registerCustomerTools(server, state, apiClient);
  registerAccountTools(server, state, apiClient);
  registerCardTools(server, state, apiClient);

  return server;
}
