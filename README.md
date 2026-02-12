# Bank MCP

An MCP (Model Context Protocol) server that bridges Cognigy AI voice agents and the Pony Bank API (`bank-api`). Exposes banking operations as MCP tools over Streamable HTTP transport.

## Prerequisites

- Node.js (v22+)
- `bank-api` running and accessible
- A BOT employee created in `bank-admin` with its API token

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env with your values

# Start dev server (with hot reload)
npm run dev
```

The server runs at `http://localhost:3002`.

## Scripts

| Command         | Description                                  |
| --------------- | -------------------------------------------- |
| `npm run dev`   | Start dev server with hot reload (tsx watch)  |
| `npm run build` | Compile TypeScript to `dist/`                 |
| `npm start`     | Run compiled build                            |

## Environment Variables

| Variable           | Required | Example                   | Description                                    |
| ------------------ | -------- | ------------------------- | ---------------------------------------------- |
| `PORT`             | No       | `3002`                    | Server port (default: 3002)                    |
| `MCP_SECRET_TOKEN` | Yes      | `mcp_sk_a1b2c3...`       | Static bearer token for Cognigy → MCP auth     |
| `BOT_API_TOKEN`    | Yes      | `botk_a1b2c3...`         | Bot employee API token for MCP → bank-api auth |
| `BANK_API_URL`     | Yes      | `http://localhost:3001`   | Base URL of bank-api                           |

## MCP Tools

| Tool               | Description                                    | Auth Phase      |
| ------------------ | ---------------------------------------------- | --------------- |
| `verify_start`     | Start identity verification by phone number    | Bot API token   |
| `verify_answer`    | Answer a verification question                 | Bot API token   |
| `get_customer`     | Get verified customer's profile                | Session JWT     |
| `get_accounts`     | List customer's bank accounts                  | Session JWT     |
| `get_transactions` | Get transactions for an account                | Session JWT     |
| `get_cards`        | List customer's cards                          | Session JWT     |
| `block_card`       | Emergency block an active card                 | Session JWT     |

## Endpoints

| Method       | Path      | Description                    |
| ------------ | --------- | ------------------------------ |
| `GET`        | `/health` | Health check                   |
| `POST/GET/DELETE` | `/mcp` | MCP protocol (Streamable HTTP) |

All requests to `/mcp` require `Authorization: Bearer <MCP_SECRET_TOKEN>`.

## Testing

```bash
# Health check
curl http://localhost:3002/health

# Initialize MCP session
curl -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <MCP_SECRET_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

## Deployment (Coolify VPS)

1. Create a new service in Coolify pointing at this repository
2. Set Dockerfile path to `bank-mcp/Dockerfile`
3. Configure environment variables (`MCP_SECRET_TOKEN`, `BOT_API_TOKEN`, `BANK_API_URL`)
4. Set domain with HTTPS
5. If `bank-api` is on the same Coolify server, use the Docker network hostname for `BANK_API_URL` (e.g., `http://bank-api:3001`)
6. Deploy

See `SPEC.md` for the full technical specification.
