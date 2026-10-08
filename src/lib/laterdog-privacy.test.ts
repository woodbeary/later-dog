import { expect, it, vi } from 'vitest';
import { EMPTY_ONBOARDING, welcomeDue } from './onboarding';
const analyticsLoad = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => { analyticsLoad(); return { default: {} }; });
it('does not initialize upstream analytics in an unconfigured public build, and still opens first run on a fresh install',async()=>{
 vi.stubEnv('VITE_LATERDOG_ANALYTICS_TOKEN','');vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});
 try {vi.resetModules();const module=await import('./analytics');expect(module.analyticsConfigured()).toBe(false);expect(module.analyticsEnabled()).toBe(false);// a fresh install has stored nothing, so it is not taken for one that finished the old first-run gate
 expect(module.emailGateDone()).toBe(false);expect(welcomeDue({ onboarding: EMPTY_ONBOARDING },{ remoteClient:false,legacyDone:module.emailGateDone() })).toBe(true);
 module.setAnalyticsEnabled(true);expect(module.analyticsEnabled()).toBe(false);await module.initAnalytics();expect(analyticsLoad).not.toHaveBeenCalled();}
 finally {vi.unstubAllEnvs();vi.unstubAllGlobals();}
});
