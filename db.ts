import { Database } from "@db/sqlite";

const dbPath = Deno.env.get("DATABASE_PATH") || "data.db";
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.exec("PRAGMA journal_mode=WAL");

// Migration: add description column (idempotent)
try {
  db.exec(`ALTER TABLE apps ADD COLUMN description TEXT DEFAULT ''`);
} catch {
  // Column already exists
}

// Migration: add PRD/ERD/POC plan columns
try { db.exec(`ALTER TABLE apps ADD COLUMN prd TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE apps ADD COLUMN erd TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE apps ADD COLUMN poc_plan TEXT DEFAULT ''`); } catch {}

// Migration: add disabled/disabled_reason columns
try { db.exec(`ALTER TABLE apps ADD COLUMN disabled INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE apps ADD COLUMN disabled_reason TEXT DEFAULT ''`); } catch {}

// Create meta tables
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    github_issue_url TEXT NOT NULL,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_schemas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    columns TEXT NOT NULL,
    UNIQUE(app_id, table_name)
  )
`);

// Conversation persistence for LLM chat
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New conversation',
    system_prompt TEXT,
    model TEXT NOT NULL DEFAULT 'sonnet',
    temperature REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Agent system tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    static_prompt TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'sonnet',
    temperature REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS guidelines (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_guidelines (
    agent_id TEXT NOT NULL,
    guideline_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, guideline_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    agent_id TEXT NOT NULL,
    mcp_server_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, mcp_server_id)
  )
`);

// Migration: add agent_id column to conversations (nullable for backward compat)
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT`);
} catch {
  // Column already exists
}

// UX lessons learned from edit requests
db.exec(`
  CREATE TABLE IF NOT EXISTS ux_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson TEXT NOT NULL,
    source_app_id TEXT,
    source_edit_description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Edit requests from non-root users
db.exec(`
  CREATE TABLE IF NOT EXISTS edit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    username TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// App credentials for per-app auth
db.exec(`
  CREATE TABLE IF NOT EXISTS app_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Usage tracking for API spend
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_dollars REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// === Spend Tracking ===

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4 },
  "gpt-4o": { input: 2.50, output: 10 },
};

const SPEND_LIMIT = 50; // dollars

export function logUsage(
  appId: string,
  endpoint: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const pricing = MODEL_PRICING[model] ?? { input: 3, output: 15 }; // default to sonnet pricing
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  db.exec(
    `INSERT INTO usage_log (app_id, endpoint, model, input_tokens, output_tokens, cost_dollars) VALUES (?, ?, ?, ?, ?, ?)`,
    [appId, endpoint, model, inputTokens, outputTokens, cost],
  );

  // Auto-disable if spend exceeds limit
  const totalSpend = getAppSpend(appId);
  if (totalSpend > SPEND_LIMIT) {
    const status = isAppDisabled(appId);
    if (!status.disabled) {
      disableApp(appId, `Auto-disabled: spend exceeded $${SPEND_LIMIT}`);
      console.log(`[spend] App ${appId} auto-disabled at $${totalSpend.toFixed(2)}`);
    }
  }
}

export function getAppSpend(appId: string): number {
  const row = db
    .prepare("SELECT SUM(cost_dollars) as total FROM usage_log WHERE app_id = ?")
    .get(appId) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

export function getAllAppSpends(): Record<string, number> {
  const rows = db
    .prepare("SELECT app_id, SUM(cost_dollars) as total FROM usage_log GROUP BY app_id")
    .all() as { app_id: string; total: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.app_id] = row.total;
  }
  return result;
}

export function disableApp(appId: string, reason: string): void {
  db.exec(`UPDATE apps SET disabled = 1, disabled_reason = ? WHERE id = ?`, [reason, appId]);
}

export function enableApp(appId: string): void {
  db.exec(`UPDATE apps SET disabled = 0, disabled_reason = '' WHERE id = ?`, [appId]);
}

