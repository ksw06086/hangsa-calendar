const root = document.querySelector("#root"),
  dialog = document.querySelector("#detail"),
  editor = document.querySelector("#event-editor"),
  archiveModal = document.querySelector("#archive-modal");
const apiBase = String(window.APP_CONFIG?.apiBase || "").replace(/\/$/, "");
function closeOnBackdrop(modal) {
  modal.addEventListener("click", (event) => {
    const box = modal.getBoundingClientRect();
    if (
      event.target === modal &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom)
    )
      modal.close();
  });
}
closeOnBackdrop(dialog);
closeOnBackdrop(editor);
closeOnBackdrop(archiveModal);
editor.addEventListener("close", () => {
  editor.innerHTML = "";
});
const queryTicket = new URLSearchParams(location.search).get("ticket");
const fragmentTicket = /^[a-f0-9]{64}$/.test(location.hash.slice(1))
  ? location.hash.slice(1)
  : "";
const ticket = queryTicket || fragmentTicket;
if (ticket) {
  const url = new URL(location.href);
  url.searchParams.delete("ticket");
  if (fragmentTicket) url.hash = "";
  history.replaceState(null, "", url);
}
let me,
  depts = [],
  eventTypes = [],
  events = [],
  page = "calendar",
  month = new Date(),
  filter = "",
  typeFilter = "",
  editId = null,
  archiveEventId = null,
  archivePostId = null,
  feedState = null;
const mode = new URLSearchParams(location.search).get("mode");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const dt = (v) =>
  v ? new Date(v).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";
const date = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const badge = (e) =>
  `<span class="status ${e.status === "삭제됨" ? "deleted" : ""}">${esc(e.status)}</span>`;
const eventType = (e) => e.event_type_name || "기타 행사";
const eventColor = (e) => e.event_type_color || "#64748B";
const canManage = (e) =>
  me?.id === "admin" || me?.id === "bot" || e.created_by === me?.id;
const isDeptUser = () => me && me.id !== "bot";
const eventEnded = (e) =>
  Date.parse(e.all_day ? `${e.end}T23:59:59` : e.end) < Date.now();
