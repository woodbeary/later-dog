import { ObservationCoordinator } from "../server/computer-observation.ts";

const frames = ["initial", "initial", "after-click", "after-click", "after-submit", "after-submit", "after-submit"];
const baselineSent = frames.length;
const coordinator = new ObservationCoordinator();
for (const [index, frame] of frames.entries()) {
  if (index === 1 || index === 2 || index === 4) coordinator.noteAction();
  coordinator.observeFrame(frame, null);
}
const metrics = coordinator.metrics;
const reduction = ((1 - metrics.screenshotsSentToModel / baselineSent) * 100).toFixed(1);
const suppressed = metrics.screenshotsCaptured - metrics.screenshotsSentToModel;
if (suppressed < 1 || metrics.screenshotsCaptured !== frames.length) {
  throw new Error("fixture failed to capture every observation or suppress a duplicate");
}
console.log("Computer observation benchmark (offline deterministic fixture)");
console.log(`Screenshot observations sent to model: ${baselineSent} → ${metrics.screenshotsSentToModel} (${reduction}% reduction)`);
console.log(`Actions: ${metrics.computerActions}; screenshots captured: ${metrics.screenshotsCaptured}; duplicate captures suppressed: ${suppressed}`);
