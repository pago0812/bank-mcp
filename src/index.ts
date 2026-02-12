import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { rateLimiter } from 'hono-rate-limiter';
import { timingSafeEqual } from 'crypto';
import { loadConfig } from './lib/config.js';
import { ApiClient } from './lib/api-client.js';
import { startSessionCleanup, stopSessionCleanup, type SessionState } from './lib/session.js';
import { createServer } from './server.js';

const MAX_SESSIONS = 1000;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

const config = loadConfig();
const apiClient = new ApiClient(config.bankApiUrl, config.botApiToken);

const app = new Hono();

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Rate limiting for /mcp
app.use('/mcp', rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (c) => c.req.header('x-forwarded-for') || 'unknown',
}));

// Auth middleware for /mcp
app.use('/mcp', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }
  const expected = `Bearer ${config.mcpSecretToken}`;
  if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
});

// Per-session store: mcpSessionId → { transport, mcpServer, state }
interface SessionEntry {
  transport: StreamableHTTPTransport;
  mcpServer: ReturnType<typeof createServer>;
  state: SessionState;
}
const sessions = new Map<string, SessionEntry>();

app.all('/mcp', async (c) => {
  const sessionId = c.req.header('Mcp-Session-Id');

  // Existing session
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const response = await entry.transport.handleRequest(c);
    if (response) return response;
    return c.body(null, 200);
  }

  // New session — enforce max limit
  if (sessions.size >= MAX_SESSIONS) {
    return c.json({ error: 'Too many concurrent sessions' }, 503);
  }

  const state: SessionState = { createdAt: Date.now() };
  const mcpServer = createServer(state, apiClient);

  let entry: SessionEntry;
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, entry);
    },
    onsessionclosed: (closedSessionId) => {
      sessions.delete(closedSessionId);
    },
  });
  entry = { transport, mcpServer, state };

  await mcpServer.connect(transport);

  const response = await transport.handleRequest(c);
  if (response) return response;
  return c.body(null, 200);
});

// Periodic cleanup of expired sessions
startSessionCleanup((maxAge) => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.state.createdAt > maxAge) {
      entry.mcpServer.close();
      sessions.delete(id);
    }
  }
});

const httpServer = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`MCP server is running on http://localhost:${info.port}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  stopSessionCleanup();
  httpServer.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
