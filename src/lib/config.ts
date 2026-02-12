export interface Config {
  port: number;
  mcpSecretToken: string;
  botApiToken: string;
  bankApiUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3002', 10),
    mcpSecretToken: requireEnv('MCP_SECRET_TOKEN'),
    botApiToken: requireEnv('BOT_API_TOKEN'),
    bankApiUrl: requireEnv('BANK_API_URL'),
  };
}
