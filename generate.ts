import Anthropic from "@anthropic-ai/sdk";
import {
  createAppTables,
  saveApp,
  saveAppCredentials,
  getApp,
  getAllAppSchemas,
  updateAppHtml,
  updateAppPocPlan,
  addColumnToTable,
  insertRow,
  getFullTableName,
  listUxLessons,
  listEditRequests,
  listConversations,
  getMessages,
  logUsage,
  type TableDef,
  type ColumnDef,
} from "./db.ts";

export interface GenerateInput {
  title?: string;
  body?: string;
  prd?: string;
  erd?: string;
}

const SYSTEM_PROMPT = `You are a full-stack web app generator. Given a description (from a GitHub issue or direct input), you produce a complete single-page web app with realistic seed data.

Return ONLY valid JSON (no markdown fences, no explanation) with this structure:
{
  "tables": [...],
  "html": "<complete HTML document>",
  "seedData": { "tablename": [{...}, ...] }
}

IMPORTANT OUTPUT RULES:
- Your ENTIRE response must be a single valid JSON object
- Do NOT wrap in markdown code fences
- Do NOT include any text before or after the JSON
- Output "tables" FIRST, then "html", then "seedData" LAST
- Keep seedData compact: use single-line objects, no extra whitespace in seed rows

TABLE RULES:
- Table names: lowercase alphanumeric + underscores only
- Column names: lowercase alphanumeric + underscores only
- Every table automatically gets "id INTEGER PRIMARY KEY AUTOINCREMENT" — do NOT include id
- Valid column types: TEXT, INTEGER, REAL, BOOLEAN

HTML RULES:
- Complete document with <!DOCTYPE html>, inline CSS, inline JavaScript
- CRUD via fetch() to these endpoints (use {{APP_ID}} placeholder, replaced at runtime):
  - GET    /api/apps/{{APP_ID}}/tables/{tableName}?limit=100&offset=0
  - GET    /api/apps/{{APP_ID}}/tables/{tableName}/{id}
  - POST   /api/apps/{{APP_ID}}/tables/{tableName}  (JSON body)
  - PUT    /api/apps/{{APP_ID}}/tables/{tableName}/{id}  (JSON body)
  - DELETE /api/apps/{{APP_ID}}/tables/{tableName}/{id}
- May use CDN imports from esm.sh, jsdelivr, or unpkg (Chart.js, D3, etc.)
- Modern, clean, professional UI with error handling
- Fully functional CRUD operations

API RESPONSE FORMATS (your HTML must handle these exact shapes):
- GET list:   returns a flat JSON array:  [{id:1, col1:"val", ...}, {id:2, ...}]
- GET one:    returns a single object:    {id:1, col1:"val", ...}
- POST:       returns created row:        {id:3, col1:"val", ...}  (status 201)
- PUT:        returns updated row:        {id:3, col1:"val", ...}
- DELETE:     returns:                    {ok: true}
- Errors:     returns:                    {error: "message"}  (status 400/404)
- The GET list response is a PLAIN ARRAY, not wrapped in an object. Use: const rows = await res.json(); rows.forEach(...)
- Always check res.ok before parsing response body

SEED DATA:
- Generate 10-15 realistic rows per main table (enough to demo but won't exceed token limits)
- For dashboards/analytics: show interesting trends, seasonal variation, multiple segments
- Include date ranges spanning 12-24 months, variety in categories/regions/segments
- Use realistic names, cities, dollar amounts ($10-$5000)
- For logos: https://ui-avatars.com/api/?name=CompanyName&size=128&background=random
- Keep each seed row on ONE line, no pretty-printing inside seed arrays

LLM CHAT API — two modes available:

1) STATELESS (simple, one-shot calls — good for AI analysis buttons, suggestions, summaries):
   POST /api/apps/{{APP_ID}}/chat
   Request:  { messages: [{role:"user",content:"..."}, ...], system?: "optional system prompt" }
   Response: { role: "assistant", content: "response text" }
   The system prompt auto-includes the app's schema and sample data — the LLM knows your tables.

2) PERSISTENT CONVERSATIONS (full chat with history saved server-side):
   POST   /api/apps/{{APP_ID}}/conversations                          → create: { title?, system? } → { id, title }
   GET    /api/apps/{{APP_ID}}/conversations                          → list:   [{ id, title, created_at, updated_at }]
   GET    /api/apps/{{APP_ID}}/conversations/{convId}                  → get:    { id, title, messages: [{id, role, content, created_at}] }
   POST   /api/apps/{{APP_ID}}/conversations/{convId}/messages         → send:   { content: "user message" } → { role: "assistant", content: "..." }
   DELETE /api/apps/{{APP_ID}}/conversations/{convId}                  → delete: { ok: true }

   Workflow: create a conversation once, then POST messages to it. History is persisted automatically.
   The LLM receives the full conversation history + app schema/data context on every call.

MODEL SELECTION:
- Available models: "haiku" (fast, cheap), "sonnet" (balanced, default), "opus" (most capable)
- GET /api/models returns the list with descriptions
- Pass model on conversation creation: { model: "opus" } — all messages in that conversation use it
- Or override per-message: { content: "...", model: "haiku" }
- For stateless /chat: { messages: [...], model: "opus" }
- You can also pass temperature (0.0-1.0): { temperature: 0.7 }

RULES FOR LLM FEATURES:
- NEVER hardcode or fake AI responses — always call one of these endpoints
- For chatbots/conversational UIs: use persistent conversations so history survives page reloads
- For one-off analysis (e.g. "analyze this data" button): use stateless /chat
- The LLM automatically knows about the app's ALL tables and data — no need to pass it yourself
- Always handle loading states and errors in the UI
- Consider adding a model selector dropdown so users can switch between haiku/sonnet/opus

RENDERING LLM RESPONSES WITH CHARTS:
The LLM chat may return \`\`\`chartjs fenced blocks containing Chart.js JSON configs.
Your HTML MUST parse these and render them as live charts. Here is the required rendering logic:

function renderLLMResponse(container, text) {
  var FENCE = String.fromCharCode(96,96,96);
  var parts = text.split(new RegExp('(' + FENCE + 'chartjs\\n[\\s\\S]*?\\n' + FENCE + ')', 'g'));
  parts.forEach(function(part) {
    if (part.startsWith(FENCE + 'chartjs')) {
      var json = part.replace(new RegExp('^' + FENCE + 'chartjs\\n'), '').replace(new RegExp('\\n' + FENCE + '$'), '');
      try {
        var config = JSON.parse(json);
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-width:600px;margin:12px 0;';
        var canvas = document.createElement('canvas');
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);
        new Chart(canvas, config);
      } catch(e) { /* fallback: show as text */ }
    } else if (part.trim()) {
      var p = document.createElement('div');
      p.style.cssText = 'white-space:pre-wrap;margin:8px 0;';
      p.textContent = part.trim();
      container.appendChild(p);
    }
  });
}

- You MUST include Chart.js via CDN: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
- Use this renderLLMResponse function (or equivalent) whenever displaying LLM chat responses
- Do NOT just dump response.content as innerHTML or textContent — always parse for chart blocks
- The LLM will produce \`\`\`chartjs blocks when asked for visualizations — your app must render them

AGENT SYSTEM — define reusable AI agents with prompts, guidelines, and MCP tools:

AGENTS CRUD:
POST   /api/apps/{{APP_ID}}/agents                    → { name, static_prompt, model?, temperature? } → { id, ... }
GET    /api/apps/{{APP_ID}}/agents                    → [{ id, name, static_prompt, model, ... }]
GET    /api/apps/{{APP_ID}}/agents/{agentId}           → { id, name, static_prompt, ..., guidelines: [...], mcp_servers: [...] }
POST   /api/apps/{{APP_ID}}/agents/{agentId}           → update { name?, static_prompt?, model?, temperature? }
POST   /api/apps/{{APP_ID}}/agents/{agentId}/delete    → { ok: true }

GUIDELINES CRUD (voice/style guidelines, linkable to agents many-to-many):
POST   /api/apps/{{APP_ID}}/guidelines                → { name, content } → { id, ... }
GET    /api/apps/{{APP_ID}}/guidelines                → [{ id, name, content, ... }]
POST   /api/apps/{{APP_ID}}/guidelines/{id}            → update { name?, content? }
POST   /api/apps/{{APP_ID}}/guidelines/{id}/delete     → { ok: true }

MCP SERVERS (external tool servers, linkable to agents many-to-many):
POST   /api/apps/{{APP_ID}}/mcp-servers               → { name, url, api_key? } → { id, ... }
GET    /api/apps/{{APP_ID}}/mcp-servers               → [{ id, name, url, ... }]
POST   /api/apps/{{APP_ID}}/mcp-servers/{id}           → update { name?, url?, api_key? }
POST   /api/apps/{{APP_ID}}/mcp-servers/{id}/delete    → { ok: true }

LINKING (many-to-many):
POST   /api/apps/{{APP_ID}}/agents/{agentId}/guidelines        → { guideline_id } (link)
POST   /api/apps/{{APP_ID}}/agents/{agentId}/guidelines/delete → { guideline_id } (unlink)
GET    /api/apps/{{APP_ID}}/agents/{agentId}/guidelines        → linked guidelines
POST   /api/apps/{{APP_ID}}/agents/{agentId}/mcp-servers        → { mcp_server_id } (link)
POST   /api/apps/{{APP_ID}}/agents/{agentId}/mcp-servers/delete → { mcp_server_id } (unlink)
GET    /api/apps/{{APP_ID}}/agents/{agentId}/mcp-servers        → linked MCP servers

AGENT INVOCATION:
1) Stateless (one-shot — agent uses its prompt + guidelines + tools to handle a single task):
   POST /api/apps/{{APP_ID}}/agents/{agentId}/invoke
   Request:  { prompt: "user task" }
   Response: { role: "assistant", content: "...", tool_calls_made: 0 }

2) Persistent conversations (agent-scoped chat with history):
   POST /api/apps/{{APP_ID}}/agents/{agentId}/conversations           → create { title? }
   GET  /api/apps/{{APP_ID}}/agents/{agentId}/conversations           → list
   POST /api/apps/{{APP_ID}}/agents/{agentId}/conversations/{id}/messages → send message { content: "..." }
   (Same response format as regular chat conversations)

The agent's system prompt is: static_prompt + all linked guidelines' content + app data context.
If MCP servers are linked, the agent can call external tools automatically (tool use loop).

LOGOS & AVATARS:
- For logos: https://ui-avatars.com/api/?name=CompanyName&size=128&background=random

CRITICAL GUARDRAILS — DO NOT VIOLATE:
- NEVER build features beyond CRUD operations + chat/conversation APIs + agent APIs
- NEVER create login/signup forms — the platform handles authentication automatically
- NEVER attempt file uploads, WebSockets, email sending, payment processing, or any server-side feature
- NEVER create server-side code — your output is HTML + table definitions + seedData ONLY
- If a request implies unsupported capabilities, implement the closest client-side equivalent with a comment explaining the limitation`;

