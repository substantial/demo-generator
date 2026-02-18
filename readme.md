# no_ui - AI App Generator

An AI-powered app generator. Give it a text description, get back a fully functional single-page web application complete with its own database tables, seed data, and CRUD API -- no human code required.

Built with Deno, Hono, SQLite, and Claude Sonnet 4.5.

## Running

```bash
deno run -N -E --unstable-temporal main.ts
```

Or with watch mode: `deno task dev`

### Environment Variables

Create a `.env` file with:

```
ANTHROPIC_API_KEY=       # Claude API key
CREDENTIALS=user,pass    # Login credentials (comma-separated)
JWT_SECRET=              # Secret for signing auth tokens
```

## Technical Overview

### How Code is Generated

**App generation** (`generate.ts`) takes a plain text description and sends it to Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) with a detailed system prompt instructing it to return **raw JSON** with this structure:

```json
{
  "tables": [
    { "name": "tablename", "columns": [{ "name": "col", "type": "TEXT|INTEGER|REAL|BOOLEAN" }] }
  ],
  "html": "<complete single-page web app as a single HTML string>",
  "seedData": { "tablename": [{ "col": "value" }, ...] }
}
```

The generated HTML is a self-contained single-page app -- inline CSS, inline JavaScript, CDN imports (Chart.js, D3, etc.) -- that makes `fetch()` calls to the generic CRUD API for all data operations. The LLM is given a 64,000-token budget for generation. If the response is truncated (hits `max_tokens`), a bracket-tracking JSON repair algorithm (`repairTruncatedJson`) attempts to close any open structures and salvage the output.

**App editing** reuses the same flow. `POST /api/apps/:appId/edit` sends Claude the current HTML, the full database schema, and a natural-language description of the requested changes. The response can include `newTables` and `newColumns` for schema evolution. Every served app page has a floating chat widget injected into it so users can request edits directly from the running app.

### How Code is Stored

Generated apps are stored as a single TEXT blob in the `apps` SQLite table. When a user hits `GET /apps/:appId`, the server reads the HTML from the database and serves it directly -- no filesystem, no build step. The main.ts route handler also injects a floating chat widget (inline HTML/CSS/JS) into every served app page before sending the response.

### How API Calls Work

The system has two layers of API:

**Platform API** (main.ts) -- routes for managing generation:
- `POST /api/apps` -- generate a new app from a text description
- `POST /api/apps/:appId/edit` -- AI-powered app editing

**Dynamic CRUD API** (crud.ts) -- a generic REST backend that every generated app calls:
- `GET    /api/apps/:appId/tables/:table` -- list rows (supports `?limit=` and `?offset=`)
- `GET    /api/apps/:appId/tables/:table/:id` -- get a single row
- `POST   /api/apps/:appId/tables/:table` -- create a row
- `PUT    /api/apps/:appId/tables/:table/:id` -- update a row
- `DELETE /api/apps/:appId/tables/:table/:id` -- delete a row

The CRUD layer uses `resolveTable()` to look up the app in `app_schemas`, verify the requested table exists for that app, and construct the real SQLite table name. Row data is validated against the stored schema (type-checked but lenient -- missing fields are allowed, types are coerced).

**Chat API** (chat.ts) -- two modes available at `/api/apps/:appId/chat` and `/api/apps/:appId/conversations/...`:
- **Stateless**: one-shot LLM call with a messages array. The system prompt automatically includes the app's full schema and all row data (up to 200 rows per table) so Claude can give data-specific answers.
- **Persistent conversations**: full CRUD for conversation threads with message history. All history is sent to Claude on each message.

The chat API supports model selection via short names (`haiku`, `sonnet`, `opus`) per-conversation or per-message.

### How Tables are Created and Managed

When a new app is generated, `createAppTables()` in `db.ts` does the following:

1. For each table in the LLM's JSON response, it creates a real SQLite table with a namespaced name: `app_{appIdWithoutDashes}_{tableName}`. This prevents collisions between apps.
2. Every table automatically gets an `id INTEGER PRIMARY KEY AUTOINCREMENT` column.
3. Column types from the LLM (`TEXT`, `INTEGER`, `REAL`, `BOOLEAN`) are mapped to SQLite types. `NOT NULL` is intentionally not enforced to be permissive with LLM-generated data.
4. Schema metadata is recorded in the `app_schemas` table as a JSON column list. This registry is what the CRUD layer and chat context builder use to know what tables and columns exist for each app.
5. Seed data from the LLM response is inserted into the newly created tables via `insertSeedData()`.

**Schema evolution during edits** is additive only:
- `ALTER TABLE ... ADD COLUMN` for new columns on existing tables
- `CREATE TABLE` for entirely new tables
- The `app_schemas` metadata is updated to reflect changes
- There is no column removal or table deletion

### Static Schema (Meta Tables)

These tables are created at startup and manage the platform itself:

| Table | Purpose |
|-------|---------|
| `apps` | Generated app records (id, title, HTML content) |
| `app_schemas` | Registry of all dynamically-created tables and their columns (JSON) |
| `conversations` | Chat conversation headers (model, system prompt, temperature) |
| `messages` | Chat message history |

### Authentication

JWT-based cookie auth (`auth.ts`). Credentials are stored in a single `CREDENTIALS` env var. On login, a 24-hour JWT is set as an `HttpOnly` cookie. The auth middleware protects all dashboard, API, and app routes -- HTML requests get redirected to `/login`, API requests get a 401.
