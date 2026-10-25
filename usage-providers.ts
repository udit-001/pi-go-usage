// The pluggable seam: how other pi packages contribute usage providers.
//
// pi-go-usage owns the /usage meter; each provider owns its own auth and API
// calls (pi-zcode owns ZCode's, this package owns OpenCode Go's). Providers
// meet through a globalThis registry because pi loads every package's
// extensions into one process — no npm dependency in either direction, and
// load order doesn't matter (whoever loads first creates the registry; the
// other side registers into it, and pi-go-usage reads whatever is there when
// the meter opens).

export interface UsageWindow {
  label: string;
  /** Percent of the window's cap already spent (0–100). */
  usedPercent?: number;
  /** Right-hand text for the window row — dollars left, tokens left, "limited". */
  statusLabel?: string;
  resetAt?: Date;
}

export type UsageState =
  | { state: "ready"; windows: UsageWindow[]; note?: string; source?: string; updatedAt: Date }
  /** No credential on this machine — a setup gap, not a failure. Renders calm. */
  | { state: "unconfigured"; message: string; setupHint?: string }
  /** Credential present but rejected or lapsed — actionable, not alarming. */
  | { state: "expired"; message: string; reauthHint?: string }
  | { state: "error"; message: string; authHint?: string };

export interface UsageProvider {
  /** Unique, stable — e.g. "opencode-go", "zcode". */
  id: string;
  /** Section header in the /usage meter, e.g. "OpenCode Go". */
  label: string;
  /** Auth + API call, owned entirely by the provider's package. */
  fetchUsage: () => Promise<UsageState>;
  /** Optional: does this provider meter the given model? Drives the footer status. */
  matchesModel?: (model: { provider?: string; id?: string } | undefined) => boolean;
  /** Optional short footer-status tag, e.g. "GO", "ZC". */
  statusTag?: string;
  /** Optional: shorten a window label for the footer, e.g. "Weekly" → "wk". */
  shortWindowLabel?: (label: string) => string;
  /** Optional: one-line hint shown when every window of this provider is limited. */
  limitedHint?: string;
}

export interface UsageProviderRegistry {
  version: 1;
  register(provider: UsageProvider): void;
  list(): UsageProvider[];
}

const REGISTRY_KEY = "__piUsageProviders";

/** Clamp a used-percent into 0–100. Domain-level because windows carry it raw. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function getUsageProviderRegistry(): UsageProviderRegistry {
  const host = globalThis as typeof globalThis & { [REGISTRY_KEY]?: UsageProviderRegistry };
  if (!host[REGISTRY_KEY]) {
    const providers = new Map<string, UsageProvider>();
    host[REGISTRY_KEY] = {
      version: 1,
      register(provider: UsageProvider): void {
        providers.set(provider.id, provider);
      },
      list(): UsageProvider[] {
        return [...providers.values()];
      },
    };
  }
  return host[REGISTRY_KEY];
}
