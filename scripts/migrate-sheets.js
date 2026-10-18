import { DatabaseSync } from "node:sqlite";
import { open, access, stat } from "node:fs/promises";
import path from "node:path";

const apiBase = String(process.env.SHEETS_API_URL || "").replace(/\/$/, "");
const migrationKey = process.env.SHEETS_MIGRATION_SECRET || "";
if (!apiBase || !migrationKey) throw Error("SHEETS_API_URL과 SHEETS_MIGRATION_SECRET을 .env에 설정해주세요.");

const db = new DatabaseSync(path.resolve("data/calendar.sqlite"), { readOnly: true });
const names = ["departments", "event_types", "users", "events", "history", "posts", "files", "notifications"];
const tables = Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
db.close();
tables.notifications = tables.notifications.map((item) => ({ ...item, sent: 1 }));

async function call(route, options = {}) {
  const response = await fetch(`${apiBase}/api${route}`, {
    ...options,
    headers: { "X-Migration-Key": migrationKey, ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || `이전 요청 실패 (${response.status})`);
  return result;
}

for (const [name, rows] of Object.entries(tables)) {
  await call("/migration/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tables: { [name]: rows } }),
  });
  console.log(`기본 데이터 가져오기: ${name} ${rows.length}행`);
}

for (const item of tables.files) {
  if (!item.path) continue;
  const fullPath = path.resolve("data/uploads", path.basename(item.path));
  try { await access(fullPath); }
  catch { throw Error("Attachment file was not found (ID " + item.id + ")."); }
  const info = await stat(fullPath);
  const session = await call("/migration/file/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.id, post_id: item.post_id, name: item.name, mime: item.mime, size: info.size }),
  });
  if (!session.complete) {
    const handle = await open(fullPath, "r");
    let driveId = "";
    try {
      for (let start = 0; start < info.size;) {
        const end = Math.min(start + session.chunkSize, info.size);
        const chunk = Buffer.alloc(end - start);
        await handle.read(chunk, 0, chunk.length, start);
        const response = await fetch(session.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": item.mime, "Content-Range": "bytes " + start + "-" + (end - 1) + "/" + info.size },
          body: chunk,
        });
        if (response.status === 308) {
          const received = response.headers.get("Range")?.match(/bytes=0-(\d+)/);
          start = received ? Number(received[1]) + 1 : end;
        } else {
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.id) throw Error(result.error?.message || "Drive upload failed (" + response.status + ").");
          driveId = result.id;
          start = info.size;
        }
        if (!Number.isFinite(start) || start <= 0) throw Error("Invalid upload position (ID " + item.id + ").");
      }
    } finally { await handle.close(); }
    if (!driveId) throw Error("Drive did not confirm upload (ID " + item.id + ").");
    await call("/migration/file/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, driveId }),
    });
  }
  console.log("Attachment migrated: " + item.id);
}
await call("/migration/complete", { method: "POST" });
console.log("이전 완료. 현재 비밀번호 해시, 행사 및 변경 이력을 옮겼고 활성 로그인 세션과 봇 링크는 폐기했습니다.");
