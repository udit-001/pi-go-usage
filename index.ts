import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createOpenCodeGoProvider,
  deepseekPeakNotice,
} from "./opencode-go.ts";
import { UsageMeter } from "./meter.ts";
import {
  clampPercent,
  getUsageProviderRegistry,
  type UsageProvider,
  type UsageState,
} from "./usage-providers.ts";

// pi-go-usage — the /usage meter for pi, pluggable over providers.
//
// This package owns the meter surface (the /usage command and the footer
// status) and the OpenCode Go provider. Other packages plug their own
// providers in through the globalThis registry (see usage-providers.ts) —
// e.g. pi-zcode registers the ZCode start-plan token buckets. Each provider
// owns its own auth and API calls; this package only renders.

// ─── Command wiring ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const registry = getUsageProviderRegistry();
  // Built-in: OpenCode Go. Registered idempotently; packages that registered
  // earlier (or later) join via the same registry.
  registry.register(createOpenCodeGoProvider());

  let meterOpen = false;
  let closeMeter: (() => void) | null = null;

  const showMeter = async (args: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The usage meter requires TUI mode", "error");
      return;
    }

    if (args.trim().toLowerCase() === "close") {
      closeMeter?.();
      return;
    }

    // Tab order follows the session: the provider metering the current model
    // leads (and holds focus), the rest keep registration order.
    const all = registry.list();
    const matched = all.find((p) => p.matchesModel?.(ctx.model));
    const providers = matched ? [matched, ...all.filter((p) => p.id !== matched.id)] : all;
    if (providers.length === 0) {
      ctx.ui.notify("No usage providers are registered.", "warning");
      return;
    }

    if (meterOpen) {
      ctx.ui.notify("Usage meter is already open. Press q or Esc to close it.", "info");
      return;
    }

    let meter: UsageMeter | undefined;

    void ctx.ui
      .custom<void>((tui, theme, _keybindings, done) => {
        meterOpen = true;
        closeMeter = () => done(undefined);

        // Inline, in place of the editor — the same slot pi's built-in
        // selectors (like the model picker) render into.
        meter = new UsageMeter({
          theme,
          providers,
          onClose: () => done(undefined),
          requestRender: () => tui.requestRender(),
        });

        return {
          render(width: number) {
            return meter?.render(width) ?? [];
          },
          invalidate() {
            meter?.invalidate();
          },
          handleInput(data: string) {
            meter?.handleInput(data);
            tui.requestRender();
          },
        };
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to open the usage meter: ${message}`, "error");
      })
      .finally(() => {
        meter?.dispose();
        meterOpen = false;
        closeMeter = null;
      });
  };

  // ─── Ambient footer status (pi-powerline-footer extension_statuses) ────
  // While the selected model is metered by one of the registered providers,
  // that provider's tightest window shows in the status bar. Muted when calm
  // (still informative — the number moves), amber at 75%, red with the plain
  // state word at 90% or when rate-limited. Nothing shows on unmatched
  // models. Only the matched provider is polled.
  const STATUS_REFRESH_MS = 5 * 60_000;
  const STATUS_WARN_PCT = 75;
  const STATUS_ERROR_PCT = 90;
  let statusTimer: NodeJS.Timeout | null = null;
  let statusInFlight = false;
  let statusShown: string | undefined;
  let statusProvider: UsageProvider | undefined;

  type StatusTier = "ok" | "warn" | "error";

  const statusContent = (
    provider: UsageProvider,
    state: UsageState | undefined,
  ): { text: string; tier: StatusTier } | undefined => {
    if (!state || state.state !== "ready") {
      return undefined;
    }
    let tightest: { label: string; percent: number; limited: boolean } | undefined;
    for (const w of state.windows) {
      const percent = clampPercent(w.usedPercent ?? 0);
      const limited = w.statusLabel === "limited";
      if (!tightest || percent > tightest.percent || (limited && !tightest.limited)) {
        tightest = { label: w.label, percent, limited };
      }
    }
    if (!tightest) {
      return undefined;
    }
    const tag = provider.statusTag ?? provider.id;
    const short = provider.shortWindowLabel?.(tightest.label) ?? tightest.label;
    if (tightest.limited || tightest.percent >= STATUS_ERROR_PCT) {
      return { text: `${tag} ${short} limit`, tier: "error" };
    }
    const pct =
      tightest.percent % 1 === 0
        ? `${Math.round(tightest.percent)}%`
        : `${(Math.round(tightest.percent * 10) / 10).toFixed(1)}%`;
    return { text: `${tag} ${short} ${pct}`, tier: tightest.percent >= STATUS_WARN_PCT ? "warn" : "ok" };
  };

  const TIER_COLORS: Record<StatusTier, "muted" | "warning" | "error"> = {
    ok: "muted",
    warn: "warning",
    error: "error",
  };

  const pushStatus = (ui: ExtensionUIContext, content: { text: string; tier: StatusTier } | undefined) => {
    const text = content?.text;
    if (text === undefined || text === statusShown) {
      if (text === undefined) {
        statusShown = undefined;
        ui.setStatus("pi-go-usage", undefined);
      }
      return;
    }
    statusShown = text;
    const theme = ui.theme;
    const styled =
      typeof theme?.fg === "function" ? theme.fg(TIER_COLORS[content!.tier], text) : text;
    ui.setStatus("pi-go-usage", styled);
  };

  const refreshStatus = async (ui: ExtensionUIContext) => {
    const provider = statusProvider;
    if (!provider || statusInFlight) {
      return;
    }
    statusInFlight = true;
    try {
      pushStatus(ui, statusContent(provider, await provider.fetchUsage()));
    } catch {
      pushStatus(ui, undefined);
    } finally {
      statusInFlight = false;
    }
  };

  const stopStatusTimer = () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  };

  // The monitor exists only while the selected model is metered by a
  // registered provider — those are the models that drain its windows.
  const setStatusForModel = (model: { provider?: string } | undefined, ui: ExtensionUIContext) => {
    const matched = registry.list().find((p) => p.matchesModel?.(model));
    if (matched) {
      if (statusProvider?.id !== matched.id) {
        stopStatusTimer();
        statusShown = undefined;
      }
      statusProvider = matched;
      if (!statusTimer) {
        statusTimer = setInterval(() => {
          void refreshStatus(ui);
        }, STATUS_REFRESH_MS);
      }
      void refreshStatus(ui);
    } else {
      stopStatusTimer();
      statusProvider = undefined;
      pushStatus(ui, undefined);
    }
  };

  // ─── DeepSeek peak toast ────────────────────────────────────────────────
  // One notice per peak window per model: switching away and back within the
  // same window stays silent — a reminder, not a nag. The key carries the
  // window's end time, so the next window speaks again.
  let lastPeakNoticeKey: string | undefined;

  const notifyPeakOnce = (
    model: { provider?: string; id?: string } | undefined,
    ui: ExtensionUIContext,
  ) => {
    const notice = deepseekPeakNotice(model);
    if (!notice) {
      return;
    }
    const key = `${model?.id}:${notice.text}`;
    if (key === lastPeakNoticeKey) {
      return;
    }
    lastPeakNoticeKey = key;
    ui.notify(notice.text, notice.level);
  };

  pi.on("session_start", (event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      return;
    }
    setStatusForModel(ctx.model, ctx.ui);
    notifyPeakOnce(ctx.model, ctx.ui);
  });

  // Fires on /model, model cycling, and session restore with the new model.
  pi.on("model_select", (event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      return;
    }
    setStatusForModel(event.model, ctx.ui);
    notifyPeakOnce(event.model, ctx.ui);
  });

  pi.on("session_shutdown", (event, ctx: ExtensionContext) => {
    stopStatusTimer();
    statusProvider = undefined;
    statusShown = undefined;
    ctx.ui.setStatus("pi-go-usage", undefined);
  });

  pi.registerCommand("usage", {
    description:
      "Show usage meters for registered providers (OpenCode Go, ZCode, …) inline. /usage close to dismiss.",
    handler: showMeter,
  });
}
