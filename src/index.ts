import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

// Admin DB connection
const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, ssl: { rejectUnauthorized: false }, });

const DB_PORT = process.env.DB_PORT ?? "5433";
const DB_SCHEMA = process.env.DATABASE_SCHEMA ?? "public";

// Tenant client connections cache
const tenantPools = new Map<string, pg.Pool>();

interface TenantRow {
    dbHost: string;
    dbName: string;
    dbUsername: string;
    dbPassword: string;
}

async function getTenantPool(tenantId: string): Promise<pg.Pool> {
    const cached = tenantPools.get(tenantId);
    if (cached) return cached;

    const res = await adminPool.query<TenantRow>(
        `SELECT "dbHost", "dbName", "dbUsername", "dbPassword"
     FROM "Tenant" WHERE id = $1`,
        [tenantId]
    );
    if (res.rowCount === 0) throw new Error(`Tenant with ID ${tenantId} not found.`);

    const t = res.rows[0];
    const pool = new Pool({
        host: t.dbHost,
        port: parseInt(DB_PORT, 10),
        database: t.dbName,
        user: t.dbUsername,
        password: t.dbPassword,
        max: 3,
        ssl: { rejectUnauthorized: false },
        options: `-c search_path=${DB_SCHEMA}`,
    });

    const client = await pool.connect();
    client.release();

    tenantPools.set(tenantId, pool);
    return pool;
}

function formatRows(rows: Record<string, unknown>[], limit = 200): string {
    if (rows.length === 0) return "(no rows)";
    const sliced = rows.slice(0, limit);
    const cols = Object.keys(sliced[0]);
    const lines = sliced.map((r) =>
        cols.map((c) => {
            const v = r[c];
            return v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
        }).join(" | ")
    );
    const truncated = rows.length > limit ? `\n... (${rows.length - limit} more rows truncated)` : "";
    return [cols.join(" | "), "-".repeat(40), ...lines].join("\n") + truncated;
}

function ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
}
function fail(err: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}


const server = new McpServer({ name: "clinic-multitenant-db", version: "1.0.0" });

// 1. List tenants
server.tool(
    "list_tenants",
    "List all tenants from the admin database with their IDs and database names. Use this first to find the tenantId for a clinic.",
    {},
    async () => {
        try {
            const res = await adminPool.query(
                `SELECT id, "dbName", "dbHost" FROM "Tenant" ORDER BY "dbName"`
            );
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);

// 2. List tables in a tenant's database
server.tool(
    "list_tables",
    "List all tables in a specific tenant's database.",
    { tenantId: z.string().describe("The tenant's ID from list_tenants") },
    async ({ tenantId }) => {
        try {
            const pool = await getTenantPool(tenantId);
            const res = await pool.query(
                `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 ORDER BY table_name`, [DB_SCHEMA]
            );
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);

// 3. Describe a table's structure
server.tool(
    "describe_table",
    "Show columns, types, nullability and defaults for a table in a tenant's database.",
    {
        tenantId: z.string(),
        tableName: z.string().describe("Table name to describe"),
    },
    async ({ tenantId, tableName }) => {
        try {
            const pool = await getTenantPool(tenantId);
            const res = await pool.query(
                `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`, [DB_SCHEMA, tableName]
            );
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);

// 4. Read-only query
server.tool(
    "query",
    "Run a read-only SELECT query against a tenant's database. Use $1, $2... placeholders with params for values.",
    {
        tenantId: z.string(),
        sql: z.string().describe("A SELECT statement"),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    },
    async ({ tenantId, sql, params }) => {
        try {
            if (!/^\s*(select|with)\b/i.test(sql)) {
                return fail(new Error("Only SELECT/WITH queries allowed here. Use 'execute' for writes."));
            }
            const pool = await getTenantPool(tenantId);
            const res = await pool.query(sql, params ?? []);
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);

// 5. Write operations (INSERT / UPDATE / DELETE)
server.tool(
    "execute",
    "Run a write statement (INSERT, UPDATE, DELETE) against a tenant's database. UPDATE and DELETE must include a WHERE clause. Returns affected row count. Use RETURNING * to see the rows.",
    {
        tenantId: z.string(),
        sql: z.string(),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    },
    async ({ tenantId, sql, params }) => {
        try {
            if (!/^\s*(insert|update|delete)\b/i.test(sql)) {
                return fail(new Error("Only INSERT/UPDATE/DELETE allowed here. Use 'query' for reads, 'execute_ddl' for schema changes."));
            }
            if (/^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql)) {
                return fail(new Error("Refusing UPDATE/DELETE without a WHERE clause."));
            }
            const pool = await getTenantPool(tenantId);
            const res = await pool.query(sql, params ?? []);
            const rows = res.rows?.length ? "\n" + formatRows(res.rows) : "";
            return ok(`OK — ${res.rowCount} row(s) affected.${rows}`);
        } catch (e) { return fail(e); }
    }
);

// 6. Schema changes (DDL)
server.tool(
    "execute_ddl",
    "Run a schema-change statement (CREATE/ALTER/DROP TABLE, CREATE INDEX, etc.) on a tenant's database. Use with care — DROP is destructive.",
    { tenantId: z.string(), sql: z.string() },
    async ({ tenantId, sql }) => {
        try {
            if (!/^\s*(create|alter|drop|truncate|comment)\b/i.test(sql)) {
                return fail(new Error("Only DDL statements allowed here."));
            }
            const pool = await getTenantPool(tenantId);
            await pool.query(sql);
            return ok("DDL executed successfully.");
        } catch (e) { return fail(e); }
    }
);

// 7. Quick row counts across all tables
server.tool(
    "table_counts",
    "Get approximate row counts for every table in a tenant's database.",
    { tenantId: z.string() },
    async ({ tenantId }) => {
        try {
            const pool = await getTenantPool(tenantId);
            const res = await pool.query(
                `SELECT relname AS table_name, n_live_tup AS approx_rows
         FROM pg_stat_user_tables ORDER BY n_live_tup DESC`
            );
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);

// 8. Query the ADMIN database (read-only)
server.tool(
    "admin_query",
    "Run a read-only SELECT against the main admin database (tenants, billing, etc.).",
    { sql: z.string() },
    async ({ sql }) => {
        try {
            if (!/^\s*(select|with)\b/i.test(sql)) return fail(new Error("SELECT only."));
            const res = await adminPool.query(sql);
            return ok(formatRows(res.rows));
        } catch (e) { return fail(e); }
    }
);


const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Multi-tenant Postgres MCP server running (stdio).");