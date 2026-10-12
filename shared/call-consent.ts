export const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
export const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

const FILLER = /^(?:(?:um+|uh+|er+|so|well|hmm+)[\s,.!?-]+)+/i;
const LIVE_HEDGES = /^(?:(?:um+|uh+|er+|so|well|hmm+|ok|okay|sure|fine)(?:[\s,.!?-]+|$))+/i;
const LIVE_YES = /^(?:yes|yeah|yep|yup|go ahead|do it|allow(?: it)?|approve(?: it)?|approved|please do)(?:[\s,]+(?:please|go ahead|do it))*[.!]*$/i;

export function spokenConsent(text: string, mode: "turns" | "live" = "turns"): "allow" | "deny" | null {
  const said = text.trim().replace(mode === "live" ? LIVE_HEDGES : FILLER, "");
  if ((mode === "live" ? LIVE_YES : YES).test(said)) return "allow";
  if (NO.test(said)) return "deny";
  return null;
}
