import { Hono } from "@hono/hono";
import Anthropic from "@anthropic-ai/sdk";
import { load } from "@std/dotenv";
import { loginHandler, logoutHandler, authMiddleware, requireRoot, requireAppAccess } from "./auth.ts";
import { listAppsWithCredentials, getApp } from "./db.ts";
import { generateApp, editApp } from "./generate.ts";
import { crud } from "./crud.ts";
import { createChatRoutes } from "./chat.ts";

// Load environment variables from .env file
const env = await load();

// Set env vars so modules can read them via Deno.env
for (const [k, v] of Object.entries(env)) {
  Deno.env.set(k, v);
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

type AppEnv = {
  Variables: {
    user: string;
    role: string;
    appId: string;
  };
};

const app = new Hono<AppEnv>();

// --- Public routes ---
app.get("/login", async (c) => {
  const html = await Deno.readTextFile("static/login.html");
  return c.html(html);
});

app.post("/auth/login", loginHandler);
app.get("/auth/logout", logoutHandler);

// --- Dashboard: root only ---
app.use("/dashboard", authMiddleware, requireRoot);

app.get("/", (c) => c.redirect("/dashboard"));

app.get("/dashboard", async (c) => {
  const html = await Deno.readTextFile("static/dashboard.html");
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

  try {
    const result = await generateApp({ title: body.title, body: body.body }, client);
    return c.json({ appId: result.appId, credentials: result.credentials });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "App generation failed";
    return c.json({ error: msg }, 500);
  }
});

app.post("/api/apps/:appId/edit", authMiddleware, requireRoot, async (c) => {
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

  try {
    await editApp(appId, body.description, client);
    return c.json({ ok: true, updated: "app" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Edit failed";
    return c.json({ error: msg }, 500);
  }
});

// --- Per-app routes: app access (root or matching app credential) ---
app.use("/apps/:appId", authMiddleware, requireAppAccess);
app.use("/api/apps/:appId/tables/*", authMiddleware, requireAppAccess);
app.use("/api/apps/:appId/chat", authMiddleware, requireAppAccess);
app.use("/api/apps/:appId/conversations/*", authMiddleware, requireAppAccess);
app.use("/api/apps/:appId/conversations", authMiddleware, requireAppAccess);
app.use("/api/apps/:appId/ai/*", authMiddleware, requireAppAccess);

// --- Models endpoint: any authenticated user ---
app.use("/api/models", authMiddleware);

// --- LLM chat routes (structured conversations + stateless) ---
app.route("/", createChatRoutes(client));

// --- CRUD routes ---
app.route("/", crud);

// --- Serve generated apps ---
app.get("/apps/:appId", (c) => {
  const appId = c.req.param("appId");
  const record = getApp(appId);
  if (!record) return c.json({ error: "App not found" }, 404);

  const role = c.get("role");

  // Only inject chat widget for root users
  if (role === "root") {
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
    <span>Edit this app</span>
    <button onclick="document.getElementById('__chat_panel').classList.remove('open')" title="Close">&times;</button>
  </div>
  <div id="__chat_messages">
    <div class="__chat_msg system">Describe changes you'd like to make to this app.</div>
  </div>
  <div id="__chat_input_area">
    <textarea id="__chat_input" rows="1" placeholder="Describe a change..."></textarea>
    <button id="__chat_send" title="Send">&#9654;</button>
  </div>
</div>
<button id="__chat_toggle" title="Edit this app">&#9998;</button>
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

  function showTyping(){
    let t=document.getElementById('__chat_typing');
    if(!t){
      t=document.createElement('div');
      t.id='__chat_typing';
      t.innerHTML='<span>.</span><span>.</span><span>.</span> Applying changes';
      messages.appendChild(t);
    }
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
    showTyping();

    try{
      const res=await fetch('/api/apps/'+appId+'/edit',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({description:text})
      });
      hideTyping();
      if(!res.ok){
        const data=await res.json();
        throw new Error(data.error||'Edit failed');
      }
      addMsg('Changes applied! Reloading...','assistant');
      setTimeout(()=>window.location.reload(),1500);
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
  }

  // App users: serve without edit widget
  return c.html(record.html);
});

Deno.serve(app.fetch);
