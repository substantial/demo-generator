import { Hono } from "@hono/hono";
import { streamSSE } from "@hono/hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { load } from "@std/dotenv";
import { verify } from "@hono/hono/jwt";
import { getCookie } from "@hono/hono/cookie";
import { loginHandler, logoutHandler, authMiddleware, requireRoot, requireAppAccess, generateMagicLinkToken, magicLinkHandler } from "./auth.ts";
import { listAppsWithCredentials, getApp, deleteApp, updateAppCredentials, deleteAppCredentials, getAppCredentials, updateAppTitle, updateAppPrd, updateAppErd, updateAppPocPlan, saveEditRequest, listEditRequests, listAllEditRequests, deleteEditRequest, saveUxLesson, listUxLessons, deleteUxLesson } from "./db.ts";
import { generateApp, editApp, extractUxLesson, generatePrd, generateErd, regenerateApp, generatePocPlan, type EditProgressEvent } from "./generate.ts";
import { crud } from "./crud.ts";
import { createChatRoutes } from "./chat.ts";
import { createAgentRoutes } from "./agents.ts";

// Load environment variables from .env file (local dev)
const env = await load();

// Merge .env values into Deno.env (no-op in production where .env doesn't exist)
for (const [k, v] of Object.entries(env)) {
  Deno.env.set(k, v);
}

// Use Deno.env.get() so both .env (local) and Fly secrets (production) work
const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const openaiClient = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

type AppEnv = {
  Variables: {
    user: string;
    role: string;
    appId: string;
  };
};

const app = new Hono<AppEnv>();

// Global error handler — always return JSON for API routes
app.onError((err, c) => {
  console.error(`[server] Unhandled error:`, err);
  const msg = err instanceof Error ? err.message : "Internal Server Error";
  return c.json({ error: msg }, 500);
});

// 404 handler — return JSON for API routes
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.text("Not Found", 404);
});

// --- Public routes ---
app.get("/login", async (c) => {
  const html = await Deno.readTextFile("static/login.html");
  return c.html(html);
});

app.post("/auth/login", loginHandler);
app.get("/auth/logout", logoutHandler);

// --- Public per-app routes (no auth) ---
app.get("/apps/:appId/magic", magicLinkHandler);

app.get("/apps/:appId/login", async (c) => {
  const appId = c.req.param("appId");
  const creds = getAppCredentials(appId);
  if (!creds) return c.redirect(`/apps/${appId}`);
  const record = getApp(appId);
  const title = record?.title ?? "App";
  let html = await Deno.readTextFile("static/app-login.html");
  html = html.replace(/\{\{APP_ID\}\}/g, appId);
  html = html.replace(/\{\{APP_TITLE\}\}/g, title);
  return c.html(html);
});

// --- Dashboard: root only ---
app.use("/dashboard", authMiddleware, requireRoot);

app.get("/", (c) => c.redirect("/dashboard"));

app.get("/dashboard", async (c) => {
  const html = await Deno.readTextFile("static/dashboard.html");
  return c.html(html);
});

// --- Dashboard app detail page: root only ---
app.use("/dashboard/apps/*", authMiddleware, requireRoot);

app.get("/dashboard/apps/:appId", async (c) => {
  const html = await Deno.readTextFile("static/app-detail.html");
  return c.html(html);
});

app.get("/dashboard/apps/:appId/prd", async (c) => {
  const html = await Deno.readTextFile("static/app-prd.html");
  return c.html(html);
});

app.get("/dashboard/apps/:appId/erd", async (c) => {
  const html = await Deno.readTextFile("static/app-erd.html");
  return c.html(html);
});

app.get("/dashboard/apps/:appId/poc-plan", async (c) => {
  const html = await Deno.readTextFile("static/app-poc-plan.html");
  return c.html(html);
});

// --- API routes: root only ---
app.get("/api/apps", authMiddleware, requireRoot, (c) => {
  const apps = listAppsWithCredentials();
  return c.json(apps);
});

