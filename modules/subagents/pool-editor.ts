import { type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { ChoicePicker, type ChoiceOption } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
  MODEL_TIERS,
  readSubagentsSection,
  subagentsSectionPath,
  tierPoolPatch,
  tierTakeoverPatch,
  tierThinkingPatch,
  THINKING_LEVELS,
  type ModelTier,
  type ThinkingLevel,
  type TierConfigLoadResult,
  type TierMapping,
  type TierThinkingMapping,
} from "./config.ts";
import { baseModelRef, findDuplicateBaseRef } from "./routing.ts";
import type { SubagentsMessageKey } from "./messages/index.ts";

export const TIER_DISPLAY_ORDER: readonly ModelTier[] = ["flagship", "balanced", "fast"];

export function tierNameKey(tier: ModelTier): SubagentsMessageKey {
  return `module.subagents.tier.name.${tier}`;
}

export function tierDisplayName(tier: ModelTier, t: Translator): string {
  return t(tierNameKey(tier));
}

export type TierMenuRegistry = Pick<ModelRegistry, "getAvailable" | "getAll" | "hasConfiguredAuth">;

export interface TierCandidate {
  readonly provider: string;
  readonly modelId: string;

  readonly authenticated: boolean;
}

export function tierCandidateValue(candidate: { provider: string; modelId: string }): string {
  return `${candidate.provider}/${candidate.modelId}`;
}

export function discoverTierCandidates(registry: TierMenuRegistry): TierCandidate[] {
  const candidates: TierCandidate[] = [];
  const seen = new Set<string>();
  const source = registry.getAvailable?.() ?? registry.getAll();
  for (const model of source) {
    const selection = { provider: model.provider, modelId: model.id };
    const key = tierCandidateValue(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...selection,
      authenticated: registry.hasConfiguredAuth(model),
    });
  }
  candidates.sort((left, right) => {
    if (left.authenticated !== right.authenticated) return left.authenticated ? -1 : 1;
    return tierCandidateValue(left).localeCompare(tierCandidateValue(right));
  });
  return candidates;
}

export interface SubagentsPanelState {
  readonly mapping: TierMapping;
  readonly tierThinking: TierThinkingMapping;
  readonly statusEnabled: boolean | undefined;
  readonly problems: readonly string[];

  readonly tierProblems: readonly string[];
}

export function readPanelState(section: Record<string, unknown>): SubagentsPanelState {
  const view = readSubagentsSection(section);
  return {
    mapping: view.tier,
    tierThinking: view.tierThinking,
    statusEnabled: view.statusEnabled,
    problems: view.problems,
    tierProblems: view.tierProblems,
  };
}

export type TierPoolOwnership = "local" | "foreign" | "unconfigured";

export interface TierEditorView {

  readonly pool: readonly string[];
  readonly ownership: TierPoolOwnership;

  readonly poolSource: string | null;

  readonly thinking: ThinkingLevel | undefined;
  readonly thinkingSource: string | null;

  readonly thinkingEditable: boolean;
}

export interface EffectivePanelView {

  readonly tiers: Readonly<Record<ModelTier, TierEditorView>>;

  readonly envLocked: boolean;

  readonly chainProblems: readonly string[];
}

export function buildEffectivePanelView(input: {
  readonly effective: TierConfigLoadResult;
  readonly localSource: string;
}): EffectivePanelView {
  const envLocked = input.effective.sourcePath !== null;
  const tiers = {} as Record<ModelTier, TierEditorView>;
  for (const tier of MODEL_TIERS) {
    const route = input.effective.config?.tiers[tier];
    const pool = route?.pool ?? [];
    const poolSource = route?.poolSource ?? null;
    const ownership: TierPoolOwnership =
      poolSource === null ? "unconfigured" : poolSource === input.localSource ? "local" : "foreign";
    tiers[tier] = {
      pool,
      ownership,
      poolSource,

      thinking: undefined,
      thinkingSource: null,
      thinkingEditable: true,
    };
  }
  return {
    tiers,
    envLocked,
    chainProblems: input.effective.config?.problems ?? [],
  };
}

