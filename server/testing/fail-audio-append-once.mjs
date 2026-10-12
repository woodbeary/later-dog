import { Store } from "../store.ts";

if (process.env.LATERDOG_TEST_FAIL_AUDIO_APPEND_ONCE === "1") {
  const original = Store.prototype.appendMessage;
  let armed = true;
  Store.prototype.appendMessage = function (...args) {
    const message = args[1];
    if (armed && (message?.attachments ?? []).some((attachment) => attachment?.kind === "audio")) {
      armed = false;
      throw new Error("test fault: the first audio append fails once");
    }
    return original.apply(this, args);
  };
}
