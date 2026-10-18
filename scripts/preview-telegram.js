import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { buildEventNotification } from "../notifications.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw Error("봇 토큰을 먼저 설정해주세요.");
const message = buildEventNotification(
  {
    department_name: "임시 부서 01",
    title: "[테스트] 알림 디자인 확인",
    start: "2026-09-18T09:00",
    end: "2026-09-18T10:00",
    all_day: 0,
  },
  "승인",
  "admin",
);
const results = [];
try {
  for (const key of ["TELEGRAM_NOTICE_CHAT_ID", "TELEGRAM_WORK_CHAT_ID"]) {
    const id = Number(process.env[key]);
    if (!id) throw Error("두 방 ID를 먼저 설정해주세요.");
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message.html,
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const result = await response.json();
    if (!result.ok)
      throw Error(`Telegram ${result.error_code}: ${result.description}`);
    assert.equal(result.result.chat.id, id);
    assert.ok(
      result.result.entities.some((entity) => entity.type === "blockquote"),
    );
    assert.ok(result.result.entities.some((entity) => entity.type === "bold"));
    const quote = result.result.entities.find(
      (entity) => entity.type === "blockquote",
    );
    const quotedText = result.result.text.slice(
      quote.offset,
      quote.offset + quote.length,
    );
    assert.ok(quotedText.includes("일시: 2026.09.18 09:00 ~ 2026.09.18 10:00"));
    assert.ok(quotedText.includes("처리: 행사기획부"));
    assert.ok(result.result.text.startsWith("✅ [승인]"));
    results.push({
      chatId: id,
      messageId: result.result.message_id,
      text: result.result.text,
      entities: result.result.entities,
    });
    console.log("새 알림 디자인 전송 성공: " + result.result.chat.title);
  }
  const directory = fileURLToPath(
    new URL("../artifacts/telegram-preview/", import.meta.url),
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "latest.json"),
    JSON.stringify(
      { created: new Date().toISOString(), passed: true, messages: results },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(String(error.message).replaceAll(token, "[REDACTED]"));
  process.exitCode = 1;
}