export function isAppDisabled(appId: string): { disabled: boolean; reason: string } {
  const row = db
    .prepare("SELECT disabled, disabled_reason FROM apps WHERE id = ?")
    .get(appId) as { disabled: number; disabled_reason: string } | undefined;
  if (!row) return { disabled: false, reason: "" };
  return { disabled: row.disabled === 1, reason: row.disabled_reason || "" };
}

export function saveAppCredentials(
  appId: string,
  username: string,
  password: string,
): void {
  db.exec(
    `INSERT INTO app_credentials (app_id, username, password) VALUES (?, ?, ?)`,
    [appId, username, password],
  );
}

export function getAppCredentialsByUsername(
  username: string,
): { app_id: string; username: string; password: string } | null {
  const row = db
    .prepare(
      "SELECT app_id, username, password FROM app_credentials WHERE username = ?",
    )
    .get(username) as
    | { app_id: string; username: string; password: string }
    | undefined;
  return row ?? null;
}

export function getAppCredentials(
  appId: string,
): { username: string; password: string } | null {
  const row = db
    .prepare("SELECT username, password FROM app_credentials WHERE app_id = ?")
    .get(appId) as { username: string; password: string } | undefined;
  return row ?? null;
}

export function updateAppCredentials(
  appId: string,
  username: string,
  password: string,
): void {
  db.exec(`DELETE FROM app_credentials WHERE app_id = ?`, [appId]);
  db.exec(
    `INSERT INTO app_credentials (app_id, username, password) VALUES (?, ?, ?)`,
    [appId, username, password],
  );
}

export function deleteAppCredentials(appId: string): void {
  db.exec(`DELETE FROM app_credentials WHERE app_id = ?`, [appId]);
}

export function deleteApp(appId: string): void {
  // Find dynamic tables for this app
  const schemas = db
    .prepare("SELECT table_name FROM app_schemas WHERE app_id = ?")
    .all(appId) as { table_name: string }[];

  // Drop dynamic tables
  for (const schema of schemas) {
    const ftn = fullTableName(appId, schema.table_name);
    db.exec(`DROP TABLE IF EXISTS "${ftn}"`);
  }

  // Delete from meta tables
  db.exec(`DELETE FROM app_schemas WHERE app_id = ?`, [appId]);
  db.exec(`DELETE FROM app_credentials WHERE app_id = ?`, [appId]);
  // Delete conversations and messages for this app
  const convos = db
    .prepare("SELECT id FROM conversations WHERE app_id = ?")
    .all(appId) as { id: string }[];
  for (const conv of convos) {
    db.exec(`DELETE FROM messages WHERE conversation_id = ?`, [conv.id]);
  }
  db.exec(`DELETE FROM conversations WHERE app_id = ?`, [appId]);

  // Delete agent system data for this app
  const agentIds = db
    .prepare("SELECT id FROM agents WHERE app_id = ?")
    .all(appId) as { id: string }[];
  for (const agent of agentIds) {
    db.exec(`DELETE FROM agent_guidelines WHERE agent_id = ?`, [agent.id]);
    db.exec(`DELETE FROM agent_mcp_servers WHERE agent_id = ?`, [agent.id]);
  }
  db.exec(`DELETE FROM agents WHERE app_id = ?`, [appId]);

  const guidelineIds = db
    .prepare("SELECT id FROM guidelines WHERE app_id = ?")
    .all(appId) as { id: string }[];
  for (const g of guidelineIds) {
    db.exec(`DELETE FROM agent_guidelines WHERE guideline_id = ?`, [g.id]);
  }
  db.exec(`DELETE FROM guidelines WHERE app_id = ?`, [appId]);

  const mcpServerIds = db
    .prepare("SELECT id FROM mcp_servers WHERE app_id = ?")
    .all(appId) as { id: string }[];
  for (const s of mcpServerIds) {
    db.exec(`DELETE FROM agent_mcp_servers WHERE mcp_server_id = ?`, [s.id]);
  }
  db.exec(`DELETE FROM mcp_servers WHERE app_id = ?`, [appId]);

  db.exec(`DELETE FROM usage_log WHERE app_id = ?`, [appId]);
  db.exec(`DELETE FROM apps WHERE id = ?`, [appId]);
}

