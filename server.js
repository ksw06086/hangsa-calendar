import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEventNotification } from "./notifications.js";
fs.mkdirSync("data/uploads", { recursive: true });
const db = new DatabaseSync("data/calendar.sqlite");
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS event_types(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,password TEXT NOT NULL,department_id INTEGER,role TEXT DEFAULT 'manager',name TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,department_id INTEGER NOT NULL REFERENCES departments(id),title TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,all_day INTEGER NOT NULL,place TEXT NOT NULL,target TEXT NOT NULL,purpose TEXT NOT NULL,expected INTEGER NOT NULL,actual INTEGER,collaborators TEXT NOT NULL,status TEXT DEFAULT '대기',reason TEXT DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL,approved TEXT);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,event_id INTEGER,action TEXT,actor TEXT,snapshot TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),title TEXT,body TEXT,created TEXT,updated TEXT);
CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,post_id INTEGER REFERENCES posts(id),name TEXT,path TEXT,mime TEXT,size INTEGER);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,channel TEXT,message TEXT,sent INTEGER DEFAULT 0,created TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,expires INTEGER);
CREATE TABLE IF NOT EXISTS tickets(token TEXT PRIMARY KEY,expires INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
`);
if (!db.prepare("PRAGMA table_info(events)").all().some((column) => column.name === "applicant")) {
  db.exec("ALTER TABLE events ADD COLUMN applicant TEXT NOT NULL DEFAULT ''");
}
for (const column of [
  ["role", "TEXT DEFAULT 'manager'"],
  ["name", "TEXT DEFAULT ''"],
]) {
  if (!db.prepare("PRAGMA table_info(users)").all().some((item) => item.name === column[0]))
    db.exec(`ALTER TABLE users ADD COLUMN ${column[0]} ${column[1]}`);
}
for (const column of [
  ["created_by", "TEXT NOT NULL DEFAULT ''"],
  ["event_type_id", "INTEGER"],
  ["applicant_position", "TEXT NOT NULL DEFAULT ''"],
  ["applicant_name", "TEXT NOT NULL DEFAULT ''"],
  ["deleted_by", "TEXT"],
  ["deleted_at", "TEXT"],
]) {
  if (!db.prepare("PRAGMA table_info(events)").all().some((item) => item.name === column[0]))
    db.exec(`ALTER TABLE events ADD COLUMN ${column[0]} ${column[1]}`);
}
export function hashPassword(p) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
}
function checkPassword(p, h) {
  const [s, v] = h.split(":");
  return timingSafeEqual(scryptSync(p, s, 64), Buffer.from(v, "hex"));
}
if (!db.prepare("SELECT id FROM departments LIMIT 1").get())
  for (let i = 1; i <= 24; i++)
    db.prepare("INSERT INTO departments(name,color) VALUES(?,?)").run(
      `임시 부서 ${String(i).padStart(2, "0")}`,
      ["#3651E3", "#B4750F", "#158A5C", "#6D28D9"][(i - 1) % 4],
    );
if (!db.prepare("SELECT id FROM event_types LIMIT 1").get())
  for (const [name, color] of [
    ["총회 행사", "#3651E3"],
    ["지파 행사", "#158A5C"],
    ["교육 행사", "#B4750F"],
    ["정기 행사", "#6D28D9"],
    ["기타 행사", "#64748B"],
  ])
    db.prepare("INSERT INTO event_types(name,color) VALUES(?,?)").run(name, color);
db.prepare("UPDATE events SET status='예정' WHERE status IS NULL OR status IN ('대기','승인','반려')").run();
db.prepare("UPDATE events SET status='삭제됨' WHERE status='취소'").run();
db.prepare("UPDATE events SET event_type_id=(SELECT id FROM event_types ORDER BY id LIMIT 1) WHERE event_type_id IS NULL").run();
const accountSeeds = [
  ["admin", "ADMIN_PASSWORD", null, "admin", "기획부 관리자"],
  ...Array.from({ length: 23 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return [`department-${number}`, `DEPARTMENT_${number}_PASSWORD`, index + 2, "manager", ""];
  }),
];
if (db.prepare("SELECT id FROM users WHERE id='department'").get())
  db.prepare("UPDATE users SET id='department-01',department_id=2,role='manager',name='' WHERE id='department'").run();
for (const [id, env, dept, role, name] of accountSeeds)
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(id)) {
    const p = process.env[env] || randomBytes(12).toString("base64url");
    db.prepare("INSERT INTO users(id,password,department_id,role,name) VALUES(?,?,?,?,?)").run(
      id,
      hashPassword(p),
      dept,
      role,
      name,
    );
    if (!process.env[env]) console.log(`초기 ${id} 비밀번호: ${p}`);
  }
db.prepare("UPDATE users SET role='admin',name='기획부 관리자' WHERE id='admin'").run();
db.prepare("UPDATE events SET created_by='department-01' WHERE created_by='department'").run();
db.prepare("UPDATE events SET applicant_name=applicant WHERE applicant_name='' AND applicant<>''").run();
if (
  !db
    .prepare("PRAGMA table_info(notifications)")
    .all()
    .some((column) => column.name === "html")
) {
  db.exec("ALTER TABLE notifications ADD COLUMN html TEXT");
}
const now = () => new Date().toISOString();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== `${req.protocol}://${req.get("host")}` &&
    req.headers.origin !== process.env.PUBLIC_URL
  )
    return res.status(403).json({ error: "허용되지 않은 요청입니다." });
  next();
});
app.set("trust proxy", 1);
const attempts = new Map();
app.post("/api/login", (req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, time: Date.now() };
  if (Date.now() - a.time > 600000) {
    a.n = 0;
    a.time = Date.now();
  }
  if (a.n >= 10)
    return res.status(429).json({ error: "10분 후 다시 시도해주세요." });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.body.id);
  if (!u || !checkPassword(String(req.body.password || ""), u.password)) {
    a.n++;
    attempts.set(key, a);
    return res
      .status(401)
      .json({ error: "계정 또는 비밀번호를 확인해주세요." });
  }
  attempts.delete(key);
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    token,
    u.id,
    Date.now() + 12 * 3600000,
  );
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: 12 * 3600000,
  });
  res.json({ ok: true });
});
app.use("/api", (req, res, next) => {
  const token = (req.headers.cookie || "").match(
    /(?:^|;\s*)session=([^;]+)/,
  )?.[1];
  const session = db
    .prepare("SELECT * FROM sessions WHERE token=? AND expires>?")
    .get(token || "", Date.now());
  if (session)
    req.user = db
      .prepare("SELECT id,department_id,role,name FROM users WHERE id=?")
      .get(session.user_id);
  const ticket = req.headers["x-bot-ticket"];
  if (
    ticket &&
    db
      .prepare("SELECT token FROM tickets WHERE token=? AND (expires IS NULL OR expires>?)")
      .get(ticket, Date.now())
  )
    req.bot = true;
  if (!req.user && !req.bot)
    return res.status(401).json({ error: "로그인이 필요합니다." });
  next();
});
const admin = (req, res, next) =>
  req.user?.id === "admin"
    ? next()
    : res.status(403).json({ error: "관리자만 사용할 수 있습니다." });
