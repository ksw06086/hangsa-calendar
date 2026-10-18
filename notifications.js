const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const singleLine = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export function formatEventDate(value) {
  return String(value).replace(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/,
    (_, year, month, day, time) =>
      `${year}.${month}.${day}${time ? " " + time : ""}`,
  );
}

export function formatProcessedTime(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}.${values.month}.${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function buildEventNotification(
  event,
  action,
  actor,
  processedAt = new Date(),
) {
  const icons = { 등록: "📅", 변경: "🔺", 삭제: "🗑️" };
  const heading = `${icons[action] || "📅"} [${singleLine(action)}] 행사 알림`;
  const department = singleLine(event.department_name);
  const title = singleLine(event.title);
  const range = `${formatEventDate(event.start)} ~ ${formatEventDate(event.end)}${event.all_day ? " (종일)" : ""}`;
  const actorName = actor === "admin" ? "행사기획부" : actor;
  const details = [`일시: ${range}`, `처리: ${actorName}`];
  const processed = `🕒 처리 시각: ${formatProcessedTime(processedAt)}`;
  return {
    text: `${heading}\n\n${department}\n${title}\n\n${details.join("\n")}\n\n${processed}`,
    html: `<b>${escapeHtml(heading)}</b>\n\n<blockquote><b>${escapeHtml(department)}</b>\n<b>${escapeHtml(title)}</b>\n\n${details
      .map((line) => {
        const colon = line.indexOf(":");
        return `<b>${escapeHtml(line.slice(0, colon))}:</b>${escapeHtml(line.slice(colon + 1))}`;
      })
      .join("\n")}</blockquote>\n\n${escapeHtml(processed)}`,
  };
}
