import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.join(root, "artifacts", "telegram-live", runId);
const token = process.env.TELEGRAM_BOT_TOKEN;
const expectedChats = {
  notice: Number(process.env.TELEGRAM_NOTICE_CHAT_ID),
  work: Number(process.env.TELEGRAM_WORK_CHAT_ID),
};
if (!token || !expectedChats.notice || !expectedChats.work)
  throw Error("봇 토큰과 두 방 ID를 먼저 설정해주세요.");
fs.mkdirSync(path.join(output, "runtime"), { recursive: true });
const report = {
  started: new Date().toISOString(),
  bot: null,
  chats: [],
  steps: [],
  receipts: [],
  passed: false,
};
let server;
async function telegram(method, body) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    const result = await response.json();
    if (!result.ok)
      throw Error(`Telegram ${result.error_code}: ${result.description}`);
    return result.result;
  } catch (error) {
    throw Error(String(error.message).replaceAll(token, "[REDACTED]"));
  }
}
try {
  const bot = await telegram("getMe", {});
  report.bot = bot.username;
  for (const [channel, id] of Object.entries(expectedChats)) {
    const chat = await telegram("getChat", { chat_id: id });
    const receipt = await telegram("sendMessage", {
      chat_id: id,
      text: `[연동 테스트] 시몬ONE 행사캘린더\n${channel === "notice" ? "접수 알림방" : "승인·반려 업무소통방"} 연결 확인용 메시지입니다.\n이어서 [테스트]로 시작하는 행사 알림이 전송됩니다.`,
    });
    assert.equal(receipt.chat.id, id);
    report.chats.push({ channel, name: chat.title, id });
    report.receipts.push({
      step: "방 연결",
      channel,
      chatId: id,
      messageId: receipt.message_id,
    });
  }
  console.log("두 방의 테스트 메시지 전송 성공");
  process.env.NODE_ENV = "test";
  process.env.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
  process.env.DEPARTMENT_PASSWORD = randomBytes(24).toString("base64url");
  process.chdir(path.join(output, "runtime"));
  const { default: app, flushNotifications } = await import(
    new URL("../server.js", import.meta.url)
  );
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = "";
  async function request(endpoint, method = "GET", body) {
    const response = await fetch(base + endpoint, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.ok(response.ok, result.error || `HTTP ${response.status}`);
    const session = response.headers.get("set-cookie");
    if (session) cookie = session.split(";")[0];
    return result;
  }
  await request("/login", "POST", {
    id: "admin",
    password: process.env.ADMIN_PASSWORD,
  });
  async function check(step, channels) {
    const receipts = await flushNotifications();
    assert.equal(receipts.length, channels.length);
    assert.deepEqual(
      receipts.map((r) => r.channel).sort(),
      [...channels].sort(),
    );
    for (const receipt of receipts) {
      assert.equal(receipt.chatId, expectedChats[receipt.channel]);
      report.receipts.push({ step, ...receipt });
    }
    report.steps.push({ step, passed: true, messages: receipts.length });
    console.log(`${step}: ${receipts.length}건 전송 확인`);
  }
  const body = {
    department_id: 1,
    title: `[테스트] 텔레그램 연동 ${runId}`,
    start: "2026-09-18T09:00",
    end: "2026-09-18T10:00",
    all_day: false,
    place: "테스트 장소",
    target: "테스트 담당자",
    purpose: "텔레그램 실제 알림 흐름 검증",
    expected: 10,
    collaborators: [2],
  };
  const { id } = await request("/events", "POST", body);
  await check("행사 신청", ["notice"]);
  await request(`/events/${id}/status`, "POST", { status: "승인" });
  await check("행사 승인", ["notice", "work"]);
  await request(`/events/${id}/actual`, "POST", { actual: 8 });
  await check("참여 인원 입력: 알림 없음", []);
  assert.equal((await request("/events"))[0].status, "승인");
  await request(`/events/${id}`, "PUT", {
    ...body,
    place: "수정된 테스트 장소",
  });
  await check("행사 수정", ["notice"]);
  assert.equal((await request("/events"))[0].status, "대기");
  await request(`/events/${id}/status`, "POST", {
    status: "반려",
    reason: "[테스트] 일정 조정이 필요합니다.",
  });
  await check("행사 반려", ["notice", "work"]);
  await request(`/events/${id}/status`, "POST", { status: "취소" });
  await check("행사 취소", ["notice"]);
  assert.equal((await request("/events"))[0].status, "취소");
  const notifications = await request("/notifications");
  assert.equal(notifications.length, 7);
  assert.ok(notifications.every((n) => n.sent === 1));
  report.passed = true;
  console.log(
    "PASS: 실제 메시지 총 9건 전송, 운영 DB와 분리한 테스트 행사 취소 완료",
  );
} catch (error) {
  report.error = String(error.message).replaceAll(token, "[REDACTED]");
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("검증 보고서: " + path.join(output, "report.json"));
  if (server) await new Promise((resolve) => server.close(resolve));
}