const editor = (req, res, next) =>
  req.bot || ["admin", "manager"].includes(req.user?.role || (req.user?.id === "admin" ? "admin" : "manager"))
    ? next()
    : res.status(403).json({ error: "부장단 또는 관리자만 등록할 수 있습니다." });
app.get("/api/me", (req, res) => res.json(req.user || { id: "bot" }));
app.post("/api/logout", (req, res) => {
  const t = (req.headers.cookie || "").match(/session=([^;]+)/)?.[1];
  db.prepare("DELETE FROM sessions WHERE token=?").run(t || "");
  res.clearCookie("session");
  res.json({ ok: true });
});
app.post("/api/password", (req, res) => {
  if (!req.user) return res.sendStatus(403);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!checkPassword(String(req.body.current || ""), u.password))
    return res.status(400).json({ error: "현재 비밀번호가 다릅니다." });
  if (typeof req.body.password !== "string" || req.body.password.length < 8)
    return res
      .status(400)
      .json({ error: "새 비밀번호는 8자 이상 입력해주세요." });
  db.prepare("UPDATE users SET password=? WHERE id=?").run(
    hashPassword(req.body.password),
    u.id,
  );
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
  res.clearCookie("session");
  res.json({ ok: true });
});
app.get("/api/departments", (req, res) =>
  res.json(db.prepare("SELECT id,name,active FROM departments").all()),
);
app.get("/api/event-types", (req, res) =>
  res.json(db.prepare("SELECT * FROM event_types ORDER BY id").all()),
);
app.post("/api/departments", admin, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name || name.length > 100)
    return res.status(400).json({ error: "부서명을 입력해주세요." });
  if (req.body.id)
    db.prepare("UPDATE departments SET name=? WHERE id=?").run(name, req.body.id);
  else
    db.prepare("INSERT INTO departments(name,color) VALUES(?,?)").run(
      name,
      "#64748B",
    );
  res.json({ ok: true });
});
app.delete("/api/departments/:id", admin, (req, res) => {
  db.prepare("UPDATE departments SET active=0 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/event-types", admin, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name || name.length > 100)
    return res.status(400).json({ error: "행사 유형명을 입력해주세요." });
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color)
    ? req.body.color
    : "#64748B";
  try {
    if (req.body.id)
      db.prepare("UPDATE event_types SET name=?,color=? WHERE id=?").run(
        name,
        color,
        req.body.id,
      );
    else
      db.prepare("INSERT INTO event_types(name,color) VALUES(?,?)").run(
        name,
        color,
      );
  } catch (error) {
    if (String(error.message).includes("UNIQUE"))
      return res.status(400).json({ error: "이미 사용 중인 행사 유형명입니다." });
    throw error;
  }
  res.json({ ok: true });
});
app.delete("/api/event-types/:id", admin, (req, res) => {
  if (!db.prepare("SELECT id FROM event_types WHERE id=?").get(req.params.id))
    return res.sendStatus(404);
  if (db.prepare("SELECT id FROM events WHERE event_type_id=? LIMIT 1").get(req.params.id))
    return res.status(400).json({ error: "사용 중인 행사 유형은 비활성화할 수 없습니다." });
  db.prepare("UPDATE event_types SET active=0 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
function event(req, id) {
  const e = db
    .prepare(
      "SELECT events.*,departments.name department_name,event_types.name event_type_name,event_types.color event_type_color FROM events JOIN departments ON departments.id=events.department_id LEFT JOIN event_types ON event_types.id=events.event_type_id WHERE events.id=?",
    )
    .get(id);
  if (!e) return null;
  if (req.bot || req.user?.id === "admin" || e.department_id === req.user?.department_id)
    return e;
  const collaborators = JSON.parse(e.collaborators || "[]");
  return collaborators.includes(req.user?.department_id) ? e : null;
}
app.get("/api/events", (req, res) => {
  let rows = db
    .prepare(
      "SELECT events.*,departments.name department_name,event_types.name event_type_name,event_types.color event_type_color FROM events JOIN departments ON departments.id=events.department_id LEFT JOIN event_types ON event_types.id=events.event_type_id ORDER BY created DESC,id DESC",
    )
    .all();
  if (req.user?.id !== "admin")
    rows = rows.filter((item) =>
      item.department_id === req.user.department_id ||
      JSON.parse(item.collaborators || "[]").includes(req.user.department_id),
    );
  res.json(rows);
});
app.get("/api/events/:id/history", (req, res) => {
  if (!event(req, req.params.id)) return res.sendStatus(404);
  res.json(
    db
      .prepare("SELECT * FROM history WHERE event_id=? ORDER BY id DESC")
      .all(req.params.id),
  );
});
app.get("/api/search", editor, (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  const departmentId = Number(req.query.department_id || 0);
  const typeId = Number(req.query.event_type_id || 0);
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const eventRows = db.prepare("SELECT events.*,departments.name department_name,event_types.name event_type_name,event_types.color event_type_color FROM events JOIN departments ON departments.id=events.department_id LEFT JOIN event_types ON event_types.id=events.event_type_id ORDER BY events.start DESC,events.id DESC").all();
  const visibleEvents = eventRows.filter((item) => event(req, item.id));
  const matchesEvent = (item) => {
    const haystack = [item.title, item.department_name, item.event_type_name, item.place, item.target, item.purpose, item.applicant_position, item.applicant_name].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) &&
      (!departmentId || item.department_id === departmentId) &&
      (!typeId || item.event_type_id === typeId) &&
      (!from || item.start.slice(0, 10) >= from) &&
      (!to || item.end.slice(0, 10) <= to);
  };
  const eventsResult = visibleEvents.filter(matchesEvent);
  const posts = db.prepare("SELECT posts.*,events.title event_title,events.department_id,departments.name department_name FROM posts JOIN events ON events.id=posts.event_id JOIN departments ON departments.id=events.department_id ORDER BY posts.created DESC").all()
    .filter((post) => !query || [post.title, post.body, post.event_title, post.department_name].join(" ").toLowerCase().includes(query));
  res.json({ events: eventsResult, posts });
});
app.get("/api/stats", (req, res) => {
  const rows = db.prepare("SELECT * FROM events WHERE status!='삭제됨'").all()
    .filter((item) => req.user?.id === "admin" || item.department_id === req.user?.department_id || JSON.parse(item.collaborators || "[]").includes(req.user?.department_id));
  const ids = rows.map((item) => item.id);
  const posts = ids.length ? db.prepare(`SELECT COUNT(*) count FROM posts WHERE event_id IN (${ids.map(() => "?").join(",")})`).get(...ids).count : 0;
  const completed = rows.filter((item) => Date.parse(item.all_day ? `${item.end}T23:59:59` : item.end) < Date.now()).length;
  res.json({ registered: rows.length, completed, posts });
});
export function validateEvent(b) {
  for (const k of ["title", "place", "target", "purpose"])
    if (typeof b[k] !== "string" || !b[k].trim() || b[k].length > 4000)
      throw Error("필수 항목을 입력해주세요.");
  if (
    !Number.isInteger(Number(b.expected)) ||
    Number(b.expected) < 0 ||
    b.expected === ""
  )
    throw Error("예상 인원을 확인해주세요.");
  const format = b.all_day
    ? /^\d{4}-\d{2}-\d{2}$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)$/;
  if (
    !format.test(b.start) ||
    !format.test(b.end) ||
    !Number.isFinite(Date.parse(b.start)) ||
    !Number.isFinite(Date.parse(b.end)) ||
    b.end < b.start ||
    (!b.all_day && b.end === b.start)
  )
    throw Error("시작·종료 일시를 확인해주세요.");
  if (!Array.isArray(b.collaborators)) throw Error("협력부서를 확인해주세요.");
  if (!Number.isInteger(Number(b.event_type_id))) throw Error("행사 유형을 선택해주세요.");
}
function notify(e, action, actor) {
  const message = buildEventNotification(
    {
      ...e,
      department_name:
        e.department_name ||
        db
          .prepare("SELECT name FROM departments WHERE id=?")
          .get(e.department_id)?.name,
    },
    action,
    actor,
  );
  db.prepare(
    "INSERT INTO notifications(channel,message,html,created) VALUES(?,?,?,?)",
  ).run("notice", message.text, message.html, now());
}
function requiredName(value, label) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw Error(`${label}를 입력해주세요 (100자 이하).`);
  return name;
}
function record(e, action, req, name) {
  const actor = name || req.user?.id || "텔레그램 신청자";
  db.prepare(
    "INSERT INTO history(event_id,action,actor,snapshot,created) VALUES(?,?,?,?,?)",
  ).run(e.id, action, actor, JSON.stringify(e), now());
  notify(e, action, actor);
}
function canManageEvent(req, e) {
  return req.bot || req.user?.id === "admin" || e.created_by === req.user?.id;
}
function eventHasEnded(e) {
  const end = e.all_day ? `${e.end}T23:59:59` : e.end;
  return Date.parse(end) < Date.now();
}
function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
app.post("/api/events", editor, (req, res) => {
  validateEvent(req.body);
  const b = req.body;
  const applicantPosition = requiredName(b.applicant_position, "신청자 직책");
  const applicantName = requiredName(b.applicant_name, "신청자 이름");
  const applicant = `${applicantPosition} ${applicantName}`;
  const dept = db
    .prepare("SELECT * FROM departments WHERE id=? AND active=1")
    .get(Number(b.department_id));
  if (!dept) throw Error("신청 가능한 부서를 선택해주세요.");
  const eventType = db
    .prepare("SELECT * FROM event_types WHERE id=? AND active=1")
    .get(Number(b.event_type_id));
  if (!eventType) throw Error("신청 가능한 행사 유형을 선택해주세요.");
  const id = transaction(() => {
    const t = now();
    const r = db
      .prepare(
        "INSERT INTO events(department_id,event_type_id,title,start,end,all_day,place,target,purpose,expected,collaborators,created,updated,applicant,applicant_position,applicant_name,created_by,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        dept.id,
        eventType.id,
        b.title.trim(),
        b.start,
        b.end,
        b.all_day ? 1 : 0,
        b.place,
        b.target,
        b.purpose,
        Number(b.expected),
        JSON.stringify(b.collaborators),
        t,
        t,
        applicant,
        applicantPosition,
        applicantName,
        req.user?.id || "bot",
        "예정",
      );
    record(event(req, Number(r.lastInsertRowid)), "등록", req, applicant);
    return Number(r.lastInsertRowid);
  });
  res.json({ id });
});
app.put("/api/events/:id", editor, (req, res) => {
  const e = event(req, req.params.id);
  if (!e || e.status === "삭제됨")
    return res.status(400).json({ error: "삭제된 행사는 수정할 수 없습니다." });
  if (!canManageEvent(req, e)) return res.status(403).json({ error: "등록자 또는 관리자만 수정할 수 있습니다." });
  if (eventHasEnded(e) && req.user?.id !== "admin")
    return res.status(400).json({ error: "종료된 행사는 실제 참여 인원과 아카이브만 수정할 수 있습니다." });
  validateEvent(req.body);
  const b = req.body;
  const editorName = req.bot
    ? requiredName(b.editor_name, "수정자")
    : req.user?.id === "admin"
      ? "행사기획부"
      : req.user?.id;
  const dept = db
    .prepare("SELECT * FROM departments WHERE id=?")
    .get(Number(b.department_id));
  if (!dept || (!dept.active && dept.id !== e.department_id))
    throw Error("부서를 확인해주세요.");
  const eventType = db
    .prepare("SELECT * FROM event_types WHERE id=? AND (active=1 OR id=?)")
    .get(Number(b.event_type_id), Number(e.event_type_id));
  if (!eventType) throw Error("행사 유형을 확인해주세요.");
  transaction(() => {
    db.prepare(
      "UPDATE events SET department_id=?,event_type_id=?,title=?,start=?,end=?,all_day=?,place=?,target=?,purpose=?,expected=?,collaborators=?,updated=? WHERE id=?",
    ).run(
      dept.id,
      eventType.id,
      b.title,
      b.start,
      b.end,
      b.all_day ? 1 : 0,
      b.place,
      b.target,
      b.purpose,
      Number(b.expected),
      JSON.stringify(b.collaborators),
      now(),
      e.id,
    );
    record(event(req, e.id), "변경", req, editorName);
  });
  res.json({ ok: true });
});
app.delete("/api/events/:id", editor, (req, res) => {
  const e = event(req, req.params.id);
  if (!e) return res.sendStatus(404);
  if (e.status === "삭제됨") return res.json({ ok: true });
  if (!canManageEvent(req, e)) return res.status(403).json({ error: "등록자 또는 관리자만 삭제할 수 있습니다." });
  const actor = req.bot
    ? requiredName(req.body?.deleter_name, "삭제자")
    : req.user?.id === "admin"
      ? "행사기획부"
      : req.user?.id;
  transaction(() => {
    db.prepare("UPDATE events SET status='삭제됨',deleted_by=?,deleted_at=?,updated=? WHERE id=?").run(actor, now(), now(), e.id);
    record(event(req, e.id), "삭제", req, actor);
  });
  res.json({ ok: true });
});
app.post("/api/events/:id/actual", editor, (req, res) => {
  const e = event(req, req.params.id);
  if (!e) return res.sendStatus(404);
  if (!canManageEvent(req, e)) return res.status(403).json({ error: "등록자 또는 관리자만 수정할 수 있습니다." });
  if (!eventHasEnded(e) && req.user?.id !== "admin")
    return res.status(400).json({ error: "실제 참여 인원은 행사 종료 후 입력할 수 있습니다." });
  const n = req.body.actual;
  if (n !== null && (!Number.isInteger(n) || n < 0))
    throw Error("참여 인원을 확인해주세요.");
  db.prepare("UPDATE events SET actual=? WHERE id=?").run(n, e.id);
  res.json({ ok: true });
});
app.get("/api/notifications", admin, (req, res) =>
  res.json(
    db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 300").all(),
  ),
);
app.get("/api/storage", editor, (req, res) => {
  const s = fs.statfsSync("data");
  res.json({ free: s.bavail * s.bsize });
});
function postEvent(req, postId) {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(postId);
  if (!post) return null;
  const linkedEvent = event(req, post.event_id);
  if (!linkedEvent || linkedEvent.status === "삭제됨") return null;
  return { post, event: linkedEvent };
}
function canEditArchive(req, linkedEvent) {
  return req.user?.id === "admin" || (linkedEvent.created_by === req.user?.id && eventHasEnded(linkedEvent));
}
app.get("/api/posts", editor, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT posts.*,events.title event_title FROM posts JOIN events ON events.id=posts.event_id ORDER BY posts.id DESC",
      )
      .all()
      .map((p) => ({
        ...p,
        files: db
          .prepare("SELECT id,name,mime,size FROM files WHERE post_id=?")
          .all(p.id),
      })),
  ),
);
db.exec(
  "CREATE INDEX IF NOT EXISTS posts_created_order ON posts(created DESC,id DESC)",
);
app.get("/api/posts/feed", editor, (req, res) => {
  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30)
    throw Error("조회 개수를 확인해주세요.");
  let cursor;
  if (req.query.cursor) {
    try {
      cursor = JSON.parse(req.query.cursor);
    } catch {
      throw Error("조회 위치를 확인해주세요.");
    }
    if (
      !cursor ||
      !Number.isInteger(cursor.id) ||
      cursor.id < 1 ||
      typeof cursor.created !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.created)
    )
      throw Error("조회 위치를 확인해주세요.");
  }
  const sql = `SELECT posts.*,events.title event_title,departments.name department_name FROM posts JOIN events ON events.id=posts.event_id JOIN departments ON departments.id=events.department_id ${cursor ? "WHERE posts.created < ? OR (posts.created = ? AND posts.id < ?)" : ""} ORDER BY posts.created DESC,posts.id DESC LIMIT ?`;
  const rows = cursor
    ? db.prepare(sql).all(cursor.created, cursor.created, cursor.id, limit + 1)
    : db.prepare(sql).all(limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((post) => ({
    ...post,
    files: db
      .prepare(
        "SELECT id,name,mime,size FROM files WHERE post_id=? ORDER BY id",
      )
      .all(post.id),
  }));
  const last = items.at(-1);
  res.json({
    items,
    nextCursor: more
      ? JSON.stringify({ created: last.created, id: last.id })
      : null,
  });
});
app.post("/api/posts", editor, (req, res) => {
  const linkedEvent = event(req, req.body.event_id);
  if (!linkedEvent || !canEditArchive(req, linkedEvent))
    throw Error("행사 종료 후 등록자 또는 관리자만 아카이브를 작성할 수 있습니다.");
  if (!String(req.body.title || "").trim())
    throw Error("게시글 제목을 입력해주세요.");
  const t = now();
  const r = db
    .prepare(
      "INSERT INTO posts(event_id,title,body,created,updated) VALUES(?,?,?,?,?)",
    )
    .run(req.body.event_id, req.body.title, String(req.body.body || ""), t, t);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put("/api/posts/:id", editor, (req, res) => {
  const linked = postEvent(req, req.params.id);
  if (!linked || !canEditArchive(req, linked.event))
    return res.status(403).json({ error: "행사 종료 후 등록자 또는 관리자만 아카이브를 수정할 수 있습니다." });
  if (!String(req.body.title || "").trim()) throw Error("제목을 입력해주세요.");
  db.prepare("UPDATE posts SET title=?,body=?,updated=? WHERE id=?").run(
    req.body.title,
    String(req.body.body || ""),
    now(),
    req.params.id,
  );
  res.json({ ok: true });
});
const upload = multer({
  dest: "data/uploads",
  limits: { fileSize: 500 * 1024 * 1024, files: 11 },
  fileFilter: (req, file, cb) =>
    [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ].includes(file.mimetype)
      ? cb(null, true)
      : cb(Error("지원하는 사진 또는 동영상 형식으로 업로드해주세요.")),
});
app.post("/api/posts/:id/files", editor, (req, res, next) =>
  upload.array("files", 11)(req, res, (err) => {
    try {
      if (err) throw err;
      const linked = postEvent(req, req.params.id);
      if (!linked || !canEditArchive(req, linked.event))
        throw Error("행사 종료 후 등록자 또는 관리자만 첨부파일을 수정할 수 있습니다.");
      const existing = db
          .prepare("SELECT * FROM files WHERE post_id=?")
          .all(req.params.id),
        all = [...existing, ...req.files];
      const images = all.filter((f) =>
          String(f.mime || f.mimetype).startsWith("image/"),
        ),
        videos = all.filter((f) =>
          String(f.mime || f.mimetype).startsWith("video/"),
        );
      if (
        images.length > 10 ||
        images.reduce((s, f) => s + f.size, 0) > 500 * 1024 * 1024 ||
        videos.length > 1
      )
        throw Error(
          "게시글당 사진 10장·합계 500MB, 동영상 1개·500MB까지 가능합니다.",
        );
      transaction(() => {
        for (const f of req.files)
          db.prepare(
            "INSERT INTO files(post_id,name,path,mime,size) VALUES(?,?,?,?,?)",
          ).run(
            req.params.id,
            Buffer.from(f.originalname, "latin1").toString("utf8"),
            f.filename,
            f.mimetype,
            f.size,
          );
      });
      res.json({ ok: true });
    } catch (e) {
      for (const f of req.files || []) fs.rmSync(f.path, { force: true });
      next(e);
    }
  }),
);
app.get("/api/files/:id", editor, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id=?").get(req.params.id);
  if (!f) return res.sendStatus(404);
  res.type(f.mime);
  res.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  );
  res.sendFile(path.resolve("data/uploads", f.path));
});
app.delete("/api/files/:id", editor, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id=?").get(req.params.id);
  const linked = f && postEvent(req, f.post_id);
  if (!linked || !canEditArchive(req, linked.event))
    return res.status(403).json({ error: "행사 종료 후 등록자 또는 관리자만 첨부파일을 수정할 수 있습니다." });
  if (f) {
    db.prepare("DELETE FROM files WHERE id=?").run(f.id);
    fs.rmSync(path.join("data/uploads", f.path), { force: true });
  }
  res.json({ ok: true });
});
app.delete("/api/posts/:id", editor, (req, res) => {
  const linked = postEvent(req, req.params.id);
  if (!linked || !canEditArchive(req, linked.event))
    return res.status(403).json({ error: "행사 종료 후 등록자 또는 관리자만 아카이브를 삭제할 수 있습니다." });
  const files = db
    .prepare("SELECT * FROM files WHERE post_id=?")
    .all(req.params.id);
  transaction(() => {
    db.prepare("DELETE FROM files WHERE post_id=?").run(req.params.id);
    db.prepare("DELETE FROM posts WHERE id=?").run(req.params.id);
  });
  for (const f of files)
    fs.rmSync(path.join("data/uploads", f.path), { force: true });
  res.json({ ok: true });
});
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).json({
    error:
      err.code === "LIMIT_FILE_SIZE"
        ? "파일은 500MB까지 가능합니다."
        : err.message || "요청 처리에 실패했습니다.",
  });
});
async function telegram(method, body) {
  const r = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    },
  );
  const j = await r.json();
  if (!j.ok) throw Error(j.description);
  return j.result;
}
export async function flushNotifications() {
  const receipts = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) return receipts;
  for (const n of db
    .prepare("SELECT * FROM notifications WHERE sent=0 AND channel='notice' ORDER BY id LIMIT 20")
    .all()) {
    const chat =
      process.env[
        n.channel === "notice"
          ? "TELEGRAM_NOTICE_CHAT_ID"
          : "TELEGRAM_WORK_CHAT_ID"
      ];
    if (!chat) continue;
    const result = await telegram("sendMessage", {
      chat_id: chat,
      text: n.html || n.message,
      ...(n.html ? { parse_mode: "HTML" } : {}),
    });
    db.prepare("UPDATE notifications SET sent=1 WHERE id=?").run(n.id);
    receipts.push({
      notificationId: n.id,
      channel: n.channel,
      chatId: result.chat.id,
      messageId: result.message_id,
    });
  }
  return receipts;
}
async function worker() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    await flushNotifications();
    const offset = Number(
      db.prepare("SELECT value FROM settings WHERE key='offset'").get()
        ?.value || 0,
    );
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 20,
      allowed_updates: ["message"],
    });
    for (const u of updates) {
      try {
        const message = u.message;
        const isMenu = message?.text?.match(/^\/(start|menu)(@\w+)?(?:\s|$)/);
        const modes = { "행사 등록": "create", "행사 수정": "edit", "행사 삭제": "delete" };
        const selectedMode = modes[message?.text?.trim()];
        if (message?.chat?.type === "private" && isMenu && process.env.PUBLIC_URL) {
          const key = `keyboard_ticket:${message.chat.id}`;
          let token = db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
          if (!token || !db.prepare("SELECT token FROM tickets WHERE token=? AND expires IS NULL").get(token)) {
            token = randomBytes(32).toString("hex");
            db.prepare("INSERT INTO tickets VALUES(?,NULL)").run(token);
            db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(key, token);
          }
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: "원하는 작업을 선택해주세요. 버튼을 누르면 화면이 바로 열립니다.",
            reply_markup: {
              keyboard: [
                [
                  { text: "행사 등록", web_app: { url: `${process.env.PUBLIC_URL}/?mode=create&ticket=${token}` } },
                  { text: "행사 수정", web_app: { url: `${process.env.PUBLIC_URL}/?mode=edit&ticket=${token}` } },
                ],
                [{ text: "행사 삭제", web_app: { url: `${process.env.PUBLIC_URL}/?mode=delete&ticket=${token}` } }],
              ],
              resize_keyboard: true,
              is_persistent: true,
            },
          });
        } else if (message?.chat?.type === "private" && selectedMode && process.env.PUBLIC_URL) {
          const token = randomBytes(32).toString("hex");
          db.prepare("INSERT INTO tickets VALUES(?,?)").run(token, Date.now() + 3600000);
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: `${message.text} 화면을 열어주세요. 링크는 1시간 동안 사용할 수 있습니다.`,
            reply_markup: {
              inline_keyboard: [[{
                text: `${message.text} 열기`,
                url: `${process.env.PUBLIC_URL}/?mode=${selectedMode}#${token}`,
              }]],
            },
          });
        } else if (isMenu && process.env.PUBLIC_URL) {
          const token = randomBytes(32).toString("hex");
          db.prepare("INSERT INTO tickets VALUES(?,?)").run(token, Date.now() + 3600000);
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: "행사 등록·수정·삭제를 선택해주세요. 링크는 1시간 동안 사용할 수 있습니다.",
            reply_markup: {
              inline_keyboard: [
                [{ text: "행사 등록", url: `${process.env.PUBLIC_URL}/?mode=create#${token}` }],
                [
                  { text: "행사 수정", url: `${process.env.PUBLIC_URL}/?mode=edit#${token}` },
                  { text: "행사 삭제", url: `${process.env.PUBLIC_URL}/?mode=delete#${token}` },
                ],
              ],
            },
          });
        }
      } catch (e) {
        console.error("텔레그램 메시지 처리:", e.message);
      } finally {
        db.prepare("INSERT OR REPLACE INTO settings VALUES('offset',?)").run(
          String(u.update_id + 1),
        );
      }
    }
  } catch (e) {
    console.error("텔레그램:", e.message);
  } finally {
    setTimeout(worker, 3000);
  }
}
if (process.env.NODE_ENV !== "test") {
  app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log(`시몬ONE: http://localhost:${process.env.PORT || 3000}`),
  );
  worker();
  setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    db.prepare("DELETE FROM tickets WHERE expires<?").run(Date.now());
  }, 3600000).unref();
}
export default app;