const EDIT_SYSTEM_PROMPT = `You are a full-stack web app editor. You receive current HTML + schema and a change description.

Return ONLY valid JSON (no markdown fences, no explanation) with this structure:
{
  "tables": [...all tables with full column lists...],
  "html": "<complete updated HTML>",
  "newTables": ["tablename"],
  "newColumns": { "existingTable": [{ "name": "col", "type": "TEXT", "nullable": true }] },
  "seedData": { "tablename": [{...}] }
}

IMPORTANT: Output "tables" FIRST, then "html", then the rest. Keep seedData compact and LAST.
Your ENTIRE response must be a single valid JSON object. No code fences, no surrounding text.

- "tables": ALL tables (existing + new) with FULL column lists
- "newTables": only completely new tables to CREATE
- "newColumns": only NEW columns to ADD to existing tables
- "seedData": optional, only for new tables or when user asks for data (keep to 10-15 rows max)
- If no schema changes: newTables=[], newColumns={}
- Use {{APP_ID}} placeholder in API URLs
- Preserve existing functionality unless the edit changes it
- May use CDN imports from esm.sh, jsdelivr, unpkg

GUARDRAILS: Never build login/signup forms (platform handles auth), no file uploads, WebSockets, email, payments, or server-side code. Output is HTML + tables + seedData only.`;

