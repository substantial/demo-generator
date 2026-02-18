import { Hono } from "@hono/hono";
import {
  getApp,
  getAppSchema,
  validateRowData,
  insertRow,
  getRows,
  getRow,
  updateRow,
  deleteRow,
  getFullTableName,
  type ColumnDef,
} from "./db.ts";

const crud = new Hono();

function resolveTable(appId: string, table: string): { columns: ColumnDef[]; ftn: string } | null {
  const app = getApp(appId);
  if (!app) return null;
  const columns = getAppSchema(appId, table);
  if (!columns) return null;
  return { columns, ftn: getFullTableName(appId, table) };
}

// List rows (support both /tables/:table and /tables/:table/rows)
crud.get("/api/apps/:appId/tables/:table/rows", (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const rows = getRows(r.ftn, limit, offset);
  return c.json(rows);
});

crud.get("/api/apps/:appId/tables/:table", (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const rows = getRows(r.ftn, limit, offset);
  return c.json(rows);
});

// Get one row
crud.get("/api/apps/:appId/tables/:table/:id", (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const row = getRow(r.ftn, id);
  if (!row) return c.json({ error: "Row not found" }, 404);
  return c.json(row);
});

// Create row (support both /tables/:table and /tables/:table/rows)
crud.post("/api/apps/:appId/tables/:table/rows", async (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { valid, errors } = validateRowData(r.columns, body);
  if (!valid) return c.json({ error: "Validation failed", errors }, 400);

  const columnNames = new Set(r.columns.map((col) => col.name));
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (columnNames.has(k)) filtered[k] = v;
  }

  try {
    const lastId = insertRow(r.ftn, filtered);
    const row = getRow(r.ftn, lastId);
    return c.json(row, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Insert failed";
    return c.json({ error: msg }, 400);
  }
});

crud.post("/api/apps/:appId/tables/:table", async (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { valid, errors } = validateRowData(r.columns, body);
  if (!valid) return c.json({ error: "Validation failed", errors }, 400);

  const columnNames = new Set(r.columns.map((col) => col.name));
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (columnNames.has(k)) filtered[k] = v;
  }

  try {
    const lastId = insertRow(r.ftn, filtered);
    const row = getRow(r.ftn, lastId);
    return c.json(row, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Insert failed";
    return c.json({ error: msg }, 400);
  }
});

// Update row
crud.put("/api/apps/:appId/tables/:table/:id", async (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const existing = getRow(r.ftn, id);
  if (!existing) return c.json({ error: "Row not found" }, 404);

  const columnNames = new Set(r.columns.map((col) => col.name));
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (columnNames.has(k)) filtered[k] = v;
  }

  try {
    updateRow(r.ftn, id, filtered);
    const row = getRow(r.ftn, id);
    return c.json(row);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Update failed";
    return c.json({ error: msg }, 400);
  }
});

// Delete row
crud.delete("/api/apps/:appId/tables/:table/:id", (c) => {
  const r = resolveTable(c.req.param("appId"), c.req.param("table"));
  if (!r) return c.json({ error: "App or table not found" }, 404);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const existing = getRow(r.ftn, id);
  if (!existing) return c.json({ error: "Row not found" }, 404);

  deleteRow(r.ftn, id);
  return c.json({ ok: true });
});

export { crud };
