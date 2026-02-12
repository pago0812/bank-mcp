# Pony Bank MCP Server — Technical Specification

## 1. Overview

The `bank-mcp` service is an MCP (Model Context Protocol) server that acts as a bridge between Cognigy AI voice agents and the Pony Bank API (`bank-api`). It exposes banking operations as MCP tools that the AI agent can autonomously invoke during voice conversations.

### Architecture

```
Customer (Phone/Voice)
    │
    ▼
Cognigy Voice Gateway (SIP trunk, STT/TTS)
    │
    ▼
Cognigy AI Agent (LLM-powered)
    │  MCP Protocol (Streamable HTTP)
    │  Authorization: Bearer <MCP_SECRET_TOKEN>
    ▼
bank-mcp (this service, port 3002)
    │  REST API calls
    │  Authorization: Bearer botk_xxx / Bearer <botSessionToken>
    ▼
bank-api (port 3001)
    │
    ▼
PostgreSQL
```

### Tech Stack

| Component       | Choice                                          |
| --------------- | ----------------------------------------------- |
| Framework       | Hono (`hono` + `@hono/node-server`)             |
| MCP SDK         | `@modelcontextprotocol/sdk`                     |
| MCP Transport   | `@hono/mcp` (`StreamableHTTPTransport`)         |
| Validation      | Zod v3                                          |
| HTTP Client     | Native `fetch` (Node 22)                        |
| Language        | TypeScript (ESM, `.js` imports)                 |
| Node            | >= 22                                           |

---

## 2. Authentication

There are two separate authentication boundaries.

### 2.1 Layer 1: Cognigy → MCP Server (Static Bearer Token)

A shared secret token secures the MCP endpoint. Only the Cognigy agent should be able to call this server.

**Method:** Static Bearer Token via `Authorization` header.

**Configuration:**

- In the MCP server: environment variable `MCP_SECRET_TOKEN`
- In Cognigy: MCP Tool Node → Custom Headers → `Authorization: Bearer <token>`

**Validation logic (middleware):**

```
1. Extract Authorization header from incoming request
2. If missing or does not equal "Bearer <MCP_SECRET_TOKEN>" → 401 Unauthorized
3. Otherwise, allow the request through to the MCP transport
```

**Important:** This middleware runs on ALL requests to the `/mcp` endpoint (POST, GET, DELETE) before the MCP SDK processes them.

**Error responses:**

| Scenario                 | Status | Body                                          |
| ------------------------ | ------ | --------------------------------------------- |
| Missing Authorization    | 401    | `{ "error": "Missing Authorization header" }` |
| Invalid token            | 401    | `{ "error": "Invalid token" }`                |

### 2.2 Layer 2: MCP Server → bank-api (Bot Auth Flow)

The MCP server authenticates to bank-api using the existing bot authentication system. No changes to bank-api are needed.

**Phase A — Verification requests (API token):**

Calls to `/api/v1/bot/verify/*` use the BOT employee API token:

```
Authorization: Bearer botk_<token>
```

The API token is stored in environment variable `BOT_API_TOKEN`.

**Phase B — Scoped access (bot session JWT):**

After successful customer verification, bank-api returns a `botSessionToken` (JWT, 15 min TTL). All subsequent calls to scoped endpoints use this token:

```
Authorization: Bearer <botSessionToken>
```

This token is scoped to a single customer and encodes both `customerId` and `botId`.

---

## 3. State Management

### Per-Session State

Each MCP session (one per Cognigy conversation) maintains its own state:

```typescript
interface SessionState {
  // Verification phase
  verificationSessionId?: string;

  // Post-verification phase
  botSessionToken?: string;
  customerId?: string;
  customerName?: string;
}
```

### How Sessions Work

1. Cognigy starts a conversation → first POST to `/mcp` has no `Mcp-Session-Id` header
2. MCP server creates a new `McpServer` instance + transport, generates a session ID
3. Session state is stored in an in-memory `Map<string, SessionState>` keyed by session ID
4. Subsequent requests from the same conversation include `Mcp-Session-Id` header → routed to same session
5. Session cleanup on DELETE or conversation end

