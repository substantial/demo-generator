/**
 * External data connections — query external PostgreSQL databases and REST APIs.
 */

import postgres from "postgres";
import { getAppConnection } from "./db.ts";

const QUERY_TIMEOUT_MS = 15_000;
const MAX_ROWS = 1000;

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface ApiResult {
  status: number;
  data: unknown;
}

/**
 * Execute a read-only SQL query against an external PostgreSQL database.
 */
export async function queryExternalDb(
  connectionId: string,
  sql: string,
  _params?: unknown[],
): Promise<QueryResult> {
  const conn = getAppConnection(connectionId);
  if (!conn) throw new Error("Connection not found");
  if (conn.type !== "postgresql") throw new Error(`Unsupported connection type: ${conn.type}`);
  if (!conn.connection_string) throw new Error("No connection string configured");

  // Validate read-only
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
    throw new Error("Only SELECT queries are allowed. Use SELECT or WITH ... SELECT.");
  }

  const client = postgres(conn.connection_string, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

    const result = await client.unsafe(`${sql} LIMIT ${MAX_ROWS}`);

    clearTimeout(timer);

    const rows = result as unknown as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  } finally {
    await client.end();
  }
}

/**
 * Fetch data from an external REST API.
 */
export async function fetchExternalApi(
  connectionId: string,
  path: string,
): Promise<ApiResult> {
  const conn = getAppConnection(connectionId);
  if (!conn) throw new Error("Connection not found");
  if (conn.type !== "rest_api") throw new Error(`Unsupported connection type for API fetch: ${conn.type}`);
  if (!conn.connection_string) throw new Error("No base URL configured");

  const config = JSON.parse(conn.config || "{}") as Record<string, unknown>;
  const baseUrl = conn.connection_string.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${cleanPath}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };

  if (config.api_key) {
    headers["Authorization"] = `Bearer ${config.api_key}`;
  }
  if (config.headers && typeof config.headers === "object") {
    Object.assign(headers, config.headers);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);

    let data: unknown;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return { status: res.status, data };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("API request timed out after 15 seconds");
    }
    throw e;
  }
}