app.post("/api/apps", authMiddleware, requireRoot, async (c) => {
  let body: { title?: string; body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.body) {
    return c.json({ error: "body (app description) is required" }, 400);
  }

  const title = body.title || body.body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 100) || "Untitled App";
  const description = body.body;

  return streamSSE(c, async (stream) => {
    try {
      // Stage 1: Generate PRD
      await stream.writeSSE({ event: "prd", data: JSON.stringify({ step: "prd", message: "Generating Product Requirements..." }) });
      const prd = await generatePrd(description, title, client);
      await stream.writeSSE({ event: "prd_complete", data: JSON.stringify({ step: "prd_complete", message: "PRD complete" }) });

      // Stage 2: Generate ERD
      await stream.writeSSE({ event: "erd", data: JSON.stringify({ step: "erd", message: "Generating Engineering Requirements..." }) });
      const erd = await generateErd(prd, title, client);
      await stream.writeSSE({ event: "erd_complete", data: JSON.stringify({ step: "erd_complete", message: "ERD complete" }) });

      // Stage 3: Generate App
      await stream.writeSSE({ event: "generating", data: JSON.stringify({ step: "generating", message: "Building app from requirements..." }) });
      const result = await generateApp({ title, body: description, prd, erd }, client);

      // Stage 4: Complete
      await stream.writeSSE({ event: "complete", data: JSON.stringify({ step: "complete", appId: result.appId, credentials: result.credentials }) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "App generation failed";
      await stream.writeSSE({ event: "error", data: JSON.stringify({ step: "error", message: msg }) });
    }
  });
});

app.post("/api/apps/:appId/edit", authMiddleware, requireAppAccess, async (c) => {
  const appId = c.req.param("appId");
  let body: { description?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.description) {
    return c.json({ error: "description is required" }, 400);
  }

  const role = c.get("role");

  // Non-root users: save the request for tracking, then execute the edit
  if (role !== "root") {
    const username = c.get("user") || "unknown";
    saveEditRequest(appId, username, body.description);
  }

  const description = body.description;

  return streamSSE(c, async (stream) => {
    try {
      await editApp(appId, description, client, async (event: EditProgressEvent) => {
        await stream.writeSSE({ event: event.step, data: JSON.stringify(event) });
      });

      // Fire-and-forget: extract UX lesson from this edit
      extractUxLesson(description, client).then((lesson) => {
        if (lesson) {
          saveUxLesson(lesson, appId, description);
          console.log(`[ux-lessons] Learned: "${lesson}"`);
        }
      }).catch(() => {});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Edit failed";
      await stream.writeSSE({ event: "error", data: JSON.stringify({ step: "error", message: msg }) });
    }
  });
});

// --- Root-only: view edit requests ---
app.get("/api/apps/:appId/edit-requests", authMiddleware, requireRoot, (c) => {
  const appId = c.req.param("appId");
  return c.json(listEditRequests(appId));
});

app.get("/api/edit-requests", authMiddleware, requireRoot, (c) => {
  return c.json(listAllEditRequests());
});

app.post("/api/apps/:appId/edit-requests/:requestId/delete", authMiddleware, requireRoot, (c) => {
  const requestId = parseInt(c.req.param("requestId"), 10);
  if (isNaN(requestId)) return c.json({ error: "Invalid request ID" }, 400);
  deleteEditRequest(requestId);
  return c.json({ ok: true });
});

// --- Root-only: AI summary of edit requests ---
app.post("/api/apps/:appId/edit-requests/summary", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  const requests = listEditRequests(appId);
  if (requests.length === 0) {
    return c.json({ summary: "No edit requests to analyze." });
  }

  const requestList = requests.map((r, i) =>
    `${i + 1}. [${r.username}, ${r.created_at}] ${r.description}`
  ).join("\n");

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `You are analyzing edit requests from users of a demo app called "${record.title}". These users are prospects evaluating our platform.

Here are all the edit requests:

${requestList}

Analyze these requests to help us understand this prospect:

1. **Features & Capabilities** — What features/capabilities is this prospect looking for? What do they need the app to do?
2. **UX Friction** — What UX patterns are causing friction? What expectations aren't being met?
3. **Prospect Needs** — What does this tell us about the prospect's business needs and whether they'd convert to a paying customer?
4. **Actionable Recommendations** — What should our product team prioritize based on this feedback?

Be concise and actionable. Use bullet points and markdown formatting.`,
    }],
  });

  const summary = message.content[0].type === "text" ? message.content[0].text : "Unable to generate summary.";
  return c.json({ summary });
});