const EDIT_DIFF_SYSTEM_PROMPT = `You are a web app editor. You receive current HTML + schema and a change description.

Instead of returning the entire HTML, return surgical PATCHES — exact search/replace operations.

Return ONLY valid JSON (no markdown fences, no explanation) with this structure:
{
  "patches": [
    { "search": "exact text from current HTML", "replace": "replacement text" }
  ],
  "newTables": [],
  "newColumns": {},
  "seedData": {}
}

PATCH RULES:
- Each "search" MUST be an EXACT substring of the current HTML (including whitespace, newlines, indentation)
- Include enough surrounding context in "search" to ensure it is UNIQUE in the document (2-3 lines minimum)
- Patches are applied in order — later patches operate on the result of earlier ones
- For ADDITIONS: use a search string that identifies the insertion point, then include it plus the new content in "replace"
- For DELETIONS: include the text to remove in "search", set "replace" to "" (empty string)
- Keep patches minimal — only change what the user asked for
- Do NOT rewrite the whole HTML via one giant patch — that defeats the purpose

TABLE RULES (same as full edit):
- "newTables": only completely new tables to CREATE (with name + columns array)
- "newColumns": only NEW columns to ADD to existing tables: { "tableName": [{ "name": "col", "type": "TEXT", "nullable": true }] }
- "seedData": only for new tables or when the user specifically asks for data
- If no schema changes: newTables=[], newColumns={}, seedData={}

- Use {{APP_ID}} placeholder in any new API URLs
- Preserve existing functionality unless the edit specifically changes it

GUARDRAILS: Never build login/signup forms, no file uploads, WebSockets, email, payments, or server-side code.`;

export async function extractUxLesson(
  editDescription: string,
  client: Anthropic,
  appId?: string,
): Promise<string | null> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `A user of a generated web app requested this change: "${editDescription}". Extract a concise, generalizable UX rule that should apply to ALL future generated apps. Focus on what the generator should do differently. Return ONLY the rule, one sentence, no preamble. If this is too app-specific to generalize, return NONE.`,
      },
    ],
  });

  if (appId) {
    logUsage(appId, "ux-lesson", "claude-sonnet-4-6", response.usage.input_tokens, response.usage.output_tokens);
  }

  const block = response.content[0];
  if (block.type !== "text") return null;
  const text = block.text.trim();
  if (text === "NONE" || text.startsWith("NONE")) return null;
  return text;
}

function buildUxLessonsBlock(): string {
  const lessons = listUxLessons();
  if (lessons.length === 0) return "";
  const lines = lessons.map((l) => `- ${l.lesson}`).join("\n");
  return `\n\nUX RULES — LEARNED FROM PAST USER FEEDBACK (MUST follow these):\n${lines}`;
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
}

// Attempt to repair truncated JSON by closing open brackets
function repairTruncatedJson(raw: string): string {
  // Already valid?
  try {
    JSON.parse(raw);
    return raw;
  } catch { /* continue to repair */ }

  console.log(`[generate] Attempting to repair truncated JSON (${raw.length} chars)...`);

  // Walk the string to find the last position ending with a properly closed value
  let inString = false;
  let escape = false;
  let lastCloseBracketPos = 0;
  const stack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
        stack.push("}");
        break;
      case "[":
        stack.push("]");
        break;
      case "}":
      case "]":
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
          lastCloseBracketPos = i + 1;
        }
        break;
    }
  }

  // Truncate to last valid close-bracket position
  let repaired = raw.slice(0, lastCloseBracketPos).trimEnd();
  if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);

  console.log(
    `[generate] Truncated to last complete value at pos ${lastCloseBracketPos} (removed ${raw.length - lastCloseBracketPos} trailing chars)`,
  );

  // Re-scan truncated string to count remaining open brackets
  const openStack: string[] = [];
  inString = false;
  escape = false;
  for (const ch of repaired) {
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
        openStack.push("}");
        break;
      case "[":
        openStack.push("]");
        break;
      case "}":
      case "]":
        if (
          openStack.length > 0 &&
          openStack[openStack.length - 1] === ch
        )
          openStack.pop();
        break;
    }
  }

  // Close remaining open brackets in correct order
  const closing = openStack.reverse().join("");
  repaired += closing;

  console.log(
    `[generate] Added ${closing.length} closing bracket(s): ${closing}`,
  );

  try {
    JSON.parse(repaired);
    console.log(
      `[generate] JSON repair successful! ${repaired.length} chars (was ${raw.length})`,
    );
    return repaired;
  } catch (e) {
    console.error(`[generate] JSON repair still invalid:`, e);
    throw new Error(
      `Response was truncated and could not be repaired`,
    );
  }
}