### Concurrent Conversations

Multiple customers calling simultaneously get separate MCP sessions with separate state. Session A's `botSessionToken` is completely isolated from Session B. They never mix because each has a unique `Mcp-Session-Id`.

### Session Persistence

State is **in-memory only**. On server restart, all sessions are lost. This is acceptable because:

- Bot session tokens have a 15 min TTL anyway
- Cognigy detects broken sessions (HTTP 404) and re-initializes
- Customer re-verification on reconnect is correct banking behavior

### Session Expiry

Sessions should be cleaned up when:

- Cognigy sends a DELETE request (conversation ended)
- The bot session token expires (15 min TTL) — set a timer on creation
- A maximum session age of 30 minutes is reached (safety net)

---

## 4. MCP Tools

The server exposes 7 tools mapped to bank-api bot endpoints. Each tool has a name, description (used by the LLM to decide when to call it), Zod input schema, and handler.

### 4.1 `verify_start` — Start Customer Verification

Start identity verification by phone number. This must be called before any other banking tool.

**Input Schema:**

| Field         | Type   | Required | Description                                       |
| ------------- | ------ | -------- | ------------------------------------------------- |
| `phoneNumber` | string | yes      | Customer's phone number (e.g., "+15551234567")    |

**bank-api call:**

```
POST /api/v1/bot/verify/start
Authorization: Bearer botk_<BOT_API_TOKEN>
Body: { "phoneNumber": "<phoneNumber>" }
```

**Success response (from bank-api):**

```json
{
  "sessionId": "uuid",
  "status": "IN_PROGRESS",
  "question": {
    "id": "last_txn_amount",
    "text": "What was the amount of the customer's last transaction?"
  },
  "expiresAt": "2026-02-12T12:10:00.000Z"
}
```

**MCP handler logic:**

1. Call bank-api `/bot/verify/start`
2. Store `sessionId` in session state
3. Return the question to the AI agent as text content

**Tool return (text content for AI):**

```
Verification started. Ask the customer: "What was the amount of your last transaction?"
Session ID: <sessionId>
Question ID: last_txn_amount
```

**Error cases:**

| bank-api status | Meaning                     | Tool response                                  |
| --------------- | --------------------------- | ---------------------------------------------- |
| 404             | Phone number not found      | "No customer found with that phone number."    |
| 422             | Invalid phone format        | "Invalid phone number format."                 |

---

### 4.2 `verify_answer` — Answer a Verification Question

Submit the customer's answer to a verification question. May need to be called multiple times until status is VERIFIED or FAILED.

**Input Schema:**

| Field        | Type   | Required | Description                                     |
| ------------ | ------ | -------- | ----------------------------------------------- |
| `questionId` | string | yes      | ID of the question being answered               |
| `answer`     | string | yes      | Customer's answer                               |

Note: `sessionId` is NOT in the input schema — it is stored in session state from `verify_start`.

**bank-api call:**

```
POST /api/v1/bot/verify/answer
Authorization: Bearer botk_<BOT_API_TOKEN>
Body: { "sessionId": "<from state>", "questionId": "<questionId>", "answer": "<answer>" }
```

**Possible bank-api responses:**

Status: `IN_PROGRESS` — more questions needed:

```json
{
  "sessionId": "uuid",
  "status": "IN_PROGRESS",
  "correct": true,
  "confidence": 0.30,
  "nextQuestion": {
    "id": "account_number",
    "text": "What is one of the customer's account numbers?"
  }
}
```

Status: `VERIFIED` — customer identity confirmed:

```json
{
  "sessionId": "uuid",
  "status": "VERIFIED",
  "correct": true,
  "confidence": 0.80,
  "botSessionToken": "<jwt>",
  "expiresIn": 900,
  "customer": {
    "id": "uuid",
    "firstName": "Jane",
    "lastName": "Doe"
  }
}
```

Status: `FAILED` — verification failed:

```json
{
  "sessionId": "uuid",
  "status": "FAILED",
  "correct": false,
  "confidence": 0.25,
  "message": "Identity verification failed. Insufficient confidence score."
}
```

