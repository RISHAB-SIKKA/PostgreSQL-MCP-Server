# PostgreSQL MCP Server

Give Cursor (or any MCP client) safe, tool-based access to a **multi-tenant Postgres** setup: one admin database that stores tenant connection info, plus isolated databases per tenant.

Stack: **TypeScript**, official **MCP SDK**, and **`pg`**. Transport: **stdio**.

---

## What you get

Ask in natural language — the agent calls tools for you:

- Discover tenants and pick a `tenantId`
- Inspect schemas, row counts, and run `SELECT`s
- Optionally write data or run DDL (separate tools so reads stay safe by default)

---

## How it works

```
Cursor Agent
    │  stdio / JSON-RPC
    ▼
postgres-mcp-server (this repo)
    │
    ├── Admin DB  →  "Tenant" registry
    │                 (id, dbHost, dbName, dbUsername, dbPassword)
    │
    └── Tenant DBs → one connection pool per tenantId (cached, max 3)
```

1. On start, connect to the admin DB via `ADMIN_DATABASE_URL`.
2. When a tool passes `tenantId`, look up that row in `"Tenant"`.
3. Open (or reuse) a pool for that tenant only — no cross-tenant queries.

---

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `list_tenants` | Read | List tenants from admin DB |
| `list_tables` | Read | Tables in a tenant DB |
| `describe_table` | Read | Column metadata |
| `table_counts` | Read | Approximate row counts |
| `query` | Read | `SELECT` / `WITH` (with `$1` params) |
| `admin_query` | Read | `SELECT` on the admin DB |
| `execute` | Write | `INSERT` / `UPDATE` / `DELETE` (`WHERE` required for update/delete) |
| `execute_ddl` | Schema | `CREATE` / `ALTER` / `DROP` / … |

---

## Requirements

- Node.js 18+
- An admin Postgres database with a `"Tenant"` table (see below)
- Tenant databases reachable from the machine running Cursor

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

Quick check (process should stay running):

```bash
export ADMIN_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/ADMIN_DB?sslmode=require"
node build/index.js
# → Multi-tenant Postgres MCP server running (stdio).
```

---

## Connect in Cursor

Add to `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

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

Then open **Customize → MCPs**, confirm `postgres-db` is connected, and ask in Agent chat: *List all tenants*.

### Environment variables

| Variable | Required | Default in code | Notes |
| --- | --- | --- | --- |
| `ADMIN_DATABASE_URL` | Yes | — | Admin DB connection string |
| `DB_PORT` | Recommended | `5433` | Port used for **all** tenant connections — set this to match your tenants |
| `DATABASE_SCHEMA` | No | `public` | `search_path` for tenant pools |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Sometimes | — | Set to `0` if corporate TLS / managed hosts fail cert verification (dev only) |

> **Port tip:** Tenant host/user/password come from `"Tenant"`, but the port always comes from `DB_PORT`. If tenants listen on `1186` or another non-default port, set `DB_PORT` accordingly.

---

## Example prompts

- List all tenants  
- Show tables for tenant `tenant-001`  
- Describe table `users` for that tenant  
- Run a read-only query counting rows created this month  

Typical flow: `list_tenants` → `list_tables` / `describe_table` → `query`.

---

## Project layout

```
src/index.ts      # MCP server + tools
build/            # tsc output (gitignored)
package.json
tsconfig.json
```

---

## License

ISC
