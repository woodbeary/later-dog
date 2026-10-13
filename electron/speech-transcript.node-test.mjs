import assert from "node:assert/strict";
import { test } from "node:test";
import { speechTranscript } from "./speech-transcript.mjs";

const run = (lines) => {
  const transcript = speechTranscript();
  return lines.map(([partial, text]) => transcript({ partial, text }).text);
};

const growing = (sentence) => sentence.split(" ").map((_, index, words) => [true, words.slice(0, index + 1).join(" ")]);

test("keeps every sentence when macOS restarts the transcript after a pause and ends with an empty final", () => {
  const heard = run([
    ...growing("Hey can you check the logs"),
    [true, "Hey can you check the logs"],
    ...growing("And then fix it"),
    [true, "And then fix it"],
    ...growing("Thanks"),
    [true, "Thanks"],
    [false, ""],
  ]);
  assert.equal(heard.at(-1), "Hey can you check the logs And then fix it Thanks");
  assert.equal(heard[7], "Hey can you check the logs And");
});

test("starts a new sentence when the transcript collapses even without a repeat", () => {
  const heard = run([[true, "Book the table for six people"], [true, "At"], [true, "At eight"], [false, "At eight tonight"]]);
  assert.equal(heard.at(-1), "Book the table for six people At eight tonight");
});

test("treats corrections and a cumulative final as the same sentence", () => {
  assert.equal(run([[true, "I want to by"], [true, "I want to buy a"], [true, "I want to buy a car"], [false, "I want to buy a car."]]).at(-1), "I want to buy a car.");
  assert.equal(run([[true, "Send the"], [true, "Send the"], [true, "Send the file"], [false, "Send the file now"]]).at(-1), "Send the file now");
  assert.equal(run([[true, "Hello there friend of mine"], [true, "Hello their friend of mi"], [false, "Hello there friend of mine"]]).at(-1), "Hello there friend of mine");
});

test("passes errors and lines without text through untouched", () => {
  const transcript = speechTranscript();
  assert.deepEqual(transcript({ error: "dictation-disabled" }), { error: "dictation-disabled" });
  assert.equal(transcript(null), null);
  assert.deepEqual(transcript({ partial: false, text: "" }), { partial: false, text: "" });
});