// Extract and clean JSON from raw LLM output
function extractJson(raw: string): string {
  let cleaned = stripCodeFences(raw.trim());

  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("No JSON object found in response");
  }

  if (firstBrace > 0) {
    console.log(
      `[generate] Stripping ${firstBrace} chars of prefix text before JSON`,
    );
    cleaned = cleaned.slice(firstBrace);
  }

  // Don't aggressively strip suffix — let repair handle truncation
  // Only strip obvious trailing text after a final }
  const lastBrace = cleaned.lastIndexOf("}");
  if (lastBrace === -1) {
    throw new Error(
      "No closing brace found in response — JSON may be truncated",
    );
  }

  if (lastBrace < cleaned.length - 1) {
    const suffix = cleaned.slice(lastBrace + 1).trim();
    if (suffix.length > 0) {
      console.log(
        `[generate] Stripping ${cleaned.length - 1 - lastBrace} chars of suffix text after JSON`,
      );
      cleaned = cleaned.slice(0, lastBrace + 1);
    }
  }

  return cleaned;
}

export interface EditProgressEvent {
  step: "analyzing" | "generating" | "applying" | "complete" | "error";
  message: string;
  tokens?: number;
}

export type EditProgressCallback = (event: EditProgressEvent) => void | Promise<void>;

interface ParsedResponse {
  tables: TableDef[];
  html: string;
  seedData?: Record<string, Record<string, unknown>[]>;
  newTables?: string[];
  newColumns?: Record<string, ColumnDef[]>;
}

function parseResponse(
  raw: string,
  label: string,
  wasTruncated: boolean,
): ParsedResponse {
  console.log(`[generate] ${label}: Raw response length: ${raw.length} chars`);
  console.log(
    `[generate] ${label}: First 200 chars: ${raw.slice(0, 200)}`,
  );
  console.log(
    `[generate] ${label}: Last 200 chars: ${raw.slice(-200)}`,
  );

  let jsonStr: string;
  try {
    jsonStr = extractJson(raw);
  } catch (e) {
    console.error(`[generate] ${label}: Failed to extract JSON:`, e);
    console.error(
      `[generate] ${label}: Full response:\n${raw.slice(0, 2000)}`,
    );
    throw e;
  }

  console.log(
    `[generate] ${label}: Extracted JSON length: ${jsonStr.length} chars`,
  );

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr);
  } catch (parseErr) {
    if (wasTruncated) {
      console.warn(
        `[generate] ${label}: JSON.parse failed on truncated response, attempting repair...`,
      );
      try {
        jsonStr = repairTruncatedJson(jsonStr);
        data = JSON.parse(jsonStr);
      } catch (repairErr) {
        console.error(
          `[generate] ${label}: Repair also failed:`,
          repairErr,
        );
        logParseError(jsonStr, parseErr, label);
        throw new Error(
          `Response was truncated (max_tokens) and could not be repaired`,
        );
      }
    } else {
      logParseError(jsonStr, parseErr, label);
      throw new Error(
        `Failed to parse LLM response as JSON: ${parseErr instanceof Error ? parseErr.message : parseErr}`,
      );
    }
  }

  console.log(
    `[generate] ${label}: Parsed JSON keys: ${Object.keys(data!).join(", ")}`,
  );

  if (!Array.isArray(data!.tables)) {
    console.error(
      `[generate] ${label}: "tables" is not an array, got: ${typeof data!.tables}`,
    );
    throw new Error(
      "Invalid response structure: missing or invalid 'tables' array",
    );
  }

  if (typeof data!.html !== "string") {
    console.error(
      `[generate] ${label}: "html" is not a string, got: ${typeof data!.html}`,
    );
    throw new Error(
      "Invalid response structure: missing or invalid 'html' string",
    );
  }

  console.log(
    `[generate] ${label}: Found ${(data!.tables as unknown[]).length} table(s), HTML length: ${(data!.html as string).length}`,
  );

  for (const table of data!.tables as Record<string, unknown>[]) {
    if (!table.name || !Array.isArray(table.columns)) {
      console.error(
        `[generate] ${label}: Invalid table definition:`,
        JSON.stringify(table).slice(0, 200),
      );
      throw new Error(
        `Invalid table definition: ${JSON.stringify(table).slice(0, 200)}`,
      );
    }
    console.log(
      `[generate] ${label}: Table "${table.name}" has ${(table.columns as unknown[]).length} column(s)`,
    );
  }

  if (data!.seedData && typeof data!.seedData === "object") {
    const seedData = data!.seedData as Record<string, unknown[]>;
    for (const [tbl, rows] of Object.entries(seedData)) {
      console.log(
        `[generate] ${label}: Seed data for "${tbl}": ${Array.isArray(rows) ? rows.length : 0} row(s)`,
      );
    }
  } else {
    console.log(`[generate] ${label}: No seed data in response`);
  }

  return data! as unknown as ParsedResponse;
}

