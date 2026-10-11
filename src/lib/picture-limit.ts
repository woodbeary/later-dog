import { PICTURES_PER_MESSAGE } from "../../shared/picture-limit";
import type { Attachment } from "./composer-attachments";

export { PICTURES_PER_MESSAGE };

export function admitPictures<T>(
  files: readonly T[],
  isPicture: (file: T) => boolean,
  attached: readonly Attachment[],
): { admitted: T[]; refused: number } {
  let left = PICTURES_PER_MESSAGE - attached.filter((attachment) => attachment.kind === "image").length;
  const admitted: T[] = [];
  let refused = 0;
  for (const file of files) {
    if (!isPicture(file)) admitted.push(file);
    else if (left > 0) {
      admitted.push(file);
      left -= 1;
    } else refused += 1;
  }
  return { admitted, refused };
}

export function joinNotices(...notices: (string | null | undefined)[]): string | null {
  const shown = notices.filter((notice): notice is string => Boolean(notice));
  return shown.length ? shown.join(" ") : null;
}