// --- Root-only: UX lessons management ---
app.get("/api/ux-lessons", authMiddleware, requireRoot, (c) => {
  return c.json(listUxLessons());
});

app.post("/api/ux-lessons/:id/delete", authMiddleware, requireRoot, (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lesson ID" }, 400);
  deleteUxLesson(id);
  return c.json({ ok: true });
});

// --- Root-only: delete app ---
app.post("/api/apps/:appId/delete", authMiddleware, requireRoot, (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  try {
    deleteApp(appId);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Delete failed";
    return c.json({ error: msg }, 500);
  }
});

// --- Root-only: update app metadata (title) ---
app.post("/api/apps/:appId/title", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  let body: { title?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.title || !body.title.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  try {
    updateAppTitle(appId, body.title.trim());
    return c.json({ ok: true, title: body.title.trim() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Update failed";
    return c.json({ error: msg }, 500);
  }
});

// --- Root-only: credential management ---
app.post("/api/apps/:appId/credentials", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  try {
    updateAppCredentials(appId, body.username, body.password);
    return c.json({ ok: true, username: body.username, password: body.password });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Credential update failed";
    return c.json({ error: msg }, 500);
  }
});

app.post("/api/apps/:appId/credentials/delete", authMiddleware, requireRoot, (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  try {
    deleteAppCredentials(appId);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Delete credentials failed";
    return c.json({ error: msg }, 500);
  }
});

// --- Root-only: generate magic link ---
app.post("/api/apps/:appId/magic-link", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const creds = getAppCredentials(appId);
  if (!creds) {
    return c.json({ error: "No credentials set for this app. Add credentials first." }, 400);
  }

  const token = await generateMagicLinkToken(appId, creds.username, creds.password);
  const host = c.req.header("Host") ?? "localhost";
  const proto = c.req.header("X-Forwarded-Proto") ?? "http";
  const url = `${proto}://${host}/apps/${appId}/magic?token=${token}`;
  return c.json({ url });
});

// --- Root-only: PRD/ERD/POC management ---
app.post("/api/apps/:appId/prd", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  let body: { prd?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (body.prd === undefined) return c.json({ error: "prd is required" }, 400);
  updateAppPrd(appId, body.prd);
  return c.json({ ok: true });
});

app.post("/api/apps/:appId/erd", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  let body: { erd?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (body.erd === undefined) return c.json({ error: "erd is required" }, 400);
  updateAppErd(appId, body.erd);
  return c.json({ ok: true });
});

app.post("/api/apps/:appId/generate-prd", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  try {
    const prd = await generatePrd(record.description, record.title, client);
    updateAppPrd(appId, prd);
    return c.json({ ok: true, prd });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "PRD generation failed";
    return c.json({ error: msg }, 500);
  }
});

