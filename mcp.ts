// MCP client — communicates with MCP servers using the official SDK
// Supports Streamable HTTP transport with proper initialize handshake.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface NamespacedMcpTool extends McpTool {
  namespacedName: string;
  serverName: string;
  serverUrl: string;
  serverApiKey?: string;
}

const TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function createMcpClient(
  url: string,
  apiKey?: string,
): Promise<Client> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });

  const client = new Client({
    name: "demo-generator",
    version: "1.0.0",
  });

  await withTimeout(client.connect(transport), TIMEOUT_MS);
  return client;
}

export async function discoverTools(server: {
  url: string;
  name: string;
  api_key?: string | null;
}): Promise<McpTool[]> {
  const client = await createMcpClient(server.url, server.api_key ?? undefined);
  try {
    const result = await withTimeout(client.listTools(), TIMEOUT_MS);
    return (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function discoverAllTools(
  servers: { id: string; url: string; name: string; api_key?: string | null }[],
): Promise<NamespacedMcpTool[]> {
  const all: NamespacedMcpTool[] = [];

  for (const server of servers) {
    try {
      const tools = await discoverTools(server);
      for (const tool of tools) {
        all.push({
          ...tool,
          namespacedName: `${server.name}__${tool.name}`,
          serverName: server.name,
          serverUrl: server.url,
          serverApiKey: server.api_key ?? undefined,
        });
      }
    } catch (e) {
      console.warn(
        `[mcp] Failed to discover tools from "${server.name}" (${server.url}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return all;
}

export async function callTool(
  server: { url: string; api_key?: string | null },
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await createMcpClient(server.url, server.api_key ?? undefined);
  try {
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      TIMEOUT_MS,
    );
    // Extract text content from MCP result
    if (result?.content && Array.isArray(result.content)) {
      const texts = result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);
      if (texts.length === 1) return texts[0];
      if (texts.length > 1) return texts.join("\n");
    }
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

export function mcpToolsToAnthropicTools(
  tools: NamespacedMcpTool[],
): { name: string; description: string; input_schema: { type: "object"; properties?: Record<string, unknown>; [key: string]: unknown } }[] {
  return tools.map((t) => {
    const schema = t.inputSchema || {};
    return {
      name: t.namespacedName,
      description: t.description || `Tool ${t.name} from ${t.serverName}`,
      input_schema: { ...schema, type: "object" as const },
    };
  });
}

export function resolveToolServer(
  namespacedName: string,
  tools: NamespacedMcpTool[],
): { serverUrl: string; serverApiKey?: string; toolName: string } | null {
  const tool = tools.find((t) => t.namespacedName === namespacedName);
  if (!tool) return null;
  return {
    serverUrl: tool.serverUrl,
    serverApiKey: tool.serverApiKey,
    toolName: tool.name,
  };
}