**MCP handler logic:**

1. Retrieve `sessionId` from session state (error if not present — `verify_start` must be called first)
2. Call bank-api `/bot/verify/answer`
3. If `VERIFIED`:
   - Store `botSessionToken`, `customerId`, and `customerName` in session state
   - Return success message with customer name
4. If `IN_PROGRESS`:
   - Return next question for the AI to ask
5. If `FAILED`:
   - Clear session state
   - Return failure message

**Tool return examples:**

IN_PROGRESS:
```
Answer was correct. Ask the customer the next question: "What is one of your account numbers?"
Question ID: account_number
Confidence: 30%
```

VERIFIED:
```
Customer identity verified successfully.
Customer: Jane Doe
You can now help them with their banking needs.
```

FAILED:
```
Identity verification failed. The customer could not be verified.
Please advise them to visit a branch or call the main support line.
```

---

### 4.3 `get_customer` — Get Customer Profile

Retrieve the verified customer's profile information.

**Input Schema:** (none — uses session state)

**Precondition:** Customer must be verified (botSessionToken in session state).

**bank-api call:**

```
GET /api/v1/bot/customer
Authorization: Bearer <botSessionToken>
```

**Response:**

```json
{
  "id": "uuid",
  "firstName": "Jane",
  "lastName": "Doe",
  "phone": "+15551234567",
  "email": "jane@example.com",
  "address": "123 Main St",
  "zipCode": "10001",
  "status": "ACTIVE"
}
```

**MCP handler logic:**

1. Check session state has `botSessionToken` (error if not — verification required)
2. Call bank-api `/bot/customer`
3. Format and return customer details

**Tool return:**

```
Customer Profile:
- Name: Jane Doe
- Phone: +15551234567
- Email: jane@example.com
- Address: 123 Main St, 10001
- Status: Active
```

---

### 4.4 `get_accounts` — List Customer Accounts

List all bank accounts for the verified customer.

**Input Schema:** (none)

**Precondition:** Customer must be verified.

**bank-api call:**

```
GET /api/v1/bot/accounts
Authorization: Bearer <botSessionToken>
```

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "accountNumber": "1234567890",
      "type": "CHECKING",
      "currency": "USD",
      "balance": 150000,
      "status": "ACTIVE",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**MCP handler logic:**

1. Check session state has `botSessionToken`
2. Call bank-api `/bot/accounts`
3. Format balances from cents to dollars (e.g., 150000 → $1,500.00)
4. Return formatted account list

**Tool return:**

```
Customer has 2 accounts:

1. Checking Account (****7890)
   Balance: $1,500.00
   Status: Active
   ID: <uuid>

2. Savings Account (****3456)
   Balance: $5,230.50
   Status: Active
   ID: <uuid>
```

---

### 4.5 `get_transactions` — Get Account Transactions

Get recent transactions for a specific account.

**Input Schema:**

| Field       | Type   | Required | Description                                             |
| ----------- | ------ | -------- | ------------------------------------------------------- |
| `accountId` | string | yes      | Account UUID (from `get_accounts` results)              |
| `limit`     | number | no       | Number of transactions to return (default: 10, max: 50) |
| `type`      | string | no       | Filter by type: DEPOSIT, WITHDRAWAL, TRANSFER_IN, etc.  |

**Precondition:** Customer must be verified.

**bank-api call:**

```
GET /api/v1/bot/accounts/<accountId>/transactions?limit=<limit>&type=<type>
Authorization: Bearer <botSessionToken>
```

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "type": "DEPOSIT",
      "amount": 50000,
      "description": "Payroll deposit",
      "status": "COMPLETED",
      "createdAt": "2026-02-10T14:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "totalPages": 5
  }
}
```

**MCP handler logic:**

1. Check session state has `botSessionToken`
2. Call bank-api `/bot/accounts/:id/transactions` with query params
3. Format amounts from cents to dollars
4. Return formatted transaction list

**Tool return:**

```
Recent transactions for account ****7890:

