# Mastra Memory Sidecar

This service gives Buzz projects durable working memory, thread-scoped channel
observations, and bounded project-scoped semantic recall. It is an optional
sidecar: Buzz and ACP remain responsible for channels, agent routing, native
sessions, tools, and current conversation state.

The service exposes:

- `GET /health`
- `POST /context`
- `POST /memory`

All memory identifiers are derived from the caller-supplied community, project,
and channel scope. The Buzz integration must supply those values from trusted
relay and project resolution, not from message content.

## Local Development

Prerequisites are Node.js 22.13 or newer, pnpm, Docker, and a Codex CLI login
backed by the intended ChatGPT subscription.

Start the opt-in PostgreSQL 17 + pgvector service from the repository root:

```bash
docker compose --profile mastra-memory up -d mastra-postgres
```

Install dependencies and verify the Codex login without making a model call:

```bash
corepack pnpm install
corepack pnpm --filter @buzz/mastra-memory exec codex login status
```

The service reads process environment variables directly; it does not load an
`.env` file. In Bash, load the development defaults and start the service with:

```bash
cp services/mastra-memory/.env.example services/mastra-memory/.env
set -a
. services/mastra-memory/.env
set +a
corepack pnpm --filter @buzz/mastra-memory dev
```

In PowerShell, the checked-in defaults already match the Compose profile, so a
plain development start is sufficient:

```powershell
corepack.cmd pnpm --filter @buzz/mastra-memory dev
```

Verify the service:

```bash
curl http://127.0.0.1:4112/health
```

The `buzz-mastra-postgres-data` Docker volume preserves memory across service
and Buzz restarts. Removing that volume deletes the local memory database.

## Model Safety

Model specifications beginning with `codex/` use the Codex SDK and the existing
Codex subscription login. Observer and Reflector calls run with:

- read-only sandboxing in a temporary working directory
- approvals disabled
- shell, web, network, MCP servers, apps, plugins, and sub-agents disabled
- transcript and memory content labeled as untrusted data

Non-`codex/` model strings pass through to Mastra unchanged, allowing the
Observer and Reflector to move independently to another Mastra-supported model.
The service uses Mastra's built-in Observer and Reflector; it does not replace
them with a custom summarizer.

## API

`POST /context` accepts:

```json
{
  "communityId": "https://community.example",
  "projectId": "30621:owner:project",
  "channelId": "backend",
  "agentId": "codex",
  "sessionId": "session-b",
  "message": "Implement refresh-token rotation."
}
```

It returns separate bounded fields:

```json
{
  "projectMemory": "...",
  "channelMemory": "...",
  "relevantMemories": [],
  "estimatedTokens": 0
}
```

`POST /memory` accepts completed public turn data:

```json
{
  "communityId": "https://community.example",
  "projectId": "30621:owner:project",
  "channelId": "backend",
  "agentId": "codex",
  "sessionId": "session-b",
  "userMessage": "Implement refresh-token rotation.",
  "agentResponse": "Implemented and tested token rotation.",
  "toolEvents": [
    {
      "name": "tests",
      "status": "passed",
      "summary": "47 tests passed"
    }
  ],
  "metadata": {}
}
```

Tool events must contain summaries, not raw logs or file dumps. Private agent
reasoning must never be sent to this endpoint.

When `MASTRA_MEMORY_AUTH_TOKEN` is configured, every endpoint requires
`Authorization: Bearer <token>`. A non-loopback bind fails configuration unless
that token is present and at least 24 characters long.

## Configuration

| Variable | Default | Constraint |
|---|---|---|
| `MASTRA_MEMORY_BIND` | `127.0.0.1` | Non-loopback requires bearer auth |
| `MASTRA_MEMORY_PORT` | `4112` | `1..65535` |
| `MASTRA_MEMORY_DATABASE_URL` | Local Compose URL on port `5433` | PostgreSQL with pgvector |
| `MASTRA_MEMORY_SCHEMA` | `buzz_mastra_memory` | Lowercase SQL identifier |
| `MASTRA_MEMORY_AUTH_TOKEN` | unset | Minimum 24 characters when set |
| `MASTRA_OBSERVER_MODEL` | `codex/gpt-5.6-sol` | Non-empty model specification |
| `MASTRA_REFLECTOR_MODEL` | `codex/gpt-5.6-sol` | Non-empty model specification |
| `MASTRA_CODEX_PATH` | SDK default | Optional Codex executable path |
| `MASTRA_CODEX_WORKING_DIRECTORY` | OS temporary directory | Optional empty work directory |
| `MASTRA_CODEX_REASONING_EFFORT` | `low` | Codex-supported effort value |
| `MASTRA_OBSERVATION_MESSAGE_TOKENS` | `6000` | Observation threshold |
| `MASTRA_REFLECTION_OBSERVATION_TOKENS` | `12000` | Must exceed observation threshold |
| `MASTRA_PREVIOUS_OBSERVER_TOKENS` | `2000` | Prior observation context |
| `MASTRA_SEMANTIC_TOP_K` | `4` | `1..6` results |
| `MASTRA_PROJECT_TOKEN_BUDGET` | `1800` | Project working-memory budget |
| `MASTRA_CHANNEL_TOKEN_BUDGET` | `2200` | Channel observation budget |
| `MASTRA_SEMANTIC_TOKEN_BUDGET` | `1500` | Recall budget |
| `MASTRA_TOTAL_TOKEN_BUDGET` | `5500` | Maximum `6000`; cannot exceed component sum |
| `MASTRA_MAX_BODY_BYTES` | `262144` | HTTP request-body bound |
| `MASTRA_MAX_TURN_CHARS` | `65536` | Per-message persistence bound |

Current user instructions, repository state, and current configuration remain
more authoritative than any returned memory. Buzz must render returned fields in
a clearly delimited persistent-context block and continue normally when the
sidecar is unavailable.

## Verification

Run the complete package checks from the repository root:

```bash
corepack pnpm --filter @buzz/mastra-memory typecheck
corepack pnpm --filter @buzz/mastra-memory test
```

The integration suite uses persistent LibSQL and deterministic local embeddings,
so it validates restart continuity and isolation without a live model call.
