import { Hono } from "@hono/hono";
import { streamSSE } from "@hono/hono/streaming";
import type { Context, Next } from "@hono/hono";
import Anthropic from "@anthropic-ai/sdk";
import {
  listApps,
  getApp,
  listEditRequests,
  saveEditRequest,
  logUsage,
  isAppDisabled,
} from "./db.ts";
import {
  generatePrd,
  generateErd,
  generateApp,
  editApp,
  type EditProgressEvent,
} from "./generate.ts";

const BASE_URL = "https://demo-generator.fly.dev";

function externalApiAuth(c: Context, next: Next) {
  const apiKey = c.req.header("X-API-Key");
  const expected = Deno.env.get("EXTERNAL_API_KEY");
  if (!expected || apiKey !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

export function createExternalApiRoutes(anthropicClient: Anthropic): Hono {
  const api = new Hono();

  api.use("*", externalApiAuth);

  // GET /api/external/apps — list all apps
  api.get("/api/external/apps", (c) => {
    const apps = listApps();
    const result = apps.map((a) => {
      const full = getApp(a.id);
      return {
        id: a.id,
        title: a.title,
        description: full?.description ?? "",
        created_at: a.created_at,
        disabled: full
          ? Boolean((full as Record<string, unknown>).disabled)
          : false,
        url: `${BASE_URL}/apps/${a.id}`,
      };
    });
    return c.json(result);
  });

  // GET /api/external/apps/:appId — get app details
  api.get("/api/external/apps/:appId", (c) => {
    const appId = c.req.param("appId");
    const record = getApp(appId);
    if (!record) return c.json({ error: "App not found" }, 404);

    const disabledStatus = isAppDisabled(appId);

    return c.json({
      id: record.id,
      title: record.title,
      description: record.description,
      prd: record.prd,
      erd: record.erd,
      html: record.html,
      disabled: disabledStatus.disabled,
      created_at: record.created_at,
      updated_at: record.updated_at,
      url: `${BASE_URL}/apps/${appId}`,
    });
  });

  // POST /api/external/apps — create a new app (SSE stream)
  api.post("/api/external/apps", async (c) => {
    let body: { title?: string; body?: string; context?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.body) {
      return c.json({ error: "body (app description) is required" }, 400);
    }

    const title =
      body.title ||
      body.body
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .slice(0, 100) ||
      "Untitled App";
    const description = body.body;
    const context = body.context;

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: "prd",
          data: JSON.stringify({
            step: "prd",
            message: "Generating Product Requirements...",
          }),
        });
        const prd = await generatePrd(description, title, anthropicClient, undefined, context);
        await stream.writeSSE({
          event: "prd_complete",
          data: JSON.stringify({
            step: "prd_complete",
            message: "PRD complete",
          }),
        });

        await stream.writeSSE({
          event: "erd",
          data: JSON.stringify({
            step: "erd",
            message: "Generating Engineering Requirements...",
          }),
        });
        const erd = await generateErd(prd, title, anthropicClient, undefined, context);
        await stream.writeSSE({
          event: "erd_complete",
          data: JSON.stringify({
            step: "erd_complete",
            message: "ERD complete",
          }),
        });

        await stream.writeSSE({
          event: "generating",
          data: JSON.stringify({
            step: "generating",
            message: "Building app from requirements...",
          }),
        });
        const result = await generateApp(
          { title, body: description, prd, erd, context },
          anthropicClient
        );

        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify({
            step: "complete",
            appId: result.appId,
            credentials: result.credentials,
            url: `${BASE_URL}/apps/${result.appId}`,
          }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "App generation failed";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ step: "error", message: msg }),
        });
      }
    });
  });

  // POST /api/external/apps/:appId/edit — edit an existing app (SSE stream)
  api.post("/api/external/apps/:appId/edit", async (c) => {
    const appId = c.req.param("appId");
    const record = getApp(appId);
    if (!record) return c.json({ error: "App not found" }, 404);

    let body: { instruction?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.instruction) {
      return c.json({ error: "instruction is required" }, 400);
    }

    saveEditRequest(appId, "external-api", body.instruction);

    return streamSSE(c, async (stream) => {
      try {
        await editApp(
          appId,
          body.instruction!,
          anthropicClient,
          async (event: EditProgressEvent) => {
            await stream.writeSSE({
              event: event.step,
              data: JSON.stringify(event),
            });
          }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Edit failed";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ step: "error", message: msg }),
        });
      }
    });
  });

  // GET /api/external/apps/:appId/edit-requests — list edit requests
  api.get("/api/external/apps/:appId/edit-requests", (c) => {
    const appId = c.req.param("appId");
    const record = getApp(appId);
    if (!record) return c.json({ error: "App not found" }, 404);
    return c.json(listEditRequests(appId));
  });

  // POST /api/external/apps/:appId/edit-requests/summary — AI summary
  api.post(
    "/api/external/apps/:appId/edit-requests/summary",
    async (c) => {
      const appId = c.req.param("appId");
      const record = getApp(appId);
      if (!record) return c.json({ error: "App not found" }, 404);

      const requests = listEditRequests(appId);
      if (requests.length === 0) {
        return c.json({ summary: "No edit requests to analyze." });
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
        return c.json({ summary });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Summary failed";
        return c.json({ error: msg }, 500);
      }
    }
  );

  return api;
}
