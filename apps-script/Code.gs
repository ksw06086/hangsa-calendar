const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

function doPost(e) {
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const expected = PropertiesService.getScriptProperties().getProperty("DRIVE_UPLOAD_SECRET");
    if (!expected || request.secret !== expected) return output({ error: "Drive upload authorization failed." });
    if (request.action === "startUpload") return startUpload(request);
    if (request.action === "deleteFile") return deleteFile(request);
    if (request.action === "quota") return getQuota();
    return output({ error: "Unknown Drive action." });
  } catch (error) {
    return output({ error: error && error.message ? error.message : "Drive operation failed." });
  }
}

function startUpload(request) {
  const size = Number(request.size);
  if (!request.name || !request.mime || !request.folderId || !Number.isInteger(size) || size <= 0 || size > 500 * 1024 * 1024) {
    return output({ error: "Upload details are incomplete or invalid." });
  }
  const response = UrlFetchApp.fetch(DRIVE_UPLOAD_API + "?uploadType=resumable&fields=id", {
    method: "post",
    contentType: "application/json; charset=UTF-8",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken(),
      "X-Upload-Content-Type": request.mime,
      "X-Upload-Content-Length": String(size),
    },
    payload: JSON.stringify({ name: request.name, mimeType: request.mime, parents: [request.folderId] }),
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const headers = response.getAllHeaders();
  const uploadUrl = headers.Location || headers.location;
  if (status < 200 || status >= 300 || !uploadUrl) {
    return output({ error: driveError(response, "Could not start the Drive upload.") });
  }
  return output({ uploadUrl: String(uploadUrl) });
}

function deleteFile(request) {
  if (!request.fileId) return output({ error: "File ID is required." });
  const response = UrlFetchApp.fetch(DRIVE_API + "/files/" + encodeURIComponent(request.fileId) + "?supportsAllDrives=true", {
    method: "delete",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) return output({ error: driveError(response, "Could not delete the Drive file.") });
  return output({ ok: true });
}

function getQuota() {
  const response = UrlFetchApp.fetch(DRIVE_API + "/about?fields=storageQuota", {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) return output({ error: driveError(response, "Could not read Drive storage quota.") });
  const quota = JSON.parse(response.getContentText()).storageQuota || {};
  const limit = Number(quota.limit), used = Number(quota.usage);
  return output({ free: Number.isFinite(limit) && Number.isFinite(used) && limit > 0 ? Math.max(0, limit - used) : null });
}

function driveError(response, fallback) {
  try {
    const body = JSON.parse(response.getContentText());
    return body.error && body.error.message ? body.error.message : fallback;
  } catch (_) {
    return fallback + " (HTTP " + response.getResponseCode() + ")";
  }
}

function output(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