export function tierPoolEditable(view: EffectivePanelView, tier: ModelTier): boolean {
  const ownership = view.tiers[tier].ownership;
  return !view.envLocked && (ownership === "local" || ownership === "unconfigured");
}

export function tierForeignEffective(view: EffectivePanelView, tier: ModelTier): boolean {
  return view.tiers[tier].ownership === "foreign";
}

export function effectiveMappingFromView(view: EffectivePanelView): TierMapping {
  const mapping: TierMapping = {};
  for (const tier of MODEL_TIERS) {
    const pool = view.tiers[tier].pool;
    if (pool.length > 0) mapping[tier] = [...pool];
  }
  return mapping;
}

export function effectiveThinkingMapping(view: EffectivePanelView): TierThinkingMapping {
  const mapping: TierThinkingMapping = {};
  for (const tier of MODEL_TIERS) {
    const level = view.tiers[tier].thinking;
    if (level !== undefined) mapping[tier] = level;
  }
  return mapping;
}

export function tierThinkingRowValue(
  tier: ModelTier,
  mapping: TierThinkingMapping,
  t: Translator,
): string {
  return mapping[tier] ?? t("module.subagents.tier.thinking.unset");
}

export function configuredCountValue(mapping: TierMapping, t: Translator): string {
  const configured = MODEL_TIERS.filter((tier) => mapping[tier]).length;
  return t("module.subagents.menu.value", { configured, total: MODEL_TIERS.length });
}

export interface SaveOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SubagentsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly agentDir: string;

  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;

  readonly getSection: () => Record<string, unknown>;

  readonly loadEffective: () => TierConfigLoadResult;
  readonly onDone: (value: string) => void;
}

