// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { composeMessage, type Attachment } from "./composer-attachments";
import { citationAttachment } from "./citations";
import { appendComposerDraft, appendDraftAttachments, draftAttachments, getDraft } from "./drafts";
import { editableGallery, editableMessage, restoreEditableMessage, uploadedImageMime } from "./composer-message-edit";

const cloudPicture = "/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png";
const macPicture = "/Users/jacob/.laterdog/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const thirdPicture = "/data/.laterdog/attachments/16fd2706-8baf-433b-82eb-8c7fada847da.webp";
const screenshot = "Screenshot 2026-10-15 at 1.53.02 PM.png";
const image = (path: string, name: string): Attachment => ({ kind: "image", id: name, path, name, size: 10, mime: "image/png" });
const file = (path: string, name: string): Attachment => ({ kind: "file", id: name, path, name, size: 10 });
let sequence = 0;
const freshDraft = () => `bot:edit-test:${++sequence}`;
const storeOf = () => globalThis.localStorage;

describe("a sent or queued message opened for editing", () => {
  it("turns Jacob's Cloud home screenshot into a picture, not a raw tag", () => {
    const sent = `look at this\n\n<attached-image path="${cloudPicture}" name="${screenshot}" />`;
    const editable = editableMessage(sent);
    expect(editable.text).toBe("look at this");
    expect(editable.attachments).toEqual([
      expect.objectContaining({ kind: "image", path: cloudPicture, name: screenshot, mime: "image/png" }),
    ]);
  });

  it("reads pictures from the Mac's attachment folder the same way", () => {
    const editable = editableMessage(composeMessage("from the Mac", [image(macPicture, "photo.jpg")]));
    expect(editable.text).toBe("from the Mac");
    expect(editable.attachments).toEqual([
      expect.objectContaining({ kind: "image", path: macPicture, name: "photo.jpg", mime: "image/jpeg" }),
    ]);
  });

  it("keeps several pictures and files, each once, and sends the same message again", () => {
    const attachments = [
      image(cloudPicture, "a & b \"one\".png"),
      image(macPicture, "two.jpg"),
      image(thirdPicture, "three.webp"),
      file("/Users/jacob/Documents/plan.pdf", "plan.pdf"),
    ];
    const sent = composeMessage("three pictures and a plan", attachments);
    const editable = editableMessage(sent);
    expect(editable.text).toBe("three pictures and a plan");
    expect(editable.attachments.map((attachment) => "path" in attachment ? attachment.path : "")).toEqual([
      cloudPicture, macPicture, thirdPicture, "/Users/jacob/Documents/plan.pdf",
    ]);
    expect(editable.attachments.map((attachment) => attachment.kind === "image" && attachment.mime)).toEqual([
      "image/png", "image/jpeg", "image/webp", false,
    ]);
    expect(editable.attachments[0]).toMatchObject({ name: "a & b \"one\".png" });
    expect(composeMessage(editable.text, editable.attachments)).toBe(sent);
  });

  it("keeps pictures sent without any words", () => {
    const sent = composeMessage("", [image(cloudPicture, "a.png"), image(macPicture, "b.jpg")]);
    const editable = editableMessage(sent);
    expect(editable.text).toBe("");
    expect(editable.attachments).toHaveLength(2);
    expect(composeMessage(editable.text, editable.attachments)).toBe(sent);
  });

  it("leaves words that only mention the tag alone", () => {
    const inline = `the composer writes <attached-image path="${cloudPicture}" /> for pictures`;
    const fenced = ["like this:", "", "```", `<attached-image path="${cloudPicture}" name="x.png" />`, "```"].join("\n");
    const notUploaded = `my desktop copy:\n\n<attached-image path="/Users/jacob/Desktop/cat.png" name="cat.png" />`;
    const notPicture = `<attached-image path="/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.pdf" />`;
    for (const sent of [inline, fenced, notUploaded, notPicture]) {
      expect(editableMessage(sent)).toEqual({ text: sent, attachments: [] });
    }
  });

  it("leaves a mention in place beside a real picture", () => {
    const sent = [
      "why does this line show?",
      "",
      `<attached-image path="/tmp/not-mine.png" name="nope.png" />`,
      "",
      `<attached-image path="${cloudPicture}" name="real.png" />`,
    ].join("\n");
    const editable = editableMessage(sent);
    expect(editable.text).toBe(`why does this line show?\n\n<attached-image path="/tmp/not-mine.png" name="nope.png" />`);
    expect(editable.attachments).toEqual([expect.objectContaining({ kind: "image", path: cloudPicture, name: "real.png" })]);
  });

  it("still gives quoted messages back as citations", () => {
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: "biscuit", threadId: "t1", messageId: "m1" },
      { text: "the quoted line", start: 0, end: 15, prefix: "", suffix: "" },
    );
    const editable = editableMessage(composeMessage("about this", [citation, image(cloudPicture, "a.png")]));
    expect(editable.text).toBe("about this");
    expect(editable.attachments.map((attachment) => attachment.kind)).toEqual(["citation", "image"]);
    expect(editable.attachments[0]).toEqual(citation);
  });

  it("only treats uploaded picture names as pictures", () => {
    expect(uploadedImageMime(cloudPicture)).toBe("image/png");
    expect(uploadedImageMime("C:\\Users\\jacob\\.laterdog\\attachments\\16fd2706-8baf-433b-82eb-8c7fada847da.gif")).toBe("image/gif");
    expect(uploadedImageMime("/Users/jacob/Desktop/cat.png")).toBeNull();
    expect(uploadedImageMime("/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.mp3")).toBeNull();
  });

  it("shows the kept pictures and files as a gallery while editing", () => {
    const editable = editableMessage(composeMessage("hi", [image(cloudPicture, "a.png"), file("/Users/jacob/plan.pdf", "plan.pdf")]));
    expect(editableGallery(editable.attachments)).toEqual({
      images: [{ path: cloudPicture, name: "a.png", private: true }],
      files: [{ path: "/Users/jacob/plan.pdf", name: "plan.pdf" }],
    });
  });
});

