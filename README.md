# PostgreSQL MCP Server

Safe, tool-based access to a **multi-tenant PostgreSQL** setup — for Cursor, Claude Desktop, or any [MCP](https://modelcontextprotocol.io) client.

One admin database holds tenant connection records. Every tenant gets its own isolated database. The agent discovers tenants, explores schemas, and runs queries — all through natural language, with reads and writes kept in separate tools so nothing destructive happens by accident.

**Stack:** TypeScript · Official MCP SDK · `pg` · stdio transport

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [Architecture](#architecture)
- [Tools](#tools)
- [Requirements](#requirements)
- [Setup](#setup)
- [Connect to an MCP client](#connect-to-an-mcp-client)
- [Environment variables](#environment-variables)
- [Example prompts](#example-prompts)
- [Project layout](#project-layout)
- [Security notes](#security-notes)
- [License](#license)

---



## Why this exists

In a multi-tenant architecture, every tenant's data lives in its own database — great for isolation, painful for day-to-day access. Checking a tenant's data normally means finding the right connection string, opening a DB client, and writing SQL by hand, every single time.

This server removes that friction. Point your MCP client at it, and you can ask things like *"which tenant has the most users?"* — the agent resolves the tenant, opens the right connection, and runs the query for you.

---



## Architecture

```
MCP Client (Cursor / Claude Desktop / etc.)
        │  stdio · JSON-RPC
        ▼
postgres-mcp-server (this repo)
        │
        ├── Admin DB  →  "Tenant" registry
        │                 (id, dbHost, dbName, dbUsername, dbPassword)
        │
        └── Tenant DBs → one connection pool per tenantId
                          (cached, max 3 connections each)
```

**How a request flows:**

1. On startup, the server opens a pool to the admin DB via `ADMIN_DATABASE_URL`.
2. When a tool call includes a `tenantId`, the server looks up that tenant's connection details in the `"Tenant"` table.
3. A dedicated pool is opened (or reused, if cached) for that tenant only.
4. Every data tool requires an explicit `tenantId` — there is no code path that spans two tenants in one query.

---



## Tools


| Tool             | Access | Purpose                                                                |
| ---------------- | ------ | ---------------------------------------------------------------------- |
| `list_tenants`   | Read   | List all tenants from the admin DB — your entry point for a `tenantId` |
| `list_tables`    | Read   | List tables in a tenant's database                                     |
| `describe_table` | Read   | Column names, types, nullability, defaults                             |
| `table_counts`   | Read   | Approximate row counts per table                                       |
| `query`          | Read   | Run `SELECT` / `WITH` statements (supports `$1, $2…` params)           |
| `admin_query`    | Read   | Run `SELECT` against the admin database itself                         |
| `execute`        | Write  | `INSERT` / `UPDATE` / `DELETE` — `WHERE` is required for update/delete |
| `execute_ddl`    | Schema | `CREATE` / `ALTER` / `DROP` / `TRUNCATE`                               |


Read, write, and schema operations are split into separate tools on purpose — you can disable an entire category (e.g. remove write access) by commenting out one tool registration.

---



## Requirements

- Node.js 18+
- An admin PostgreSQL database with a `"Tenant"` table (see below)
- Tenant databases reachable from the machine running the MCP client



### Admin `"Tenant"` table

```sql
CREATE TABLE IF NOT EXISTS "Tenant" (
  id             TEXT PRIMARY KEY,
  "dbHost"       TEXT NOT NULL,
  "dbName"       TEXT NOT NULL,
  "dbUsername"   TEXT NOT NULL,
  "dbPassword"   TEXT NOT NULL
);
```

Register a tenant:

```sql
INSERT INTO "Tenant" (id, "dbHost", "dbName", "dbUsername", "dbPassword")
VALUES ('tenant-001', 'db.example.com', 'my_tenant_db', 'db_user', 'db_password');
```

---



## Setup

```bash
git clone https://github.com/RISHAB-SIKKA/PostgreSQL-MCP-Server.git
cd PostgreSQL-MCP-Server
npm install
npm run build
```

**Quick smoke test** — the process should stay running:

```bash
export ADMIN_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/ADMIN_DB?sslmode=require"
node build/index.js
# → Multi-tenant Postgres MCP server running (stdio).
```

Press `Ctrl+C` to stop.

---



## Connect to an MCP client



### Cursor

Add to `~/.cursor/mcp.json` (or a project-level `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "postgres-db": {
      "command": "node",
      "args": ["/absolute/path/to/PostgreSQL-MCP-Server/build/index.js"],
      "env": {
        "ADMIN_DATABASE_URL": "postgresql://USER:PASSWORD@HOST:5432/ADMIN_DB?sslmode=require",
        "DB_PORT": "5432",
        "DATABASE_SCHEMA": "public",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

Open **Customize → MCPs**, confirm `postgres-db` shows as connected, then ask in Agent chat: *"List all tenants."*

### Claude Desktop

Add to `claude_desktop_config.json`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "postgres-db": {
      "command": "node",
      "args": ["/absolute/path/to/PostgreSQL-MCP-Server/build/index.js"],
      "env": {
        "ADMIN_DATABASE_URL": "postgresql://USER:PASSWORD@HOST:5432/ADMIN_DB?sslmode=require",
        "DB_PORT": "5432",
        "DATABASE_SCHEMA": "public"
      }
    }
  }
}
```

---



## Environment variables


| Variable                       | Required    | Default  | Notes                                                                                                           |
| ------------------------------ | ----------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `ADMIN_DATABASE_URL`           | Yes         | —        | Connection string for the admin database                                                                        |
| `DB_PORT`                      | Recommended | `5433`   | Port used for **all** tenant connections — set this to match your tenants                                       |
| `DATABASE_SCHEMA`              | No          | `public` | `search_path` applied to tenant pools                                                                           |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Sometimes   | —        | Set to `0` only if corporate TLS or a managed host fails cert verification (dev only — don't use in production) |


> **Port tip:** Tenant host, username, and password come from the `"Tenant"` table, but the port always comes from `DB_PORT`. If your tenants listen on a non-default port (e.g. `1186`), set `DB_PORT` accordingly — it applies to every tenant connection.

---



## Example prompts

- "List all tenants."
- "Show tables for tenant `tenant-001`."
- "Describe the `users` table for that tenant."
- "Run a read-only query counting rows created this month."
- "Which tenant has the most registered users?"

**Typical flow:** `list_tenants` → `list_tables` / `describe_table` → `query`

---



## Project layout

```
src/index.ts      # MCP server + tool definitions
build/            # tsc output (gitignored)
package.json
tsconfig.json
```

---



## Security notes

- `query` and `admin_query` are gated to `SELECT` / `WITH` only; `execute` refuses `UPDATE` / `DELETE` without a `WHERE` clause. These checks catch statement *type*, not injected SQL inside a statement — always pass values via `$1, $2…` params rather than string-concatenating them into `sql`.
- Tenant credentials (`dbPassword`) are stored in plaintext in the `"Tenant"` table. Consider encrypting at rest or moving to a secrets manager for production use.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate verification — fine for local dev against self-signed/managed hosts, but should never ship to production.
- `execute_ddl` has no confirmation step. If you don't need schema changes from the agent, comment out that tool registration.

---



## License

ISC