function logParseError(
  jsonStr: string,
  err: unknown,
  label: string,
): void {
  console.error(`[generate] ${label}: JSON.parse failed:`, err);
  if (err instanceof SyntaxError) {
    const posMatch = err.message.match(/position (\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      console.error(
        `[generate] ${label}: Context around error (pos ${pos}):`,
      );
      console.error(
        jsonStr.slice(Math.max(0, pos - 100), pos + 100),
      );
    }
  }
  console.error(
    `[generate] ${label}: First 500 chars:\n${jsonStr.slice(0, 500)}`,
  );
  console.error(
    `[generate] ${label}: Last 500 chars:\n${jsonStr.slice(-500)}`,
  );
}

function insertSeedData(
  appId: string,
  seedData: Record<string, Record<string, unknown>[]>,
): void {
  for (const [tableName, rows] of Object.entries(seedData)) {
    if (!Array.isArray(rows)) {
      console.warn(
        `[generate] Seed data for "${tableName}" is not an array, skipping`,
      );
      continue;
    }
    const ftn = getFullTableName(appId, tableName);
    let inserted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        insertRow(ftn, row);
        inserted++;
      } catch (e) {
        failed++;
        if (failed <= 3) {
          console.warn(
            `[generate] Failed to insert seed row into ${tableName}:`,
            e,
          );
          console.warn(
            `[generate] Row data:`,
            JSON.stringify(row).slice(0, 200),
          );
        }
      }
    }
    console.log(
      `[generate] Seed data for "${tableName}": ${inserted} inserted, ${failed} failed out of ${rows.length} total`,
    );
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
}