1. Feb 10, 2026 — Deposit: +$500.00 (Payroll deposit) — Completed
2. Feb 09, 2026 — Withdrawal: -$50.00 (ATM withdrawal) — Completed
3. Feb 08, 2026 — Transfer Out: -$200.00 (To savings) — Completed

Showing 3 of 45 total transactions.
```

---

### 4.6 `get_cards` — List Customer Cards

List all cards across the customer's accounts.

**Input Schema:** (none)

**Precondition:** Customer must be verified.

**bank-api call:**

```
GET /api/v1/bot/cards
Authorization: Bearer <botSessionToken>
```

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "accountId": "uuid",
      "maskedNumber": "****1234",
      "expiryDate": "2028-12-31T00:00:00.000Z",
      "type": "DEBIT",
      "status": "ACTIVE",
      "dailyLimit": 100000,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**MCP handler logic:**

1. Check session state has `botSessionToken`
2. Call bank-api `/bot/cards`
3. Format daily limits from cents to dollars
4. Return formatted card list

**Tool return:**

```
Customer has 2 cards:

1. Debit Card ****1234
   Status: Active
   Expires: 12/2028
   Daily Limit: $1,000.00
   ID: <uuid>

2. Debit Card ****5678
   Status: Blocked
   Expires: 06/2027
   Daily Limit: $500.00
   ID: <uuid>
```

---

### 4.7 `block_card` — Block a Card

Emergency card block. Only works on cards with ACTIVE status.

**Input Schema:**

| Field    | Type   | Required | Description                             |
| -------- | ------ | -------- | --------------------------------------- |
| `cardId` | string | yes      | Card UUID (from `get_cards` results)    |

**Precondition:** Customer must be verified.

**bank-api call:**

```
POST /api/v1/bot/cards/<cardId>/block
Authorization: Bearer <botSessionToken>
```

**Success response:**

```json
{
  "id": "uuid",
  "accountId": "uuid",
  "maskedNumber": "****1234",
  "type": "DEBIT",
  "status": "BLOCKED",
  "dailyLimit": 100000,
  "createdAt": "...",
  "updatedAt": "..."
}
```

**MCP handler logic:**

1. Check session state has `botSessionToken`
2. Call bank-api `/bot/cards/:id/block`
3. Return confirmation

**Error cases:**

| bank-api status | Meaning                         | Tool response                                              |
| --------------- | ------------------------------- | ---------------------------------------------------------- |
| 404             | Card not found or not owned     | "Card not found."                                          |
| 422             | Card is not ACTIVE              | "Cannot block this card — it is already blocked/expired."  |

**Tool return:**

```
Card ****1234 has been successfully blocked.
The card can no longer be used for transactions.
If the customer needs a replacement, advise them to visit a branch.
```

---

## 5. Shared Handler Patterns

### 5.1 Precondition Check

All scoped tools (4.3–4.7) must verify that the customer has been authenticated before making API calls:

```
1. Check if session state has botSessionToken
2. If not → return error: "Customer must be verified first. Use verify_start to begin identity verification."
3. If yes → proceed with API call
```

### 5.2 API Error Handling

All bank-api calls should handle errors consistently:

```
1. Call bank-api endpoint
2. If response.ok → parse JSON, format, return
3. If 401 → botSessionToken expired → clear session state, return:
   "Session expired. The customer needs to verify their identity again."