app.post("/api/apps/:appId/generate-erd", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  try {
    // Auto-generate PRD first if none exists
    let prd = record.prd;
    let prdGenerated = false;
    if (!prd) {
      prd = await generatePrd(record.description, record.title, client);
      updateAppPrd(appId, prd);
      prdGenerated = true;
    }
    const erd = await generateErd(prd, record.title, client);
    updateAppErd(appId, erd);
    return c.json({ ok: true, erd, ...(prdGenerated ? { prd } : {}) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ERD generation failed";
    return c.json({ error: msg }, 500);
  }
});

app.post("/api/apps/:appId/regenerate", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  let body: { prd?: string; erd?: string } = {};
  try { body = await c.req.json(); } catch { /* use stored values */ }

  const prd = body.prd || record.prd;
  const erd = body.erd || record.erd;
  if (!prd || !erd) return c.json({ error: "Both PRD and ERD are required to regenerate" }, 400);

  // Save any updated PRD/ERD
  if (body.prd) updateAppPrd(appId, body.prd);
  if (body.erd) updateAppErd(appId, body.erd);

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ event: "generating", data: JSON.stringify({ step: "generating", message: "Regenerating app from PRD + ERD..." }) });
      await regenerateApp(appId, prd, erd, client);
      await stream.writeSSE({ event: "complete", data: JSON.stringify({ step: "complete", message: "App regenerated successfully" }) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Regeneration failed";
      await stream.writeSSE({ event: "error", data: JSON.stringify({ step: "error", message: msg }) });
    }
  });
});

app.get("/api/apps/:appId/poc-plan", authMiddleware, requireRoot, (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  return c.json({ poc_plan: record.poc_plan || "" });
});

app.post("/api/apps/:appId/poc-plan", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  try {
    const pocPlan = await generatePocPlan(appId, client);
    return c.json({ ok: true, poc_plan: pocPlan });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "POC plan generation failed";
    return c.json({ error: msg }, 500);
  }
});

app.put("/api/apps/:appId/poc-plan", authMiddleware, requireRoot, async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);
  let body: { poc_plan?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (body.poc_plan === undefined) return c.json({ error: "poc_plan is required" }, 400);
  updateAppPocPlan(appId, body.poc_plan);
  return c.json({ ok: true });
});

// --- Per-app routes: open if no credentials, otherwise require auth ---
import type { Context, Next } from "@hono/hono";

const openOrAuth = async (c: Context, next: Next) => {
  const appId = c.req.param("appId");
  if (!appId) { await next(); return; }
  const creds = getAppCredentials(appId);
  if (!creds) { await next(); return; }

  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    const secret = Deno.env.get("JWT_SECRET") ?? "";
    const payload = await verify(token, secret, "HS256");
    c.set("user", payload.sub as string);
    c.set("role", payload.role as string);
    if (payload.appId) c.set("appId", payload.appId as string);
    if (payload.role === "root") { await next(); return; }
    if (payload.role === "app" && payload.appId === appId) { await next(); return; }
    return c.json({ error: "Forbidden" }, 403);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
};

app.use("/api/apps/:appId/tables/*", openOrAuth);
app.use("/api/apps/:appId/chat", openOrAuth);
app.use("/api/apps/:appId/conversations/*", openOrAuth);
app.use("/api/apps/:appId/conversations", openOrAuth);
app.use("/api/apps/:appId/ai/*", openOrAuth);
app.use("/api/apps/:appId/agents/*", openOrAuth);
app.use("/api/apps/:appId/agents", openOrAuth);
app.use("/api/apps/:appId/guidelines/*", openOrAuth);
app.use("/api/apps/:appId/guidelines", openOrAuth);
app.use("/api/apps/:appId/mcp-servers/*", openOrAuth);
app.use("/api/apps/:appId/mcp-servers", openOrAuth);

// --- Models endpoint: any authenticated user ---
app.use("/api/models", authMiddleware);

// --- LLM chat routes (structured conversations + stateless) ---
app.route("/", createChatRoutes(client, openaiClient));

// --- Agent routes ---
app.route("/", createAgentRoutes(client));

// --- CRUD routes ---
app.route("/", crud);

