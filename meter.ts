// The /usage meter, generalized over providers, with questionnaire-style tab
// navigation: one tab per provider, Tab/←→ to switch, active tab highlighted.
// Each tab shows that provider's windows (label, bar, percent, status line),
// its own provenance and hint lines. Renders in the same slot pi's built-in
// selectors use — in place of the editor, full width, thin theme borders.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clampPercent, type UsageProvider, type UsageState, type UsageWindow } from "./usage-providers.ts";

type ThemeColorName = Parameters<Theme["fg"]>[0];

export interface ProgressBarOptions {
  /** Bar width in cells. The meter caps this inside its focus band. */
  width: number;
  /** Used percent, 0–100. Values outside the range are clamped. */
  usedPercent: number;
  /** Color of the used portion. Default: accent. */
  filledColor?: ThemeColorName;
  /** Color of the untouched remainder. Default: dim. */
  emptyColor?: ThemeColorName;
}

/**
 * Render a usage bar: `usedPercent`/100 of `width` cells filled, the rest
 * empty, both as single colored runs. Returns ANSI-styled text for one line.
 */
export function renderProgressBar(theme: Theme, options: ProgressBarOptions): string {
  const cells = Math.max(1, Math.floor(options.width));
  const percent = clampPercent(options.usedPercent);
  const filledCells = Math.round((percent / 100) * cells);
  const restCells = cells - filledCells;

  const fill = "█".repeat(filledCells);
  const rest = "░".repeat(restCells);

  // Skip empty runs — an ANSI span with nothing inside is invisible noise.
  const filledRun = filledCells > 0 ? theme.fg(options.filledColor ?? "accent", fill) : "";
  const emptyRun = restCells > 0 ? theme.fg(options.emptyColor ?? "dim", rest) : "";
  return filledRun + emptyRun;
}

function formatUsedPercent(value: number): string {
  // Keep one decimal below 10% — sub-1% spend is real (0.4% of a window) and
  // must not round to "0% used". Above 10%, integer precision is enough.
  if (value < 10 && value % 1 !== 0) {
    return `${value.toFixed(1)}% used`;
  }
  return `${Math.round(value)}% used`;
}

function formatAbsoluteResetTime(resetAt: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(resetAt);
}

interface ProviderEntry {
  provider: UsageProvider;
  state?: UsageState;
  refreshError?: string;
}

export interface UsageMeterOptions {
  theme: Theme;
  providers: UsageProvider[];
  onClose: () => void;
  requestRender: () => void;
}