export function listAppsWithCredentials(): {
  id: string;
  title: string;
  description: string;
  prd: string;
  erd: string;
  poc_plan: string;
  github_issue_url: string;
  created_at: string;
  cred_username: string | null;
  cred_password: string | null;
  disabled: number;
  disabled_reason: string;
}[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.description, a.prd, a.erd, a.poc_plan, a.github_issue_url, a.created_at,
              a.disabled, a.disabled_reason,
              ac.username AS cred_username, ac.password AS cred_password
       FROM apps a
       LEFT JOIN app_credentials ac ON a.id = ac.app_id
       ORDER BY a.created_at DESC`,
    )
    .all() as {
    id: string;
    title: string;
    description: string;
    prd: string;
    erd: string;
    poc_plan: string;
    github_issue_url: string;
    created_at: string;
    cred_username: string | null;
    cred_password: string | null;
    disabled: number;
    disabled_reason: string;
  }[];
}

// Conversation helpers
export function createConversation(
  id: string,
  appId: string,
  title: string,
  systemPrompt?: string,
  model?: string,
  temperature?: number,
): void {
  db.exec(
    `INSERT INTO conversations (id, app_id, title, system_prompt, model, temperature) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      appId,
      title,
      systemPrompt ?? null,
      model ?? "sonnet",
      temperature ?? null,
    ],
  );
}

export interface ConversationRecord {
  id: string;
  app_id: string;
  title: string;
  system_prompt: string | null;
  model: string;
  temperature: number | null;
  created_at: string;
  updated_at: string;
}

export function getConversation(id: string): ConversationRecord | null {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? (row as unknown as ConversationRecord) : null;
}

export function listConversations(appId: string): {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}[] {
  return db
    .prepare(
      "SELECT id, title, created_at, updated_at FROM conversations WHERE app_id = ? ORDER BY updated_at DESC",
    )
    .all(appId) as {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
  }[];
}

export function addMessage(
  conversationId: string,
  role: string,
  content: string,
): number {
  const id = db
    .prepare(
      `INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`,
    )
    .run(conversationId, role, content);
  db.exec(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
    [conversationId],
  );
  return id;
}

export function getMessages(conversationId: string): {
  id: number;
  role: string;
  content: string;
  created_at: string;
}[] {
  return db
    .prepare(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC",
    )
    .all(conversationId) as {
    id: number;
    role: string;
    content: string;
    created_at: string;
  }[];
}

export function updateConversationTitle(id: string, title: string): void {
  db.exec(
    `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`,
    [title, id],
  );
}