4. If 404 → return resource-specific "not found" message
5. If 422 → return validation error details
6. If 5xx → return: "Banking service is temporarily unavailable. Please try again."
```

### 5.3 Amount Formatting

All monetary values from bank-api are in **cents** (integers). The MCP server must convert to dollars for human-readable output:

```
150000 → "$1,500.00"
50 → "$0.50"
0 → "$0.00"
```

---

## 6. Project Structure

```
bank-mcp/
├── src/
│   ├── index.ts                 # Entry point: Hono app, MCP transport, auth middleware
│   ├── server.ts                # McpServer factory: creates server and registers all tools
│   ├── tools/
│   │   ├── verify.ts            # verify_start, verify_answer
│   │   ├── customer.ts          # get_customer
│   │   ├── accounts.ts          # get_accounts, get_transactions
│   │   └── cards.ts             # get_cards, block_card
│   └── lib/
│       ├── api-client.ts        # HTTP client wrapper for bank-api calls
│       ├── config.ts            # Environment variable loading and validation
│       ├── session.ts           # SessionState type + session store (Map)
│       └── format.ts            # Money formatting, date formatting utilities
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
└── SPEC.md                      # This file
```

---

## 7. File Specifications

### 7.1 `src/lib/config.ts`

Load and validate environment variables at startup. Throw if required vars are missing.

```typescript
interface Config {
  port: number;            // default: 3002
  mcpSecretToken: string;  // MCP_SECRET_TOKEN (required)
  botApiToken: string;     // BOT_API_TOKEN (required) — the botk_xxx token
  bankApiUrl: string;      // BANK_API_URL (required) — e.g., http://localhost:3001
}
```

### 7.2 `src/lib/api-client.ts`

A lightweight fetch wrapper for calling bank-api. Two methods:

- `botTokenRequest(method, path, body?)` — uses `BOT_API_TOKEN` header (for verify endpoints)
- `sessionRequest(method, path, sessionToken, body?)` — uses bot session JWT header (for scoped endpoints)

Both methods:
- Set `Content-Type: application/json`
- Parse JSON response
- Return `{ ok: boolean, status: number, data: any }` tuple
- Do NOT throw on HTTP errors (let the tool handlers decide how to respond)

### 7.3 `src/lib/session.ts`

Session state management:

```typescript
interface SessionState {
  verificationSessionId?: string;
  botSessionToken?: string;
  customerId?: string;
  customerName?: string;
  createdAt: number; // Date.now() — for expiry cleanup
}

