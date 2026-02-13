type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value?.toLowerCase();
  if (level && level in LOG_PRIORITY) return level as LogLevel;
  return 'info';
}

const currentLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL);

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LOG_PRIORITY[level] < LOG_PRIORITY[currentLevel]) return;
  const entry = { timestamp: new Date().toISOString(), level, message, ...fields };
  const json = JSON.stringify(entry);
  if (level === 'error') console.error(json);
  else if (level === 'warn') console.warn(json);
  else console.log(json);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function withToolLogging<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolResult>,
): (args: TArgs) => Promise<ToolResult> {
  return async (args: TArgs) => {
    const start = Date.now();
    logger.debug('tool_call_input', { tool: toolName, args });
    try {
      const result = await handler(args);
      const duration = Date.now() - start;
      if (result.isError) {
        logger.warn('tool_call', { tool: toolName, duration, isError: true });
      } else {
        logger.info('tool_call', { tool: toolName, duration, isError: false });
      }
      logger.debug('tool_call_output', { tool: toolName, result });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('tool_call_error', {
        tool: toolName,
        duration,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
