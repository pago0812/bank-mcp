import type { Context, Next } from 'hono';
import { logger } from '../lib/logger.js';

export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();

  let requestBody: unknown;
  if (c.req.method !== 'GET' && c.req.method !== 'DELETE') {
    requestBody = await c.req.json().catch(() => undefined);
  }

  await next();
  const duration = Date.now() - start;

  logger.info('http_request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  });
  logger.debug('http_request_detail', {
    method: c.req.method,
    path: c.req.path,
    requestBody,
  });
}
