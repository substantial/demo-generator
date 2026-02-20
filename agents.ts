import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import Anthropic from "@anthropic-ai/sdk";
import {
  getApp,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  createGuideline,
  getGuideline,
  listGuidelines,
  updateGuideline,
  deleteGuideline,
  createMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
  deleteMcpServer,
  linkAgentGuideline,
  unlinkAgentGuideline,
  getAgentGuidelines,
  linkAgentMcpServer,
  unlinkAgentMcpServer,
  getAgentMcpServers,
  createAgentConversation,
  listAgentConversations,
  getConversation,
  addMessage,
  getMessages,
  updateConversationTitle,
  logUsage,
} from "./db.ts";
import { buildSystemContext, resolveModel } from "./chat.ts";
import {
  discoverAllTools,
  mcpToolsToAnthropicTools,
  resolveToolServer,
  callTool,
  type NamespacedMcpTool,
} from "./mcp.ts";

const MAX_TOOL_ITERATIONS = 10;

interface AgentLoopResult {
  role: "assistant";
  content: string;
  tool_calls_made: number;
}

async function runAgentLoop(
  client: Anthropic,
  appId: string,
  appTitle: string,
  agentId: string,
  messages: { role: "user" | "assistant"; content: string }[],
  modelOverride?: string,
  temperatureOverride?: number,
): Promise<AgentLoopResult> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error("Agent not found");

  // Build system prompt: static_prompt + guidelines + data context
  const guidelines = getAgentGuidelines(agentId);
  let systemBase = agent.static_prompt || "";
  if (guidelines.length > 0) {
    systemBase += "\n\nGUIDELINES:\n";
    for (const g of guidelines) {
      systemBase += `\n--- ${g.name} ---\n${g.content}\n`;
    }
  }

  const system = buildSystemContext(appId, appTitle, systemBase || undefined);

  // Discover MCP tools
  const mcpServers = getAgentMcpServers(agentId);
  let tools: NamespacedMcpTool[] = [];
  let anthropicTools: ReturnType<typeof mcpToolsToAnthropicTools> = [];
  if (mcpServers.length > 0) {
    tools = await discoverAllTools(mcpServers);
    anthropicTools = mcpToolsToAnthropicTools(tools);
  }

  const model = resolveModel(modelOverride || agent.model);
  const temperature = temperatureOverride ?? agent.temperature ?? undefined;

  let currentMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let toolCallsMade = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS + 1; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages: currentMessages,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools as Anthropic.Tool[] } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    });

    logUsage(appId, "agent", model, response.usage.input_tokens, response.usage.output_tokens);

    // Check if response has tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0 || iteration >= MAX_TOOL_ITERATIONS) {
      // No tool use or max iterations — extract final text
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        role: "assistant",
        content: text,
        tool_calls_made: toolCallsMade,
      };
    }

    // Execute tool calls
    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: response.content },
    ];

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallsMade++;
      const resolved = resolveToolServer(toolUse.name, tools);
      if (!resolved) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: Unknown tool "${toolUse.name}"`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await callTool(
          { url: resolved.serverUrl, api_key: resolved.serverApiKey },
          resolved.toolName,
          (toolUse.input as Record<string, unknown>) || {},
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        });
      }
    }

    currentMessages = [
      ...currentMessages,
      { role: "user" as const, content: toolResults },
    ];
  }

  // Should not reach here, but just in case
  return { role: "assistant", content: "", tool_calls_made: toolCallsMade };
}

export function createAgentRoutes(client: Anthropic): Hono {
  const router = new Hono();

  // === Agent CRUD ===

  router.post("/api/apps/:appId/agents", async (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: {
      name?: string;
      static_prompt?: string;
      model?: string;
      temperature?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.name) return c.json({ error: "name is required" }, 400);

    const id = crypto.randomUUID();
    createAgent(
      id,
      appId,
      body.name,
      body.static_prompt || "",
      body.model,
      body.temperature,
    );
    return c.json(getAgent(id), 201);
  });

  router.get("/api/apps/:appId/agents", (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);
    return c.json(listAgents(appId));
  });

  router.get("/api/apps/:appId/agents/:agentId", (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({
      ...agent,
      guidelines: getAgentGuidelines(agent.id),
      mcp_servers: getAgentMcpServers(agent.id),
    });
  });

  router.post("/api/apps/:appId/agents/:agentId", async (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    let body: {
      name?: string;
      static_prompt?: string;
      model?: string;
      temperature?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    updateAgent(agent.id, body);
    return c.json(getAgent(agent.id));
  });

  router.post("/api/apps/:appId/agents/:agentId/delete", (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    deleteAgent(agent.id);
    return c.json({ ok: true });
  });

  // === Guideline CRUD ===

  router.post("/api/apps/:appId/guidelines", async (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: { name?: string; content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.name) return c.json({ error: "name is required" }, 400);

    const id = crypto.randomUUID();
    createGuideline(id, appId, body.name, body.content || "");
    return c.json(getGuideline(id), 201);
  });

  router.get("/api/apps/:appId/guidelines", (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);
    return c.json(listGuidelines(appId));
  });

  router.get("/api/apps/:appId/guidelines/:guidelineId", (c: Context) => {
    const guideline = getGuideline(c.req.param("guidelineId"));
    if (!guideline) return c.json({ error: "Guideline not found" }, 404);
    return c.json(guideline);
  });

  router.post(
    "/api/apps/:appId/guidelines/:guidelineId",
    async (c: Context) => {
      const guideline = getGuideline(c.req.param("guidelineId"));
      if (!guideline) return c.json({ error: "Guideline not found" }, 404);

      let body: { name?: string; content?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      updateGuideline(guideline.id, body);
      return c.json(getGuideline(guideline.id));
    },
  );

  router.post(
    "/api/apps/:appId/guidelines/:guidelineId/delete",
    (c: Context) => {
      const guideline = getGuideline(c.req.param("guidelineId"));
      if (!guideline) return c.json({ error: "Guideline not found" }, 404);
      deleteGuideline(guideline.id);
      return c.json({ ok: true });
    },
  );

  // === MCP Server CRUD ===

  router.post("/api/apps/:appId/mcp-servers", async (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    let body: { name?: string; url?: string; api_key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.url) return c.json({ error: "url is required" }, 400);

    const id = crypto.randomUUID();
    createMcpServer(id, appId, body.name, body.url, body.api_key);
    return c.json(getMcpServer(id), 201);
  });

  router.get("/api/apps/:appId/mcp-servers", (c: Context) => {
    const appId = c.req.param("appId");
    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);
    return c.json(listMcpServers(appId));
  });

  router.get("/api/apps/:appId/mcp-servers/:serverId", (c: Context) => {
    const server = getMcpServer(c.req.param("serverId"));
    if (!server) return c.json({ error: "MCP server not found" }, 404);
    return c.json(server);
  });

  router.post("/api/apps/:appId/mcp-servers/:serverId", async (c: Context) => {
    const server = getMcpServer(c.req.param("serverId"));
    if (!server) return c.json({ error: "MCP server not found" }, 404);

    let body: { name?: string; url?: string; api_key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    updateMcpServer(server.id, body);
    return c.json(getMcpServer(server.id));
  });

  router.post("/api/apps/:appId/mcp-servers/:serverId/delete", (c: Context) => {
    const server = getMcpServer(c.req.param("serverId"));
    if (!server) return c.json({ error: "MCP server not found" }, 404);
    deleteMcpServer(server.id);
    return c.json({ ok: true });
  });

  // === Junction Routes: Agent <-> Guidelines ===

  router.post(
    "/api/apps/:appId/agents/:agentId/guidelines",
    async (c: Context) => {
      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      let body: { guideline_id?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.guideline_id)
        return c.json({ error: "guideline_id is required" }, 400);
      const guideline = getGuideline(body.guideline_id);
      if (!guideline) return c.json({ error: "Guideline not found" }, 404);

      linkAgentGuideline(agent.id, guideline.id);
      return c.json({ ok: true });
    },
  );

  router.post(
    "/api/apps/:appId/agents/:agentId/guidelines/delete",
    async (c: Context) => {
      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      let body: { guideline_id?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.guideline_id)
        return c.json({ error: "guideline_id is required" }, 400);
      unlinkAgentGuideline(agent.id, body.guideline_id);
      return c.json({ ok: true });
    },
  );

  router.get("/api/apps/:appId/agents/:agentId/guidelines", (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(getAgentGuidelines(agent.id));
  });

  // === Junction Routes: Agent <-> MCP Servers ===

  router.post(
    "/api/apps/:appId/agents/:agentId/mcp-servers",
    async (c: Context) => {
      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      let body: { mcp_server_id?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.mcp_server_id)
        return c.json({ error: "mcp_server_id is required" }, 400);
      const server = getMcpServer(body.mcp_server_id);
      if (!server) return c.json({ error: "MCP server not found" }, 404);

      linkAgentMcpServer(agent.id, server.id);
      return c.json({ ok: true });
    },
  );

  router.post(
    "/api/apps/:appId/agents/:agentId/mcp-servers/delete",
    async (c: Context) => {
      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      let body: { mcp_server_id?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.mcp_server_id)
        return c.json({ error: "mcp_server_id is required" }, 400);
      unlinkAgentMcpServer(agent.id, body.mcp_server_id);
      return c.json({ ok: true });
    },
  );

  router.get("/api/apps/:appId/agents/:agentId/mcp-servers", (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(getAgentMcpServers(agent.id));
  });

  // === Stateless Invocation ===

  router.post("/api/apps/:appId/agents/:agentId/invoke", async (c: Context) => {
    const appId = c.req.param("appId");

    const app = getApp(appId);
    if (!app) return c.json({ error: "App not found" }, 404);

    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    let body: { prompt?: string; model?: string; temperature?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

    try {
      const result = await runAgentLoop(
        client,
        appId,
        app.title,
        agent.id,
        [{ role: "user", content: body.prompt }],
        body.model,
        body.temperature,
      );
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Agent invocation failed";
      return c.json({ error: msg }, 500);
    }
  });

  // === Persistent Conversations ===

  router.post(
    "/api/apps/:appId/agents/:agentId/conversations",
    async (c: Context) => {
      const appId = c.req.param("appId");
      const app = getApp(appId);
      if (!app) return c.json({ error: "App not found" }, 404);

      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      let body: { title?: string } = {};
      try {
        body = await c.req.json();
      } catch {
        // empty body is fine
      }

      const id = crypto.randomUUID();
      const title = body.title || "New conversation";
      createAgentConversation(id, appId, agent.id, title);
      return c.json({ id, title }, 201);
    },
  );

  router.get("/api/apps/:appId/agents/:agentId/conversations", (c: Context) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(listAgentConversations(agent.id));
  });

  router.post(
    "/api/apps/:appId/agents/:agentId/conversations/:convId/messages",
    async (c: Context) => {
      const appId = c.req.param("appId");

      const app = getApp(appId);
      if (!app) return c.json({ error: "App not found" }, 404);

      const agent = getAgent(c.req.param("agentId"));
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      const convId = c.req.param("convId");
      const convo = getConversation(convId);
      if (!convo) return c.json({ error: "Conversation not found" }, 404);

      let body: {
        content?: string;
        message?: string;
        model?: string;
        temperature?: number;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      const userContent = (body.content || body.message || "").trim();
      if (!userContent) return c.json({ error: "content is required" }, 400);

      addMessage(convId, "user", userContent);

      const allMsgs = getMessages(convId);
      const messages = allMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      try {
        const result = await runAgentLoop(
          client,
          appId,
          app.title,
          agent.id,
          messages,
          body.model,
          body.temperature,
        );

        addMessage(convId, "assistant", result.content);

        // Auto-title on first message
        if (allMsgs.length <= 1) {
          const shortTitle =
            userContent.length > 60
              ? userContent.slice(0, 57) + "..."
              : userContent;
          updateConversationTitle(convId, shortTitle);
        }

        return c.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Agent invocation failed";
        return c.json({ error: msg }, 500);
      }
    },
  );

  return router;
}