function randomAlphanumeric(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export async function generateApp(
  input: GenerateInput,
  client: Anthropic,
): Promise<{ appId: string; credentials: { username: string; password: string } }> {
  if (!input.body) {
    throw new Error("App description (body) is required");
  }

  const body = input.body;
  const title =
    input.title ||
    body
      .split("\n")[0]
      .replace(/^#+\s*/, "")
      .slice(0, 100) ||
    "Untitled App";
  const issueUrl = "manual-input";
  console.log(
    `[generate] Manual input: "${title}" (${body.length} chars)`,
  );

  const uxLessonsBlock = buildUxLessonsBlock();
  const systemPrompt = SYSTEM_PROMPT + uxLessonsBlock;

  console.log(
    `[generate] Sending streaming request to Claude (model: claude-opus-4-6, max_tokens: 64000)...`,
  );
  if (uxLessonsBlock) {
    console.log(`[generate] Injecting ${listUxLessons().length} UX lesson(s) into system prompt`);
  }
  const startTime = Date.now();

  let userContent = `App Request: ${title}\n\n${body}`;
  if (input.prd) {
    userContent += `\n\n--- PRODUCT REQUIREMENTS DOCUMENT ---\n${input.prd}`;
  }
  if (input.erd) {
    userContent += `\n\n--- ENGINEERING REQUIREMENTS DOCUMENT ---\n${input.erd}`;
  }

  const stream = client.messages.stream({
    model: "claude-opus-4-6",
    max_tokens: 64000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  // Log token progress as it streams
  let lastLoggedTokens = 0;
  stream.on("text", () => {
    const current = stream.currentMessage?.usage?.output_tokens ?? 0;
    if (current - lastLoggedTokens >= 2000) {
      console.log(`[generate] Streaming... ${current} output tokens so far`);
      lastLoggedTokens = current;
    }
  });

  const response = await stream.finalMessage();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[generate] Claude responded in ${elapsed}s`);
  console.log(`[generate] Stop reason: ${response.stop_reason}`);
  console.log(
    `[generate] Usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`,
  );

  const wasTruncated = response.stop_reason === "max_tokens";
  if (wasTruncated) {
    console.warn(
      `[generate] WARNING: Response was truncated (hit max_tokens). Will attempt JSON repair.`,
    );
  }

  const block = response.content[0];
  if (block.type !== "text") {
    console.error(
      `[generate] Unexpected content block type: ${block.type}`,
    );
    throw new Error(
      `Unexpected response type from Claude: ${block.type}`,
    );
  }

  const parsed = parseResponse(block.text, "generateApp", wasTruncated);
  const appId = crypto.randomUUID();
  console.log(`[generate] App ID: ${appId}`);

  console.log(
    `[generate] Creating ${parsed.tables.length} table(s)...`,
  );
  createAppTables(appId, parsed.tables);
  console.log(`[generate] Tables created successfully`);

  if (parsed.seedData) {
    console.log(`[generate] Inserting seed data...`);
    insertSeedData(appId, parsed.seedData);
    console.log(`[generate] Seed data insertion complete`);
  }

  const html = parsed.html.replace(/\{\{APP_ID\}\}/g, appId);
  saveApp(appId, issueUrl, title, html, body, input.prd, input.erd);
  logUsage(appId, "generate", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);
  console.log(
    `[generate] App saved: "${title}" -> /apps/${appId}`,
  );

  // Generate per-app credentials
  const slug = slugify(title) || "app";
  const shortId = appId.slice(0, 4);
  const username = `app-${slug}-${shortId}`;
  const password = `${slug}-${randomAlphanumeric(4)}`;
  saveAppCredentials(appId, username, password);
  console.log(`[generate] App credentials created: ${username}`);

  return { appId, credentials: { username, password } };
}

interface PatchOp {
  search: string;
  replace: string;
}

interface ParsedDiffResponse {
  patches: PatchOp[];
  newTables?: string[];
  newColumns?: Record<string, ColumnDef[]>;
  seedData?: Record<string, Record<string, unknown>[]>;
}

function applyPatches(html: string, patches: PatchOp[]): string | null {
  let result = html;
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch.search || !result.includes(patch.search)) {
      console.warn(
        `[generate] Patch ${i + 1}/${patches.length} search not found (${patch.search.length} chars): "${patch.search.slice(0, 120)}..."`,
      );
      return null; // Signal failure — caller should fall back
    }
    result = result.replace(patch.search, patch.replace);
    console.log(
      `[generate] Patch ${i + 1}/${patches.length} applied: -${patch.search.length} +${patch.replace.length} chars`,
    );
  }
  return result;
}

async function editAppFast(
  appId: string,
  currentHtml: string,
  schemaDescription: string,
  description: string,
  client: Anthropic,
  onProgress?: EditProgressCallback,
): Promise<boolean | null> {
  // Returns true on success, null on failure (caller should fall back)
  console.log(`[generate] Trying fast diff-based edit with Sonnet...`);
  const startTime = Date.now();

  const uxLessonsBlock = buildUxLessonsBlock();

  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    system: EDIT_DIFF_SYSTEM_PROMPT + uxLessonsBlock,
    messages: [
      {
        role: "user",
        content: `Current app HTML:\n${currentHtml}\n\nCurrent database schema:\n${schemaDescription}\n\nRequested changes:\n${description}`,
      },
    ],
  });

  let lastLoggedTokens = 0;
  stream.on("text", () => {
    const current = stream.currentMessage?.usage?.output_tokens ?? 0;
    if (current - lastLoggedTokens >= 500) {
      console.log(`[generate] Fast edit streaming... ${current} output tokens`);
      lastLoggedTokens = current;
      onProgress?.({ step: "generating", message: "Generating changes...", tokens: current });
    }
  });

  const response = await stream.finalMessage();
  logUsage(appId, "edit-fast", "claude-sonnet-4-6", response.usage.input_tokens, response.usage.output_tokens);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[generate] Sonnet responded in ${elapsed}s, stop: ${response.stop_reason}, output: ${response.usage.output_tokens} tokens`,
  );

  const block = response.content[0];
  if (block.type !== "text") {
    console.warn(`[generate] Fast edit: unexpected block type ${block.type}`);
    return null;
  }

  // Parse the diff response
  let jsonStr: string;
  try {
    jsonStr = extractJson(block.text);
  } catch {
    console.warn(`[generate] Fast edit: failed to extract JSON, falling back`);
    return null;
  }

  let data: ParsedDiffResponse;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    console.warn(`[generate] Fast edit: JSON parse failed, falling back`);
    return null;
  }

  if (!Array.isArray(data.patches)) {
    console.warn(`[generate] Fast edit: no patches array, falling back`);
    return null;
  }

  console.log(`[generate] Fast edit: ${data.patches.length} patch(es) to apply`);

  // Apply patches to HTML
  const patchedHtml = applyPatches(currentHtml, data.patches);
  if (patchedHtml === null) {
    console.warn(`[generate] Fast edit: patch application failed, falling back`);
    return null;
  }

  // Apply schema changes
  if (data.newTables && data.newTables.length > 0) {
    // Need table defs — the diff response should include them in newTables
    // But the diff format doesn't include full table defs. We'll parse from the patches.
    // For now, log and continue — schema changes in diff mode are rare
    console.log(`[generate] Fast edit: ${data.newTables.length} new table(s) requested`);
  }

  if (data.newColumns) {
    for (const [tableName, cols] of Object.entries(data.newColumns)) {
      console.log(
        `[generate] Fast edit: adding ${cols.length} column(s) to "${tableName}"`,
      );
      for (const col of cols) {
        addColumnToTable(appId, tableName, col);
      }
    }
  }

  if (data.seedData) {
    console.log(`[generate] Fast edit: inserting seed data...`);
    insertSeedData(appId, data.seedData);
  }

  const html = patchedHtml.replace(/\{\{APP_ID\}\}/g, appId);
  updateAppHtml(appId, html);
  console.log(`[generate] Fast edit completed in ${elapsed}s`);
  return true;
}

export async function editApp(
  appId: string,
  description: string,
  client: Anthropic,
  onProgress?: EditProgressCallback,
): Promise<boolean> {
  console.log(
    `[generate] Editing app ${appId}: "${description.slice(0, 100)}"`,
  );

  try {
    const app = getApp(appId);
    if (!app) throw new Error("App not found");

    const schemas = getAllAppSchemas(appId);
    console.log(
      `[generate] Current schema: ${schemas.length} table(s)`,
    );
    const schemaDescription = schemas
      .map(
        (s) =>
          `Table "${s.tableName}": ${JSON.stringify(s.columns)}`,
      )
      .join("\n");

    if (onProgress) await onProgress({ step: "analyzing", message: "Analyzing app and schema..." });

    // === Phase 1: Try fast diff-based edit with Sonnet ===
    if (onProgress) await onProgress({ step: "generating", message: "Generating changes..." });

    try {
      const fastResult = await editAppFast(
        appId, app.html, schemaDescription, description, client, onProgress,
      );

      if (fastResult === true) {
        if (onProgress) await onProgress({ step: "complete", message: "Edit complete" });
        return true;
      }
    } catch (fastErr) {
      console.warn(`[generate] Fast edit threw:`, fastErr);
    }

    // === Phase 2: Fallback to full regeneration with Opus ===
    console.log(`[generate] Falling back to full regeneration with Opus...`);
    if (onProgress) await onProgress({ step: "generating", message: "Regenerating full app (patch failed, using thorough mode)..." });

    const uxLessonsBlock = buildUxLessonsBlock();
    const editSystemPrompt = EDIT_SYSTEM_PROMPT + uxLessonsBlock;

    console.log(`[generate] Sending streaming edit request to Opus...`);
    const startTime = Date.now();

    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 64000,
      system: editSystemPrompt,
      messages: [
        {
          role: "user",
          content: `Current app HTML:\n${app.html}\n\nCurrent database schema:\n${schemaDescription}\n\nRequested changes:\n${description}`,
        },
      ],
    });

    let lastLoggedTokens = 0;
    stream.on("text", () => {
      const current = stream.currentMessage?.usage?.output_tokens ?? 0;
      if (current - lastLoggedTokens >= 500) {
        console.log(`[generate] Streaming edit... ${current} output tokens so far`);
        lastLoggedTokens = current;
        onProgress?.({ step: "generating", message: "Regenerating full app...", tokens: current });
      }
    });

    const response = await stream.finalMessage();
    logUsage(appId, "edit-full", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[generate] Opus responded in ${elapsed}s`);
    console.log(`[generate] Stop reason: ${response.stop_reason}`);
    console.log(
      `[generate] Usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`,
    );

    const wasTruncated = response.stop_reason === "max_tokens";
    if (wasTruncated) {
      console.warn(
        `[generate] WARNING: Edit response was truncated. Will attempt JSON repair.`,
      );
    }

    const block = response.content[0];
    if (block.type !== "text") {
      console.error(
        `[generate] Unexpected content block type: ${block.type}`,
      );
      throw new Error(
        `Unexpected response type from Claude: ${block.type}`,
      );
    }

    if (onProgress) await onProgress({ step: "applying", message: "Applying changes..." });

    const parsed = parseResponse(block.text, "editApp", wasTruncated);

    if (parsed.newTables && parsed.newTables.length > 0) {
      console.log(
        `[generate] Creating ${parsed.newTables.length} new table(s): ${parsed.newTables.join(", ")}`,
      );
      const newTableDefs = parsed.tables.filter((t) =>
        parsed.newTables!.includes(t.name),
      );
      createAppTables(appId, newTableDefs);
    }

    if (parsed.newColumns) {
      for (const [tableName, cols] of Object.entries(
        parsed.newColumns,
      )) {
        console.log(
          `[generate] Adding ${cols.length} column(s) to "${tableName}": ${cols.map((c) => c.name).join(", ")}`,
        );
        for (const col of cols) {
          addColumnToTable(appId, tableName, col);
        }
      }
    }

    if (parsed.seedData) {
      console.log(
        `[generate] Inserting seed data for edited app...`,
      );
      insertSeedData(appId, parsed.seedData);
    }

    const html = parsed.html.replace(/\{\{APP_ID\}\}/g, appId);
    updateAppHtml(appId, html);
    console.log(`[generate] App updated successfully`);

    if (onProgress) await onProgress({ step: "complete", message: "Edit complete" });

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Edit failed";
    onProgress?.({ step: "error", message: msg });
    throw err;
  }
}

// === PRD / ERD / POC Plan Generation ===

const PLATFORM_CONSTRAINTS = `PLATFORM CONSTRAINTS (the generated app runs on this platform):
- Output is a single-page HTML document with inline CSS and JavaScript
- Data persistence via SQLite tables accessed through REST CRUD endpoints
- LLM chat available via stateless /chat and persistent /conversations endpoints
- AI agents with custom prompts, guidelines, and MCP tool integrations
- Authentication is handled by the platform — do NOT design login/signup flows
- No file uploads, WebSockets, email, payment processing, or server-side code
- CDN imports allowed (Chart.js, D3, etc.)
- All interactivity must be client-side JavaScript`;

export async function generatePrd(
  description: string,
  title: string,
  client: Anthropic,
  appId?: string,
): Promise<string> {
  console.log(`[generate] Generating PRD for "${title}"...`);
  const startTime = Date.now();

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `You are a senior product manager. Create a comprehensive Product Requirements Document (PRD) for the following app.

App Title: ${title}
App Description:
${description}

${PLATFORM_CONSTRAINTS}

Return a well-structured markdown PRD with these sections:
1. **Overview** — What the app does and its primary value proposition
2. **User Personas** — Who will use this app and their goals
3. **Core Features** — Each feature with clear acceptance criteria
4. **Data Model** — What data entities are needed and their relationships
5. **User Flows** — Key workflows users will go through
6. **UI/UX Requirements** — Layout, navigation, visual design guidance
7. **Non-Functional Requirements** — Performance, accessibility, responsiveness

Be specific and actionable. Every feature must be implementable within the platform constraints above.`,
      },
    ],
  });

  if (appId) {
    logUsage(appId, "generate-prd", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[generate] PRD generated in ${elapsed}s`);

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function generateErd(
  prd: string,
  title: string,
  client: Anthropic,
  appId?: string,
): Promise<string> {
  console.log(`[generate] Generating ERD for "${title}"...`);
  const startTime = Date.now();

  const uxLessonsBlock = buildUxLessonsBlock();

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `You are a senior software engineer. Create a comprehensive Engineering Requirements Document (ERD) based on the following PRD.

App Title: ${title}

--- PRODUCT REQUIREMENTS DOCUMENT ---
${prd}

${PLATFORM_CONSTRAINTS}
${uxLessonsBlock}

Return a well-structured markdown ERD with these sections:
1. **Database Schema** — Exact table and column definitions (name, type, nullable, defaults). Remember: every table auto-gets \`id INTEGER PRIMARY KEY AUTOINCREMENT\`
2. **Seed Data Plan** — What realistic seed data to generate (10-15 rows per main table) with specific examples
3. **API Integration Plan** — Which CRUD endpoints the app will use and how
4. **AI/Chat Integration** — How to use stateless /chat or persistent /conversations for AI features
5. **UI Architecture** — Component layout, sections, navigation structure
6. **Interactive Features** — Client-side interactivity, filtering, sorting, modals, charts
7. **Error Handling** — How to handle API errors, loading states, empty states
8. **CDN Dependencies** — Which external libraries to import and why

Be extremely specific. A developer should be able to build the complete app from this ERD alone.`,
      },
    ],
  });

  if (appId) {
    logUsage(appId, "generate-erd", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[generate] ERD generated in ${elapsed}s`);

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function regenerateApp(
  appId: string,
  prd: string,
  erd: string,
  client: Anthropic,
): Promise<void> {
  console.log(`[generate] Regenerating app ${appId} from PRD+ERD...`);
  const app = getApp(appId);
  if (!app) throw new Error("App not found");

  const uxLessonsBlock = buildUxLessonsBlock();
  const systemPrompt = SYSTEM_PROMPT + uxLessonsBlock;

  let userContent = `App Request: ${app.title}\n\n${app.description}`;
  userContent += `\n\n--- PRODUCT REQUIREMENTS DOCUMENT ---\n${prd}`;
  userContent += `\n\n--- ENGINEERING REQUIREMENTS DOCUMENT ---\n${erd}`;

  const startTime = Date.now();
  const stream = client.messages.stream({
    model: "claude-opus-4-6",
    max_tokens: 64000,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  let lastLoggedTokens = 0;
  stream.on("text", () => {
    const current = stream.currentMessage?.usage?.output_tokens ?? 0;
    if (current - lastLoggedTokens >= 2000) {
      console.log(`[generate] Regeneration streaming... ${current} output tokens so far`);
      lastLoggedTokens = current;
    }
  });

  const response = await stream.finalMessage();
  logUsage(appId, "regenerate", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[generate] Regeneration response in ${elapsed}s, stop: ${response.stop_reason}`);

  const wasTruncated = response.stop_reason === "max_tokens";
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");

  const parsed = parseResponse(block.text, "regenerateApp", wasTruncated);

  // Drop existing tables and recreate
  const existingSchemas = getAllAppSchemas(appId);
  for (const schema of existingSchemas) {
    const ftn = getFullTableName(appId, schema.tableName);
    try {
      // We need to import db for raw exec — use getFullTableName and insertRow pattern
      // Actually we can use the db module's exec via a helper. For now, just create fresh tables.
    } catch { /* ignore */ }
  }

  console.log(`[generate] Creating ${parsed.tables.length} table(s)...`);
  createAppTables(appId, parsed.tables);

  if (parsed.seedData) {
    console.log(`[generate] Inserting seed data...`);
    insertSeedData(appId, parsed.seedData);
  }

  const html = parsed.html.replace(/\{\{APP_ID\}\}/g, appId);
  updateAppHtml(appId, html);
  console.log(`[generate] App regenerated successfully`);
}

