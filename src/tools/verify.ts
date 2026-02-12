import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../lib/api-client.js';
import type { SessionState } from '../lib/session.js';

export function registerVerifyTools(server: McpServer, state: SessionState, apiClient: ApiClient): void {
  server.registerTool('verify_start', {
    description: 'Start customer identity verification by phone number. This must be called before any other banking tool.',
    inputSchema: {
      phoneNumber: z.string().describe('Customer\'s phone number (e.g., "+15551234567")'),
    },
  }, async ({ phoneNumber }) => {
    const res = await apiClient.botTokenRequest('POST', '/api/v1/bot/verify/start', { phoneNumber });

    if (!res.ok) {
      if (res.status === 401) {
        return { content: [{ type: 'text', text: 'Bot authentication failed. Please contact technical support.' }] };
      }
      if (res.status === 404) {
        return { content: [{ type: 'text', text: 'No customer found with that phone number.' }] };
      }
      if (res.status === 422) {
        return { content: [{ type: 'text', text: 'Invalid phone number format.' }] };
      }
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    if (!res.data?.sessionId || !res.data?.question) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }

    state.verificationSessionId = res.data.sessionId;

    const text = [
      `Verification started. Ask the customer: "${res.data.question.text}"`,
      `Session ID: ${res.data.sessionId}`,
      `Question ID: ${res.data.question.id}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('verify_answer', {
    description: 'Submit the customer\'s answer to a verification question. May need to be called multiple times until verification succeeds or fails.',
    inputSchema: {
      questionId: z.string().describe('ID of the question being answered'),
      answer: z.string().describe('Customer\'s answer'),
    },
  }, async ({ questionId, answer }) => {
    if (!state.verificationSessionId) {
      return {
        content: [{ type: 'text', text: 'Customer must be verified first. Use verify_start to begin identity verification.' }],
        isError: true,
      };
    }

    const res = await apiClient.botTokenRequest('POST', '/api/v1/bot/verify/answer', {
      sessionId: state.verificationSessionId,
      questionId,
      answer,
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { content: [{ type: 'text', text: 'Bot authentication failed. Please contact technical support.' }] };
      }
      if (res.status === 404) {
        return { content: [{ type: 'text', text: 'Verification session not found or expired. Please start again.' }] };
      }
      return { content: [{ type: 'text', text: 'Banking service is temporarily unavailable. Please try again.' }] };
    }

    if (!res.data?.status) {
      return { content: [{ type: 'text', text: 'Received invalid response from banking service. Please try again.' }] };
    }

    const { status } = res.data;

    if (status === 'VERIFIED') {
      state.botSessionToken = res.data.botSessionToken;
      state.customerId = res.data.customer.id;
      state.customerName = `${res.data.customer.firstName} ${res.data.customer.lastName}`;

      const text = [
        'Customer identity verified successfully.',
        `Customer: ${state.customerName}`,
        'You can now help them with their banking needs.',
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    if (status === 'IN_PROGRESS') {
      const confidence = Math.round(res.data.confidence * 100);
      const text = [
        `Answer was ${res.data.correct ? 'correct' : 'incorrect'}. Ask the customer the next question: "${res.data.nextQuestion.text}"`,
        `Question ID: ${res.data.nextQuestion.id}`,
        `Confidence: ${confidence}%`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    // FAILED
    state.verificationSessionId = undefined;
    state.botSessionToken = undefined;
    state.customerId = undefined;
    state.customerName = undefined;

    const text = [
      'Identity verification failed. The customer could not be verified.',
      'Please advise them to visit a branch or call the main support line.',
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  });
}