// --- Serve generated apps ---
app.get("/apps/:appId", async (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  const creds = getAppCredentials(appId);

  // No credentials → serve directly to anyone (open access, no widget)
  if (!creds) {
    return c.html(record.html);
  }

  // Has credentials → try to authenticate via JWT cookie
  let role: string | undefined;
  let tokenAppId: string | undefined;
  const token = getCookie(c, "auth_token");
  if (token) {
    try {
      const secret = Deno.env.get("JWT_SECRET") ?? "";
      const payload = await verify(token, secret, "HS256");
      role = payload.role as string;
      tokenAppId = payload.appId as string | undefined;
    } catch {
      // Invalid/expired token — treat as unauthenticated
    }
  }

  // Check access: root or matching app user
  const hasAccess = role === "root" || (role === "app" && tokenAppId === appId);

  if (!hasAccess) {
    return c.redirect(`/apps/${appId}/login`);
  }

  const isRoot = role === "root";
  const headerText = isRoot ? 'Edit this app' : 'Suggest changes';
  const systemMsg = isRoot
    ? "Describe changes you'd like to make to this app."
    : 'Suggest changes to this app. Your ideas will be saved for review.';
  const successMsg = 'Changes applied! Refresh the page to see changes.';
  const chatWidget = `
<style>
#__chat_toggle{position:fixed;bottom:20px;right:20px;z-index:9999;width:52px;height:52px;border-radius:50%;background:#4a90d9;color:#fff;border:none;font-size:1.4rem;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;transition:transform .15s}
#__chat_toggle:hover{transform:scale(1.08)}
#__chat_panel{display:none;position:fixed;bottom:80px;right:20px;z-index:10000;width:380px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 100px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.25);flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:hidden}
#__chat_panel.open{display:flex}
#__chat_header{padding:12px 16px;background:#4a90d9;color:#fff;font-weight:600;font-size:.95rem;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
#__chat_header button{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;padding:0 4px;opacity:.8}
#__chat_header button:hover{opacity:1}
#__chat_messages{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.__chat_msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:.875rem;line-height:1.4;word-wrap:break-word}
.__chat_msg.user{align-self:flex-end;background:#4a90d9;color:#fff;border-bottom-right-radius:4px}
.__chat_msg.assistant{align-self:flex-start;background:#f0f0f0;color:#333;border-bottom-left-radius:4px}
.__chat_msg.system{align-self:center;background:none;color:#888;font-size:.8rem;font-style:italic;padding:4px 0}
.__chat_msg.error{align-self:center;background:#fee;color:#d32f2f;font-size:.8rem;padding:6px 10px;border-radius:6px}
#__chat_typing{display:none;align-self:flex-start;padding:8px 12px;background:#f0f0f0;border-radius:12px;border-bottom-left-radius:4px;font-size:.875rem;color:#888}
#__chat_typing.active{display:block}
#__chat_typing span{display:inline-block;animation:__dots 1.4s infinite}
#__chat_typing span:nth-child(2){animation-delay:.2s}
#__chat_typing span:nth-child(3){animation-delay:.4s}
@keyframes __dots{0%,80%,100%{opacity:.3}40%{opacity:1}}
#__chat_input_area{display:flex;gap:8px;padding:12px;border-top:1px solid #e0e0e0;flex-shrink:0}
#__chat_input{flex:1;padding:8px 12px;border:1px solid #ccc;border-radius:20px;font-size:.875rem;outline:none;resize:none;max-height:80px;font-family:inherit;line-height:1.4}
#__chat_input:focus{border-color:#4a90d9}
#__chat_send{width:36px;height:36px;border-radius:50%;background:#4a90d9;color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:flex-end}
#__chat_send:hover{background:#357abd}
#__chat_send:disabled{background:#ccc;cursor:not-allowed}
</style>
<div id="__chat_panel">
  <div id="__chat_header">
    <span>${headerText}</span>
    <button onclick="document.getElementById('__chat_panel').classList.remove('open')" title="Close">&times;</button>
  </div>
  <div id="__chat_messages">
    <div class="__chat_msg system">${systemMsg}</div>
  </div>
  <div id="__chat_input_area">
    <textarea id="__chat_input" rows="1" placeholder="${isRoot ? 'Describe a change...' : 'Suggest a change...'}"></textarea>
    <button id="__chat_send" title="Send">&#9654;</button>
  </div>
</div>
<button id="__chat_toggle" title="${headerText}">&#9998;</button>
<script>
(function(){
  const panel=document.getElementById('__chat_panel');
  const toggle=document.getElementById('__chat_toggle');
  const messages=document.getElementById('__chat_messages');
  const input=document.getElementById('__chat_input');
  const sendBtn=document.getElementById('__chat_send');
  const appId='${appId}';
  let busy=false;

  toggle.addEventListener('click',()=>{
    panel.classList.toggle('open');
    if(panel.classList.contains('open'))input.focus();
  });

  function addMsg(text,cls){
    const d=document.createElement('div');
    d.className='__chat_msg '+cls;
    d.textContent=text;
    messages.appendChild(d);
    messages.scrollTop=messages.scrollHeight;
    return d;
  }

  function showTyping(text){
    let t=document.getElementById('__chat_typing');
    if(!t){
      t=document.createElement('div');
      t.id='__chat_typing';
      messages.appendChild(t);
    }
    t.innerHTML='<span>.</span><span>.</span><span>.</span> '+(text||'Applying changes');
    t.classList.add('active');
    messages.scrollTop=messages.scrollHeight;
  }
  function hideTyping(){
    const t=document.getElementById('__chat_typing');
    if(t)t.classList.remove('active');
  }

  async function send(){
    const text=input.value.trim();
    if(!text||busy)return;
    busy=true;
    sendBtn.disabled=true;
    input.value='';
    input.style.height='auto';

    addMsg(text,'user');
    showTyping('Starting...');

    try{
      const res=await fetch('/api/apps/'+appId+'/edit',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({description:text})
      });
      if(!res.ok){
        hideTyping();
        var errText=await res.text();
        var errMsg='Edit failed';
        try{errMsg=JSON.parse(errText).error||errMsg;}catch(e2){}
        throw new Error(errMsg);
      }
      var reader=res.body.getReader();
      var decoder=new TextDecoder();
      var buf='';
      var done=false;
      while(!done){
        var chunk=reader.read();
        var result=await chunk;
        if(result.done){done=true;break;}
        buf+=decoder.decode(result.value,{stream:true});
        var lines=buf.split('\\n');
        buf=lines.pop()||'';
        var evtType='';
        for(var i=0;i<lines.length;i++){
          var line=lines[i];
          if(line.indexOf('event: ')===0){evtType=line.slice(7).trim();}
          else if(line.indexOf('data: ')===0){
            try{
              var ev=JSON.parse(line.slice(6));
              if(evtType==='error'||ev.step==='error'){
                hideTyping();
                addMsg('Error: '+ev.message,'error');
                busy=false;sendBtn.disabled=false;input.focus();
                return;
              }
              if(ev.step==='complete'){
                hideTyping();
                addMsg('${successMsg}','assistant');
                setTimeout(function(){window.location.reload();},1500);
                return;
              }
              var label=ev.message||'Working...';
              if(ev.tokens){label=ev.message+' ('+ev.tokens+' tokens)';}
              showTyping(label);
            }catch(pe){}
          }
        }
      }
      hideTyping();
      addMsg('${successMsg}','assistant');
      setTimeout(function(){window.location.reload();},1500);
    }catch(e){
      hideTyping();
      addMsg('Error: '+e.message,'error');
      busy=false;
      sendBtn.disabled=false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
  });
  input.addEventListener('input',()=>{
    input.style.height='auto';
    input.style.height=Math.min(input.scrollHeight,80)+'px';
  });
})();
</script>`;

  const html = record.html.replace(
    /<\/body>/i,
    chatWidget + "\n</body>",
  );
  return c.html(html);
});

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, app.fetch);
