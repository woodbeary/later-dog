export function claudeApiErrorFrame(frame: { error?: unknown; is_api_error_message?: unknown }): boolean {
  return frame.is_api_error_message === true || typeof frame.error === "string";
}