export async function saveTierPool(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  pool: readonly string[],
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(tierPoolPatch(tier, pool, subagentsSectionPath(options.agentDir)));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function saveTierThinking(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  level: ThinkingLevel | null,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(
      tierThinkingPatch(tier, level, subagentsSectionPath(options.agentDir)),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function saveTierTakeover(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  pool: readonly string[],
  thinking: ThinkingLevel | null | undefined,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(
      tierTakeoverPatch(tier, pool, thinking, subagentsSectionPath(options.agentDir)),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export type PoolEditorRow =
  | { readonly kind: "tier"; readonly tier: ModelTier }
  | { readonly kind: "model"; readonly tier: ModelTier; readonly index: number }
  | { readonly kind: "add"; readonly tier: ModelTier }
  | { readonly kind: "takeover"; readonly tier: ModelTier };

export function poolEditorRowId(row: PoolEditorRow): string {
  switch (row.kind) {
    case "tier":
      return `subagents.pool.${row.tier}`;
    case "model":
      return `subagents.pool.${row.tier}.model.${row.index}`;
    case "add":
      return `subagents.pool.${row.tier}.add`;
    case "takeover":
      return `subagents.pool.${row.tier}.takeover`;
  }
}

export function buildPoolEditorRows(view: EffectivePanelView): PoolEditorRow[] {
  const rows: PoolEditorRow[] = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    const tierView = view.tiers[tier];
    rows.push({ kind: "tier", tier });
    for (let index = 0; index < tierView.pool.length; index += 1) {
      rows.push({ kind: "model", tier, index });
    }
    if (tierPoolEditable(view, tier)) {
      rows.push({ kind: "add", tier });
    }
    if (!view.envLocked && tierForeignEffective(view, tier)) {
      rows.push({ kind: "takeover", tier });
    }
  }
  return rows;
}

export function poolEditorRowIds(view: EffectivePanelView): string[] {
  return buildPoolEditorRows(view).map(poolEditorRowId);
}

const THINKING_CYCLE: readonly (ThinkingLevel | null)[] = [null, ...THINKING_LEVELS];

export function nextThinkingLevel(current: ThinkingLevel | null, step: 1 | -1): ThinkingLevel | null {
  const index = THINKING_CYCLE.indexOf(current);
  const next = (index + step + THINKING_CYCLE.length) % THINKING_CYCLE.length;
  return THINKING_CYCLE[next] ?? null;
}

export function poolAfterMove(pool: readonly string[], index: number, step: 1 | -1): string[] | null {
  const target = index + step;
  if (target < 0 || target >= pool.length) return null;
  const next = [...pool];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const SHOW_UNAUTHENTICATED_MODELS = "__show_unauthenticated__";

interface PendingDelete {
  readonly tier: ModelTier;
  readonly index: number;
  readonly model: string;
}

export class SubagentsPanel implements Component {
  private readonly options: SubagentsPanelOptions;
  private readonly candidates: TierCandidate[];
  private local: SubagentsPanelState;
  private loadResult: TierConfigLoadResult;
  private view: EffectivePanelView;
  private rows: PoolEditorRow[];
  private selectedIndex = 0;
  private pendingDelete: PendingDelete | null = null;
  private submenu: Component | null = null;
  private readonly maxVisible = 10;

  constructor(options: SubagentsPanelOptions) {
    this.options = options;
    this.candidates = discoverTierCandidates(options.context.modelRegistry);
    this.local = readPanelState(options.getSection());
    this.loadResult = options.loadEffective();
    this.pruneUnavailableLocalPools();
    this.view = this.buildView();
    this.rows = buildPoolEditorRows(this.view);
  }

  private pruneUnavailableLocalPools(): void {
    if (typeof (this.options.context.modelRegistry as any).getAvailable !== "function") return;
    const section = this.options.getSection();
    const models = section.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return;
    const available = new Set(this.candidates.map((candidate) => tierCandidateValue(candidate)));
    const next: Record<string, string[]> = {};
    let changed = false;
    for (const tier of MODEL_TIERS) {
      const pool = (models as Record<string, unknown>)[tier];
      if (!Array.isArray(pool)) continue;
      const filtered = pool.filter((ref): ref is string => typeof ref === "string" && available.has(baseModelRef(ref)));
      next[tier] = filtered;
      if (filtered.length !== pool.length || filtered.some((ref, index) => ref !== pool[index])) changed = true;
    }
    if (changed) void this.options.saveConfig({ models: next }, { reapply: () => undefined }).catch((error) => this.notify(String(error)));
  }

  private buildView(): EffectivePanelView {
    return buildEffectivePanelView({
      effective: this.loadResult,
      localSource: subagentsSectionPath(this.options.agentDir),
    });
  }

  private get loadFailed(): boolean {
    return this.loadResult.config === null;
  }

  private get locked(): boolean {
    return this.local.tierProblems.length > 0;
  }

  render(width: number): string[] {
    if (this.submenu) return this.submenu.render(width);
    if (this.loadFailed) return this.renderLoadError(width);
    if (this.locked) return this.renderLocked(width);
    return this.renderEditor(width);
  }

  invalidate(): void {
    this.submenu?.invalidate?.();
  }

  handleInput(data: string): void {

    if (this.submenu) {
      this.submenu.handleInput?.(data);
      return;
    }
    const kb = getKeybindings();

    if (this.locked || this.loadFailed) {
      if (kb.matches(data, "tui.select.cancel")) this.close();
      return;
    }
    if (matchesKey(data, "shift+up")) {
      void this.moveCandidate(-1);
    } else if (matchesKey(data, "shift+down")) {
      void this.moveCandidate(1);
    } else if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      this.activate();
    } else if (matchesKey(data, "ctrl+d")) {
      this.toggleDeleteArm();
    } else if (kb.matches(data, "tui.select.cancel")) {
      if (this.pendingDelete) {
        this.pendingDelete = null;
        this.options.requestRender();
      } else {
        this.close();
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.submenu) {
      const result = this.submenu.handleMouse?.(event);
      return result ? { ...result, focus: true } : undefined;
    }

    if (this.locked || this.loadFailed) return undefined;
    if (this.rows.length === 0) return undefined;
    const { startIndex, endIndex } = this.getVisibleRange();
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      const previousIndex = this.selectedIndex;
      this.moveSelection(delta);
      return { handled: true, render: this.selectedIndex !== previousIndex };
    }
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const rowIndex = startIndex + event.y;
    if (rowIndex < startIndex || rowIndex >= endIndex) return undefined;
    if (event.type === "press") {
      if (this.selectedIndex !== rowIndex) {
        this.selectedIndex = rowIndex;
        this.pendingDelete = null;
      }
      return { handled: true, focus: true };
    }
    this.selectedIndex = rowIndex;
    this.activate();
    return { handled: true };
  }

  private close(): void {

    this.options.onDone(configuredCountValue(effectiveMappingFromView(this.view), this.options.t));
  }

  private notify(message: string): void {
    this.options.context.ui.notify(message, "error");
  }

  private reportSave(outcome: SaveOutcome): void {
    if (outcome.ok) return;
    this.notify(this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }));
  }

  private refresh(selectRowId?: string): void {
    this.local = readPanelState(this.options.getSection());
    this.loadResult = this.options.loadEffective();
    this.view = this.buildView();
    this.rows = buildPoolEditorRows(this.view);
    const target =
      selectRowId === undefined ? -1 : this.rows.findIndex((row) => poolEditorRowId(row) === selectRowId);
    this.selectedIndex =
      target >= 0 ? target : Math.min(this.selectedIndex, this.rows.length - 1);
    if (this.pendingDelete) {
      const pool = this.view.tiers[this.pendingDelete.tier].pool;
      if (pool[this.pendingDelete.index] !== this.pendingDelete.model) {
        this.pendingDelete = null;
      }
    }
    this.options.requestRender();
  }

  private currentRow(): PoolEditorRow | undefined {
    return this.rows[this.selectedIndex];
  }

  selectRow(id: string): boolean {
    const index = this.rows.findIndex((row) => poolEditorRowId(row) === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    this.pendingDelete = null;
    return true;
  }

  currentRowId(): string {
    const row = this.rows[this.selectedIndex];
    return row ? poolEditorRowId(row) : "";
  }

  private moveSelection(step: 1 | -1): void {
    if (this.rows.length === 0) return;
    const next = (this.selectedIndex + step + this.rows.length) % this.rows.length;
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.pendingDelete = null;
    }
    this.options.requestRender();
  }

  private blockForeignTier(tier: ModelTier): boolean {
    if (tierPoolEditable(this.view, tier)) return false;
    this.notify(this.options.t("module.subagents.pool.foreignBlocked"));
    return true;
  }

  private activate(): void {
    const row = this.currentRow();
    if (!row) return;
    if (
      row.kind === "model" &&
      this.pendingDelete &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index
    ) {
      void this.confirmDelete(row);
      return;
    }
    this.pendingDelete = null;
    if (row.kind === "takeover") {
      void this.takeTierOver(row.tier);
      return;
    }
    if (row.kind !== "tier" && this.blockForeignTier(row.tier)) return;
    if (row.kind !== "tier") this.openModelPicker(row);
  }

  private toggleDeleteArm(): void {
    const row = this.currentRow();
    if (!row || row.kind !== "model") return;
    if (this.blockForeignTier(row.tier)) return;
    if (
      this.pendingDelete &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index
    ) {
      this.pendingDelete = null;
    } else {
      this.pendingDelete = {
        tier: row.tier,
        index: row.index,
        model: this.view.tiers[row.tier].pool[row.index] ?? "",
      };
    }
    this.options.requestRender();
  }

  private async confirmDelete(row: { readonly tier: ModelTier; readonly index: number }): Promise<void> {
    const pool = [...this.view.tiers[row.tier].pool];
    const outcome = await saveTierPool(
      this.options,
      row.tier,
      pool.filter((_, index) => index !== row.index),
    );
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;

      this.refresh();
    }
  }

  private async moveCandidate(step: 1 | -1): Promise<void> {
    const row = this.currentRow();
    if (!row || row.kind !== "model") return;
    if (this.blockForeignTier(row.tier)) return;
    const pool = [...this.view.tiers[row.tier].pool];
    const nextPool = poolAfterMove(pool, row.index, step);
    if (!nextPool) return;
    const outcome = await saveTierPool(this.options, row.tier, nextPool);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(`subagents.pool.${row.tier}.model.${row.index + step}`);
    }
  }

  private async takeTierOver(tier: ModelTier): Promise<void> {
    const tierView = this.view.tiers[tier];
    if (tierView.pool.length === 0) return;
    const outcome = await saveTierPool(this.options, tier, tierView.pool);
    this.reportSave(outcome);
    if (!outcome.ok) return;
    this.refresh(`subagents.pool.${tier}.takeover`);
    if (this.view.tiers[tier].ownership === "foreign") {
      this.notify(
        this.options.t("module.subagents.pool.takeoverShadowNote", {
          path: this.view.tiers[tier].poolSource ?? "",
        }),
      );
    }
  }

  private openModelPicker(row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number }): void {
    const t = this.options.t;
    const tierName = tierDisplayName(row.tier, t);
    const title =
      row.kind === "model"
        ? t("module.subagents.pool.replaceTitle", { tier: tierName })
        : t("module.subagents.pool.addTitle", { tier: tierName });
    this.mountModelPicker(row, title);
  }

  private mountModelPicker(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    title: string,
  ): void {
    const t = this.options.t;
    const unauthenticated = this.candidates.filter((candidate) => !candidate.authenticated);
    const options: ChoiceOption[] = this.candidates
      .filter((candidate) => candidate.authenticated)
      .map((candidate) => ({
        value: tierCandidateValue(candidate),
        label: tierCandidateValue(candidate),
        description: t("module.subagents.tier.authenticated"),
      }));
    if (unauthenticated.length > 0) {
      options.push({
        value: SHOW_UNAUTHENTICATED_MODELS,
        label: t("module.subagents.pool.showUnauthenticated", { count: unauthenticated.length }),
        description: t("module.subagents.tier.noAuthRequired"),
      });
    }
    this.submenu = new ChoicePicker({
      title,
      theme: this.options.theme,
      t,

      searchable: true,
      options,
      onSelect: (value) => {
        if (value === SHOW_UNAUTHENTICATED_MODELS) {
          this.mountUnauthenticatedPicker(row, title);
          return;
        }
        this.applyModelSelection(row, value);
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private mountUnauthenticatedPicker(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    backTitle: string,
  ): void {
    const t = this.options.t;
    this.submenu = new ChoicePicker({
      title: t("module.subagents.pool.unauthTitle", { title: backTitle }),
      theme: this.options.theme,
      t,
      searchable: true,
      options: this.candidates
        .filter((candidate) => !candidate.authenticated)
        .map((candidate) => ({
          value: tierCandidateValue(candidate),
          label: tierCandidateValue(candidate),
          description: t("module.subagents.tier.noAuthRequired"),
        })),
      onSelect: (value) => {
        this.applyModelSelection(row, value);
      },
      onCancel: () => this.mountModelPicker(row, backTitle),
    });
    this.options.requestRender();
  }

  private async applyModelSelection(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    model: string,
  ): Promise<void> {
    const t = this.options.t;

    const modelRef = baseModelRef(model);
    const pool = this.view.tiers[row.tier].pool.map(baseModelRef);
    const replaceIndex = row.kind === "model" ? row.index : undefined;
    if (replaceIndex !== undefined && pool[replaceIndex] === modelRef) return;
    const nextPool =
      replaceIndex !== undefined
        ? pool.map((candidate, index) => (index === replaceIndex ? modelRef : candidate))
        : [...pool, modelRef];
    const duplicate = findDuplicateBaseRef(nextPool);
    if (duplicate) {
      const existing = duplicate.first === modelRef ? duplicate.second : duplicate.first;
      this.notify(t("module.subagents.pool.duplicate", { candidate: modelRef, existing }));
      return;
    }
    const outcome = await saveTierPool(this.options, row.tier, nextPool);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(
        replaceIndex !== undefined
          ? `subagents.pool.${row.tier}.model.${replaceIndex}`
          : `subagents.pool.${row.tier}.model.${pool.length}`,
      );
    }
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.rows.length - this.maxVisible,
      ),
    );
    return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, this.rows.length) };
  }

  private renderEditor(width: number): string[] {
    const lines: string[] = [];
    const { startIndex, endIndex } = this.getVisibleRange();
    for (let i = startIndex; i < endIndex; i++) {
      const row = this.rows[i];
      if (!row) continue;
      lines.push(this.renderRow(row, i === this.selectedIndex, width));
    }
    if (startIndex > 0 || endIndex < this.rows.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.rows.length})`;
      lines.push(this.options.theme.hint(truncateToWidth(scrollText, width - 2, "")));
    }

    if (this.view.envLocked) {
      lines.push(
        truncateToWidth(
          this.options.theme.fg(
            "error",
            this.options.t("module.subagents.pool.envLocked", {
              path: this.loadResult.sourcePath ?? "",
            }),
          ),
          width,
        ),
      );
    }
    for (const problem of this.view.chainProblems) {
      lines.push(truncateToWidth(this.options.theme.fg("error", problem), width));
    }
    lines.push("");
    lines.push(truncateToWidth(this.options.theme.hint(this.options.t("module.subagents.pool.hint")), width));
    return lines;
  }

  private shortenSource(source: string, max = 48): string {
    const chars = Array.from(source);
    if (visibleWidth(source) <= max) return source;
    return `…${chars.slice(-(max - 1)).join("")}`;
  }

  private renderRow(row: PoolEditorRow, selected: boolean, width: number): string {
    const t = this.options.t;
    const theme = this.options.theme;
    const prefix = selected ? theme.settings.cursor : "  ";
    if (row.kind === "tier") {
      const label = theme.title(tierDisplayName(row.tier, t));
      const tierView = this.view.tiers[row.tier];
      const parts: string[] = [];
      if (tierView.ownership === "foreign") {
        parts.push(
          t("module.subagents.pool.source", {
            source: this.shortenSource(tierView.poolSource ?? ""),
          }),
        );
      }
      if (tierView.pool.length === 0) parts.push(t("module.subagents.tier.unmapped"));
      const value = theme.settings.value(parts.join(" · "), selected);
      const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(value));
      return truncateToWidth(prefix + label + " ".repeat(pad) + value, width);
    }
    if (row.kind === "add") {
      return truncateToWidth(prefix + "  " + theme.hint(t("module.subagents.pool.add")), width);
    }
    if (row.kind === "takeover") {
      return truncateToWidth(
        prefix + "  " + theme.settings.label(t("module.subagents.pool.takeover"), selected),
        width,
      );
    }
    const model = this.view.tiers[row.tier].pool[row.index] ?? "";
    const armed =
      this.pendingDelete !== null &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index;
    const body = armed
      ? theme.fg("error", model) + theme.hint(` · ${t("module.subagents.pool.deleteArmed")}`)
      : theme.settings.label(model, selected);
    return truncateToWidth(prefix + "  " + body, width);
  }

  private renderLocked(width: number): string[] {
    const t = this.options.t;
    const theme = this.options.theme;
    const lines = [theme.title(t("module.subagents.pool.lockedTitle")), ""];
    for (const problem of this.local.tierProblems) {
      lines.push(truncateToWidth(theme.fg("error", problem), width));
    }
    lines.push("");
    lines.push(truncateToWidth(theme.hint(t("module.subagents.pool.lockedHint")), width));
    return lines;
  }

  private renderLoadError(width: number): string[] {
    const t = this.options.t;
    const theme = this.options.theme;
    const lines = [theme.title(t("module.subagents.pool.loadErrorTitle")), ""];
    const error = this.loadResult.error ?? "";
    if (error) lines.push(truncateToWidth(theme.fg("error", error), width));
    lines.push("");
    lines.push(truncateToWidth(theme.hint(t("module.subagents.pool.loadErrorHint")), width));
    return lines;
  }
}
