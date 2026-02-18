import { Database } from "@db/sqlite";

const db = new Database("data.db");

// Enable WAL mode for better concurrency
db.exec("PRAGMA journal_mode=WAL");

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
    .prepare("SELECT app_id, username, password FROM app_credentials WHERE username = ?")
    .get(username) as { app_id: string; username: string; password: string } | undefined;
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

export function listAppsWithCredentials(): {
  id: string;
  title: string;
  github_issue_url: string;
  created_at: string;
  cred_username: string | null;
  cred_password: string | null;
}[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.github_issue_url, a.created_at,
              ac.username AS cred_username, ac.password AS cred_password
       FROM apps a
       LEFT JOIN app_credentials ac ON a.id = ac.app_id
       ORDER BY a.created_at DESC`,
    )
    .all() as {
    id: string;
    title: string;
    github_issue_url: string;
    created_at: string;
    cred_username: string | null;
    cred_password: string | null;
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
    [id, appId, title, systemPrompt ?? null, model ?? "sonnet", temperature ?? null],
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
  return row ? row as unknown as ConversationRecord : null;
}

export function listConversations(appId: string): {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}[] {
  return db.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE app_id = ? ORDER BY updated_at DESC",
  ).all(appId) as { id: string; title: string; created_at: string; updated_at: string }[];
}

export function addMessage(
  conversationId: string,
  role: string,
  content: string,
): number {
  const id = db.prepare(
    `INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`,
  ).run(conversationId, role, content);
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
  return db.prepare(
    "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC",
  ).all(conversationId) as { id: number; role: string; content: string; created_at: string }[];
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
  const row = db.prepare(
    "SELECT columns FROM app_schemas WHERE app_id = ? AND table_name = ?",
  ).get(appId, tableName) as { columns: string } | undefined;
  return row ? JSON.parse(row.columns) : null;
}

export function getAllAppSchemas(
  appId: string,
): { tableName: string; columns: ColumnDef[] }[] {
  const rows = db.prepare(
    "SELECT table_name, columns FROM app_schemas WHERE app_id = ?",
  ).all(appId) as { table_name: string; columns: string }[];
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

export function insertRow(
  ftn: string,
  data: Record<string, unknown>,
): number {
  const keys = Object.keys(data);
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => data[k]) as (string | number | boolean | null)[];
  const result = db.prepare(
    `INSERT INTO "${ftn}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders})`,
  ).run(...values);
  return result;
}

export function getRows(
  ftn: string,
  limit = 100,
  offset = 0,
): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM "${ftn}" LIMIT ? OFFSET ?`).all(
    limit,
    offset,
  ) as Record<string, unknown>[];
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
  const values = keys.map((k) => data[k]) as (string | number | boolean | null)[];
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
): void {
  db.exec(
    `INSERT INTO apps (id, github_issue_url, title, html) VALUES (?, ?, ?, ?)`,
    [id, issueUrl, title, html],
  );
}

export function getApp(
  id: string,
): {
  id: string;
  github_issue_url: string;
  title: string;
  html: string;
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

export function updateAppHtml(appId: string, html: string): void {
  db.exec(
    `UPDATE apps SET html = ?, updated_at = datetime('now') WHERE id = ?`,
    [html, appId],
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
  db.exec(
    `ALTER TABLE "${ftn}" ADD COLUMN "${col.name}" ${sqlType(col.type)}${defaultClause}`,
  );

  // Update schema metadata
  const existing = getAppSchema(appId, tableName) ?? [];
  existing.push(col);
  db.exec(
    `UPDATE app_schemas SET columns = ? WHERE app_id = ? AND table_name = ?`,
    [JSON.stringify(existing), appId, tableName],
  );
}

export { db };
