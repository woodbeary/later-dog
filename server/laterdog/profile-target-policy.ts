import type { DirectApplyCheck } from "../direct-apply.ts";
import { canAccessTeam, canReachPeer } from "../peer-roster.ts";
import type { ProfileRequestServiceOptions, ProfileRequestStore } from "../profile-requests.ts";

export function profileTargetPolicy(
  store: Pick<ProfileRequestStore, "bot">,
  autoApply: DirectApplyCheck,
): Pick<ProfileRequestServiceOptions, "validateTarget" | "autoApply"> {
  return {
    validateTarget: (proposerBotId, targetBotId, fields) => {
      const proposer = store.bot(proposerBotId);
      const target = store.bot(targetBotId);
      if (!target) return "that bot no longer exists";
      if (!proposer || proposer.hidden || !canReachPeer(proposer, target)) {
        return "that bot is not a reachable teammate";
      }
      if ((fields.length !== 1 || fields[0] !== "name") &&
          (!proposer.chiefOfStaff || !canAccessTeam(proposer, target.section))) {
        return "only a section's Chief of Staff can change another bot's profile beyond its name";
      }
      return null;
    },
    autoApply: (botId, threadId, targetBotId) =>
      targetBotId !== botId && !store.bot(botId)?.chiefOfStaff ? null : autoApply(botId, threadId, targetBotId),
  };
}