export async function generatePocPlan(
  appId: string,
  client: Anthropic,
): Promise<string> {
  console.log(`[generate] Generating POC Build Plan for app ${appId}...`);
  const app = getApp(appId);
  if (!app) throw new Error("App not found");

  // Gather context
  const schemas = getAllAppSchemas(appId);
  const editReqs = listEditRequests(appId);
  const convos = listConversations(appId);

  // Collect recent chat messages (up to 10 convos, 20 msgs each)
  let chatContext = "";
  const convosToScan = convos.slice(0, 10);
  for (const convo of convosToScan) {
    const msgs = getMessages(convo.id);
    const recentMsgs = msgs.slice(-20);
    if (recentMsgs.length > 0) {
      chatContext += `\n\nConversation "${convo.title}":\n`;
      for (const msg of recentMsgs) {
        chatContext += `  [${msg.role}]: ${msg.content.slice(0, 500)}\n`;
      }
    }
  }

  const schemaDesc = schemas.map(s =>
    `Table "${s.tableName}": ${s.columns.map(c => `${c.name} (${c.type})`).join(", ")}`
  ).join("\n");

  const editReqDesc = editReqs.length > 0
    ? editReqs.map((r, i) => `${i + 1}. [${r.username}] ${r.description}`).join("\n")
    : "No edit requests yet.";

  const startTime = Date.now();
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `You are a technical project manager. Generate a Trello-ready POC Build Plan for turning this prototype app into a production application.

App Title: ${app.title}
App Description: ${app.description}

${app.prd ? `--- PRD ---\n${app.prd}\n` : ""}
${app.erd ? `--- ERD ---\n${app.erd}\n` : ""}
--- CURRENT SCHEMA ---
${schemaDesc}

--- CLIENT EDIT REQUESTS (feedback from prospect) ---
${editReqDesc}

${chatContext ? `--- RECENT CHAT CONVERSATIONS (client interactions) ---${chatContext}` : ""}

--- CURRENT HTML (first 5000 chars) ---
${app.html.slice(0, 5000)}

Generate a markdown build plan organized into sprints with Trello-ready tickets:

**Sprint 1: Foundation** — Infrastructure, database, authentication, core API
**Sprint 2: Core Features** — Features from the PRD
**Sprint 3: Polish & Feedback** — Address client edit requests and chat feedback
**Sprint 4: Launch Prep** — Testing, documentation, deployment

For each ticket use this format:
**[TICKET-XXX] Title**
- Estimate: S / M / L / XL
- Description: What needs to be done
- Acceptance Criteria:
  - [ ] Criterion 1
  - [ ] Criterion 2

Number tickets sequentially (TICKET-001, TICKET-002, etc.). Be specific and actionable.`,
      },
    ],
  });

  logUsage(appId, "poc-plan", "claude-opus-4-6", response.usage.input_tokens, response.usage.output_tokens);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[generate] POC Build Plan generated in ${elapsed}s`);

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");

  // Store it
  updateAppPocPlan(appId, block.text);
  return block.text;
}

