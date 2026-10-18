import { scrypt as nodeScrypt } from "node:crypto";
import { buildEventNotification } from "../notifications.js";

const TABLES = {
  departments: ["id", "name", "active"],
  event_types: ["id", "name", "color", "active"],
  users: ["id", "password", "department_id", "role", "name"],
  events: ["id", "department_id", "event_type_id", "title", "start", "end", "all_day", "place", "target", "purpose", "expected", "actual", "collaborators", "status", "reason", "created", "updated", "approved", "applicant", "created_by", "applicant_position", "applicant_name", "deleted_by", "deleted_at"],
  history: ["id", "event_id", "action", "actor", "snapshot", "created"],
  posts: ["id", "event_id", "title", "body", "created", "updated"],
  files: ["id", "post_id", "name", "drive_id", "mime", "size"],
  notifications: ["id", "channel", "message", "html", "sent", "created"],
  sessions: ["token", "user_id", "expires"],
  tickets: ["token", "expires"],
  settings: ["key", "value"],
};
const SHEET_NAMES = Object.keys(TABLES);
let cachedGoogleToken;
let initializedSpreadsheet = "";
let initializing;
const loginFailures = new Map();
function derivePassword(password, salt) {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(new Uint8Array(key))));
}

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function unhex(value) {
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => parseInt(byte, 16));
}
function pemBytes(pem) {
  return Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), (c) => c.charCodeAt(0));
}
async function googleToken(env) {
  if (cachedGoogleToken && cachedGoogleToken.exp > Date.now() + 60000) return cachedGoogleToken.value;
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3500 }))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(new Uint8Array(signature))}` }) });
  const result = await response.json();
  if (!response.ok) throw Error("Google API 인증에 실패했습니다.");
  cachedGoogleToken = { value: result.access_token, exp: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}
async function sheets(env, path, init = {}) {
  const token = await googleToken(env);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEETS_SPREADSHEET_ID}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error?.message || "Google Sheets 요청에 실패했습니다.");
  return result;
}
async function drive(env, path, init = {}) {
  const token = await googleToken(env);
  const response = await fetch(`https://www.googleapis.com/drive/v3${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) throw Error("Google Drive 요청에 실패했습니다.");
  return response;
}
async function personalDrive(env, action, values = {}) {
  if (!env.DRIVE_UPLOAD_WEBAPP_URL || !env.DRIVE_UPLOAD_SECRET) throw Error("Google Apps Script Drive connection is not configured.");
  const response = await fetch(env.DRIVE_UPLOAD_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env.DRIVE_UPLOAD_SECRET, action, ...values }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw Error(result.error || "Google Drive connection failed.");
  return result;
}
async function startDriveUpload(env, name, mime, size) {
  const result = await personalDrive(env, "startUpload", { name, mime, size, folderId: env.GOOGLE_DRIVE_FOLDER_ID });
  if (!result.uploadUrl) throw Error("Google Drive upload URL was not returned.");
  return result.uploadUrl;
}
async function acceptUploadChunk(env, uploadId, request) {
  const row = await getBy(env, "settings", "key", `upload:${uploadId}`);
  if (!row) throw error("업로드 세션이 만료되었습니다.", 404);
  const session = JSON.parse(row.value), range = request.headers.get("Content-Range") || "";
  const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match || Number(match[3]) !== Number(session.size)) throw error("업로드 위치를 확인해주세요.");
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (end < start || end >= total || end - start + 1 > 8 * 1024 * 1024) throw error("업로드 구간이 올바르지 않습니다.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== end - start + 1) throw error("전송된 파일 크기가 일치하지 않습니다.");
  const response = await fetch(session.uploadUrl, { method: "PUT", headers: { "Content-Length": String(bytes.byteLength), "Content-Range": range, "Content-Type": session.mime }, body: bytes });
  if (response.status === 308) {
    const received = response.headers.get("Range")?.match(/bytes=0-(\d+)/);
    return { complete: false, nextOffset: received ? Number(received[1]) + 1 : end + 1 };
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw error("Google Drive 파일 업로드에 실패했습니다.", 502);
  return { complete: true, driveId: result.id };
}
async function table(env, name) {
  const values = (await sheets(env, `/values/${encodeURIComponent(name)}!A1:Z`)).values || [];
  const headers = values.shift() || TABLES[name];
  return values.map((row, index) => {
    if (!row.some((cell) => cell !== "")) return null;
    const item = Object.fromEntries(headers.map((key, col) => [key, decodeCell(name, key, row[col] ?? "")]));
    Object.defineProperty(item, "__row", { value: index + 2, enumerable: false });
    return item;
  }).filter(Boolean);
}
function decodeCell(name, key, value) {
  if (name === "events" && key === "collaborators") { try { return JSON.parse(value || "[]"); } catch { return []; } }
  if (name === "history" && key === "snapshot") { try { return JSON.parse(value || "{}"); } catch { return {}; } }
  if (["active", "all_day", "expected", "actual", "expires", "sent", "size", "id", "department_id", "event_type_id", "event_id", "post_id"].includes(key)) {
    if (value === "" || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}
function encodeCell(key, value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || (typeof value === "object")) return JSON.stringify(value);
  return String(value);
}
async function writeTable(env, name, rows) {
  const headers = TABLES[name];
  const values = [headers, ...rows.map((row) => headers.map((key) => encodeCell(key, row[key])))];
  await sheets(env, `/values/${encodeURIComponent(name)}!A1:Z:clear`, { method: "POST", body: "{}" });
  if (values.length) await sheets(env, `/values/${encodeURIComponent(name)}!A1?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values }) });
}
async function ensureTables(env) {
  if (initializedSpreadsheet === env.SHEETS_SPREADSHEET_ID) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const spreadsheet = await sheets(env, "?fields=sheets.properties.title");
    const existing = new Set((spreadsheet.sheets || []).map((sheet) => sheet.properties.title));
    const missing = SHEET_NAMES.filter((name) => !existing.has(name));
    if (missing.length) {
      await sheets(env, ":batchUpdate", { method: "POST", body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }) });
    }
    for (const name of SHEET_NAMES) {
      const values = (await sheets(env, `/values/${encodeURIComponent(name)}!A1:Z1`)).values || [];
      if (!values.length) await sheets(env, `/values/${encodeURIComponent(name)}!A1?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [TABLES[name]] }) });
    }
    initializedSpreadsheet = env.SHEETS_SPREADSHEET_ID;
  })();
  try { await initializing; } finally { initializing = null; }
}
async function list(env, name) {
  const rows = await table(env, name);
  return rows.length ? rows : [];
}
async function getBy(env, name, field, value) {
  return (await list(env, name)).find((row) => String(row[field]) === String(value)) || null;
}
async function save(env, name, record) {
  const rows = await table(env, name);
  const key = name === "settings" ? "key" : name === "sessions" || name === "tickets" ? "token" : "id";
  const index = rows.findIndex((row) => String(row[key]) === String(record[key]));
  const headers = TABLES[name], merged = index < 0 ? record : { ...rows[index], ...record };
  const values = headers.map((field) => encodeCell(field, merged[field]));
  if (index < 0) {
    await sheets(env, `/values/${encodeURIComponent(name)}!A:Z:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: [values] }) });
  } else {
    const rowNum = rows[index].__row;
    await sheets(env, `/values/${encodeURIComponent(name)}!A${rowNum}:Z${rowNum}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [values] }) });
  }
  return record;
}
async function remove(env, name, key, value) {
  const row = (await table(env, name)).find((item) => String(item[key]) === String(value));
  if (row) await sheets(env, `/values/${encodeURIComponent(name)}!A${row.__row}:Z${row.__row}:clear`, { method: "POST", body: "{}" });
}
async function nextId(env, name) {
  const timestamp = Date.now() * 1000;
  return timestamp + crypto.getRandomValues(new Uint16Array(1))[0] % 1000;
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const derived = await derivePassword(password, saltHex);
  const expected = unhex(hashHex);
  if (derived.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < derived.length; index++) difference |= derived[index] ^ expected[index];
  return difference === 0;
}
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } }); }
function error(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function now() { return new Date().toISOString(); }
function eventEnded(e) { return Date.parse(e.all_day ? `${e.end}T23:59:59` : e.end) < Date.now(); }
function validateEvent(b) {
  if (["title", "place", "target", "purpose"].some((key) => typeof b[key] !== "string" || !b[key].trim() || b[key].length > 4000)) throw error("필수 항목을 입력해주세요.");
  if (!Number.isInteger(Number(b.expected)) || Number(b.expected) < 0 || b.expected === "") throw error("예상 인원을 확인해주세요.");
  const format = b.all_day ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)$/;
  if (!format.test(b.start) || !format.test(b.end) || !Number.isFinite(Date.parse(b.start)) || !Number.isFinite(Date.parse(b.end)) || b.end < b.start || (!b.all_day && b.end === b.start)) throw error("시작·종료 일시를 확인해주세요.");
  if (!Array.isArray(b.collaborators) || !Number.isInteger(Number(b.event_type_id))) throw error("행사 유형과 협력부서를 확인해주세요.");
}
async function joinedEvents(env) {
  const [events, departments, types] = await Promise.all([list(env, "events"), list(env, "departments"), list(env, "event_types")]);
  return events.map((e) => ({ ...e, department_name: departments.find((d) => d.id === Number(e.department_id))?.name || "", event_type_name: types.find((t) => t.id === Number(e.event_type_id))?.name || "기타 행사", event_type_color: types.find((t) => t.id === Number(e.event_type_id))?.color || "#64748B" }));
}
async function getEvent(env, id, user) {
  const row = (await joinedEvents(env)).find((item) => Number(item.id) === Number(id));
  return row && visible(row, user) ? row : null;
}
function canManageEvent(user, item) { return user.id === "bot" || user.id === "admin" || item.created_by === user.id; }
function canEditArchive(user, item) { return user.id === "admin" || (user.id !== "bot" && item.created_by === user.id && eventEnded(item)); }
async function getPost(env, id, user) {
  const post = await getBy(env, "posts", "id", id);
  const event = post && await getEvent(env, post.event_id, user);
  return post && event && event.status !== "삭제됨" ? { post, event } : null;
}
async function postRows(env, user) {
  const [posts, events, departments, files] = await Promise.all([list(env, "posts"), joinedEvents(env), list(env, "departments"), list(env, "files")]);
  return posts.filter((post) => events.some((e) => Number(e.id) === Number(post.event_id) && e.status !== "삭제됨" && visible(e, user))).map((post) => {
    const event = events.find((e) => Number(e.id) === Number(post.event_id));
    return { ...post, event_title: event?.title || "", department_name: departments.find((d) => Number(d.id) === Number(event?.department_id))?.name || "", files: files.filter((f) => Number(f.post_id) === Number(post.id)).map(({ id, name, mime, size }) => ({ id, name, mime, size })) };
  });
}
function visible(e, user) { return user?.id === "bot" || user?.id === "admin" || Number(e.department_id) === Number(user?.department_id) || (Array.isArray(e.collaborators) ? e.collaborators : []).includes(Number(user?.department_id)); }
async function authorize(request, env) {
  const requestUrl = new URL(request.url);
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || requestUrl.searchParams.get("token") || "";
  if (!token) {
    const ticket = request.headers.get("X-Bot-Ticket") || requestUrl.searchParams.get("ticket") || "";
    const row = ticket && await getBy(env, "tickets", "token", ticket);
    if (row && (row.expires === null || Number(row.expires) > Date.now())) return { id: "bot", department_id: null, role: "manager", ticket };
    throw error("로그인이 필요합니다.", 401);
  }
  const session = await getBy(env, "sessions", "token", await digest(token));
  if (!session || Number(session.expires) < Date.now()) throw error("로그인이 필요합니다.", 401);
  const user = await getBy(env, "users", "id", session.user_id);
  if (!user) throw error("로그인이 필요합니다.", 401);
  return { id: user.id, department_id: user.department_id, role: user.role, name: user.name };
}
function admin(user) { if (user.id !== "admin") throw error("관리자만 사용할 수 있습니다.", 403); }
function editor(user) { if (!user || (user.id !== "bot" && !["admin", "manager"].includes(user.role || "manager"))) throw error("부장단 또는 관리자만 사용할 수 있습니다.", 403); }
async function historyAndNotify(env, event, action, actor) {
  const id = await nextId(env, "history");
  await save(env, "history", { id, event_id: event.id, action, actor, snapshot: event, created: now() });
  const noticeId = await nextId(env, "notifications");
  const notice = buildEventNotification(event, action, actor);
  await save(env, "notifications", { id: noticeId, channel: "notice", message: notice.text, html: notice.html, sent: 0, created: now() });
}
async function notifyTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_NOTICE_CHAT_ID) return;
  for (const n of (await list(env, "notifications")).filter((item) => item.channel === "notice" && !item.sent).slice(0, 20)) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_NOTICE_CHAT_ID, text: n.html || n.message, ...(n.html ? { parse_mode: "HTML" } : {}) }) });
    if (response.ok) await save(env, "notifications", { ...n, sent: 1 });
  }
}
async function telegram(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!result.ok) throw Error(result.description || "Telegram API 요청에 실패했습니다.");
  return result.result;
}
async function pollTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.PUBLIC_URL) return;
  const offsetRow = await getBy(env, "settings", "key", "telegram_offset");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${Number(offsetRow?.value || 0)}&timeout=0&allowed_updates=%5B%22message%22%5D`);
  const result = await response.json();
  if (!result.ok) return;
  const modes = { "행사 등록": "create", "행사 수정": "edit", "행사 삭제": "delete" };
  for (const update of result.result || []) {
    const message = update.message, chatId = message?.chat?.id, chatType = message?.chat?.type;
    const isMenu = /^\/(start|menu)(@\w+)?(?:\s|$)/.test(message?.text || "");
    if (chatType === "private" && isMenu) {
      const key = `keyboard_ticket:${chatId}`;
      let stored = await getBy(env, "settings", "key", key), ticket = stored?.value;
      if (!ticket || !await getBy(env, "tickets", "token", ticket)) {
        ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
        await save(env, "tickets", { token: ticket, expires: null }); await save(env, "settings", { key, value: ticket });
      }
      await telegram(env, "sendMessage", { chat_id: chatId, text: "원하는 작업을 선택해주세요. 버튼을 누르면 화면이 바로 열립니다.", reply_markup: { keyboard: [[{ text: "행사 등록", web_app: { url: `${env.PUBLIC_URL}/?mode=create&ticket=${ticket}` } }, { text: "행사 수정", web_app: { url: `${env.PUBLIC_URL}/?mode=edit&ticket=${ticket}` } }], [{ text: "행사 삭제", web_app: { url: `${env.PUBLIC_URL}/?mode=delete&ticket=${ticket}` } }]], resize_keyboard: true, is_persistent: true } });
    } else if (chatType === "private" && modes[message?.text?.trim()]) {
      const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      await save(env, "tickets", { token: ticket, expires: Date.now() + 3600000 });
      await telegram(env, "sendMessage", { chat_id: chatId, text: `${message.text} 화면을 열어주세요. 링크는 1시간 동안 사용할 수 있습니다.`, reply_markup: { inline_keyboard: [[{ text: `${message.text} 열기`, url: `${env.PUBLIC_URL}/?mode=${modes[message.text.trim()]}#${ticket}` }]] } });
    } else if (isMenu) {
      const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      await save(env, "tickets", { token: ticket, expires: Date.now() + 3600000 });
      await telegram(env, "sendMessage", { chat_id: chatId, text: "행사 등록·수정·삭제를 선택해주세요. 링크는 1시간 동안 사용할 수 있습니다.", reply_markup: { inline_keyboard: [[{ text: "행사 등록", url: `${env.PUBLIC_URL}/?mode=create#${ticket}` }], [{ text: "행사 수정", url: `${env.PUBLIC_URL}/?mode=edit#${ticket}` }, { text: "행사 삭제", url: `${env.PUBLIC_URL}/?mode=delete#${ticket}` }]] } });
    }
    await save(env, "settings", { key: "telegram_offset", value: String(update.update_id + 1) });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN, "Access-Control-Allow-Headers": "Authorization, Content-Type, Content-Range, X-Bot-Ticket, X-Migration-Key", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && origin !== env.ALLOWED_ORIGIN) return json({ error: "허용되지 않은 요청입니다." }, 403, cors);
    try {
      await ensureTables(env);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api/, "");
      const isMultipart = request.headers.get("Content-Type")?.includes("multipart/form-data");
      const rawChunk = /^\/uploads\/[\w-]+$/.test(path) || /^\/migration\/file\/chunk\/[\w-]+$/.test(path);
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !isMultipart && !rawChunk ? await request.json().catch(() => ({})) : {};
      if (request.method === "POST" && path === "/migration/import") {
        if (!env.MIGRATION_SECRET || request.headers.get("X-Migration-Key") !== env.MIGRATION_SECRET) throw error("허용되지 않은 요청입니다.", 403);
        const migrationStatus = (await getBy(env, "settings", "key", "migration_status"))?.value || "";
        if (migrationStatus === "completed") throw error("데이터 이전은 이미 완료되었습니다.", 409);
        if (!migrationStatus) {
          const existingRows = [];
          for (const name of ["departments", "event_types", "users", "events", "history", "posts", "files"]) if ((await list(env, name)).length) existingRows.push(name);
          if (existingRows.length) throw error("이전용 스프레드시트에 이미 데이터가 있습니다. 비어 있는 스프레드시트를 사용해주세요.", 409);
        }
        const migration = body.tables || {};
        for (const name of ["departments", "event_types", "users", "events", "history", "posts", "notifications", "files"]) {
          if (!Array.isArray(migration[name])) continue;
          const previousFiles = name === "files" ? await list(env, "files") : [];
          const records = migration[name].map((row) => name === "files" ? { ...row, drive_id: previousFiles.find((f) => Number(f.id) === Number(row.id))?.drive_id || "" } : row);
          await writeTable(env, name, records);
        }
        await save(env, "settings", { key: "migration_status", value: "importing" });
        return json({ ok: true, message: "데이터 행을 가져왔습니다." }, 200, cors);
      }
      if (request.method === "POST" && path === "/migration/file/session") {
        if (!env.MIGRATION_SECRET || request.headers.get("X-Migration-Key") !== env.MIGRATION_SECRET) throw error("Unauthorized", 403);
        const { id, name, mime, size } = body;
        const old = await getBy(env, "files", "id", id);
        if (old?.drive_id) return json({ complete: true, id, driveId: old.drive_id }, 200, cors);
        const uploadUrl = await startDriveUpload(env, name, mime, Number(size));
        return json({ uploadUrl, chunkSize: 8 * 1024 * 1024 }, 200, cors);
      }

      const migrationChunk = path.match(/^\/migration\/file\/chunk\/([\w-]+)$/);
      if (request.method === "PUT" && migrationChunk) {
        if (!env.MIGRATION_SECRET || request.headers.get("X-Migration-Key") !== env.MIGRATION_SECRET) throw error("허용되지 않은 요청입니다.", 403);
        const result = await acceptUploadChunk(env, migrationChunk[1], request);
        if (result.complete) {
          const stored = await getBy(env, "settings", "key", `upload:${migrationChunk[1]}`), data = JSON.parse(stored.value);
          await save(env, "files", { id: data.id, post_id: data.post_id, name: data.name, drive_id: result.driveId, mime: data.mime, size: data.size });
          await remove(env, "settings", "key", `upload:${migrationChunk[1]}`);
        }
        return json(result, 200, cors);
      }
      if (request.method === "POST" && path === "/migration/file/complete") {
        if (!env.MIGRATION_SECRET || request.headers.get("X-Migration-Key") !== env.MIGRATION_SECRET) throw error("Unauthorized", 403);
        const { id, driveId } = body;
        if (!id || !driveId) throw error("File ID and Drive ID are required.");
        const old = await getBy(env, "files", "id", id);
        if (!old) throw error("File record was not found.", 404);
        if (old.drive_id) return json({ ok: true, alreadyComplete: true }, 200, cors);
        await save(env, "files", { ...old, drive_id: driveId });
        return json({ ok: true }, 200, cors);
      }

      if (request.method === "POST" && path === "/migration/complete") {
        if (!env.MIGRATION_SECRET || request.headers.get("X-Migration-Key") !== env.MIGRATION_SECRET) throw error("허용되지 않은 요청입니다.", 403);
        if ((await list(env, "files")).some((file) => !file.drive_id)) throw error("Drive 첨부파일 이전이 끝나지 않았습니다.", 409);
        await save(env, "settings", { key: "migration_status", value: "completed" });
        return json({ ok: true }, 200, cors);
      }
      if (request.method === "POST" && path === "/login") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const attempt = loginFailures.get(ip) || { count: 0, started: Date.now() };
        if (Date.now() - attempt.started > 10 * 60 * 1000) { attempt.count = 0; attempt.started = Date.now(); }
        if (attempt.count >= 10) throw error("10분 후 다시 시도해주세요.", 429);
        const user = await getBy(env, "users", "id", body.id);
        if (!user || !await verifyPassword(String(body.password || ""), user.password)) {
          attempt.count++; loginFailures.set(ip, attempt);
          if (loginFailures.size > 1000) loginFailures.delete(loginFailures.keys().next().value);
          throw error("계정 또는 비밀번호를 확인해주세요.", 401);
        }
        loginFailures.delete(ip);
        const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
        await save(env, "sessions", { token: await digest(token), user_id: user.id, expires: Date.now() + 12 * 3600000 });
        return json({ ok: true, token }, 200, cors);
      }
      if (request.method === "GET" && path === "/health") {
        await personalDrive(env, "quota");
        return json({ ok: true, storage: "Google Sheets + personal Google Drive" }, 200, cors);
      }
      const user = await authorize(request, env);
      if (request.method === "GET" && path === "/me") return json(user, 200, cors);
      if (request.method === "POST" && path === "/logout") { const raw = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || ""; await remove(env, "sessions", "token", await digest(raw)); return json({ ok: true }, 200, cors); }
      if (request.method === "POST" && path === "/password") {
        const row = await getBy(env, "users", "id", user.id);
        if (!await verifyPassword(String(body.current || ""), row.password)) throw error("현재 비밀번호가 다릅니다.");
        if (typeof body.password !== "string" || body.password.length < 8) throw error("새 비밀번호는 8자 이상 입력해주세요.");
        const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
        const hash = await derivePassword(body.password, salt);
        const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
        await save(env, "users", { ...row, password: `${salt}:${hex(hash)}` });
        await writeTable(env, "sessions", (await list(env, "sessions")).filter((s) => s.user_id !== user.id));
        return json({ ok: true }, 200, cors);
      }
      if (request.method === "GET" && path === "/storage") {
        editor(user); let free = null;
        try { const quota = await personalDrive(env, "quota"); if (Number.isFinite(Number(quota.free))) free = Number(quota.free); }
        catch { /* Drive quota may not be available for this account. */ }
        return json({ free, provider: "Google Drive" }, 200, cors);
      }
      const uploadSession = path.match(/^\/posts\/(\d+)\/files\/session$/);
      if (request.method === "POST" && uploadSession) {
        editor(user); const linked = await getPost(env, uploadSession[1], user);
        if (!linked || !canEditArchive(user, linked.event)) throw error("행사 종료 후 등록자 또는 관리자만 첨부파일을 수정할 수 있습니다.", 403);
        const name = String(body.name || ""), mime = String(body.mime || ""), size = Number(body.size);
        const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]);
        if (!name || !allowed.has(mime) || !Number.isInteger(size) || size <= 0 || size > 500 * 1024 * 1024) throw error("지원하는 사진 또는 동영상 파일을 확인해주세요. 파일은 500MB까지 가능합니다.");
        const currentFiles = (await list(env, "files")).filter((f) => Number(f.post_id) === Number(uploadSession[1]));
        const all = [...currentFiles, { mime, size }], images = all.filter((f) => String(f.mime).startsWith("image/")), videos = all.filter((f) => String(f.mime).startsWith("video/"));
        if (images.length > 10 || images.reduce((sum, f) => sum + Number(f.size), 0) > 500 * 1024 * 1024 || videos.length > 1 || videos.some((f) => Number(f.size) > 500 * 1024 * 1024)) throw error("게시글당 사진 10장·합계 500MB, 동영상 1개·500MB까지 가능합니다.");
        const uploadId = crypto.randomUUID();
        const uploadUrl = await startDriveUpload(env, name, mime, size);
        await save(env, "settings", { key: `upload:${uploadId}`, value: JSON.stringify({ uploadUrl, post_id: Number(uploadSession[1]), name, mime, size, user_id: user.id, created: Date.now() }) });
        return json({ uploadId, chunkSize: 8 * 1024 * 1024 }, 200, cors);
      }
      const chunkMatch = path.match(/^\/uploads\/([\w-]+)$/);
      if (request.method === "PUT" && chunkMatch) {
        const upload = await getBy(env, "settings", "key", `upload:${chunkMatch[1]}`);
        if (!upload) throw error("업로드 세션이 만료되었습니다.", 404);
        const data = JSON.parse(upload.value);
        if (data.migration || data.user_id !== user.id || Date.now() - Number(data.created || 0) > 24 * 3600000) throw error("업로드 세션을 사용할 수 없습니다.", 403);
        const linked = await getPost(env, data.post_id, user);
        if (!linked || !canEditArchive(user, linked.event)) throw error("첨부파일을 수정할 수 없습니다.", 403);
        const result = await acceptUploadChunk(env, chunkMatch[1], request);
        if (result.complete) {
          await save(env, "files", { id: await nextId(env, "files"), post_id: data.post_id, name: data.name, drive_id: result.driveId, mime: data.mime, size: data.size });
          await remove(env, "settings", "key", `upload:${chunkMatch[1]}`);
        }
        return json(result, 200, cors);
      }
      if (request.method === "GET" && path === "/departments") return json(await list(env, "departments"), 200, cors);
      if (request.method === "GET" && path === "/event-types") return json((await list(env, "event_types")).sort((a,b) => a.id-b.id), 200, cors);
      if (request.method === "GET" && path === "/events") {
        const rows = await joinedEvents(env);
        return json(user.id === "admin" ? rows : rows.filter((item) => visible(item, user)), 200, cors);
      }
      if (path === "/departments" && request.method === "POST") {
        admin(user); const name = String(body.name || "").trim();
        if (!name || name.length > 100) throw error("부서명을 입력해주세요.");
        if (body.id) { const row = await getBy(env, "departments", "id", body.id); if (!row) throw error("부서를 찾을 수 없습니다.", 404); await save(env, "departments", { ...row, name }); }
        else await save(env, "departments", { id: await nextId(env, "departments"), name, active: 1 });
        return json({ ok: true }, 200, cors);
      }
      if ((/^\/departments\/\d+$/.test(path)) && request.method === "DELETE") {
        admin(user); const id = path.split("/").at(-1); const row = await getBy(env, "departments", "id", id);
        if (row) await save(env, "departments", { ...row, active: 0 });
        return json({ ok: true }, 200, cors);
      }
      if (path === "/event-types" && request.method === "POST") {
        admin(user); const name = String(body.name || "").trim();
        if (!name || name.length > 100) throw error("행사 유형명을 입력해주세요.");
        if ((await list(env, "event_types")).some((x) => x.name === name && String(x.id) !== String(body.id || ""))) throw error("이미 사용 중인 행사 유형명입니다.");
        const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : "#64748B";
        if (body.id) { const row = await getBy(env, "event_types", "id", body.id); if (!row) throw error("행사 유형을 찾을 수 없습니다.", 404); await save(env, "event_types", { ...row, name, color }); }
        else await save(env, "event_types", { id: await nextId(env, "event_types"), name, color, active: 1 });
        return json({ ok: true }, 200, cors);
      }
      if (/^\/event-types\/\d+$/.test(path) && request.method === "DELETE") {
        admin(user); const id = Number(path.split("/").at(-1));
        if ((await list(env, "events")).some((e) => Number(e.event_type_id) === id)) throw error("사용 중인 행사 유형은 비활성화할 수 없습니다.");
        const row = await getBy(env, "event_types", "id", id); if (row) await save(env, "event_types", { ...row, active: 0 });
        return json({ ok: true }, 200, cors);
      }
      const historyMatch = path.match(/^\/events\/(\d+)\/history$/);
      if (historyMatch && request.method === "GET") {
        if (!await getEvent(env, historyMatch[1], user)) throw error("행사를 찾을 수 없습니다.", 404);
        return json((await list(env, "history")).filter((h) => Number(h.event_id) === Number(historyMatch[1])).sort((a,b) => b.id-a.id), 200, cors);
      }
      if (path === "/events" && request.method === "POST") {
        editor(user); validateEvent(body);
        const position = String(body.applicant_position || "").trim(), name = String(body.applicant_name || "").trim();
        if (!position || !name || position.length > 100 || name.length > 100) throw error("신청자 직책과 이름을 입력해주세요 (각 100자 이하).");
        const dept = await getBy(env, "departments", "id", body.department_id);
        if (!dept || !Number(dept.active)) throw error("신청 가능한 부서를 선택해주세요.");
        const type = await getBy(env, "event_types", "id", body.event_type_id);
        if (!type || !Number(type.active)) throw error("신청 가능한 행사 유형을 선택해주세요.");
        const id = await nextId(env, "events"), t = now();
        const item = { id, department_id: Number(dept.id), event_type_id: Number(type.id), title: body.title.trim(), start: body.start, end: body.end, all_day: body.all_day ? 1 : 0, place: body.place, target: body.target, purpose: body.purpose, expected: Number(body.expected), actual: null, collaborators: body.collaborators.map(Number), status: "예정", reason: "", created: t, updated: t, approved: "", applicant: `${position} ${name}`, created_by: user.id, applicant_position: position, applicant_name: name, deleted_by: "", deleted_at: "", department_name: dept.name, event_type_name: type.name, event_type_color: type.color };
        await save(env, "events", item); await historyAndNotify(env, item, "등록", item.applicant);
        return json({ id }, 200, cors);
      }
      const eventMatch = path.match(/^\/events\/(\d+)$/);
      if (eventMatch && request.method === "PUT") {
        editor(user); const item = await getEvent(env, eventMatch[1], user);
        if (!item || item.status === "삭제됨") throw error("삭제된 행사는 수정할 수 없습니다.");
        if (!canManageEvent(user, item)) throw error("등록자 또는 관리자만 수정할 수 있습니다.", 403);
        if (eventEnded(item) && user.id !== "admin") throw error("종료된 행사는 실제 참여 인원과 아카이브만 수정할 수 있습니다.");
        validateEvent(body);
        const dept = await getBy(env, "departments", "id", body.department_id), type = await getBy(env, "event_types", "id", body.event_type_id);
        if (!dept || (!Number(dept.active) && Number(dept.id) !== Number(item.department_id))) throw error("부서를 확인해주세요.");
        if (!type || (!Number(type.active) && Number(type.id) !== Number(item.event_type_id))) throw error("행사 유형을 확인해주세요.");
        const updated = { ...item, department_id: Number(dept.id), event_type_id: Number(type.id), title: body.title.trim(), start: body.start, end: body.end, all_day: body.all_day ? 1 : 0, place: body.place, target: body.target, purpose: body.purpose, expected: Number(body.expected), collaborators: body.collaborators.map(Number), updated: now() };
        const actor = user.id === "bot" ? String(body.editor_name || "").trim() : user.id === "admin" ? "행사기획부" : user.id;
        if (user.id === "bot" && (!actor || actor.length > 100)) throw error("수정자를 입력해주세요.");
        await save(env, "events", updated); await historyAndNotify(env, updated, "변경", actor);
        return json({ ok: true }, 200, cors);
      }
      if (eventMatch && request.method === "DELETE") {
        editor(user); const item = await getEvent(env, eventMatch[1], user);
        if (!item) throw error("행사를 찾을 수 없습니다.", 404);
        if (item.status === "삭제됨") return json({ ok: true }, 200, cors);
        if (!canManageEvent(user, item)) throw error("등록자 또는 관리자만 삭제할 수 있습니다.", 403);
        const actor = user.id === "bot" ? String(body.deleter_name || "").trim() : user.id === "admin" ? "행사기획부" : user.id;
        if (user.id === "bot" && (!actor || actor.length > 100)) throw error("삭제자를 입력해주세요.");
        const updated = { ...item, status: "삭제됨", deleted_by: actor, deleted_at: now(), updated: now() };
        await save(env, "events", updated); await historyAndNotify(env, updated, "삭제", updated.deleted_by);
        return json({ ok: true }, 200, cors);
      }
      const actualMatch = path.match(/^\/events\/(\d+)\/actual$/);
      if (actualMatch && request.method === "POST") {
        editor(user); const item = await getEvent(env, actualMatch[1], user);
        if (!item || !canManageEvent(user, item)) throw error("등록자 또는 관리자만 수정할 수 있습니다.", 403);
        if (!eventEnded(item) && user.id !== "admin") throw error("실제 참여 인원은 행사 종료 후 입력할 수 있습니다.");
        if (body.actual !== null && (!Number.isInteger(body.actual) || body.actual < 0)) throw error("참여 인원을 확인해주세요.");
        await save(env, "events", { ...item, actual: body.actual }); return json({ ok: true }, 200, cors);
      }
      if (path === "/search" && request.method === "GET") {
        editor(user); const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        const deptId = Number(url.searchParams.get("department_id") || 0), typeId = Number(url.searchParams.get("event_type_id") || 0), from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
        const events = (await joinedEvents(env)).filter((e) => visible(e, user) && (!q || [e.title,e.department_name,e.event_type_name,e.place,e.target,e.purpose,e.applicant_position,e.applicant_name].join(" ").toLowerCase().includes(q)) && (!deptId || Number(e.department_id) === deptId) && (!typeId || Number(e.event_type_id) === typeId) && (!from || e.start.slice(0,10) >= from) && (!to || e.end.slice(0,10) <= to));
        const posts = (await postRows(env, user)).filter((p) => !q || [p.title,p.body,p.event_title,p.department_name].join(" ").toLowerCase().includes(q));
        return json({ events, posts }, 200, cors);
      }
      if (path === "/stats" && request.method === "GET") {
        const rows = (await joinedEvents(env)).filter((e) => e.status !== "삭제됨" && visible(e, user));
        const posts = await list(env, "posts"); const ids = new Set(rows.map((e) => Number(e.id)));
        return json({ registered: rows.length, completed: rows.filter(eventEnded).length, posts: posts.filter((p) => ids.has(Number(p.event_id))).length }, 200, cors);
      }
      if (path === "/notifications" && request.method === "GET") {
        admin(user); return json((await list(env, "notifications")).sort((a,b) => b.id-a.id).slice(0,300), 200, cors);
      }
      if (path === "/posts" && request.method === "GET") { editor(user); return json(await postRows(env, user), 200, cors); }
      if (path === "/posts/feed" && request.method === "GET") {
        editor(user); const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 10)));
        let rows = (await postRows(env, user)).sort((a,b) => b.created.localeCompare(a.created) || b.id-a.id);
        const cursor = url.searchParams.get("cursor"); if (cursor) { const c = JSON.parse(cursor); rows = rows.filter((p) => p.created < c.created || (p.created === c.created && p.id < c.id)); }
        const items = rows.slice(0, limit), more = rows.length > limit, last = items.at(-1);
        return json({ items, nextCursor: more && last ? JSON.stringify({ created: last.created, id: last.id }) : null }, 200, cors);
      }
      if (path === "/posts" && request.method === "POST") {
        editor(user); const item = await getEvent(env, body.event_id, user);
        if (!item || !canEditArchive(user, item)) throw error("행사 종료 후 등록자 또는 관리자만 아카이브를 작성할 수 있습니다.");
        if (!String(body.title || "").trim()) throw error("게시글 제목을 입력해주세요.");
        const id = await nextId(env, "posts"), t = now();
        await save(env, "posts", { id, event_id: Number(body.event_id), title: body.title.trim(), body: String(body.body || ""), created: t, updated: t });
        return json({ id }, 200, cors);
      }
      const postMatch = path.match(/^\/posts\/(\d+)$/);
      if (postMatch && request.method === "PUT") {
        editor(user); const linked = await getPost(env, postMatch[1], user);
        if (!linked || !canEditArchive(user, linked.event)) throw error("행사 종료 후 등록자 또는 관리자만 아카이브를 수정할 수 있습니다.", 403);
        if (!String(body.title || "").trim()) throw error("제목을 입력해주세요.");
        await save(env, "posts", { ...linked.post, title: body.title.trim(), body: String(body.body || ""), updated: now() });
        return json({ ok: true }, 200, cors);
      }
      if (postMatch && request.method === "DELETE") {
        editor(user); const linked = await getPost(env, postMatch[1], user);
        if (!linked || !canEditArchive(user, linked.event)) throw error("행사 종료 후 등록자 또는 관리자만 아카이브를 삭제할 수 있습니다.", 403);
        const files = (await list(env, "files")).filter((f) => Number(f.post_id) === Number(postMatch[1]));
        for (const file of files) { if (file.drive_id) await personalDrive(env, "deleteFile", { fileId: file.drive_id }).catch(() => {}); await remove(env, "files", "id", file.id); }
        await remove(env, "posts", "id", postMatch[1]); return json({ ok: true }, 200, cors);
      }
      const fileMatch = path.match(/^\/files\/(\d+)$/);
      if (fileMatch && request.method === "GET") {
        editor(user); const file = await getBy(env, "files", "id", fileMatch[1]);
        const linked = file && await getPost(env, file.post_id, user);
        if (!file || !linked || !file.drive_id) throw error("파일을 찾을 수 없습니다.", 404);
        const response = await drive(env, `/files/${encodeURIComponent(file.drive_id)}?alt=media`, { method: "GET" });
        return new Response(response.body, { status: 200, headers: { ...cors, "Content-Type": file.mime || "application/octet-stream", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      }
      if (fileMatch && request.method === "DELETE") {
        editor(user); const file = await getBy(env, "files", "id", fileMatch[1]), linked = file && await getPost(env, file.post_id, user);
        if (!file || !linked || !canEditArchive(user, linked.event)) throw error("첨부파일을 찾을 수 없습니다.", 404);
        if (file.drive_id) await personalDrive(env, "deleteFile", { fileId: file.drive_id });
        await remove(env, "files", "id", fileMatch[1]); return json({ ok: true }, 200, cors);
      }
      return json({ error: "아직 전환되지 않은 API입니다.", path }, 501, cors);
    } catch (e) { return json({ error: e.message || "서버 오류가 발생했습니다." }, e.status || 500, cors); }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil((async () => { await ensureTables(env); await Promise.all([notifyTelegram(env), pollTelegram(env)]); })()); },
};
