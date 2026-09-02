import { hashPassword, randomToken, sha256, verifyPassword } from "./auth.ts";
import { openDatabase, type User } from "./db.ts";

const root = new URL("../", import.meta.url).pathname;
const dataDirectory = Deno.env.get("DATA_DIR") ?? `${root}data`;
const uploadDirectory = `${dataDirectory}/uploads`;
const maxUploadBytes = Number(Deno.env.get("MAX_UPLOAD_BYTES") ?? 10 * 1024 ** 3);
const sessionSeconds = 60 * 60 * 24 * 7;
const fileLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000;
const secureCookie = Deno.env.get("COOKIE_SECURE") === "1";
await Deno.mkdir(uploadDirectory, { recursive: true });
const databasePath = `${dataDirectory}/dekapost.sqlite`;
// Keep existing installations readable after the service rename.
const legacyDatabasePath = `${dataDirectory}/faststorage.sqlite`;
let databaseToOpen = databasePath;
try {
  await Deno.stat(databasePath);
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    try {
      await Deno.stat(legacyDatabasePath);
      databaseToOpen = legacyDatabasePath;
    } catch (legacyError) {
      if (!(legacyError instanceof Deno.errors.NotFound)) throw legacyError;
    }
  } else {
    throw error;
  }
}
const db = await openDatabase(databaseToOpen, `${root}migrations`);

type SessionUser = User & { password_hash: string };
type FileRow = {
  id: string;
  share_token: string;
  original_name: string;
  media_type: string;
  size: number;
  storage_name: string;
  created_at: string;
  expires_at: string;
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

function missingFilePage(): Response {
  return new Response(
    `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ファイルが見つかりません — DekaPost</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"></head>
<body><header><a class="brand" href="/"><img src="/logo.svg" alt=""> DekaPost</a></header>
<main class="missing-page"><p class="eyebrow">FILE NOT FOUND</p><h1>ファイルが<br><em>見つかりません。</em></h1>
<p class="lead">このファイルは削除されたか、7日間の保存期限を過ぎています。</p>
<a class="home-link" href="/">トップページへ戻る <span>→</span></a></main></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function removeExpiredFiles(): Promise<void> {
  const rows = db.prepare("SELECT id, storage_name FROM files WHERE expires_at <= ?").all(
    new Date().toISOString(),
  ) as Array<{ id: string; storage_name: string }>;
  for (const row of rows) {
    try {
      await Deno.remove(`${uploadDirectory}/${row.storage_name}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(error);
        continue;
      }
    }
    db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
  }
}

function cookie(request: Request, name: string): string | null {
  const part = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) =>
    item.startsWith(`${name}=`)
  );
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

async function currentUser(request: Request): Promise<SessionUser | null> {
  const session = cookie(request, "session");
  if (!session) return null;
  const row = db.prepare(
    `SELECT users.id, users.password_hash, users.is_admin, users.must_change_password
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = ? AND sessions.expires_at > ?`,
  ).get(await sha256(session), new Date().toISOString()) as SessionUser | undefined;
  return row ?? null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(value);
}

async function register(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!validUserId(body?.id)) {
    return errorResponse(
      "IDは半角英数字・ハイフン・アンダースコアの3〜32文字で入力してください",
      400,
    );
  }
  if (!validPassword(body?.password)) {
    return errorResponse("パスワードは8文字以上で入力してください", 400);
  }
  if (body.acceptedTerms !== true || body.termsVersion !== "NANI Terms v1.0") {
    return errorResponse("利用規約への同意が必要です", 400);
  }
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO users(
        id, password_hash, is_admin, must_change_password, created_at, updated_at,
        accepted_terms_version, accepted_terms_at
      ) VALUES (?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(body.id, await hashPassword(body.password), now, now, body.termsVersion, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return errorResponse("このIDは使用できません", 409);
    }
    throw error;
  }
  return json({ ok: true }, 201);
}

