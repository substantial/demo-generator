/**
 * REST API routes for managing external data connections.
 */

import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import {
  getApp,
  createAppConnection,
  getAppConnection,
  listAppConnections,
  deleteAppConnection,
} from "./db.ts";
import { queryExternalDb, fetchExternalApi } from "./connections.ts";

export function createConnectionRoutes(): Hono {
  const router = new Hono();

  // POST /api/apps/:appId/connections — create a connection
  router.post("/api/apps/:appId/connections", async (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: {
      type?: string;
      name?: string;
      connection_string?: string;
      config?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.type) return c.json({ error: "type is required" }, 400);
    if (!body.name) return c.json({ error: "name is required" }, 400);

    const validTypes = ["postgresql", "mysql", "rest_api"];
    if (!validTypes.includes(body.type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    const id = crypto.randomUUID();
    const conn = createAppConnection(
      id,
      appId,
      body.type,
      body.name,
      body.connection_string,
      body.config,
    );
    return c.json(conn, 201);
  });

  // GET /api/apps/:appId/connections — list connections
  router.get("/api/apps/:appId/connections", (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    const connections = listAppConnections(appId);
    // Redact connection strings for security
    const safe = connections.map((conn) => ({
      ...conn,
      connection_string: conn.connection_string
        ? conn.connection_string.replace(/\/\/[^@]+@/, "//***@")
        : null,
    }));
    return c.json(safe);
  });

  // DELETE /api/apps/:appId/connections/:connId — delete a connection
  router.delete("/api/apps/:appId/connections/:connId", (c: Context) => {
    const connId = c.req.param("connId");
    const conn = getAppConnection(connId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);
    deleteAppConnection(connId);
    return c.json({ ok: true });
  });

  // POST /api/apps/:appId/connections/:connId/test — test connectivity
  router.post("/api/apps/:appId/connections/:connId/test", async (c: Context) => {
    const connId = c.req.param("connId");
    const conn = getAppConnection(connId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);

    try {
      if (conn.type === "postgresql") {
        const result = await queryExternalDb(connId, "SELECT 1 AS ok");
        return c.json({ success: true, message: `Connected successfully. Got ${result.rowCount} row(s).` });
      } else if (conn.type === "rest_api") {
        const result = await fetchExternalApi(connId, "/");
        return c.json({ success: true, message: `Connected. Status: ${result.status}` });
      } else {
        return c.json({ error: `Testing not supported for type: ${conn.type}` }, 400);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Connection test failed";
      return c.json({ success: false, error: msg });
    }
  });

  // POST /api/apps/:appId/connections/:connId/query — execute read-only SQL
  router.post("/api/apps/:appId/connections/:connId/query", async (c: Context) => {
    const connId = c.req.param("connId");
    const conn = getAppConnection(connId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);

    if (conn.type !== "postgresql") {
      return c.json({ error: "Query is only supported for postgresql connections" }, 400);
    }

    let body: { sql?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.sql) return c.json({ error: "sql is required" }, 400);

    try {
      const result = await queryExternalDb(connId, body.sql);
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Query failed";
      return c.json({ error: msg }, 400);
    }
  });

  return router;
}
