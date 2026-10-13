import { ChevronRight, ExternalLink } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { AnthropicEveryClaudeBot, ApiKeyRow, OpenAiCompatUrl, credentialCopy, type ConfigSection, type TestableProvider } from "./ApiKeys";
import { apiKeySection, hasSavedApiKey, isApiKeyEngine } from "./EngineSetup";
import { InstanceProviderMark } from "./ProviderIcons";

type KeySection = ConfigSection & TestableProvider;

const ORDER: readonly KeySection[] = ["openrouter", "xai", "openai", "anthropic", "mistral", "cerebras", "openaiCompat"];

export function keyProviders(instances: readonly InstanceInfo[]): InstanceInfo[] {
  const found = new Map<KeySection, InstanceInfo>();
  for (const instance of instances) {
    const section = isApiKeyEngine(instance) ? apiKeySection(instance) : null;
    if (section && !found.has(section)) found.set(section, instance);
  }
  return ORDER.flatMap((section) => found.get(section) ?? []);
}

export function keyStepTitle(instance: InstanceInfo | undefined): string {
  if (instance && apiKeySection(instance) === "openaiCompat") return t("accounts.sheet.customTitle");
  return t("accounts.sheet.keyTitle", { name: instance?.displayName ?? "" });
}

export function MoreProviders({ providers, onPick }: { providers: readonly InstanceInfo[]; onPick: (instance: InstanceInfo) => void }) {
  return (
    <ul data-more-providers className="-mx-1 flex flex-col">
      {providers.map((instance) => (
        <li key={instance.instanceId}>
          <button
            type="button"
            data-key-provider={instance.instanceId}
            onClick={() => onPick(instance)}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none"
          >
            <InstanceProviderMark instance={instance} size={16} />
            <span className="min-w-0 flex-1 truncate">{instance.displayName}</span>
            {hasSavedApiKey(instance) && <span className="shrink-0 text-[12px] text-ink-tertiary">{t("keys.connected")}</span>}
            <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ProviderKeyFields({ instance }: { instance: InstanceInfo }) {
  const section = apiKeySection(instance);
  if (!section) return null;
  const credential = credentialCopy(section);
  return (
    <div data-provider-key={section} className="flex flex-col gap-3">
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">
        {credential.description}{" "}
        <a
          href={credential.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {credential.linkLabel}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      </p>
      {section === "openaiCompat" && <OpenAiCompatUrl autoFocus />}
      <ApiKeyRow section={section} bare autoFocus={section !== "openaiCompat"} testProvider={section} />
      {section === "anthropic" && <AnthropicEveryClaudeBot />}
    </div>
  );
}