async function api(url, method = "GET", body) {
  const apiToken = localStorage.getItem("simon-one-session") || "";
  const r = await fetch(apiBase + "/api" + url, {
    method,
    headers: {
      ...(ticket ? { "X-Bot-Ticket": ticket } : {}),
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  let j;
  try {
    j = await r.json();
  } catch {
    j = { error: "요청을 처리할 수 없습니다." };
  }
  if (!r.ok) throw Error(j.error);
  if (url === "/login" && j.token) localStorage.setItem("simon-one-session", j.token);
  if (url === "/logout" || url === "/password") localStorage.removeItem("simon-one-session");
  return j;
}
function fileUrl(id) {
  const base = `${apiBase}/api/files/${id}`;
  const token = localStorage.getItem("simon-one-session");
  return apiBase && token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
async function uploadFiles(postId, files) {
  for (const file of files) {
    const session = await api(`/posts/${postId}/files/session`, "POST", {
      name: file.name,
      mime: file.type,
      size: file.size,
    });
    let start = 0;
    while (start < file.size) {
      const end = Math.min(start + session.chunkSize, file.size);
      const response = await fetch(`${apiBase}/api/uploads/${session.uploadId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("simon-one-session") || ""}`,
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end - 1}/${file.size}`,
        },
        body: file.slice(start, end),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || "파일 업로드에 실패했습니다.");
      start = result.complete ? file.size : Number(result.nextOffset);
      if (!Number.isFinite(start) || start <= 0) throw Error("파일 업로드 위치를 확인할 수 없습니다.");
      toast(`${file.name} 업로드 중 · ${Math.round((start / file.size) * 100)}%`);
    }
  }
}
function toast(t) {
  const el = document.querySelector("#toast");
  el.textContent = t;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  try {
    await action(b.dataset.action, b);
  } catch (err) {
    toast(err.message);
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await submit(e.target);
  } catch (err) {
    toast(err.message);
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.matches('.cal-cell[data-action="new-date"]') &&
    ["Enter", " "].includes(event.key)
  ) {
    event.preventDefault();
    event.target.click();
  }
});
async function load() {
  [depts, eventTypes, events] = await Promise.all([
    api("/departments"),
    api("/event-types"),
    api("/events"),
  ]);
}
function pw(name, label) {
  return `<div class="field"><label>${label}</label><div class="password"><input name="${name}" type="password" required autocomplete="${name === "current" ? "current-password" : "new-password"}"><button type="button" class="btn ghost" data-action="reveal" aria-label="비밀번호 표시 전환">보기</button></div></div>`;
}
function login() {
  root.innerHTML = `<form id="login" class="card login"><div class="logo">시몬<span>ONE</span></div><h1>행사캘린더 로그인</h1><p>기획부 관리자 또는 부서 계정으로 로그인합니다.</p><div class="field"><label>계정</label><input name="id" placeholder="admin 또는 department-01" required autocomplete="username"></div>${pw("password", "비밀번호")}<button class="btn primary">로그인</button></form>`;
}
async function start() {
  try {
    me = await api("/me");
    await load();
    if (me.id === "bot") page = mode === "create" ? "form" : "bot";
    else restoreLocation();
    render();
  } catch (err) {
    if (ticket) {
      root.innerHTML = `<div class="card login"><h1>접수 링크가 만료되었습니다</h1><p>텔레그램 봇에서 /start 를 입력해 새 링크를 받아주세요.</p></div>`;
    } else login();
  }
}
function restoreLocation() {
  const params = new URLSearchParams(location.search);
  const allowedPages =
    me.id === "admin"
      ? [
          "calendar",
          "form",
          "archive",
          "archive-feed",
          "departments",
          "event-types",
          "notifications",
          "search",
          "stats",
          "settings",
        ]
      : ["calendar", "form", "archive", "search", "stats", "settings"];
  page = allowedPages.includes(params.get("page"))
    ? params.get("page")
    : "calendar";
  const savedMonth = params.get("month");
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(savedMonth || "")) {
    const [year, monthNumber] = savedMonth.split("-").map(Number);
    month = new Date(year, monthNumber - 1, 1);
  }
  filter = depts.some(
    (department) => department.id === Number(params.get("dept")),
  )
    ? params.get("dept")
    : "";
  typeFilter = eventTypes.some(
    (type) => type.id === Number(params.get("type")),
  )
    ? params.get("type")
    : "";
  editId =
    page === "form" &&
        events.some(
      (event) =>
        event.id === Number(params.get("edit")) && event.status !== "삭제됨",
    )
      ? Number(params.get("edit"))
      : null;
  archiveEventId =
    page === "archive" &&
    events.some((event) => event.id === Number(params.get("event")))
      ? Number(params.get("event"))
      : null;
}
function syncLocation() {
  if (me?.id === "bot") return;
  const url = new URL(location.href);
  const values = {
    page,
    month: date(month).slice(0, 7),
    dept: filter,
    type: typeFilter,
    edit: page === "form" ? editId : null,
    event: page === "archive" ? archiveEventId : null,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  history.replaceState(null, "", url);
}
function render() {
  root.innerHTML = `<div class="app ${me.id === "bot" ? "bot" : ""}"><aside class="nav"><div class="logo">시몬<span>ONE</span> 행사캘린더</div>${[
    ["calendar", "행사 캘린더"],
      ...(me.id === "admin"
        ? [
            ["form", "행사 등록"],
            ["archive", "행사 아카이브"],
            ["archive-feed", "아카이브 모아보기"],
            ["departments", "부서 관리"],
            ["event-types", "행사유형관리"],
            ["notifications", "알림 내역"],
            ["search", "통합 검색"],
            ["stats", "행사 통계"],
          ]
        : isDeptUser()
          ? [
              ["form", "행사 등록"],
              ["archive", "행사 아카이브"],
              ["search", "통합 검색"],
              ["stats", "행사 통계"],
            ]
          : []),
    ["settings", "비밀번호 변경"],
  ]
    .map(
      ([id, t]) =>
        `<button class="${page === id ? "active" : ""}" data-action="page" data-page="${id}"><span class="dot"></span>${t}</button>`,
    )
    .join(
      "",
    )}<footer>${me.id === "admin" ? "기획행사부 관리자" : esc(depts.find((d) => d.id === me.department_id)?.name)}<button data-action="logout">로그아웃</button></footer></aside><main class="main" id="main"></main></div>`;
  draw();
}
function head(title, sub, extra = "") {
  return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${extra}</div>`;
}
function options(selected, active = true) {
  return depts
    .filter((d) => !active || d.active || d.id === Number(selected))
    .map(
      (d) =>
        `<option value="${d.id}" ${d.id === Number(selected) ? "selected" : ""}>${esc(d.name)}${!d.active ? " (비활성)" : ""}</option>`,
    )
    .join("");
}
function draw() {
  syncLocation();
  feedState?.observer?.disconnect();
  feedState = null;
  const main = document.querySelector("#main");
  if (page === "calendar") calendar(main);
  if (page === "form")
    form(
      main,
      events.find((e) => e.id === editId),
    );
  if (page === "bot") bot(main);
  if (page === "settings")
    main.innerHTML =
      head("비밀번호 변경", "현재 로그인한 계정의 비밀번호를 변경합니다.") +
      `<form id="password" class="card form-section settings-form">${pw("current", "현재 비밀번호")}${pw("password", "새 비밀번호 · 8자 이상")}<button class="btn primary">변경하고 다시 로그인</button></form>`;
  if (page === "departments") departments(main);
  if (page === "event-types") eventTypesPage(main);
  if (page === "archive") archive(main);
  if (page === "archive-feed") archiveFeed(main);
  if (page === "search") searchPage(main);
  if (page === "stats") statsPage(main);
  if (page === "notifications") notifications(main);
}
function calendar(main) {
  const visible = events.filter(
    (e) =>
      e.status !== "삭제됨" &&
      (!filter || e.department_id === Number(filter)) &&
      (!typeFilter || e.event_type_id === Number(typeFilter)),
  );
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const count =
    Math.ceil(
      (first.getDay() +
        new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) /
        7,
    ) * 7;
  let cells = "";
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const ds = date(d);
    cells += `<div class="cal-cell ${d.getMonth() !== month.getMonth() ? "dim" : ""} ${ds === date(new Date()) ? "today" : ""}" data-date="${ds}" ${isDeptUser() ? `data-action="new-date" tabindex="0" role="group" aria-label="${ds} 종일 행사 등록"` : ""}><div class="num">${d.getDate()}</div>${visible
      .filter((e) => e.start.slice(0, 10) <= ds && e.end.slice(0, 10) >= ds)
      .map(
        (e) =>
          `<button class="evt" style="background:${esc(eventColor(e))}15;color:${esc(eventColor(e))}" data-action="detail" data-id="${e.id}" title="${esc(e.title)}">${esc(e.department_name)} · ${esc(eventType(e))} · ${esc(e.title)}</button>`,
      )
      .join("")}</div>`;
  }
  main.innerHTML =
    head(
      "행사 캘린더",
      isDeptUser()
        ? "전체 부서의 행사 일정을 한 화면에서 확인합니다."
        : "소속 부서에서 신청한 행사 일정을 확인합니다.",
      isDeptUser()
        ? '<button class="btn primary" data-action="new">+ 행사 등록</button><button class="btn ghost" data-action="download-calendar">이미지 다운로드</button>'
        : "",
    ) +
    `<div class="summary"><span class="chip">전체 행사 ${visible.length}</span><span class="chip">예정 ${visible.filter((e) => e.status !== "삭제됨" && !eventEnded(e)).length}</span><span class="chip">종료 ${visible.filter((e) => eventEnded(e)).length}</span></div><div class="card"><div class="cal-toolbar"><div class="month-nav"><button data-action="prev" aria-label="이전 달">‹</button><span>${month.getFullYear()}년 ${month.getMonth() + 1}월</span><button data-action="next" aria-label="다음 달">›</button><button data-action="today">오늘</button></div><div class="cal-filters"><select id="dept-filter" aria-label="부서 필터"><option value="">전체 부서</option>${options(filter, false)}</select><select id="type-filter" aria-label="행사 유형 필터"><option value="">전체 행사 유형</option>${eventTypes.filter((type) => type.active).map((type) => `<option value="${type.id}" ${String(type.id) === String(typeFilter) ? "selected" : ""}>${esc(type.name)}</option>`).join("")}</select></div></div><div class="cal-grid"><div class="cal-weekdays">${["일", "월", "화", "수", "목", "금", "토"].map((s) => `<div>${s}</div>`).join("")}</div><div class="cal-body">${cells}</div></div></div>`;
  document.querySelector("#dept-filter").value = filter;
  document.querySelector("#dept-filter").onchange = (e) => {
    filter = e.target.value;
    draw();
  };
  document.querySelector("#type-filter").onchange = (e) => {
    typeFilter = e.target.value;
    draw();
  };
}
function timeOptions(v) {
  let html = "";
  for (let h = 0; h < 24; h++)
    for (const m of ["00", "30"]) {
      const t = `${String(h).padStart(2, "0")}:${m}`;
      html += `<option ${t === v ? "selected" : ""}>${t}</option>`;
    }
  return html;
}
function field(name, label, value = "", type = "text") {
  return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value)}" ${type === "number" ? 'min="0" step="1"' : ""} required></div>`;
}
function openEventEditor(event) {
  editId = event?.id || null;
  editor.innerHTML =
    '<button type="button" class="btn ghost editor-close" data-action="editor-close" aria-label="행사 입력창 닫기">✕</button><div id="event-editor-body"></div>';
  form(editor.querySelector("#event-editor-body"), event, true);
  editor.querySelector("h1").id = "event-editor-title";
  editor.showModal();
}
function form(main, e, modal = false) {
  main.innerHTML =
    head(
      e?.id ? "행사 수정" : "행사 등록",
      e?.id
        ? "등록된 행사 정보를 수정합니다."
        : "등록 권한이 있는 행사 정보를 입력해주세요.",
    ) +
    `<form id="event-form" class="card form-section"><input type="hidden" name="event_id" value="${e?.id || ""}"><div class="field"><label>주관 부서</label><select name="department_id" required>${options(e?.department_id)}</select></div>${field("title", "행사명", e?.title)}${e?.id ? `<div class="field"><label>신청자</label><p>${esc(e.applicant || "미입력")}</p></div>${field("editor_name", "수정자", "")}` : field("applicant", "신청자", "")}<div class="field"><label><input type="checkbox" name="all_day" ${e?.all_day ? "checked" : ""}> 종일</label></div><div class="row2">${field("start_date", "시작 날짜", e?.start.slice(0, 10) || date(new Date()), "date")}${field("end_date", "종료 날짜", e?.end.slice(0, 10) || date(new Date()), "date")}</div><div class="row2" id="time-fields"><div class="field"><label>시작 시간</label><select name="start_time">${timeOptions(e?.start.slice(11, 16) || "09:00")}</select></div><div class="field"><label>종료 시간</label><select name="end_time">${timeOptions(e?.end.slice(11, 16) || "10:00")}</select></div></div><div class="row2">${field("place", "장소", e?.place)}${field("target", "대상", e?.target)}</div>${field("expected", "예상 인원", e?.expected ?? "", "number")}<div class="field"><label>목적</label><textarea name="purpose" required>${esc(e?.purpose)}</textarea></div><div class="field"><label>협력부서 · 선택사항 (여러 부서 선택 가능)</label><div class="dept-picker">${depts
      .filter((d) => d.active)
      .map(
        (d) =>
          `<label><input type="checkbox" name="collaborators" value="${d.id}" ${JSON.parse(e?.collaborators || "[]").includes(d.id) ? "checked" : ""}> ${esc(d.name)}</label>`,
      )
      .join(
        "",
      )}</div></div><div class="actions"><button class="btn primary">${e?.id ? "수정 저장" : "신청 등록"}</button><button type="button" class="btn ghost" data-action="${modal ? "editor-close" : "back"}">${modal ? "닫기" : "돌아가기"}</button></div></form>`;
  const departmentField = main.querySelector('[name="department_id"]');
  departmentField.insertAdjacentHTML(
    "afterend",
    `<div class="field"><label>행사 유형</label><select name="event_type_id" required>${eventTypes
      .filter((type) => type.active || type.id === Number(e?.event_type_id))
      .map(
        (type) =>
          `<option value="${type.id}" ${type.id === Number(e?.event_type_id) ? "selected" : ""}>${esc(type.name)}</option>`,
      )
      .join("")}</select></div>`,
  );
  if (e?.id && me.id !== "bot") main.querySelector('[name="editor_name"]')?.remove();
  if (e?.id) {
    const applicantBox = [...main.querySelectorAll(".field")].find(
      (box) => box.querySelector("label")?.textContent === "신청자",
    );
    applicantBox?.insertAdjacentHTML(
      "afterend",
      `<div class="field"><label>신청자 직책</label><p>${esc(e.applicant_position || "미입력")}</p></div><div class="field"><label>신청자 이름</label><p>${esc(e.applicant_name || e.applicant || "미입력")}</p></div>`,
    );
    applicantBox?.remove();
  } else {
    const applicantInput = main.querySelector('[name="applicant"]');
    applicantInput?.parentElement.insertAdjacentHTML(
      "afterend",
      `${field("applicant_name", "신청자 이름", "")}`,
    );
    if (applicantInput) {
      applicantInput.name = "applicant_position";
      applicantInput.parentElement.querySelector("label").textContent = "신청자 직책";
    }
  }
  const toggle = () => {
    main
      .querySelector("#time-fields")
      .classList.toggle("hidden", main.querySelector("[name=all_day]").checked);
  };
  main.querySelector("[name=all_day]").onchange = toggle;
  toggle();
}
function bot(main) {
  main.innerHTML =
    head(
      mode === "delete" ? "행사 삭제" : "행사 수정",
      "부서를 선택한 뒤 신청한 행사를 선택해주세요.",
    ) +
    `<div class="card form-section"><div class="field"><label>부서</label><select id="bot-dept"><option value="">부서를 선택해주세요</option>${options("", false)}</select></div><div class="field"><label>행사 · 최근 등록 순</label><select id="bot-event"><option value="">행사를 선택해주세요.</option></select></div>${mode === "delete" ? field("deleter_name", "삭제자", "") : ""}<button class="btn primary" data-action="bot-select">${mode === "delete" ? "삭제하기" : "수정하기"}</button><p class="muted">삭제된 행사는 기록으로 보존됩니다.</p></div>`;
  document.querySelector("#bot-dept").onchange = (e) => {
    document.querySelector("#bot-event").innerHTML =
      '<option value="">행사를 선택해주세요</option>' +
      events
        .filter(
          (v) =>
            v.department_id === Number(e.target.value) && v.status !== "삭제됨",
        )
        .map(
          (v) =>
            `<option value="${v.id}">[${esc(eventType(v))}] ${esc(v.title)} · ${dt(v.created)}</option>`,
        )
        .join("");
  };
}
function details(id) {
  const e = events.find((v) => v.id === Number(id));
  if (!e) return;
  const adminActions =
    isDeptUser()
      ? `<div class="detail-actions"><div class="detail-action-group archive-actions"><span class="action-label">아카이브</span><button class="btn archive-new" aria-label="새 아카이브 작성" data-action="archive-new" data-id="${e.id}">＋ 새로 작성</button><button class="btn archive-view" aria-label="작성한 아카이브 보기" data-action="archive-view" data-id="${e.id}">작성본 보기</button></div><div class="detail-action-group event-actions"><span class="action-label">행사 관리</span>${canManage(e) && e.status !== "삭제됨" ? `<button class="btn ghost" data-action="edit" data-id="${e.id}">수정</button><button class="btn cancel" data-action="delete-event" data-id="${e.id}">삭제</button>` : ""}<button class="btn ghost" data-action="history" data-id="${e.id}">변경 이력</button></div></div>`
      : "";
  dialog.innerHTML = `<div class="m-top"><span class="m-dept">${esc(e.department_name)}</span><button class="btn ghost" data-action="close">닫기</button></div><h2>${esc(e.title)} ${badge(e)}</h2><div class="m-grid">${[
    [
      "일시",
      `${e.start.replace("T", " ")} ~ ${e.end.replace("T", " ")}${e.all_day ? " · 종일" : ""}`,
    ],
    ["장소", e.place],
    ["신청자 직책", e.applicant_position || "미입력"],
    ["신청자 이름", e.applicant_name || e.applicant || "미입력"],
    ["대상", e.target],
    ["예상 인원", e.expected + "명"],
    ["실제 참여 인원", e.actual === null ? "미입력" : e.actual + "명"],
    ["신청 일시", dt(e.created)],
    ["최근 수정 일시", dt(e.updated)],
    ["행사 유형", eventType(e)],
  ]
    .map(
      ([l, v]) =>
        `<div class="m-cell"><span class="label">${l}</span><span class="value">${esc(v)}</span></div>`,
    )
    .join(
      "",
    )}</div><div class="m-cell"><span class="label">목적</span><p>${esc(e.purpose)}</p></div><p>협력부서: ${
    JSON.parse(e.collaborators)
      .map((id) => esc(depts.find((d) => d.id === id)?.name))
      .join(", ") || "없음"
  }</p>${canManage(e) && eventEnded(e) && e.status !== "삭제됨" ? `<form id="actual"><input type="hidden" name="event_id" value="${e.id}"><div class="field"><label>실제 참여 인원 · 선택사항</label><input name="actual" type="number" min="0" step="1" value="${e.actual ?? ""}"></div><button class="btn ghost">참여 인원 저장</button></form>` : ""}${adminActions}`;
  dialog.showModal();
}
function openArchiveNew(eventId) {
  const event = events.find((item) => item.id === Number(eventId));
  if (!event) return;
  archiveModal.innerHTML = `<button type="button" class="btn ghost editor-close" data-action="archive-close" aria-label="아카이브 입력창 닫기">✕</button><div class="page-head"><div><h1 id="archive-modal-title">새 아카이브 작성</h1><p>${esc(event.department_name)} · ${esc(event.title)}</p></div></div><form id="archive-modal-form" class="form-section"><input type="hidden" name="event_id" value="${event.id}">${field("title", "게시글 제목")}<div class="field"><label>기록 / 피드백</label><textarea name="body"></textarea></div><div class="actions"><button class="btn primary">게시글 작성</button><button type="button" class="btn ghost" data-action="archive-close">닫기</button></div></form>`;
  archiveModal.showModal();
  archiveModal.querySelector('[name="title"]').focus();
}
async function openArchiveView(eventId) {
  const event = events.find((item) => item.id === Number(eventId));
  if (!event) return;
  const posts = (await api("/posts")).filter(
    (post) => post.event_id === Number(eventId),
  );
  archiveModal.innerHTML = `<button type="button" class="btn ghost editor-close" data-action="archive-close" aria-label="아카이브 보기창 닫기">✕</button><div class="page-head"><div><h1 id="archive-modal-title">작성한 아카이브 보기</h1><p>${esc(event.department_name)} · ${esc(event.title)}</p></div></div><div class="archive-read-list">${
    posts.length
      ? posts
          .map(
            (post) => `<article class="archive-read-item"><div class="meta">작성 ${dt(post.created)} · 수정 ${dt(post.updated)}</div><h2>${esc(post.title)}</h2><p class="feed-body">${esc(post.body)}</p>${post.files.length ? `<div class="feed-media">${post.files.map((file) => `<div>${file.mime.startsWith("image/") ? `<a href="${fileUrl(file.id)}" target="_blank"><img src="${fileUrl(file.id)}" loading="lazy" alt="${esc(file.name)}"></a>` : `<video src="${fileUrl(file.id)}" controls preload="metadata"></video>`}</div>`).join("")}</div>` : ""}<div class="actions"><button class="btn primary" data-action="archive-edit" data-event-id="${event.id}" data-id="${post.id}">수정</button></div></article>`,
          )
          .join("")
      : '<p class="muted archive-empty">이 행사에 작성된 아카이브가 없습니다.</p>'
  }</div><div class="actions"><button class="btn ghost" data-action="archive-close">닫기</button></div>`;
  archiveModal.showModal();
}
function departments(main) {
  main.innerHTML =
    head(
      "부서 관리",
      "삭제한 부서는 신규 신청에서 제외하고 기존 기록은 보존합니다.",
    ) +
    `<form id="department-new" class="card dept-row"><input name="name" type="text" placeholder="새 부서명" required><button class="btn primary">부서 추가</button></form><div class="card list">${depts.map((d) => `<form id="dept-${d.id}" class="dept-row"><input name="id" type="hidden" value="${d.id}"><input name="name" type="text" value="${esc(d.name)}" required><span class="muted">${d.active ? "사용 중" : "비활성"}</span><button class="btn ghost">저장</button>${d.active ? `<button type="button" class="btn ghost error" data-action="delete-dept" data-id="${d.id}">삭제</button>` : ""}</form>`).join("")}</div>`;
}
function eventTypesPage(main) {
  main.innerHTML =
    head("행사유형관리", "행사 유형을 추가·수정하고 캘린더 색상을 지정합니다.") +
    `<form id="event-type-new" class="card dept-row"><input name="name" type="text" placeholder="새 행사 유형" required><input type="color" name="color" value="#64748b"><button class="btn primary">행사 유형 추가</button></form><div class="card list">${eventTypes.map((type) => `<form id="event-type-${type.id}" class="dept-row"><input name="id" type="hidden" value="${type.id}"><input name="name" type="text" value="${esc(type.name)}" required><input name="color" type="color" value="${type.color}"><span class="muted">${type.active ? "사용 중" : "비활성"}</span><button class="btn ghost">저장</button>${type.active ? `<button type="button" class="btn ghost error" data-action="delete-event-type" data-id="${type.id}">삭제</button>` : ""}</form>`).join("")}</div>`;
}
async function archive(main) {
  main.innerHTML =
    head("행사 아카이브", "행사별 사진과 기록을 게시글로 보관합니다.") +
    `<form id="post-new" class="card form-section"><div class="field"><label>행사</label><select name="event_id" required>${events.map((e) => `<option value="${e.id}">${esc(e.department_name)} · ${esc(e.title)} [${esc(e.status)}]</option>`).join("")}</select></div>${field("title", "게시글 제목")}<div class="field"><label>기록 / 피드백</label><textarea name="body"></textarea></div><button class="btn primary">게시글 작성</button></form><p id="storage" class="muted"></p><div id="posts" class="card list"></div>`;
  const [posts, storage] = await Promise.all([api("/posts"), api("/storage")]);
  if (page !== "archive") return;
  if (archiveEventId)
    main.querySelector("#post-new [name=event_id]").value =
      String(archiveEventId);
  document.querySelector("#storage").textContent =
    storage.free == null
      ? `Google Drive 저장 · 게시글당 사진 10장/합계 500MB, 동영상 1개/500MB`
      : `저장 공간: ${(storage.free / 1024 ** 3).toFixed(1)}GB 남음 · 게시글당 사진 10장/합계 500MB, 동영상 1개/500MB`;
  document.querySelector("#posts").innerHTML =
    posts
      .map(
        (p) =>
          `<article class="item"><div class="meta">${esc(p.event_title)} · ${dt(p.created)} · 수정 ${dt(p.updated)}</div><form id="post-${p.id}">${field("title", "제목", p.title)}<div class="field"><label>기록</label><textarea name="body">${esc(p.body)}</textarea></div><div class="actions"><button class="btn ghost">내용 저장</button><button type="button" class="btn ghost error" data-action="delete-post" data-id="${p.id}">게시글 삭제</button></div></form><div class="media">${p.files.map((f) => `<div>${f.mime.startsWith("image/") ? `<a href="${fileUrl(f.id)}" target="_blank"><img class="thumb" src="${fileUrl(f.id)}" alt="${esc(f.name)}" loading="lazy"></a>` : `<video class="thumb" src="${fileUrl(f.id)}" controls preload="metadata"></video>`}<div class="meta">${esc(f.name)} · ${(f.size / 1024 ** 2).toFixed(1)}MB</div><button class="btn ghost" data-action="delete-file" data-id="${f.id}">첨부 삭제</button></div>`).join("")}</div><form id="upload-${p.id}" class="actions"><input name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" required><button class="btn primary">첨부 추가</button></form></article>`,
      )
      .join("") || '<div class="item muted">아직 작성된 기록이 없습니다.</div>';
  if (archivePostId) {
    const target = document.querySelector(`#post-${archivePostId}`);
    if (target) {
      target.closest("article")?.classList.add("archive-edit-target");
      target.querySelector('[name="title"]')?.focus();
      target.scrollIntoView({ block: "center" });
    }
    archivePostId = null;
  }
}
function feedPost(post) {
  return `<article class="card feed-post" data-post-id="${post.id}"><div class="meta">${esc(post.department_name)} · ${esc(post.event_title)}<br>작성 ${dt(post.created)}</div><h2>${esc(post.title)}</h2><p class="feed-body">${esc(post.body)}</p>${post.files.length ? `<div class="feed-media">${post.files.map((file) => `<div>${file.mime.startsWith("image/") ? `<a href="${fileUrl(file.id)}" target="_blank"><img src="${fileUrl(file.id)}" loading="lazy" alt="행사 사진"></a>` : `<video src="${fileUrl(file.id)}" controls preload="metadata"></video>`}</div>`).join("")}</div>` : ""}</article>`;
}
function searchPage(main) {
  main.innerHTML =
    head("통합 검색", "행사와 아카이브를 한 번에 검색합니다.") +
    `<form id="search-form" class="card form-section search-form"><div class="field"><label>검색어</label><input name="q" type="search" placeholder="행사명, 부서명, 장소, 게시글 내용"></div><div class="row2"><div class="field"><label>부서</label><select name="department_id"><option value="">전체 부서</option>${options("", false)}</select></div><div class="field"><label>행사 유형</label><select name="event_type_id"><option value="">전체 행사 유형</option>${eventTypes.filter((type) => type.active).map((type) => `<option value="${type.id}">${esc(type.name)}</option>`).join("")}</select></div></div><div class="row2"><div class="field"><label>시작일</label><input name="from" type="date"></div><div class="field"><label>종료일</label><input name="to" type="date"></div></div><button class="btn primary">검색</button></form><div id="search-results"></div>`;
}
async function statsPage(main) {
  main.innerHTML = head("행사 통계", "현재 계정이 열람할 수 있는 행사와 기록을 집계합니다.") + '<div class="stats-grid" id="stats-grid"><div class="card stat-card">불러오는 중…</div></div>';
  const stats = await api("/stats");
  if (page !== "stats") return;
  main.querySelector("#stats-grid").innerHTML = [["등록 행사 수", stats.registered], ["완료 행사 수", stats.completed], ["아카이브 게시글 수", stats.posts]].map(([label, value]) => `<div class="card stat-card"><span class="label">${label}</span><strong>${value}</strong></div>`).join("");
}
function archiveFeed(main) {
  main.innerHTML =
    head("아카이브 모아보기", "모든 행사 기록을 최신 작성 순서로 확인합니다.") +
    '<div id="archive-feed-list"></div><div id="archive-feed-more"><p class="muted" role="status"></p><button class="btn ghost" data-action="feed-more">더 보기</button></div>';
  const state = {
    list: main.querySelector("#archive-feed-list"),
    sentinel: main.querySelector("#archive-feed-more"),
    cursor: null,
    loading: false,
    done: false,
    count: 0,
    observer: null,
  };
  feedState = state;
  if (typeof IntersectionObserver === "function") {
    state.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadFeed(state);
      },
      { rootMargin: "600px" },
    );
    state.observer.observe(state.sentinel);
  }
  loadFeed(state);
}
async function loadFeed(state) {
  if (
    !state ||
    state !== feedState ||
    page !== "archive-feed" ||
    state.loading ||
    state.done
  )
    return;
  state.loading = true;
  const button = state.sentinel.querySelector("button");
  const status = state.sentinel.querySelector("[role=status]");
  button.disabled = true;
  status.textContent = "기록을 불러오는 중입니다…";
  try {
    const result = await api(
      "/posts/feed?limit=10" +
        (state.cursor ? "&cursor=" + encodeURIComponent(state.cursor) : ""),
    );
    if (state !== feedState || page !== "archive-feed") return;
    state.list.insertAdjacentHTML(
      "beforeend",
      result.items.map(feedPost).join(""),
    );
    state.count += result.items.length;
    state.cursor = result.nextCursor;
    state.done = !result.nextCursor;
    button.hidden = state.done;
    status.textContent = state.done
      ? state.count
        ? `모든 게시글 ${state.count}개를 확인했습니다.`
        : "아직 작성된 기록이 없습니다."
      : `게시글 ${state.count}개를 불러왔습니다.`;
    if (state.done) state.observer?.disconnect();
    else if (state.observer) {
      state.observer.unobserve(state.sentinel);
      state.observer.observe(state.sentinel);
    }
  } catch (error) {
    if (state !== feedState) return;
    status.textContent = error.message;
    button.textContent = "다시 불러오기";
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}
async function notifications(main) {
  main.innerHTML =
    head(
      "알림 내역",
      "텔레그램 접수 알림방으로 전달할 메시지를 확인합니다.",
    ) + '<div class="card list" id="notifications"></div>';
  const rows = await api("/notifications");
  if (page !== "notifications") return;
  document.querySelector("#notifications").innerHTML =
    rows
      .map(
        (n) =>
          `<div class="item"><div class="meta">접수 알림방 · ${n.sent ? "전송 완료" : "전송 대기"} · ${dt(n.created)}</div><p>${esc(n.message)}</p></div>`,
      )
      .join("") || '<div class="item muted">알림이 없습니다.</div>';
}
async function action(a, b) {
  if (a === "reveal") {
    const input = b.previousElementSibling;
    input.type = input.type === "password" ? "text" : "password";
    b.textContent = input.type === "password" ? "보기" : "숨기기";
    return;
  }
  if (a === "page") {
    page = b.dataset.page;
    editId = null;
    archiveEventId = null;
    render();
  }
  if (a === "logout") {
    await api("/logout", "POST");
    login();
  }
  if (a === "prev" || a === "next") {
    month = new Date(
      month.getFullYear(),
      month.getMonth() + (a === "prev" ? -1 : 1),
      1,
    );
    draw();
  }
  if (a === "today") {
    month = new Date();
    draw();
  }
  if (a === "download-calendar") downloadCalendarImage();
  if (a === "new") {
    openEventEditor();
  }
  if (a === "new-date") {
    const selectedDepartment = depts.find(
      (department) => department.id === Number(filter) && department.active,
    );
    openEventEditor({
      start: b.dataset.date,
      end: b.dataset.date,
      all_day: 1,
      department_id: selectedDepartment?.id,
    });
  }
  if (a === "archive-new") {
    dialog.close();
    openArchiveNew(b.dataset.id);
  }
  if (a === "archive-view") {
    dialog.close();
    await openArchiveView(b.dataset.id);
  }
  if (a === "archive-close") archiveModal.close();
  if (a === "archive-edit") {
    archiveModal.close();
    archiveEventId = Number(b.dataset.eventId);
    archivePostId = Number(b.dataset.id);
    page = "archive";
    render();
  }
  if (a === "feed-more") await loadFeed(feedState);
  if (a === "editor-close") editor.close();
  if (a === "detail") details(b.dataset.id);
  if (a === "close") dialog.close();
  if (a === "edit") {
    dialog.close();
    editId = Number(b.dataset.id);
    page = "form";
    render();
  }
  if (a === "back") {
    page = me.id === "bot" ? "bot" : "calendar";
    render();
  }
  if (a === "bot-select") {
    const id = document.querySelector("#bot-event").value;
    if (!id) throw Error("행사를 선택해주세요.");
    if (mode === "delete") {
      const name = document.querySelector('[name="deleter_name"]').value.trim();
      if (!name) throw Error("삭제자를 입력해주세요.");
      await deleteEvent(id, name);
    } else {
      editId = Number(id);
      page = "form";
      render();
    }
  }
  if (a === "delete-event") await deleteEvent(b.dataset.id);
  if (a === "history") {
    const h = await api(`/events/${b.dataset.id}/history`);
    dialog.innerHTML = `<button class="btn ghost" data-action="close">닫기</button><h2>변경 이력</h2>${h.map((v) => `<div class="item"><b>${esc(v.action)}</b> · ${dt(v.created)}<div class="meta">${esc(v.actor)}</div><p>${esc(JSON.parse(v.snapshot).title)} · ${esc(JSON.parse(v.snapshot).start)} ~ ${esc(JSON.parse(v.snapshot).end)}</p></div>`).join("")}`;
  }
  if (
    a === "delete-dept" &&
    confirm("부서를 비활성화할까요? 기존 기록은 보존됩니다.")
  ) {
    await api("/departments/" + b.dataset.id, "DELETE");
    await load();
    draw();
  }
  if (
    a === "delete-event-type" &&
    confirm("행사 유형을 비활성화할까요? 기존 행사 기록은 보존됩니다.")
  ) {
    await api("/event-types/" + b.dataset.id, "DELETE");
    await load();
    draw();
  }
  if (a === "delete-post" || a === "delete-file") {
    if (!confirm("삭제할까요?")) return;
    await api(
      `/${a === "delete-post" ? "posts" : "files"}/${b.dataset.id}`,
      "DELETE",
    );
    draw();
  }
}
async function deleteEvent(id, suppliedName) {
  const name = me.id === "bot" ? suppliedName : null;
  if (me.id !== "bot" && !confirm("행사를 삭제할까요? 삭제된 행사는 기록으로 보존됩니다.")) return;
  const body = me.id === "bot" ? { deleter_name: name } : undefined;
  await api(`/events/${id}`, "DELETE", body);
  dialog.close();
  await load();
  draw();
  toast("행사가 삭제되었습니다.");
}
function downloadCalendarImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f8fc";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#182338";
  context.font = "bold 42px sans-serif";
  context.fillText(`시몬ONE 행사 캘린더 · ${month.getFullYear()}년 ${month.getMonth() + 1}월`, 60, 75);
  const visible = events.filter((item) => item.status !== "삭제됨" && (!filter || item.department_id === Number(filter)) && (!typeFilter || item.event_type_id === Number(typeFilter)));
  context.font = "24px sans-serif";
  visible.forEach((item, index) => {
    const y = 135 + index * 48;
    if (y > canvas.height - 40) return;
    context.fillStyle = eventColor(item);
    context.fillRect(60, y - 24, 16, 28);
    context.fillStyle = "#182338";
    context.fillText(`${item.start} · ${item.department_name} · ${eventType(item)} · ${item.title}`, 90, y);
  });
  const link = document.createElement("a");
  link.download = `simon-one-${date(month).slice(0, 7)}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}
async function submit(f) {
  const data = new FormData(f),
    b = Object.fromEntries(data);
  const button = f.querySelector("button[type=submit],button:not([type])");
  if (button) button.disabled = true;
  try {
    if (f.getAttribute("id") === "login") {
      await api("/login", "POST", b);
      await start();
      return;
    }
    if (f.getAttribute("id") === "password") {
      await api("/password", "POST", b);
      toast("비밀번호가 변경되었습니다.");
      login();
      return;
    }
    if (f.getAttribute("id") === "search-form") {
      const query = new URLSearchParams(
        Object.entries(b).filter(([, value]) => value),
      ).toString();
      const result = await api("/search?" + query);
      const target = document.querySelector("#search-results");
      target.innerHTML = `<h2>행사 ${result.events.length}건 · 아카이브 ${result.posts.length}건</h2>${result.events.map((item) => `<button class="card item search-result" data-action="detail" data-id="${item.id}"><b>${esc(item.title)}</b><span>${esc(item.department_name)} · ${esc(eventType(item))} · ${esc(item.start)}</span></button>`).join("")}${result.posts.map((item) => `<article class="card item"><b>${esc(item.title)}</b><span>${esc(item.department_name)} · ${esc(item.event_title)}</span><p>${esc(item.body)}</p></article>`).join("") || (!result.events.length ? '<p class="muted">검색 결과가 없습니다.</p>' : "")}`;
      return;
    }
    if (f.getAttribute("id") === "event-form") {
      b.all_day = data.has("all_day");
      b.start = b.start_date + (b.all_day ? "" : "T" + b.start_time);
      b.end = b.end_date + (b.all_day ? "" : "T" + b.end_time);
      b.collaborators = data.getAll("collaborators").map(Number);
      await api(
        b.event_id ? "/events/" + b.event_id : "/events",
        b.event_id ? "PUT" : "POST",
        b,
      );
      await load();
      editId = null;
      if (editor.open) {
        editor.close();
        draw();
      } else {
        page = me.id === "bot" ? "bot" : "calendar";
        render();
      }
      toast("저장되었습니다.");
      return;
    }
    if (f.getAttribute("id") === "actual") {
      await api(`/events/${b.event_id}/actual`, "POST", {
        actual: b.actual === "" ? null : Number(b.actual),
      });
      dialog.close();
      await load();
      details(b.event_id);
      toast("참여 인원을 저장했습니다.");
      return;
    }
    if (f.getAttribute("id") === "archive-modal-form") {
      await api("/posts", "POST", { ...b, event_id: Number(b.event_id) });
      archiveModal.close();
      toast("아카이브를 작성했습니다.");
      return;
    }
    if (
      f.getAttribute("id") === "department-new" ||
      f.getAttribute("id") === "event-type-new" ||
      f.getAttribute("id").startsWith("dept-") ||
      f.getAttribute("id").startsWith("event-type-")
    ) {
      await api(
        f.getAttribute("id") === "event-type-new" ||
          f.getAttribute("id").startsWith("event-type-")
          ? "/event-types"
          : "/departments",
        "POST",
        b,
      );
      await load();
      draw();
      return;
    }
    if (f.getAttribute("id") === "post-new")
      await api("/posts", "POST", { ...b, event_id: Number(b.event_id) });
    else if (f.getAttribute("id").startsWith("post-"))
      await api("/posts/" + f.getAttribute("id").slice(5), "PUT", b);
    else if (f.getAttribute("id").startsWith("upload-")) {
      toast("첨부파일을 업로드하고 있습니다.");
      const postId = f.getAttribute("id").slice(7);
      if (apiBase) await uploadFiles(postId, data.getAll("files").filter((file) => file.size));
      else await api("/posts/" + postId + "/files", "POST", data);
    }
    draw();
    toast("저장되었습니다.");
  } finally {
    if (button) button.disabled = false;
  }
}
start();
