/**
 * MCP Server for no_ui demo generator.
 * Exposes tools to list/get/create apps and analyze edit requests.
 * Auth: X-API-Key header checked against EXTERNAL_API_KEY env var.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Context } from "@hono/hono";
import Anthropic from "@anthropic-ai/sdk";
import {
  listApps,
  getApp,
  listEditRequests,
  logUsage,
  isAppDisabled,
} from "./db.ts";
import {
  generatePrd,
  generateErd,
  generateApp,
} from "./generate.ts";

const BASE_URL = "https://demo-generator.fly.dev";

function createMcpServerInstance(anthropicClient: Anthropic): McpServer {
  const server = new McpServer({
    name: "no_ui",
    version: "1.0.0",
  });

  // list_apps
  server.tool("list_apps", "List all demo apps", {}, async () => {
    const apps = listApps();
    const result = apps.map((a) => ({
      id: a.id,
      title: a.title,
      created_at: a.created_at,
      url: `${BASE_URL}/apps/${a.id}`,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // get_app
  server.tool(
    "get_app",
    "Get details of a specific app",
    { appId: z.string().describe("The app ID") },
    async ({ appId }) => {
      const record = getApp(appId);
      if (!record) {
        return { content: [{ type: "text" as const, text: "App not found" }], isError: true };
      }
      const disabledStatus = isAppDisabled(appId);
      const result = {
        id: record.id,
        title: record.title,
        description: record.description,
        prd: record.prd,
        erd: record.erd,
        disabled: disabledStatus.disabled,
        created_at: record.created_at,
        updated_at: record.updated_at,
        url: `${BASE_URL}/apps/${appId}`,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // create_app
  server.tool(
    "create_app",
    "Create a new demo app from a description. Returns the app ID and URL when complete.",
    {
      title: z.string().optional().describe("App title"),
      body: z.string().describe("App description / requirements"),
      context: z.string().optional().describe("Data & business context for realistic seed data generation"),
    },
    async ({ title, body, context }) => {
      if (!body) {
        return { content: [{ type: "text" as const, text: "body is required" }], isError: true };
      }

      const appTitle =
        title ||
        body
          .split("\n")[0]
          .replace(/^#+\s*/, "")
          .slice(0, 100) ||
        "Untitled App";

      try {
        // Generate PRD
        const prd = await generatePrd(body, appTitle, anthropicClient, undefined, context);
        // Generate ERD
        const erd = await generateErd(prd, appTitle, anthropicClient, undefined, context);
        // Generate App
        const result = await generateApp(
          { title: appTitle, body, prd, erd, context },
          anthropicClient
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                appId: result.appId,
                url: `${BASE_URL}/apps/${result.appId}`,
                credentials: result.credentials,
              }),
            },
          ],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "App creation failed";
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
    }
  );

  // list_edit_requests
  server.tool(
    "list_edit_requests",
    "List edit requests for an app",
    { appId: z.string().describe("The app ID") },
    async ({ appId }) => {
      const record = getApp(appId);
      if (!record) {
        return { content: [{ type: "text" as const, text: "App not found" }], isError: true };
      }
      const requests = listEditRequests(appId);
      return { content: [{ type: "text" as const, text: JSON.stringify(requests, null, 2) }] };
    }
  );

  // summarize_edit_requests
  server.tool(
    "summarize_edit_requests",
    "Get an AI summary of edit requests for an app",
    { appId: z.string().describe("The app ID") },
    async ({ appId }) => {
      const record = getApp(appId);
      if (!record) {
        return { content: [{ type: "text" as const, text: "App not found" }], isError: true };
      }

      const requests = listEditRequests(appId);
      if (requests.length === 0) {
        return { content: [{ type: "text" as const, text: "No edit requests to analyze." }] };
      }

      const requestList = requests
        .map(
          (r, i) =>
            `${i + 1}. [${r.username}, ${r.created_at}] ${r.description}`
        )
        .join("\n");

      try {
        const message = await anthropicClient.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `Summarize these edit requests from users of "${record.title}" demo app. Focus on: what features they want, what UX friction exists, and what it tells us about the prospect.\n\nEdit requests:\n${requestList}\n\nBe concise. Use bullet points.`,
            },
          ],
        });

        logUsage(
          appId,
          "edit-summary",
          "claude-sonnet-4-5-20250929",
          message.usage.input_tokens,
          message.usage.output_tokens
        );

        const summary =
          message.content[0].type === "text"
            ? message.content[0].text
            : "Unable to generate summary.";

        return { content: [{ type: "text" as const, text: summary }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Summary failed";
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
    }
  );

  return server;
}

/**
 * Handle MCP requests via Hono route handler.
 * Mount at POST /mcp in main.ts.
 */
export function createMcpHandler(anthropicClient: Anthropic) {
  const server = createMcpServerInstance(anthropicClient);

  return async (c: Context) => {
    // Auth check
    const apiKey = c.req.header("X-API-Key");
    const expected = Deno.env.get("EXTERNAL_API_KEY");
    if (!expected || apiKey !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      const body = await c.req.json();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless
      });

      await server.connect(transport);

      // Handle the JSON-RPC request
      const response = await transport.handleRequest(
        c.req.raw as unknown as Request,
        body
      );

      // Cleanup
      await server.close();

      if (response) {
        return response;
      }

      return c.json({ error: "No response from MCP server" }, 500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "MCP error";
      console.error("[mcp-server] Error:", msg);
      return c.json({ error: msg }, 500);
    }
  };
}
