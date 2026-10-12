const INTEGRITY = "The update failed verification. Download a fresh installer from the official release page.";
const DISK = "Not enough disk space to prepare the update. Free some space, then try again.";
const PERMISSION = "The update could not write to the app or its cache. Check folder permissions, or use the official installer.";
const BUSY = "An update file is in use. Close other copies of later.dog, then try again.";
const NEEDS_PERSON = new Set([INTEGRITY, DISK, PERMISSION, BUSY]);

export function updateErrorNeedsPerson(error) {
  return NEEDS_PERSON.has(updateErrorMessage(error));
}

export function updateNotPublished(error) {
  return error?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
}

export function updateErrorMessage(error) {
  const message = String(error?.message ?? error ?? "Update failed");
  const detail = `${error?.code ?? ""} ${message}`;
  const integrity = /ERR_UPDATER_(?:INVALID_SIGNATURE|CHECKSUM_MISMATCH)/i.test(detail);
  const tls = /CERT_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SSL_ERROR|SELF_SIGNED_CERT_IN_CHAIN/i.test(detail);
  if (!integrity && tls) {
    return "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.";
  }
  if (integrity || /checksum|signature|codesign/i.test(detail)) {
    return INTEGRITY;
  }
  if (/\bENOSPC\b|no space left|disk (?:is )?full/i.test(detail)) {
    return DISK;
  }
  if (/\b(?:EACCES|EPERM)\b|read.only (?:volume|file system)|permission denied|access is denied/i.test(detail)) {
    return PERMISSION;
  }
  if (/\bEBUSY\b|being used by another process/i.test(detail)) {
    return BUSY;
  }
  if (/certificate/i.test(detail)) {
    return "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.";
  }
  if (/\b404\b|cannot find .*\.yml|cannot parse update info|no files provided|ERR_UPDATER_INVALID_RELEASE_FEED/i.test(detail)) {
    return "The update files are missing or invalid. Check the official release page, or try again later.";
  }
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|net::ERR_|\bHTTP[^\n]*\b5\d\d\b|status(?: code)?[: ]+5\d\d\b/i.test(detail)) {
    return "The update download was interrupted or the server is unavailable. Check your connection and try again.";
  }
  return message;
}
