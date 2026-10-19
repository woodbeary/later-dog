import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";
import { installRecordingBanners } from "./recording-banners";

setAnalyticsEnabled(false);
if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
if (new URLSearchParams(location.search).has("desktopBanners")) installRecordingBanners();
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
