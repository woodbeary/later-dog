const token = process.env.LATERDOG_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.LATERDOG_TEST_DESKTOP_OWNER_TOKEN;
if (token) {
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event === "message") queueMicrotask(() => listener({ data: { type: "laterdog:desktop-mutation-token", token } }));
      },
      postMessage() {},
    },
  });
}