// Map<mcpSessionId, SessionState>
// Includes cleanup function for expired sessions (> 30 min)
```

### 7.4 `src/lib/format.ts`

Utility functions:

- `formatCurrency(cents: number): string` — e.g., 150000 → "$1,500.00"
- `formatDate(iso: string): string` — e.g., "2026-02-10T14:30:00.000Z" → "Feb 10, 2026"
- `maskAccountNumber(num: string): string` — e.g., "1234567890" → "****7890"

### 7.5 `src/index.ts`

Entry point. Responsibilities:

1. Load config (fail fast if env vars missing)
2. Create Hono app
3. Add health check endpoint: `GET /health` → `{ "status": "ok" }`
4. Add auth middleware on `/mcp` route (validate MCP_SECRET_TOKEN)
5. Handle MCP protocol: `app.all('/mcp', ...)` using `StreamableHTTPTransport` from `@hono/mcp`
6. For each new session: create `McpServer` via `createServer()` from `server.ts`, create transport, connect, store in sessions map
7. For existing sessions: look up transport by `Mcp-Session-Id` header
8. Start server on configured port

### 7.6 `src/server.ts`

Factory function `createServer(sessionState: SessionState)` that:

1. Creates a new `McpServer` instance
2. Registers all 7 tools (importing from `tools/*.ts`)
3. Returns the server

The `sessionState` reference is passed to each tool registration so tools can read/write session state.

### 7.7 Tool Files (`src/tools/*.ts`)

Each file exports a function `registerXxxTools(server: McpServer, state: SessionState, apiClient: ApiClient)` that calls `server.registerTool()` for each tool in that group.

---

## 8. Environment Variables

| Variable           | Required | Example                          | Description                                      |
| ------------------ | -------- | -------------------------------- | ------------------------------------------------ |
| `PORT`             | no       | `3002`                           | Server port (default: 3002)                      |
| `MCP_SECRET_TOKEN` | yes      | `mcp_sk_a1b2c3d4e5f6...`        | Static bearer token for Cognigy → MCP auth       |
| `BOT_API_TOKEN`    | yes      | `botk_a1b2c3d4e5f6...`          | Bot employee API token for MCP → bank-api auth   |
| `BANK_API_URL`     | yes      | `http://localhost:3001`          | Base URL of bank-api                             |

### `.env.example`

```env
# MCP Server
PORT=3002

# Layer 1: Cognigy → MCP authentication
# Generate with: node -e "console.log('mcp_sk_' + require('crypto').randomBytes(32).toString('hex'))"
MCP_SECRET_TOKEN=

# Layer 2: MCP → bank-api authentication
# This is the bot employee API token created in bank-admin
BOT_API_TOKEN=

# bank-api connection
BANK_API_URL=http://localhost:3001
```

---

## 9. Dockerfile

Multi-stage build for production deployment on Coolify.

```dockerfile
# ── Build stage ──
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ──
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Non-root user
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001
USER mcpuser

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "dist/index.js"]
```

### Build and Run

```bash
# Build
docker build -t pony-bank-mcp .

# Run
docker run -d \
  --name bank-mcp \
  -p 3002:3002 \
  -e MCP_SECRET_TOKEN=your-secret \
  -e BOT_API_TOKEN=botk_your-token \
  -e BANK_API_URL=http://bank-api:3001 \
  pony-bank-mcp
```

### Coolify Deployment

1. Create a new service in Coolify
2. Source: Git repository or Dockerfile
3. Set Dockerfile path to `bank-mcp/Dockerfile`
4. Configure environment variables (MCP_SECRET_TOKEN, BOT_API_TOKEN, BANK_API_URL)
5. Set domain (e.g., `mcp.yourbank.com`) with HTTPS
6. If bank-api and bank-mcp are on the same Coolify server, use Docker network hostname for BANK_API_URL (e.g., `http://bank-api:3001`) to avoid public internet roundtrips
7. Deploy

---

## 10. Cognigy Configuration

### MCP Tool Node Setup

In the Cognigy Flow Editor:

1. Add an **AI Agent Node** to the flow
2. Inside the AI Agent, add an **MCP Tool Node**
3. Configure:
   - **Name:** `Pony Bank`
   - **MCP Server URL:** `https://mcp.yourbank.com/mcp`
   - **Timeout:** 30 seconds
   - **Authentication:** None (using Custom Headers instead)
   - **Custom Headers:**
     - Key: `Authorization`
     - Value: `Bearer <MCP_SECRET_TOKEN>` (same value as the server's env var)
4. Optionally whitelist specific tools for different flow sections

### AI Agent Instructions

The Cognigy AI Agent should be configured with instructions like:

```
You are a Pony Bank voice assistant. You help customers with their banking needs over the phone.

IMPORTANT RULES:
1. Always verify the customer's identity first using verify_start with their phone number.
2. Ask the verification questions naturally in conversation.
3. After verification, greet the customer by name.
4. Convert amounts to natural speech (say "fifteen hundred dollars" not "1500 cents").
5. Never read out full account IDs — use the last 4 digits of account numbers.
6. For card blocking, always confirm with the customer before proceeding.
7. If verification fails, politely direct the customer to visit a branch or call the main line.
```

---

## 11. Dependencies

### Production

```json
{
  "hono": "^4.11.9",
  "@hono/node-server": "^1.19.9",
  "@hono/mcp": "^0.2.3",
  "@modelcontextprotocol/sdk": "^1.12.0",
  "zod": "^3.24.0"
}
```

### Development

```json
{
  "@types/node": "^22.0.0",
  "tsx": "^4.7.1",
  "typescript": "^5.8.3"
}
```

---

## 12. Development Workflow

### Local Development

```bash
cd bank-mcp

# Install dependencies
npm install

# Create .env from example
cp .env.example .env
# Edit .env with your values

# Run in dev mode (hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

### Testing the MCP Server

The MCP server can be tested without Cognigy using any MCP client or raw HTTP:

```bash
# Health check
curl http://localhost:3002/health

# Initialize MCP session (raw HTTP)
curl -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <MCP_SECRET_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

### Prerequisites

Before running bank-mcp, ensure:

1. bank-api is running on the configured `BANK_API_URL`
2. A BOT employee has been created in bank-admin and the API token saved
3. The database is seeded with test customers (`npm run db:seed` in bank-api)