describe("restoring an edited message into the composer", () => {
  it("puts the words before the current draft and the pictures after its attachments", () => {
    const draftId = freshDraft();
    appendComposerDraft(draftId, "and my next thought");
    appendDraftAttachments(draftId, [file("/tmp/notes.pdf", "notes.pdf")]);
    restoreEditableMessage(draftId, editableMessage(composeMessage("look at this", [image(cloudPicture, "a.png")])));
    expect(getDraft(storeOf(), draftId)).toBe("look at this\n\nand my next thought");
    expect(draftAttachments(draftId)).toEqual([
      expect.objectContaining({ kind: "file", path: "/tmp/notes.pdf" }),
      expect.objectContaining({ kind: "image", path: cloudPicture, name: "a.png" }),
    ]);
  });

  it("never adds a picture the draft already has", () => {
    const draftId = freshDraft();
    const editable = editableMessage(composeMessage("twice", [image(cloudPicture, "a.png"), image(macPicture, "b.jpg")]));
    appendDraftAttachments(draftId, [image(cloudPicture, "a.png")]);
    restoreEditableMessage(draftId, editable);
    restoreEditableMessage(draftId, editable);
    const paths = draftAttachments(draftId).map((attachment) => attachment.kind === "image" ? attachment.path : "");
    expect(paths).toEqual([cloudPicture, macPicture]);
  });

  it("keeps restored pictures in the saved draft", () => {
    const draftId = freshDraft();
    restoreEditableMessage(draftId, editableMessage(composeMessage("saved", [image(cloudPicture, "a.png")])));
    const saved = JSON.parse(storeOf().getItem("laterdog-draft-attachments") ?? "{}") as Record<string, Attachment[]>;
    expect(saved[draftId]).toEqual([expect.objectContaining({ kind: "image", path: cloudPicture, size: 0, mime: "image/png" })]);
  });
});
