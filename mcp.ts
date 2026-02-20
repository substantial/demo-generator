// MCP client — communicates with MCP servers over HTTP using JSON-RPC 2.0

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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TIMEOUT_MS = 30_000;

async function jsonRpcCall(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  apiKey?: string,
): Promise<unknown> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params ? { params } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`MCP server returned HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP JSON-RPC error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverTools(server: {
  url: string;
  name: string;
  api_key?: string | null;
}): Promise<McpTool[]> {
  const result = (await jsonRpcCall(server.url, "tools/list", undefined, server.api_key ?? undefined)) as {
    tools?: McpTool[];
  };
  return result?.tools ?? [];
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
  return jsonRpcCall(
    server.url,
    "tools/call",
    { name: toolName, arguments: args },
    server.api_key ?? undefined,
  );
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
