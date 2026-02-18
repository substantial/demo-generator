import Anthropic from "@anthropic-ai/sdk";
import {
  createAppTables,
  saveApp,
  saveAppCredentials,
  getApp,
  getAllAppSchemas,
  updateAppHtml,
  addColumnToTable,
  insertRow,
  getFullTableName,
  type TableDef,
  type ColumnDef,
} from "./db.ts";

export interface GenerateInput {
  title?: string;
  body?: string;
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

LOGOS & AVATARS:
- For logos: https://ui-avatars.com/api/?name=CompanyName&size=128&background=random`;

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
- May use CDN imports from esm.sh, jsdelivr, unpkg`;

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

  console.log(
    `[generate] Sending streaming request to Claude (model: claude-sonnet-4-5-20250929, max_tokens: 64000)...`,
  );
  const startTime = Date.now();

  const stream = client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `App Request: ${title}\n\n${body}`,
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
  saveApp(appId, issueUrl, title, html, body);
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

export async function editApp(
  appId: string,
  description: string,
  client: Anthropic,
): Promise<boolean> {
  console.log(
    `[generate] Editing app ${appId}: "${description.slice(0, 100)}"`,
  );

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

  console.log(`[generate] Sending streaming edit request to Claude...`);
  const startTime = Date.now();

  const stream = client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64000,
    system: EDIT_SYSTEM_PROMPT,
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
    if (current - lastLoggedTokens >= 2000) {
      console.log(`[generate] Streaming edit... ${current} output tokens so far`);
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

  return true;
}