async function login(request: Request): Promise<Response> {
  const body = await readJson(request);
  const id = body?.id;
  const password = body?.password;
  if (typeof id !== "string" || typeof password !== "string") {
    return errorResponse("Invalid ID or password", 401);
  }
  const user = db.prepare(
    "SELECT id, password_hash, is_admin, must_change_password FROM users WHERE id = ?",
  ).get(id) as SessionUser | undefined;
  if (!user || !await verifyPassword(password, user.password_hash)) {
    return errorResponse("Invalid ID or password", 401);
  }
  const session = randomToken();
  const now = new Date();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  db.prepare("INSERT INTO sessions(id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(
      await sha256(session),
      user.id,
      new Date(now.getTime() + sessionSeconds * 1000).toISOString(),
      now.toISOString(),
    );
  const attributes = [
    `session=${encodeURIComponent(session)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessionSeconds}`,
  ];
  if (secureCookie) attributes.push("Secure");
  return json({ id: user.id, mustChangePassword: Boolean(user.must_change_password) }, 200, {
    "set-cookie": attributes.join("; "),
  });
}

async function changePassword(request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (typeof body?.currentPassword !== "string" || !validPassword(body.newPassword)) {
    return errorResponse(
      "Current password and a new password of at least 8 characters are required",
      400,
    );
  }
  if (!await verifyPassword(body.currentPassword, user.password_hash)) {
    return errorResponse("Current password is incorrect", 400);
  }
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
  ).run(await hashPassword(body.newPassword), new Date().toISOString(), user.id);
  return json({ ok: true });
}

function safeFilename(value: string): string {
  return [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join("").replaceAll("/", "_").replaceAll("\\", "_")
    .slice(0, 255) || "download";
}

async function upload(request: Request, user: SessionUser): Promise<Response> {
  if (user.must_change_password) return errorResponse("Password change required", 403);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxUploadBytes) {
    return errorResponse("File is too large", 413);
  }
  if (!request.body) return errorResponse("File body is required", 400);
  const encodedName = request.headers.get("x-file-name");
  if (!encodedName) return errorResponse("File name is required", 400);
  let originalName: string;
  try {
    originalName = safeFilename(decodeURIComponent(encodedName));
  } catch {
    return errorResponse("Invalid file name", 400);
  }
  const id = crypto.randomUUID();
  const shareToken = randomToken(24);
  const storageName = `${id}.bin`;
  const path = `${uploadDirectory}/${storageName}`;
  const file = await Deno.open(path, { createNew: true, write: true });
  let size = 0;
  try {
    await request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > maxUploadBytes) throw new Error("UPLOAD_TOO_LARGE");
          controller.enqueue(chunk);
        },
      }),
    ).pipeTo(file.writable);
  } catch (error) {
    try {
      await Deno.remove(path);
    } catch { /* already absent */ }
    if (error instanceof Error && error.message === "UPLOAD_TOO_LARGE") {
      return errorResponse("File is too large", 413);
    }
    throw error;
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + fileLifetimeMilliseconds).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO files(
        id, owner_id, share_token, original_name, media_type, size, storage_name, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      shareToken,
      originalName,
      request.headers.get("content-type") || "application/octet-stream",
      size,
      storageName,
      now,
      expiresAt,
    );
    db.prepare(
      "UPDATE users SET total_file_count = total_file_count + 1, updated_at = ? WHERE id = ?",
    )
      .run(now, user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    try {
      await Deno.remove(path);
    } catch { /* already absent */ }
    throw error;
  }
  return json(
    { id, name: originalName, size, url: `/s/${shareToken}`, createdAt: now, expiresAt },
    201,
  );
}

