import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../lib/api-client.js';
import type { SessionState } from '../lib/session.js';
import { formatCurrency, formatDate } from '../lib/format.js';
import { withToolLogging } from '../lib/logger.js';

function handleSessionExpired(state: SessionState) {
  state.botSessionToken = undefined;
  state.customerId = undefined;
  state.customerName = undefined;
  return { content: [{ type: 'text' as const, text: 'Session expired. The customer needs to verify their identity again.' }] };
}

function formatExpiry(expiry: string): string {
  const [month, year] = expiry.split('/');
  return `${month}/20${year}`;
}

export function registerCardTools(server: McpServer, state: SessionState, apiClient: ApiClient): void {
  server.registerTool('get_cards', {
    description: 'List all cards across the customer\'s accounts. Customer must be verified first.',
  }, withToolLogging('get_cards', async () => {
    if (!state.botSessionToken) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const res = await apiClient.sessionRequest('GET', '/api/v1/bot/cards', state.botSessionToken);

    if (!res.ok) {
      if (res.status === 401) return handleSessionExpired(state);
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    const cards = res.data?.data;

    if (!Array.isArray(cards)) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }

    if (cards.length === 0) {
      return { content: [{ type: 'text', text: 'Customer has no cards.' }] };
    }

    const lines = [`Customer has ${cards.length} card${cards.length === 1 ? '' : 's'}:`, ''];

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const type = c.type.charAt(0) + c.type.slice(1).toLowerCase();
      lines.push(
        `${i + 1}. ${type} Card ${c.maskedNumber}`,
        `   Status: ${c.status.charAt(0) + c.status.slice(1).toLowerCase()}`,
        `   Expires: ${formatExpiry(c.expiryDate)}`,
        `   Daily Limit: ${formatCurrency(c.dailyLimit)}`,
        `   ID: ${c.id}`,
        '',
      );
    }

    return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
  }));

  server.registerTool('block_card', {
    description: 'Emergency card block. Only works on cards with ACTIVE status. Customer must be verified first.',
    inputSchema: {
      cardId: z.string().describe('Card UUID (from get_cards results)'),
    },
  }, withToolLogging('block_card', async ({ cardId }) => {
    if (!state.botSessionToken) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const res = await apiClient.sessionRequest('POST', `/api/v1/bot/cards/${cardId}/block`, state.botSessionToken);

    if (!res.ok) {
      if (res.status === 401) return handleSessionExpired(state);
      if (res.status === 404) return { content: [{ type: 'text', text: 'Card not found.' }] };
      if (res.status === 422) return { content: [{ type: 'text', text: 'Cannot block this card — it is already blocked/expired.' }] };
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    const text = [
      `Card ${res.data.maskedNumber} has been successfully blocked.`,
      'The card can no longer be used for transactions.',
      'If the customer needs a replacement, advise them to visit a branch.',
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  }));
}