export function deleteConversation(id: string): void {
  db.exec(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
  db.exec(`DELETE FROM conversations WHERE id = ?`, [id]);
}

export interface ColumnDef {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL" | "BOOLEAN";
  nullable?: boolean;
  default?: string | number | null;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
}

function sqlType(colType: string): string {
  switch (colType.toUpperCase()) {
    case "TEXT":
      return "TEXT";
    case "INTEGER":
      return "INTEGER";
    case "REAL":
      return "REAL";
    case "BOOLEAN":
      return "INTEGER";
    default:
      return "TEXT";
  }
}

function fullTableName(appId: string, tableName: string): string {
  const shortId = appId.replace(/-/g, "");
  return `app_${shortId}_${tableName}`;
}

export function createAppTables(appId: string, tables: TableDef[]): void {
  for (const table of tables) {
    const ftn = fullTableName(appId, table.name);
    const colDefs = table.columns.map((col) => {
      let def = `"${col.name}" ${sqlType(col.type)}`;
      // Don't enforce NOT NULL — generated HTML may omit fields
      if (col.default !== undefined && col.default !== null) {
        def += ` DEFAULT ${typeof col.default === "string" ? `'${col.default}'` : col.default}`;
      }
      return def;
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS "${ftn}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${colDefs.join(",\n        ")}
      )
    `);

    // Save schema metadata
    db.exec(
      `INSERT OR REPLACE INTO app_schemas (app_id, table_name, columns) VALUES (?, ?, ?)`,
      [appId, table.name, JSON.stringify(table.columns)],
    );
  }
}

export function getAppSchema(
  appId: string,
  tableName: string,
): ColumnDef[] | null {
  const row = db
    .prepare(
      "SELECT columns FROM app_schemas WHERE app_id = ? AND table_name = ?",
    )
    .get(appId, tableName) as { columns: string } | undefined;
  return row ? JSON.parse(row.columns) : null;
}

export function getAllAppSchemas(
  appId: string,
): { tableName: string; columns: ColumnDef[] }[] {
  const rows = db
    .prepare("SELECT table_name, columns FROM app_schemas WHERE app_id = ?")
    .all(appId) as { table_name: string; columns: string }[];
  return rows.map((r) => ({
    tableName: r.table_name,
    columns: JSON.parse(r.columns),
  }));
}

export function validateRowData(
  columns: ColumnDef[],
  data: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  // Only type-check fields that are present — let SQLite enforce NOT NULL constraints
  for (const col of columns) {
    const val = data[col.name];
    if (val === undefined || val === null) continue;
    switch (col.type.toUpperCase()) {
      case "INTEGER":
      case "BOOLEAN":
        if (typeof val !== "number" && typeof val !== "boolean") {
          errors.push(`${col.name} must be a number`);
        }
        break;
      case "REAL":
        if (typeof val !== "number") {
          errors.push(`${col.name} must be a number`);
        }
        break;
      case "TEXT":
        // Coerce numbers/booleans to string silently rather than rejecting
        break;
    }
  }
  return { valid: errors.length === 0, errors };
}

export function insertRow(ftn: string, data: Record<string, unknown>): number {
  const keys = Object.keys(data);
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => data[k]) as (
    | string
    | number
    | boolean
    | null
  )[];
  const result = db
    .prepare(
      `INSERT INTO "${ftn}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders})`,
    )
    .run(...values);
  return result;
}

export function getRows(
  ftn: string,
  limit = 100,
  offset = 0,
): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM "${ftn}" LIMIT ? OFFSET ?`)
    .all(limit, offset) as Record<string, unknown>[];
}

export function getRow(
  ftn: string,
  id: number,
): Record<string, unknown> | null {
  const row = db.prepare(`SELECT * FROM "${ftn}" WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

export function updateRow(
  ftn: string,
  id: number,
  data: Record<string, unknown>,
): boolean {
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  const values = keys.map((k) => data[k]) as (
    | string
    | number
    | boolean
    | null
  )[];
  db.prepare(`UPDATE "${ftn}" SET ${setClauses} WHERE id = ?`).run(
    ...values,
    id,
  );
  return true;
}

export function deleteRow(ftn: string, id: number): boolean {
  db.prepare(`DELETE FROM "${ftn}" WHERE id = ?`).run(id);
  return true;
}

export function getFullTableName(appId: string, tableName: string): string {
  return fullTableName(appId, tableName);
}

// App record helpers
export function saveApp(
  id: string,
  issueUrl: string,
  title: string,
  html: string,
  description?: string,
  prd?: string,
  erd?: string,
): void {
  db.exec(
    `INSERT INTO apps (id, github_issue_url, title, html, description, prd, erd) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, issueUrl, title, html, description ?? "", prd ?? "", erd ?? ""],
  );
}

export function getApp(id: string): {
  id: string;
  github_issue_url: string;
  title: string;
  html: string;
  description: string;
  prd: string;
  erd: string;
  poc_plan: string;
  created_at: string;
  updated_at: string;
} | null {
  const row = db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as
    | Record<string, string>
    | undefined;
  return row
    ? (row as {
        id: string;
        github_issue_url: string;
        title: string;
        html: string;
        description: string;
        prd: string;
        erd: string;
        poc_plan: string;
        created_at: string;
        updated_at: string;
      })
    : null;
}

export function listApps(): {
  id: string;
  title: string;
  github_issue_url: string;
  created_at: string;
}[] {
  return db
    .prepare(
      "SELECT id, title, github_issue_url, created_at FROM apps ORDER BY created_at DESC",
    )
    .all() as {
    id: string;
    title: string;
    github_issue_url: string;
    created_at: string;
  }[];
}

export function updateAppTitle(appId: string, title: string): void {
  db.exec(
    `UPDATE apps SET title = ?, updated_at = datetime('now') WHERE id = ?`,
    [title, appId],
  );
}

export function updateAppHtml(appId: string, html: string): void {
  db.exec(
    `UPDATE apps SET html = ?, updated_at = datetime('now') WHERE id = ?`,
    [html, appId],
  );
}

export function updateAppPrd(appId: string, prd: string): void {
  db.exec(
    `UPDATE apps SET prd = ?, updated_at = datetime('now') WHERE id = ?`,
    [prd, appId],
  );
}

export function updateAppErd(appId: string, erd: string): void {
  db.exec(
    `UPDATE apps SET erd = ?, updated_at = datetime('now') WHERE id = ?`,
    [erd, appId],
  );
}

export function updateAppPocPlan(appId: string, pocPlan: string): void {
  db.exec(
    `UPDATE apps SET poc_plan = ?, updated_at = datetime('now') WHERE id = ?`,
    [pocPlan, appId],
  );
}

export function addColumnToTable(
  appId: string,
  tableName: string,
  col: ColumnDef,
): void {
  const ftn = fullTableName(appId, tableName);
  const defaultClause =
    col.default !== undefined && col.default !== null
      ? ` DEFAULT ${typeof col.default === "string" ? `'${col.default}'` : col.default}`
      : "";
  try {
    db.exec(
      `ALTER TABLE "${ftn}" ADD COLUMN "${col.name}" ${sqlType(col.type)}${defaultClause}`,
    );
  } catch {
    // Column already exists — ignore
    return;
  }

  // Update schema metadata
  const existing = getAppSchema(appId, tableName) ?? [];
  existing.push(col);
  db.exec(
    `UPDATE app_schemas SET columns = ? WHERE app_id = ? AND table_name = ?`,
    [JSON.stringify(existing), appId, tableName],
  );
}

// === Edit Requests ===

export function saveEditRequest(
  appId: string,
  username: string,
  description: string,
): void {
  db.exec(
    `INSERT INTO edit_requests (app_id, username, description) VALUES (?, ?, ?)`,
    [appId, username, description],
  );
}

export function listEditRequests(appId: string): {
  id: number;
  app_id: string;
  username: string;
  description: string;
  created_at: string;
}[] {
  return db
    .prepare(
      "SELECT * FROM edit_requests WHERE app_id = ? ORDER BY created_at DESC",
    )
    .all(appId) as {
    id: number;
    app_id: string;
    username: string;
    description: string;
    created_at: string;
  }[];
}

export function deleteEditRequest(id: number): void {
  db.exec(`DELETE FROM edit_requests WHERE id = ?`, [id]);
}

// === UX Lessons ===

export function saveUxLesson(
  lesson: string,
  sourceAppId?: string,
  sourceEditDescription?: string,
): void {
  db.exec(
    `INSERT INTO ux_lessons (lesson, source_app_id, source_edit_description) VALUES (?, ?, ?)`,
    [lesson, sourceAppId ?? null, sourceEditDescription ?? null],
  );
}

export function listUxLessons(): {
  id: number;
  lesson: string;
  source_app_id: string | null;
  source_edit_description: string | null;
  created_at: string;
}[] {
  return db
    .prepare("SELECT * FROM ux_lessons ORDER BY created_at ASC")
    .all() as {
    id: number;
    lesson: string;
    source_app_id: string | null;
    source_edit_description: string | null;
    created_at: string;
  }[];
}

export function deleteUxLesson(id: number): void {
  db.exec(`DELETE FROM ux_lessons WHERE id = ?`, [id]);
}

export function listAllEditRequests(): {
  id: number;
  app_id: string;
  username: string;
  description: string;
  created_at: string;
}[] {
  return db
    .prepare("SELECT * FROM edit_requests ORDER BY created_at DESC")
    .all() as {
    id: number;
    app_id: string;
    username: string;
    description: string;
    created_at: string;
  }[];
}

// === Agent CRUD ===

export interface AgentRecord {
  id: string;
  app_id: string;
  name: string;
  static_prompt: string;
  model: string;
  temperature: number | null;
  created_at: string;
  updated_at: string;
}

export function createAgent(
  id: string,
  appId: string,
  name: string,
  staticPrompt: string,
  model?: string,
  temperature?: number,
): void {
  db.exec(
    `INSERT INTO agents (id, app_id, name, static_prompt, model, temperature) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, appId, name, staticPrompt, model ?? "sonnet", temperature ?? null],
  );
}

export function getAgent(id: string): AgentRecord | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? (row as unknown as AgentRecord) : null;
}