async function listFiles(user: SessionUser): Promise<Response> {
  await removeExpiredFiles();
  const rows = db.prepare(
    `SELECT id, share_token, original_name, size, created_at, expires_at
     FROM files WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).all(user.id) as Array<Record<string, string | number>>;
  return json(rows.map((row) => ({
    id: row.id,
    name: row.original_name,
    size: row.size,
    url: `/s/${row.share_token}`,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  })));
}

function requireAdmin(user: SessionUser): Response | null {
  return user.is_admin ? null : errorResponse("Admin access required", 403);
}

function listUsers(user: SessionUser): Response {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const rows = db.prepare(
    `SELECT users.id, users.is_admin, users.must_change_password, users.created_at,
       COALESCE(SUM(files.size), 0) AS storage_bytes,
       COUNT(files.id) AS file_count,
       users.total_file_count
     FROM users
     LEFT JOIN files ON files.owner_id = users.id
     GROUP BY users.id
     ORDER BY users.created_at ASC, users.id ASC`,
  ).all() as Array<Record<string, string | number>>;
  return json(rows.map((row) => ({
    id: row.id,
    isAdmin: Boolean(row.is_admin),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    storageBytes: row.storage_bytes,
    fileCount: row.file_count,
    totalFileCount: row.total_file_count,
  })));
}

async function deleteFile(id: string, user: SessionUser): Promise<Response> {
  const row = db.prepare("SELECT storage_name FROM files WHERE id = ? AND owner_id = ?").get(
    id,
    user.id,
  ) as { storage_name: string } | undefined;
  if (!row) return errorResponse("File not found", 404);
  db.prepare("DELETE FROM files WHERE id = ? AND owner_id = ?").run(id, user.id);
  try {
    await Deno.remove(`${uploadDirectory}/${row.storage_name}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return new Response(null, { status: 204 });
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function download(token: string, head = false): Promise<Response> {
  await removeExpiredFiles();
  const row = db.prepare(
    `SELECT original_name, media_type, size, storage_name, expires_at
     FROM files WHERE share_token = ? AND expires_at > ?`,
  ).get(token, new Date().toISOString()) as FileRow | undefined;
  if (!row) return missingFilePage();
  try {
    const file = await Deno.open(`${uploadDirectory}/${row.storage_name}`, { read: true });
    const headers = {
      "content-type": row.media_type,
      "content-length": String(row.size),
      "content-disposition": contentDisposition(row.original_name),
      "x-content-type-options": "nosniff",
    };
    if (head) {
      file.close();
      return new Response(null, { headers });
    }
    return new Response(file.readable, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return missingFilePage();
    throw error;
  }
}

async function staticFile(path: string): Promise<Response> {
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/logo.svg": ["logo.svg", "image/svg+xml"],
  };
  const entry = files[path];
  if (!entry) return errorResponse("Not found", 404);
  return new Response(await Deno.readFile(`${root}public/${entry[0]}`), {
    headers: { "content-type": entry[1], "cache-control": "no-cache" },
  });
}

export function createHandler(): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/register") {
        return await register(request);
      }
      if (request.method === "POST" && url.pathname === "/api/login") return await login(request);
      if (request.method === "POST" && url.pathname === "/api/logout") {
        const session = cookie(request, "session");
        if (session) {
          db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(await sha256(session));
        }
        return json({ ok: true }, 200, {
          "set-cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        });
      }
      const share = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
      if (share && (request.method === "GET" || request.method === "HEAD")) {
        return await download(share[1], request.method === "HEAD");
      }
      if (url.pathname.startsWith("/api/")) {
        const user = await currentUser(request);
        if (!user) return errorResponse("Authentication required", 401);
        if (request.method === "GET" && url.pathname === "/api/admin/users") {
          return listUsers(user);
        }
        if (request.method === "GET" && url.pathname === "/api/me") {
          return json({
            id: user.id,
            isAdmin: Boolean(user.is_admin),
            mustChangePassword: Boolean(user.must_change_password),
          });
        }
        if (request.method === "POST" && url.pathname === "/api/password") {
          return await changePassword(request, user);
        }
        if (request.method === "GET" && url.pathname === "/api/files") {
          return await listFiles(user);
        }
        if (request.method === "POST" && url.pathname === "/api/files") {
          return await upload(request, user);
        }
        const match = url.pathname.match(/^\/api\/files\/([0-9a-f-]+)$/);
        if (request.method === "DELETE" && match) return await deleteFile(match[1], user);
        return errorResponse("Not found", 404);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await staticFile(url.pathname);
      }
      return errorResponse("Method not allowed", 405);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return errorResponse("Internal server error", 500);
    }
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8000);
  const hostname = Deno.env.get("HOST") ?? "127.0.0.1";
  Deno.serve({ port, hostname }, createHandler());
  await removeExpiredFiles();
  setInterval(() => {
    removeExpiredFiles().catch(console.error);
  }, 60 * 60 * 1000);
}
