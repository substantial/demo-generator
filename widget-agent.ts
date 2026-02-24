/**
 * Widget conversational agent — powers the widget chat with tool use,
 * conversation persistence, and SSE streaming.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  getApp,
  createConversation,
  getConversation,
  addMessage,
  getMessages,
  updateConversationTitle,
  createAppConnection,
  getAppConnectionByName,
  listAppConnections,
  listMcpServers,
  createMcpServer,
  logUsage,
  saveEditRequest,
} from "./db.ts";
import { buildSystemContext, resolveModel } from "./chat.ts";
import { NATIVE_TOOLS, NATIVE_TOOL_NAMES, handleNativeTool } from "./agents.ts";
import { editApp, type EditProgressEvent } from "./generate.ts";
import {
  discoverAllTools,
  mcpToolsToAnthropicTools,
  resolveToolServer,
  callTool,
  type NamespacedMcpTool,
} from "./mcp.ts";

const MAX_TOOL_ITERATIONS = 10;

const WIDGET_TOOLS: Anthropic.Tool[] = [
  {
    name: "edit_app",
    description:
      "Edit the app's HTML/UI. Use this ONLY when the user explicitly asks to change, modify, add, or remove something from the app. Do NOT use this for questions or information requests.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: {
          type: "string",
          description: "Clear description of the change to make to the app",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "register_mcp_server",
    description:
      "Register an MCP (Model Context Protocol) server for this app. This allows the app to use tools provided by the MCP server.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable name for this MCP server" },
        url: { type: "string", description: "The MCP server URL" },
        api_key: { type: "string", description: "Optional API key for authentication" },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "start_oauth",
    description:
      "Start an OAuth authorization flow. Generates an authorization URL the user can click to grant access. Saves a partial connection that will be completed when the OAuth callback is received.",
    input_schema: {
      type: "object" as const,
      properties: {
        provider: {
          type: "string",
          description: 'OAuth provider name (e.g. "google", "atlassian", "github", "generic")',
        },
        client_id: { type: "string", description: "OAuth client ID" },
        client_secret: { type: "string", description: "OAuth client secret" },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "OAuth scopes to request",
        },
        auth_url: {
          type: "string",
          description: "OAuth authorization endpoint URL",
        },
        token_url: {
          type: "string",
          description: "OAuth token exchange endpoint URL",
        },
        connection_name: {
          type: "string",
          description: "Human-readable name for this connection",
        },
      },
      required: ["provider", "client_id", "client_secret", "scopes", "auth_url", "token_url", "connection_name"],
    },
  },
];

interface WidgetAgentOptions {
  client: Anthropic;
  appId: string;
  message: string;
  conversationId?: string;
  isRoot: boolean;
  baseUrl: string;
  onEvent: (event: WidgetSSEEvent) => Promise<void>;
}

export interface WidgetSSEEvent {
  event: "message" | "tool_call" | "edit_progress" | "done" | "error" | "conversation_id";
  data: Record<string, unknown>;
}

export async function runWidgetAgent(opts: WidgetAgentOptions): Promise<void> {
  const { client, appId, message, isRoot, baseUrl, onEvent } = opts;

  const app = getApp(appId);
  if (!app) {
    await onEvent({ event: "error", data: { text: "App not found" } });
    return;
  }

  // Resolve or create conversation
  let conversationId = opts.conversationId;
  if (conversationId) {
    const existing = getConversation(conversationId);
    if (!existing) conversationId = undefined;
  }
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    createConversation(conversationId, appId, "Widget chat");
  }
  await onEvent({ event: "conversation_id", data: { conversation_id: conversationId } });

  // Save user message
  addMessage(conversationId, "user", message);

  // Non-root: save edit request for tracking but still allow conversation
  if (!isRoot) {
    saveEditRequest(appId, "widget-user", message);
  }

  // Build message history
  const allMsgs = getMessages(conversationId);
  const messages: Anthropic.MessageParam[] = allMsgs.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Build system prompt
  const widgetInstructions = `You are a helpful assistant for the app "${app.title}". You can answer questions about the app and its data, AND you can make changes to the app when asked.

IMPORTANT RULES:
- Answer questions directly and conversationally. Do NOT use the edit_app tool unless the user explicitly asks to change/modify/add/remove/update something in the app.
- When the user asks a question (e.g. "What data is in this app?", "How does this work?"), just answer it using the data context provided.
- When the user asks to make a change (e.g. "Add a search bar", "Change the color to blue"), use the edit_app tool.
- When asked to connect to external data (database, API, etc.), check existing connections first with list_connections. If credentials are missing, ask the user for them.
- For OAuth services (Google, GitHub, Atlassian, etc.), use start_oauth to generate the authorization URL for the user to click.
- Be concise and helpful. Use markdown formatting for readability.`;

  const system = buildSystemContext(appId, app.title, widgetInstructions);

  // Assemble tools — deduplicate by name (MCP tools could collide with native/widget tools)
  const toolsByName = new Map<string, Anthropic.Tool>();
  for (const t of WIDGET_TOOLS) toolsByName.set(t.name, t);
  for (const t of NATIVE_TOOLS) toolsByName.set(t.name, t);

  // Also discover any MCP server tools registered for this app
  const mcpServers = listMcpServers(appId);
  let mcpTools: NamespacedMcpTool[] = [];
  if (mcpServers.length > 0) {
    try {
      mcpTools = await discoverAllTools(mcpServers);
      for (const t of mcpToolsToAnthropicTools(mcpTools) as Anthropic.Tool[]) {
        toolsByName.set(t.name, t);
      }
    } catch {
      // MCP discovery failed, continue without MCP tools
    }
  }
  const allTools: Anthropic.Tool[] = Array.from(toolsByName.values());

  const model = resolveModel("sonnet");
  let currentMessages = messages;
  let toolCallsMade = 0;
  let editWasMade = false;
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS + 1; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages: currentMessages,
      tools: allTools,
    });

    logUsage(appId, "widget-chat", model, response.usage.input_tokens, response.usage.output_tokens);

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Extract any text from this response
    const textParts = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);

    // Stream text incrementally
    for (const text of textParts) {
      if (text) {
        await onEvent({ event: "message", data: { text } });
      }
    }

    if (toolUseBlocks.length === 0 || iteration >= MAX_TOOL_ITERATIONS) {
      finalText = textParts.join("");
      break;
    }

    // Execute tool calls
    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: response.content },
    ];

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallsMade++;
      const input = (toolUse.input as Record<string, unknown>) || {};

      if (toolUse.name === "edit_app") {
        const instruction = input.instruction as string;
        await onEvent({
          event: "tool_call",
          data: { tool: "edit_app", status: "running", instruction },
        });

        // Non-root users: still allow edits through the agent
        try {
          await editApp(appId, instruction, client, async (ev: EditProgressEvent) => {
            await onEvent({
              event: "edit_progress",
              data: { step: ev.step, message: ev.message, tokens: ev.tokens },
            });
          });
          editWasMade = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Edit applied successfully. The app has been updated.",
          });
        } catch (e) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Edit failed: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true,
          });
        }
        continue;
      }

      if (toolUse.name === "register_mcp_server") {
        await onEvent({
          event: "tool_call",
          data: { tool: "register_mcp_server", status: "running" },
        });
        try {
          const id = crypto.randomUUID();
          createMcpServer(id, appId, input.name as string, input.url as string, input.api_key as string | undefined);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ success: true, mcp_server: { id, name: input.name, url: input.url } }),
          });
        } catch (e) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Failed to register MCP server: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true,
          });
        }
        continue;
      }

      if (toolUse.name === "start_oauth") {
        await onEvent({
          event: "tool_call",
          data: { tool: "start_oauth", status: "running" },
        });
        try {
          const connectionName = input.connection_name as string;
          const provider = input.provider as string;
          const clientId = input.client_id as string;
          const clientSecret = input.client_secret as string;
          const scopes = input.scopes as string[];
          const authUrl = input.auth_url as string;
          const tokenUrl = input.token_url as string;

          // Create a partial connection with OAuth config
          const connId = crypto.randomUUID();
          createAppConnection(connId, appId, "rest_api", connectionName, "", {
            oauth_provider: provider,
            client_id: clientId,
            client_secret: clientSecret,
            token_url: tokenUrl,
            scopes: scopes.join(" "),
          });

          // Build the OAuth authorize URL
          const redirectUri = `${baseUrl}/api/apps/${appId}/oauth/callback`;
          const state = connId; // Use connection ID as state for the callback
          const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: scopes.join(" "),
            state,
            access_type: "offline",
            prompt: "consent",
          });

          const authorizeUrl = `${authUrl}?${params.toString()}`;

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              authorize_url: authorizeUrl,
              connection_id: connId,
              message: "Authorization URL generated. User needs to click the link to authorize.",
            }),
          });
        } catch (e) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `OAuth setup failed: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true,
          });
        }
        continue;
      }

      // Check native tools (save_connection, list_connections, query_database, fetch_api, import_data)
      if (NATIVE_TOOL_NAMES.has(toolUse.name)) {
        await onEvent({
          event: "tool_call",
          data: { tool: toolUse.name, status: "running" },
        });
        try {
          const result = await handleNativeTool(toolUse.name, input, appId);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          });
        } catch (e) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true,
          });
        }
        continue;
      }

      // Try MCP tools
      const resolved = resolveToolServer(toolUse.name, mcpTools);
      if (resolved) {
        await onEvent({
          event: "tool_call",
          data: { tool: toolUse.name, status: "running" },
        });
        try {
          const result = await callTool(
            { url: resolved.serverUrl, api_key: resolved.serverApiKey },
            resolved.toolName,
            input,
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
        continue;
      }

      // Unknown tool
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: `Error: Unknown tool "${toolUse.name}"`,
        is_error: true,
      });
    }

    currentMessages = [
      ...currentMessages,
      { role: "user" as const, content: toolResults },
    ];
  }

  // Save assistant response
  if (finalText) {
    addMessage(conversationId, "assistant", finalText);
  }

  // Auto-title on first exchange
  if (allMsgs.length <= 1) {
    const shortTitle = message.length > 60 ? message.slice(0, 57) + "..." : message;
    updateConversationTitle(conversationId, shortTitle);
  }

  await onEvent({
    event: "done",
    data: { text: finalText, edit_made: editWasMade, tool_calls: toolCallsMade },
  });
}
