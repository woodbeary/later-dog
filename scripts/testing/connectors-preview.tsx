import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../../src/components/PluginsPanel";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
// The synthetic provider's sign-in page is not a real site: popups stay
// blocked, and verify-connectors.ts stands in for the person's consent.
window.open = () => null;
createRoot(document.getElementById("root")!).render(<StoreProvider><PluginsPanel /></StoreProvider>);
