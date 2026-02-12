# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                           # Dev server with hot reload (port 3002), loads .env
npm run build                         # TypeScript compile to dist/
npm start                             # Run production build
```

## Environment

Requires `.env` with `MCP_SECRET_TOKEN`, `BOT_API_TOKEN`, `BANK_API_URL` (see `.env.example`). No dotenv — uses `--env-file=.env` via tsx.

**Prerequisites**: bank-api must be running on `BANK_API_URL` with a BOT employee created and its API token saved as `BOT_API_TOKEN`.

## Architecture

**MCP server** bridging Cognigy AI voice agents and bank-api. Hono (`@hono/node-server`) + `@hono/mcp` (`StreamableHTTPTransport`) + `@modelcontextprotocol/sdk`. ESM modules — all imports use `.js` extensions. Node >= 22.

### Two-layer authentication

1. **Cognigy → MCP** (Layer 1): Static bearer token (`MCP_SECRET_TOKEN`) validated by middleware on `/mcp`.
2. **MCP → bank-api** (Layer 2): Bot API token (`botk_` prefix) for verification endpoints, then scoped bot session JWT (15min TTL) for customer data endpoints.

### Session management

Each MCP session (one per Cognigy conversation) gets its own `McpServer` + `StreamableHTTPTransport` + `SessionState` object. Stored in a `Map<sessionId, SessionEntry>` in `src/index.ts`. The transport's `onsessioninitialized` callback registers entries; `onsessionclosed` removes them. Expired sessions (>30 min) are cleaned up periodically.

**Session state** is a plain object passed by reference to all tool handlers — mutations in verify tools are immediately visible to scoped tools.

### Tool registration pattern

Each `src/tools/*.ts` file exports a `registerXxxTools(server, state, apiClient)` function that calls `server.registerTool()`. The `src/server.ts` factory creates an `McpServer` and registers all tool groups.

**7 tools**: `verify_start`, `verify_answer` (use bot API token), `get_customer`, `get_accounts`, `get_transactions`, `get_cards`, `block_card` (use bot session JWT).

### Error handling

Tools never throw — they return `{ content: [{ type: 'text', text }] }` with human-readable messages. On 401, session state is cleared and the user is told to re-verify. Precondition checks return `isError: true` when `botSessionToken` is missing.

### Formatting

All monetary values from bank-api are in **cents** (integers). `formatCurrency` in `src/lib/format.ts` converts to dollars (`$1,500.00`). Account numbers are masked to last 4 digits.

### API client

`src/lib/api-client.ts` — lightweight fetch wrapper. Two methods: `botTokenRequest` (uses `BOT_API_TOKEN`) and `sessionRequest` (uses bot session JWT). Returns `{ ok, status, data }` — does not throw on HTTP errors.

## Specification

`SPEC.md` contains the full technical specification including all bank-api endpoints, request/response formats, and tool return text formats. Refer to it for detailed behavior.
