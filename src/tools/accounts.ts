import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../lib/api-client.js';
import type { SessionState } from '../lib/session.js';
import { formatCurrency, formatDate, maskAccountNumber } from '../lib/format.js';

function handleSessionExpired(state: SessionState) {
  state.botSessionToken = undefined;
  state.customerId = undefined;
  state.customerName = undefined;
  return { content: [{ type: 'text' as const, text: 'Session expired. The customer needs to verify their identity again.' }] };
}

export function registerAccountTools(server: McpServer, state: SessionState, apiClient: ApiClient): void {
  server.registerTool('get_accounts', {
    description: 'List all bank accounts for the verified customer. Customer must be verified first.',
  }, async () => {
    if (!state.botSessionToken) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const res = await apiClient.sessionRequest('GET', '/api/v1/bot/accounts', state.botSessionToken);

    if (!res.ok) {
      if (res.status === 401) return handleSessionExpired(state);
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    const accounts = res.data?.data;

    if (!Array.isArray(accounts)) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }

    if (accounts.length === 0) {
      return { content: [{ type: 'text', text: 'Customer has no accounts.' }] };
    }

    const lines = [`Customer has ${accounts.length} account${accounts.length === 1 ? '' : 's'}:`, ''];

    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i];
      const type = a.type.charAt(0) + a.type.slice(1).toLowerCase();
      lines.push(
        `${i + 1}. ${type} Account (${maskAccountNumber(a.accountNumber)})`,
        `   Balance: ${formatCurrency(a.balance)}`,
        `   Status: ${a.status.charAt(0) + a.status.slice(1).toLowerCase()}`,
        `   ID: ${a.id}`,
        '',
      );
    }

    return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
  });

  server.registerTool('get_transactions', {
    description: 'Get recent transactions for a specific account. Customer must be verified first.',
    inputSchema: {
      accountId: z.string().describe('Account UUID (from get_accounts results)'),
      limit: z.number().min(1).max(50).optional().describe('Number of transactions to return (default: 10, max: 50)'),
      type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT']).optional().describe('Filter by type: DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT'),
    },
  }, async ({ accountId, limit, type }) => {
    if (!state.botSessionToken) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (type) params.set('type', type);
    const query = params.toString();
    const path = `/api/v1/bot/accounts/${accountId}/transactions${query ? `?${query}` : ''}`;

    const res = await apiClient.sessionRequest('GET', path, state.botSessionToken);

    if (!res.ok) {
      if (res.status === 401) return handleSessionExpired(state);
      if (res.status === 404) return { content: [{ type: 'text', text: 'Account not found.' }] };
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    const transactions = res.data?.data;
    const total = res.data?.meta?.total ?? 0;

    if (!Array.isArray(transactions)) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }

    if (transactions.length === 0) {
      return { content: [{ type: 'text', text: 'No transactions found for this account.' }] };
    }

    const lines = [`Recent transactions for account:`, ''];

    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i];
      const sign = t.type === 'CREDIT' || t.type === 'TRANSFER_IN' ? '+' : '-';
      const typeLabel = t.type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      lines.push(
        `${i + 1}. ${formatDate(t.createdAt)} — ${typeLabel}: ${sign}${formatCurrency(t.amount)} (${t.description}) — ${t.status.charAt(0) + t.status.slice(1).toLowerCase()}`,
      );
    }

    lines.push('', `Showing ${transactions.length} of ${total} total transactions.`);

    return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
  });
}
