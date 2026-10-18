import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventNotification, formatProcessedTime } from "../notifications.js";

const event = {
  department_name: "교육부",
  title: "부서 행사",
  start: "2026-09-18T09:00",
  end: "2026-09-18T10:30",
  all_day: 0,
};

test("등록·수정·삭제 알림의 일시와 한국시간 표시", () => {
  for (const [action, icon] of Object.entries({ 등록: "📅", 변경: "🔺", 삭제: "🗑️" })) {
    const message = buildEventNotification(event, action, "admin", new Date("2026-09-15T12:36:33Z"));
    assert.ok(message.text.startsWith(`${icon} [${action}]`));
    assert.ok(message.text.includes("일시: 2026.09.18 09:00 ~ 2026.09.18 10:30"));
    assert.ok(message.text.includes("처리: 행사기획부"));
    assert.ok(message.text.includes("🕒 처리 시각: 2026.09.15 21:36:33"));
    assert.ok(message.html.includes("<blockquote>"));
  }
  assert.equal(formatProcessedTime(new Date("2026-09-15T15:00:00Z")), "2026.09.16 00:00:00");
});

test("종일 행사에는 시간을 붙이지 않는다", () => {
  const message = buildEventNotification(
    { ...event, start: "2026-09-18", end: "2026-09-19", all_day: 1 },
    "등록",
    "텔레그램 신청자",
  );
  assert.ok(message.text.includes("일시: 2026.09.18 ~ 2026.09.19 (종일)"));
  assert.ok(message.text.includes("처리: 텔레그램 신청자"));
});

test("행사명과 HTML을 이스케이프한다", () => {
  const message = buildEventNotification({ ...event, title: '행사 <b>이름</b> & "사진"' }, "변경", "admin");
  assert.ok(message.html.includes("행사 &lt;b&gt;이름&lt;/b&gt; &amp; &quot;사진&quot;"));
  assert.ok(!message.html.includes("<b>이름</b>"));
});
