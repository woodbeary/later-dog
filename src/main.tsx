import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  BROWSER_SIGN_IN_FAILED, previewBrowserSignIn, readSessionState, SERVICE_TRUST_REASON, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applyTheme, readTheme } from "./lib/theme";
import { applyFont, readFont } from "./lib/fonts";
import { installPressFeedback } from "./lib/press";
import { forgetFirstPaint, pageOrigin, readFirstPaint } from "./lib/first-paint";
import { paintedBeforeSession, signInReason } from "./lib/first-paint-gate";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import "katex/dist/katex.min.css";
import "./styles.css";

applyTheme(readTheme());
applyFont(readFont());
installPressFeedback();

const root = createRoot(document.getElementById("root")!);
const paint = (node: React.ReactNode) => root.render(<StrictMode>{node}</StrictMode>);
const signInPage = (reason: string) => <PairPage initialCode={null} reason={reason} />;

async function pairRoot(): Promise<React.ReactNode> {
  const signIn = takeBrowserSignInFromLocation();
  if (signIn) {
    const preview = await previewBrowserSignIn(signIn);
    return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} /> : signInPage(BROWSER_SIGN_IN_FAILED);
  }
  return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
}

async function start(brand: Promise<unknown>): Promise<void> {
  if (location.pathname === "/pair") {
    forgetFirstPaint();
    const [, node] = await Promise.all([brand, pairRoot()]);
    paint(node);
    return;
  }
  const session = readSessionState();
  const viewer = location.pathname === "/desktop-viewer";
  const painted = await paintedBeforeSession({
    hasSnapshot: !viewer && readFirstPaint(pageOrigin()) !== null,
    ready: brand,
    session,
    paint,
    app: () => <App />,
    signIn: signInPage,
    forget: forgetFirstPaint,
    serviceReason: SERVICE_TRUST_REASON,
  });
  if (painted) return;
  const [, answered] = await Promise.all([brand, session]);
  const needed = signInReason(answered, SERVICE_TRUST_REASON);
  if (needed) {
    forgetFirstPaint();
    paint(signInPage(needed.reason));
    return;
  }
  if (viewer) {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    paint(<DesktopViewer />);
    return;
  }
  paint(<App />);
}

void start(bootstrapBrand());
