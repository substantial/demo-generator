import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  getApp,
  getAllAppSchemas,
  getRows,
  getFullTableName,
  createConversation,
  getConversation,
  listConversations,
  addMessage,
  getMessages,
  updateConversationTitle,
  deleteConversation,
  logUsage,
} from "./db.ts";

// Map short names to actual model IDs
export const MODEL_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
  "gpt-4o": "gpt-4o",
};

export function resolveModel(name?: string | null): string {
  if (!name) return MODEL_MAP.sonnet;
  if (name.startsWith("claude-") || name.startsWith("gpt-") || name.startsWith("o1") || name.startsWith("o3")) return name;
  return MODEL_MAP[name.toLowerCase()] ?? MODEL_MAP.sonnet;
}

function resolveChatModel(name?: string | null): string {
  if (!name) return "gpt-4o";
  if (name.startsWith("claude-") || name.startsWith("gpt-") || name.startsWith("o1") || name.startsWith("o3")) return name;
  return MODEL_MAP[name.toLowerCase()] ?? "gpt-4o";
}

function getModelProvider(model: string): "anthropic" | "openai" {
  return (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3"))
    ? "openai" : "anthropic";
}

// Build a data-aware system prompt for an app — includes ALL data up to a reasonable limit
export function buildSystemContext(
  appId: string,
  appTitle: string,
  customSystem?: string | null,
): string {
  const schemas = getAllAppSchemas(appId);
  let context = customSystem ||
    `You are an intelligent AI assistant embedded in "${appTitle}". You have full access to the app's live data. Provide specific, data-driven answers. Be concise and insightful.`;

  if (schemas.length > 0) {
    context += "\n\nDATA CONTEXT — the app has these tables:\n";
    for (const schema of schemas) {
      const cols = schema.columns
        .map((c) => `${c.name} (${c.type})`)
        .join(", ");
      context += `\n  TABLE ${schema.tableName}: id (INTEGER), ${cols}`;

      try {
        const ftn = getFullTableName(appId, schema.tableName);
        const rows = getRows(ftn, 200, 0);
        if (rows.length > 0) {
          context += `\n    ALL DATA (${rows.length} rows): ${JSON.stringify(rows)}`;
        } else {
          context += `\n    (empty table)`;
        }
      } catch {
        // table might not exist yet
      }
    }
    context +=
      "\n\nIMPORTANT: Use the actual data above for analysis. Reference specific values, compute real aggregates, identify real trends. Never make up numbers.";
  }

  context += `

CHART RENDERING:
When the user asks for a chart, visualization, or graph, return a Chart.js config block like this:

\`\`\`chartjs
{
  "type": "bar",
  "data": {
    "labels": ["Jan", "Feb", "Mar"],
    "datasets": [{"label": "Sales", "data": [10, 20, 30]}]
  },
  "options": { "responsive": true }
}
\`\`\`

Rules:
- Use ONLY \`\`\`chartjs fenced blocks for charts — the app will render them as live Chart.js canvases
- NEVER output raw HTML, SVG, or markdown tables as a substitute for charts
- NEVER describe what a chart would look like — actually produce the chartjs config
- You can include explanatory text OUTSIDE the chart block (before or after)
- Use the real data from the tables above to populate chart data
- Supported chart types: bar, line, pie, doughnut, scatter, radar, polarArea, bubble
- You can include multiple \`\`\`chartjs blocks in one response for side-by-side comparisons
- Make charts visually appealing: use colors, proper labels, titles, and legends`;

  return context;
}

export interface LLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export function createChatRoutes(anthropicClient: Anthropic, openaiClient: OpenAI): Hono {
  const chat = new Hono();

  async function callLLM(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[],
    model: string,
    temperature?: number,
  ): Promise<LLMResult> {
    if (getModelProvider(model) === "openai") {
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: system },
        ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ];
      const response = await openaiClient.chat.completions.create({
        model,
        messages: openaiMessages,
        max_tokens: 4096,
        ...(temperature !== undefined ? { temperature } : {}),
      });
      return {
        text: response.choices[0]?.message?.content ?? "",
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
    } else {
      const response = await anthropicClient.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
      });
      return {
        text: response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    }
  }

  // === Handler functions (shared across route aliases) ===

  async function handleListConversations(c: Context) {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);
    return c.json(listConversations(appId));
  }

  async function handleCreateConversation(c: Context) {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: { title?: string; system?: string; model?: string; temperature?: number } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is fine
    }

    const id = crypto.randomUUID();
    const model = body.model || "sonnet";
    createConversation(id, appId, body.title || "New conversation", body.system, model, body.temperature);
    return c.json({ id, title: body.title || "New conversation", model }, 201);
  }

  async function handleGetConversation(c: Context) {
    const convId = c.req.param("convId");
    const convo = getConversation(convId);
    if (!convo) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ...convo, messages: getMessages(convId) });
  }

  async function handleDeleteConversation(c: Context) {
    const convId = c.req.param("convId");
    const convo = getConversation(convId);
    if (!convo) return c.json({ error: "Conversation not found" }, 404);
    deleteConversation(convId);
    return c.json({ ok: true });
  }

  async function handleSendMessage(c: Context) {
    const appId = c.req.param("appId");
    const convId = c.req.param("convId");

    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    const convo = getConversation(convId);
    if (!convo) return c.json({ error: "Conversation not found" }, 404);

    let body: { content?: string; message?: string; model?: string; temperature?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Accept either "content" or "message" field
    const userContent = (body.content || body.message || "").trim();
    if (!userContent) {
      return c.json({ error: "content is required" }, 400);
    }

    addMessage(convId, "user", userContent);

    const allMsgs = getMessages(convId);
    const messages = allMsgs.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const system = buildSystemContext(appId, app.title, convo.system_prompt);
    const model = resolveChatModel(body.model || convo.model);
    const temperature = body.temperature ?? convo.temperature ?? undefined;

    try {
      const result = await callLLM(system, messages, model, temperature);
      logUsage(appId, "chat", model, result.inputTokens, result.outputTokens);

      addMessage(convId, "assistant", result.text);

      if (allMsgs.length <= 1) {
        const shortTitle = userContent.length > 60 ? userContent.slice(0, 57) + "..." : userContent;
        updateConversationTitle(convId, shortTitle);
      }

      return c.json({ role: "assistant", content: result.text, model });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Chat failed";
      return c.json({ error: msg }, 500);
    }
  }

  async function handleStatelessChat(c: Context) {
    const appId = c.req.param("appId");

    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: {
      messages?: { role: string; content: string }[];
      system?: string;
      model?: string;
      temperature?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: "messages array is required" }, 400);
    }

    const messages = body.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content) }));

    if (messages.length === 0) {
      return c.json({ error: "At least one user message is required" }, 400);
    }

    const system = buildSystemContext(appId, app.title, body.system);
    const model = resolveChatModel(body.model);
    const temperature = body.temperature;

    try {
      const result = await callLLM(system, messages, model, temperature);
      logUsage(appId, "chat", model, result.inputTokens, result.outputTokens);

      return c.json({ role: "assistant", content: result.text, response: result.text, model });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Chat failed";
      return c.json({ error: msg }, 500);
    }
  }

  // === Register routes with all common path variants ===
  // The LLM generates various URL patterns, so we accept them all.

  const prefixes = [
    "/api/apps/:appId",
    "/api/apps/:appId/ai",
  ];

  for (const prefix of prefixes) {
    // List conversations
    chat.get(`${prefix}/conversations`, handleListConversations);

    // Create conversation
    chat.post(`${prefix}/conversations`, handleCreateConversation);

    // Get conversation
    chat.get(`${prefix}/conversations/:convId`, handleGetConversation);

    // Delete conversation
    chat.delete(`${prefix}/conversations/:convId`, handleDeleteConversation);

    // Send message — accept /messages, /chat, or bare POST to conversation
    chat.post(`${prefix}/conversations/:convId/messages`, handleSendMessage);
    chat.post(`${prefix}/conversations/:convId/chat`, handleSendMessage);

    // Stateless chat
    chat.post(`${prefix}/chat`, handleStatelessChat);
  }

  // Available models endpoint
  chat.get("/api/models", (c) => {
    return c.json({
      models: [
        { id: "gpt-4o", name: "GPT-4o", description: "Fast, capable — default for chat" },
        { id: "haiku", name: "Claude Haiku 4.5", description: "Fast, lightweight — good for simple Q&A" },
        { id: "sonnet", name: "Claude Sonnet 4.5", description: "Balanced — good for most tasks" },
        { id: "opus", name: "Claude Opus 4.6", description: "Most capable — best for complex analysis" },
      ],
      default: "gpt-4o",
    });
  });

  return chat;
}
