import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { chromium } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("등록 중심 행사 운영과 삭제 로그", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-runtime-"));
  const server = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    cwd: directory,
    env: { ...process.env, PORT: "3199", ADMIN_PASSWORD: "admin-test-123", DEPARTMENT_PASSWORD: "dept-test-123", TELEGRAM_BOT_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("서버 시작 시간 초과")), 10000);
      server.stdout.on("data", (data) => {
        if (String(data).includes("http://localhost")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server.on("exit", () => reject(Error("서버 종료")));
    });
    let cookie = "";
    async function request(url, method = "GET", body, session = cookie) {
      const response = await fetch("http://localhost:3199/api" + url, {
        method,
        headers: {
          ...(session.startsWith("bot:") ? { "X-Bot-Ticket": session.slice(4) } : { Cookie: session }),
          ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
      let data;
      try { data = await response.json(); } catch {}
      return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    }
    cookie = (await request("/login", "POST", { id: "admin", password: "admin-test-123" })).cookie;
    const type = (await request("/event-types")).data[0];
    const event = {
      department_id: 1,
      event_type_id: type.id,
      title: "테스트 행사",
      applicant_position: "부장",
      applicant_name: "담당자",
      start: "2099-09-18T09:00",
      end: "2099-09-18T10:30",
      all_day: false,
      place: "강당",
      target: "전체",
      purpose: "검증",
      expected: 100,
      collaborators: [2],
    };
    const created = await request("/events", "POST", event);
    assert.equal(created.status, 200);
    const id = created.data.id;
    let current = (await request("/events")).data.find((item) => item.id === id);
    assert.equal(current.status, "예정");
    assert.equal(current.event_type_id, type.id);
    assert.equal((await request(`/events/${id}/status`, "POST", { status: "승인" })).status, 404);
    assert.equal((await request(`/events/${id}/status`, "POST", { status: "취소" })).status, 404);

    assert.equal((await request(`/events/${id}`, "PUT", { ...event, title: "수정 행사" })).status, 200);
    current = (await request("/events")).data.find((item) => item.id === id);
    assert.equal(current.title, "수정 행사");

    const ticketDb = new DatabaseSync(path.join(directory, "data/calendar.sqlite"));
    ticketDb.prepare("INSERT INTO tickets VALUES(?,?)").run("test-ticket", Date.now() + 60000);
    ticketDb.close();
    assert.equal((await request(`/events/${id}`, "DELETE", { deleter_name: "봇 사용자" }, "bot:test-ticket")).status, 200);
    current = (await request("/events")).data.find((item) => item.id === id);
    assert.equal(current.status, "삭제됨");
    assert.equal(current.deleted_by, "봇 사용자");
    assert.equal((await request(`/events/${id}/history`)).data[0].action, "삭제");

    const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(15000);
      await page.goto("http://localhost:3199", { waitUntil: "domcontentloaded" });
      await page.locator("[name=id]").fill("admin");
      await page.locator("[name=password]").fill("admin-test-123");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await page.getByRole("heading", { name: "행사 캘린더", exact: true }).waitFor();
      await page.getByRole("button", { name: "+ 행사 등록", exact: true }).click();
      await page.locator("[name=event_type_id]").waitFor();
      const bodyText = await page.locator("body").textContent();
      assert.equal(/승인|반려|취소/.test(bodyText), false);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
