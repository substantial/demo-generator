import { sign, verify } from "@hono/hono/jwt";
import { getCookie, setCookie, deleteCookie } from "@hono/hono/cookie";
import type { Context, Next } from "@hono/hono";
import { getAppCredentialsByUsername } from "./db.ts";

const COOKIE_NAME = "auth_token";

function getCredentials(): { username: string; password: string } {
  const raw = Deno.env.get("CREDENTIALS") ?? "";
  const idx = raw.indexOf(",");
  if (idx === -1) throw new Error("CREDENTIALS env var must be username,password");
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

function getSecret(): string {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) throw new Error("JWT_SECRET env var is required");
  return secret;
}

export async function loginHandler(c: Context): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Check root credentials first
  const creds = getCredentials();
  if (body.username === creds.username && body.password === creds.password) {
    const token = await sign(
      { sub: "admin", role: "root", exp: Math.floor(Date.now() / 1000) + 86400 },
      getSecret(),
    );

    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 86400,
    });

    return c.json({ ok: true, redirect: "/dashboard" });
  }

  // Fallback: check app credentials
  if (body.username) {
    const appCred = getAppCredentialsByUsername(body.username);
    if (appCred && body.password === appCred.password) {
      const token = await sign(
        {
          sub: appCred.username,
          role: "app",
          appId: appCred.app_id,
          exp: Math.floor(Date.now() / 1000) + 86400,
        },
        getSecret(),
      );

      setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 86400,
      });

      return c.json({ ok: true, redirect: `/apps/${appCred.app_id}` });
    }
  }

  return c.json({ error: "Invalid credentials" }, 401);
}

export async function logoutHandler(c: Context): Promise<Response> {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.redirect("/login");
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return authFail(c);

  try {
    const payload = await verify(token, getSecret(), "HS256");
    c.set("user", payload.sub);
    c.set("role", payload.role as string);
    if (payload.appId) {
      c.set("appId", payload.appId as string);
    }
    await next();
  } catch {
    return authFail(c);
  }
}

export async function requireRoot(c: Context, next: Next): Promise<Response | void> {
  if (c.get("role") !== "root") {
    return c.json({ error: "Forbidden: root access required" }, 403);
  }
  await next();
}

export async function requireAppAccess(c: Context, next: Next): Promise<Response | void> {
  const role = c.get("role");
  if (role === "root") {
    await next();
    return;
  }
  if (role === "app") {
    const tokenAppId = c.get("appId");
    const routeAppId = c.req.param("appId");
    if (tokenAppId && routeAppId && tokenAppId === routeAppId) {
      await next();
      return;
    }
  }
  return c.json({ error: "Forbidden: you do not have access to this app" }, 403);
}

function authFail(c: Context): Response {
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/html") && !c.req.path.startsWith("/api/")) {
    return c.redirect("/login");
  }
  return c.json({ error: "Unauthorized" }, 401);
}