export class UsageMeter {
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;
  private readonly entries: ProviderEntry[];
  private activeIndex = 0;
  private reloading = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: UsageMeterOptions) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRender = options.requestRender;
    this.entries = options.providers.map((provider) => ({ provider }));
    void this.reload();
  }

  dispose(): void {
    this.invalidate();
  }

  async reload(): Promise<void> {
    if (this.reloading) {
      this.requestRender();
      return;
    }
    this.reloading = true;
    this.invalidate();
    this.requestRender();

    await Promise.all(
      this.entries.map(async (entry) => {
        try {
          const next = await entry.provider.fetchUsage();
          entry.state = next;
          entry.refreshError = undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A failed refresh keeps the last-known-good windows — stale truth
          // beats no truth.
          if (entry.state?.state === "ready") {
            entry.refreshError = message;
          } else {
            entry.state = { state: "error", message };
          }
        }
      }),
    );

    this.reloading = false;
    this.invalidate();
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.reload();
      return;
    }
    // Tab navigation, questionnaire-style.
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.activeIndex = (this.activeIndex + 1) % this.entries.length;
      this.invalidate();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.activeIndex = (this.activeIndex - 1 + this.entries.length) % this.entries.length;
      this.invalidate();
      this.requestRender();
      return;
    }
  }

  /** Tab health glyph: what the tab bar knows without switching to a tab. */
  private tabGlyph(entry: ProviderEntry): { glyph: string; color: "success" | "warning" | "dim" } {
    const state = entry.state;
    if (entry.refreshError) return { glyph: "!", color: "warning" };
    if (!state) return { glyph: "…", color: "dim" };
    if (state.state === "error") return { glyph: "✕", color: "warning" };
    return { glyph: "✓", color: "success" };
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const theme = this.theme;
    const lines: string[] = [];
    // Nothing in the meter spans the terminal. The windows live in a bounded
    // focus band; the eye scans within it vertically (label column, bar column,
    // % column all line up) instead of sweeping the full width.
    const METER_WIDTH = 72;
    const LABEL_COL = 9; // floor; the column widens to the provider's longest label (capped 32)
    let labelCol = LABEL_COL;
    const BAR_WIDTH = 30;
    const panelWidth = Math.max(10, Math.min(width, METER_WIDTH));
    const contentWidth = Math.max(10, panelWidth - 2);
    const pad = " ";

    const addBorder = () => {
      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
    };
    const addLine = (value = "") => {
      lines.push(`${pad}${truncateToWidth(value, contentWidth, "")}`);
    };
    const addBlank = () => lines.push(pad);
    const addWrapped = (value: string, indent = "") => {
      const availableWidth = Math.max(1, contentWidth - indent.length);
      for (const wrapped of wrapTextWithAnsi(value, availableWidth)) {
        addLine(`${indent}${wrapped}`);
      }
    };
    const addWindowRow = (usageWindow: UsageWindow, usedPercent: number, money?: string, moneyIsError = false) => {
      const barWidth = Math.max(12, Math.min(BAR_WIDTH, contentWidth - labelCol - 12));
      const labelText = truncateToWidth(usageWindow.label, labelCol, "…").padEnd(labelCol);
      const pctText = formatUsedPercent(usedPercent).padStart(9);
      const bar = renderProgressBar(theme, {
        width: barWidth,
        usedPercent,
        filledColor: usedPercent >= 90 ? "error" : usedPercent >= 75 ? "warning" : "accent",
        emptyColor: "dim",
      });
      addLine(`${theme.fg("text", theme.bold(labelText))} ${bar}  ${theme.fg("muted", pctText)}`);

      const moneyText = moneyIsError ? "limited" : money;
      if (moneyText) {
        const parts = [theme.fg(moneyIsError ? "error" : "accent", moneyText)];
        if (usageWindow.resetAt instanceof Date) {
          parts.push(theme.fg("dim", `resets ${formatAbsoluteResetTime(usageWindow.resetAt)}`));
        }
        addLine(`${" ".repeat(labelCol + 1)}${parts.join(" · ")}`);
      } else if (usageWindow.resetAt instanceof Date) {
        addLine(`${" ".repeat(labelCol + 1)}${theme.fg("dim", `resets ${formatAbsoluteResetTime(usageWindow.resetAt)}`)}`);
      }
    };

    // Tab bar — questionnaire pattern: ← [■ Tab] [□ Tab] →, active highlighted.
    const addTabBar = () => {
      if (this.entries.length <= 1) return;
      const tabs: string[] = ["← "];
      this.entries.forEach((entry, i) => {
        const isActive = i === this.activeIndex;
        const { glyph, color } = this.tabGlyph(entry);
        const text = ` ${glyph} ${truncateToWidth(entry.provider.label, 18, "…")} `;
        const styled = isActive
          ? theme.bg("selectedBg", theme.fg("text", text))
          : theme.fg(color === "warning" ? "warning" : "muted", text);
        tabs.push(`${styled} `);
      });
      tabs.push("→");
      addLine(tabs.join(""));
      addBlank();
    };

    const renderSection = (entry: ProviderEntry, state: UsageState | undefined) => {
      // One provider: a plain label header (no tab machinery to learn).
      // Several: the questionnaire-style tab bar carries the labels.
      if (this.entries.length <= 1) {
        addLine(theme.fg("accent", theme.bold(truncateToWidth(entry.provider.label, contentWidth))));
        addBlank();
      } else {
        addTabBar();
      }

      if (!state) {
        addWrapped(theme.fg("warning", "Fetching usage…"));
        addBlank();
        return;
      }

      if (state.state === "error") {
        addWrapped(theme.fg("error", state.message));
        if (state.authHint) {
          addWrapped(theme.fg("dim", state.authHint));
        }
        addBlank();
        return;
      }

      // Size the label column to this provider's longest window label so
      // plan-attributed labels like "1024 Dev Day · GLM-5.3" stay readable
      // instead of truncating to "1024 Dev…".
      const longestLabel = Math.max(0, ...state.windows.map((w) => [...w.label].length));
      labelCol = Math.max(LABEL_COL, Math.min(32, longestLabel));

      for (const usageWindow of state.windows) {
        const usedPercent = clampPercent(usageWindow.usedPercent ?? 0);
        const limited = usageWindow.statusLabel === "limited";
        addWindowRow(usageWindow, usedPercent, usageWindow.statusLabel, limited);
        addBlank();
      }

      if (state.windows.some((w) => w.statusLabel === "limited") && entry.provider.limitedHint) {
        addLine(theme.fg("dim", entry.provider.limitedHint));
      }
      if (entry.refreshError) {
        const when = state.updatedAt instanceof Date ? `from ${state.updatedAt.toLocaleTimeString()}` : "from earlier";
        const why = entry.refreshError.length > 48 ? `${entry.refreshError.slice(0, 48)}…` : entry.refreshError;
        addLine(theme.fg("warning", `refresh failed (${why}) — showing data ${when}`));
      }
      const provenance = [
        state.source,
        state.updatedAt instanceof Date ? `updated ${state.updatedAt.toLocaleTimeString()}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      if (provenance) {
        addLine(theme.fg("dim", provenance));
      }
      if (state.note) {
        addLine(theme.fg("dim", state.note));
      }
    };

    addBorder();
    const entry = this.entries[this.activeIndex];
    if (entry) {
      renderSection(entry, entry.state);
    }
    const help = this.entries.length > 1 ? "Tab/←→ switch · r refresh · q / Esc close" : "r refresh · q / Esc close";
    addLine(theme.fg("dim", help));
    addBorder();

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
