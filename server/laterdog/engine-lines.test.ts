import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { consumeEngineLines } from "./engine-lines.ts";
it("lets other requests run between expensive frames, applies backpressure and drains before close", async () => {
  const input = new PassThrough(),
    order: string[] = [];
  const done = consumeEngineLines(
    input,
    (line) => {
      order.push(line);
      if (line === "one") {
        setImmediate(() => order.push("other"));
        const end = performance.now() + 12;
        while (performance.now() < end) {}
      }
    },
    true,
    true,
  );
  input.write(Buffer.from("one\ntwo\n"));
  input.end(Buffer.from("three"));
  await new Promise<void>((resolve) =>
    done(() => {
      order.push("exit");
      resolve();
    }),
  );
  expect(order).toEqual(["one", "other", "two", "three", "exit"]);
});
