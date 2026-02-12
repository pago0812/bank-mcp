import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../lib/api-client.js';
import type { SessionState } from '../lib/session.js';

export function registerCustomerTools(server: McpServer, state: SessionState, apiClient: ApiClient): void {
  server.registerTool('get_customer', {
    description: 'Retrieve the verified customer\'s profile information. Customer must be verified first.',
  }, async () => {
    if (!state.botSessionToken) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const res = await apiClient.sessionRequest('GET', '/api/v1/bot/customer', state.botSessionToken);

    if (!res.ok) {
      if (res.status === 401) {
        state.botSessionToken = undefined;
        state.customerId = undefined;
        state.customerName = undefined;
        return { content: [{ type: 'text', text: 'Session expired. The customer needs to verify their identity again.' }] };
      }
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    const c = res.data;
    if (!c?.firstName) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }
    const text = [
      'Customer Profile:',
      `- Name: ${c.firstName} ${c.lastName}`,
      `- Phone: ${c.phone}`,
      `- Email: ${c.email}`,
      `- Address: ${c.address}, ${c.zipCode}`,
      `- Status: ${c.status.charAt(0) + c.status.slice(1).toLowerCase()}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  });
}