export function listAgents(appId: string): AgentRecord[] {
  return db
    .prepare("SELECT * FROM agents WHERE app_id = ? ORDER BY created_at DESC")
    .all(appId) as unknown as AgentRecord[];
}

export function updateAgent(
  id: string,
  fields: {
    name?: string;
    static_prompt?: string;
    model?: string;
    temperature?: number;
  },
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.static_prompt !== undefined) {
    sets.push("static_prompt = ?");
    vals.push(fields.static_prompt);
  }
  if (fields.model !== undefined) {
    sets.push("model = ?");
    vals.push(fields.model);
  }
  if (fields.temperature !== undefined) {
    sets.push("temperature = ?");
    vals.push(fields.temperature);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.exec(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export function deleteAgent(agentId: string): void {
  db.exec(`DELETE FROM agent_guidelines WHERE agent_id = ?`, [agentId]);
  db.exec(`DELETE FROM agent_mcp_servers WHERE agent_id = ?`, [agentId]);
  // Delete conversations and messages tied to this agent
  const convos = db
    .prepare("SELECT id FROM conversations WHERE agent_id = ?")
    .all(agentId) as { id: string }[];
  for (const conv of convos) {
    db.exec(`DELETE FROM messages WHERE conversation_id = ?`, [conv.id]);
  }
  db.exec(`DELETE FROM conversations WHERE agent_id = ?`, [agentId]);
  db.exec(`DELETE FROM agents WHERE id = ?`, [agentId]);
}

// === Guideline CRUD ===

export interface GuidelineRecord {
  id: string;
  app_id: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function createGuideline(
  id: string,
  appId: string,
  name: string,
  content: string,
): void {
  db.exec(
    `INSERT INTO guidelines (id, app_id, name, content) VALUES (?, ?, ?, ?)`,
    [id, appId, name, content],
  );
}

export function getGuideline(id: string): GuidelineRecord | null {
  const row = db.prepare("SELECT * FROM guidelines WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? (row as unknown as GuidelineRecord) : null;
}

export function listGuidelines(appId: string): GuidelineRecord[] {
  return db
    .prepare(
      "SELECT * FROM guidelines WHERE app_id = ? ORDER BY created_at DESC",
    )
    .all(appId) as unknown as GuidelineRecord[];
}

export function updateGuideline(
  id: string,
  fields: { name?: string; content?: string },
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.content !== undefined) {
    sets.push("content = ?");
    vals.push(fields.content);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.exec(`UPDATE guidelines SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export function deleteGuideline(id: string): void {
  db.exec(`DELETE FROM agent_guidelines WHERE guideline_id = ?`, [id]);
  db.exec(`DELETE FROM guidelines WHERE id = ?`, [id]);
}

// === MCP Server CRUD ===

export interface McpServerRecord {
  id: string;
  app_id: string;
  name: string;
  url: string;
  api_key: string | null;
  created_at: string;
  updated_at: string;
}

export function createMcpServer(
  id: string,
  appId: string,
  name: string,
  url: string,
  apiKey?: string,
): void {
  db.exec(
    `INSERT INTO mcp_servers (id, app_id, name, url, api_key) VALUES (?, ?, ?, ?, ?)`,
    [id, appId, name, url, apiKey ?? null],
  );
}

export function getMcpServer(id: string): McpServerRecord | null {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? (row as unknown as McpServerRecord) : null;
}

export function listMcpServers(appId: string): McpServerRecord[] {
  return db
    .prepare(
      "SELECT * FROM mcp_servers WHERE app_id = ? ORDER BY created_at DESC",
    )
    .all(appId) as unknown as McpServerRecord[];
}

export function updateMcpServer(
  id: string,
  fields: { name?: string; url?: string; api_key?: string },
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.url !== undefined) {
    sets.push("url = ?");
    vals.push(fields.url);
  }
  if (fields.api_key !== undefined) {
    sets.push("api_key = ?");
    vals.push(fields.api_key);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.exec(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export function deleteMcpServer(id: string): void {
  db.exec(`DELETE FROM agent_mcp_servers WHERE mcp_server_id = ?`, [id]);
  db.exec(`DELETE FROM mcp_servers WHERE id = ?`, [id]);
}

// === Junction Table Helpers ===

export function linkAgentGuideline(agentId: string, guidelineId: string): void {
  db.exec(
    `INSERT OR IGNORE INTO agent_guidelines (agent_id, guideline_id) VALUES (?, ?)`,
    [agentId, guidelineId],
  );
}

export function unlinkAgentGuideline(
  agentId: string,
  guidelineId: string,
): void {
  db.exec(
    `DELETE FROM agent_guidelines WHERE agent_id = ? AND guideline_id = ?`,
    [agentId, guidelineId],
  );
}

export function getAgentGuidelines(agentId: string): GuidelineRecord[] {
  return db
    .prepare(
      `SELECT g.* FROM guidelines g
       INNER JOIN agent_guidelines ag ON g.id = ag.guideline_id
       WHERE ag.agent_id = ?
       ORDER BY g.created_at ASC`,
    )
    .all(agentId) as unknown as GuidelineRecord[];
}

export function linkAgentMcpServer(agentId: string, mcpServerId: string): void {
  db.exec(
    `INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)`,
    [agentId, mcpServerId],
  );
}

export function unlinkAgentMcpServer(
  agentId: string,
  mcpServerId: string,
): void {
  db.exec(
    `DELETE FROM agent_mcp_servers WHERE agent_id = ? AND mcp_server_id = ?`,
    [agentId, mcpServerId],
  );
}

export function getAgentMcpServers(agentId: string): McpServerRecord[] {
  return db
    .prepare(
      `SELECT s.* FROM mcp_servers s
       INNER JOIN agent_mcp_servers ams ON s.id = ams.mcp_server_id
       WHERE ams.agent_id = ?
       ORDER BY s.created_at ASC`,
    )
    .all(agentId) as unknown as McpServerRecord[];
}

// === Agent-scoped conversation helpers ===

export function createAgentConversation(
  id: string,
  appId: string,
  agentId: string,
  title: string,
): void {
  db.exec(
    `INSERT INTO conversations (id, app_id, agent_id, title, model) VALUES (?, ?, ?, ?, 'sonnet')`,
    [id, appId, agentId, title],
  );
}

export function listAgentConversations(agentId: string): {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}[] {
  return db
    .prepare(
      "SELECT id, title, created_at, updated_at FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC",
    )
    .all(agentId) as {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
  }[];
}

export { db };
