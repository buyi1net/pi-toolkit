import {
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  type SettingItem,
  Text,
} from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import { schemaFieldRow } from "../../kit/menu/items.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import { enabledField, type ModuleMenuContext } from "../../kit/module.ts";
import type { VisionRouteConfig } from "./config.ts";
import {
  modelValueLabel,
  routeValueLabel,
  visionEntryValue,
  type VisionFacadePatch,
  type VisionRouteSnapshot,
  type VisionSaveOptions,
} from "./facade.ts";
import { selectAutomaticPiVisionModel, testPiVisionModel } from "./pi-model-backend.ts";
import { VISION_PROBE_EXPECTED, VISION_PROBE_IMAGE } from "./vision-probe.ts";

export const VISION_MENU_ITEM_ID = "vision.settings";

export const VISION_ENABLED_FIELD = enabledField(
  "module.vision.enabled.label",
  "module.vision.enabled.description",
);

const ROW_ENABLED = "vision.enabled";

const ROW_MODEL = "vision.settings.model";
const ROW_PROJECT_OVERRIDE = "vision.settings.projectOverride";
const ROW_REFRESH = "vision.settings.refresh";
const ROW_CHECK = "vision.settings.check";
const ROW_ROUTE = "vision.settings.route";

const VALUE_AUTO = "auto";
const VALUE_OFF = "off";

const MODEL_VALUE_SEPARATOR = "\u0000";

export type VisionMenuRegistry = Pick<
  ModelRegistry,
  | "getAll"
  | "getAvailable"
  | "find"
  | "getProviderAuthStatus"
  | "complete"
  | "hasConfiguredAuth"
  | "refresh"
>;

export interface VisionSelection {
  readonly provider: string;
  readonly modelId: string;
}

export interface VisionCandidate extends VisionSelection {

  readonly authenticated: boolean;
}

export interface VisionMenuRuntime {

  snapshot(): VisionRouteSnapshot;

  save(patch: VisionFacadePatch, options?: VisionSaveOptions): Promise<VisionRouteSnapshot>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function candidateKey(candidate: VisionSelection): string {
  return `${candidate.provider}${MODEL_VALUE_SEPARATOR}${candidate.modelId}`;
}

export function isModelValue(value: string): boolean {
  return value.includes(MODEL_VALUE_SEPARATOR);
}

export function parseModelValue(value: string): VisionSelection | undefined {
  const index = value.indexOf(MODEL_VALUE_SEPARATOR);
  if (index <= 0) return undefined;
  const provider = value.slice(0, index);
  const modelId = value.slice(index + 1);
  return provider && modelId ? { provider, modelId } : undefined;
}

export function discoverCandidates(registry: VisionMenuRegistry): VisionCandidate[] {
  const candidates: VisionCandidate[] = [];
  const seen = new Set<string>();
  for (const model of registry.getAvailable()) {
    if (!model.input.includes("image")) continue;
    const selection: VisionSelection = { provider: model.provider, modelId: model.id };
    const key = candidateKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...selection, authenticated: registry.hasConfiguredAuth(model) });
  }
  candidates.sort((left, right) => {
    if (left.authenticated !== right.authenticated) return left.authenticated ? -1 : 1;
    return candidateKey(left).localeCompare(candidateKey(right));
  });
  return candidates;
}

export function candidateKeys(candidates: readonly VisionCandidate[]): string {
  return candidates.map((candidate) => candidateKey(candidate)).join("|");
}

export function sameCandidates(
  left: readonly VisionCandidate[],
  right: readonly VisionCandidate[],
): boolean {
  return candidateKeys(left) === candidateKeys(right);
}

export function routeSelectionValue(route: VisionRouteConfig): string {
  if (route.allowedModels !== null && route.allowedModels.length === 0) return VALUE_OFF;
  if (route.mode === "fixed" && route.fixedModel) {
    return `${route.fixedModel.provider}${MODEL_VALUE_SEPARATOR}${route.fixedModel.model}`;
  }
  return VALUE_AUTO;
}

export function routePatchFor(value: string): Partial<VisionRouteConfig> | undefined {
  if (value === VALUE_AUTO) return { mode: "automatic", allowedModels: null };
  if (value === VALUE_OFF) return { mode: "automatic", allowedModels: [] };
  const selection = parseModelValue(value);
  return selection
    ? {
        mode: "fixed",
        allowedModels: null,
        fixedModel: { provider: selection.provider, model: selection.modelId },
      }
    : undefined;
}

export function resolveRouteCandidate(
  route: VisionRouteConfig,
  registry: VisionMenuRegistry,
  currentModel?: { provider: string; id: string },
): VisionSelection | undefined {
  if (route.allowedModels !== null && route.allowedModels.length === 0) return undefined;
  if (route.mode === "fixed" && route.fixedModel) {
    return { provider: route.fixedModel.provider, modelId: route.fixedModel.model };
  }
  const allowed = route.allowedModels?.map((model) => ({ provider: model.provider, modelId: model.model })) ?? null;
  const selection = selectAutomaticPiVisionModel(registry, {
    allowedModels: allowed,
    ...(currentModel ? { currentModel: { provider: currentModel.provider, modelId: currentModel.id } } : {}),
  });
  return selection ? { provider: selection.provider, modelId: selection.modelId } : undefined;
}

export function diagnosticCacheKey(options: {
  readonly generation: number;
  readonly route: VisionRouteConfig;
  readonly candidates: readonly VisionCandidate[];
  readonly currentModel?: { provider: string; id: string };
}): string {
  return [
    options.generation,
    routeSelectionValue(options.route),
    candidateKeys(options.candidates),
    options.currentModel
      ? `${options.currentModel.provider}${MODEL_VALUE_SEPARATOR}${options.currentModel.id}`
      : "no-current-model",
  ].join("\n");
}

export interface ProbeOutcome {
  readonly passed: boolean;
  readonly matched: number;
  readonly total: number;
  readonly text: string;
}

export async function probeVisionModel(
  registry: VisionMenuRegistry,
  selection: VisionSelection,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const result = await testPiVisionModel(registry, selection, VISION_PROBE_IMAGE, VISION_PROBE_EXPECTED, {
    ...(signal ? { signal } : {}),
  });
  return { passed: result.passed, matched: result.matched, total: result.total, text: result.text };
}

export interface SaveRouteResult {
  readonly kind: "saved" | "modelsChanged" | "failed";
  readonly route?: VisionRouteConfig;
  readonly reason?: string;
}

export async function saveRouteSelection(options: {
  readonly value: string;
  readonly openedWith: readonly VisionCandidate[];
  readonly registry: VisionMenuRegistry;
  readonly runtime: VisionMenuRuntime;
  readonly context: ExtensionContext;
}): Promise<SaveRouteResult> {
  const patch = routePatchFor(options.value);
  if (!patch) return { kind: "failed", reason: `unknown selection: ${options.value}` };

  const latest = discoverCandidates(options.registry);
  if (!sameCandidates(options.openedWith, latest)) return { kind: "modelsChanged" };

  try {
    const snapshot = await options.runtime.save({ route: patch }, { context: options.context });
    return { kind: "saved", route: snapshot.route };
  } catch (error) {
    return { kind: "failed", reason: describeError(error) };
  }
}

export interface SelfCheckResult {
  readonly kind: "passed" | "failed" | "noRoute" | "noModel" | "cancelled";
  readonly text: string;
  readonly cached: boolean;
}

export async function runVisionSelfCheck(options: {
  readonly t: Translator;
  readonly registry: VisionMenuRegistry;
  readonly runtime: VisionMenuRuntime;
  readonly context: ExtensionContext;
  readonly candidates: readonly VisionCandidate[];
  readonly signal?: AbortSignal;
}): Promise<SelfCheckResult> {
  const { t, registry, runtime } = options;
  const snapshot = runtime.snapshot();
  const route = snapshot.route;
  if (route.allowedModels !== null && route.allowedModels.length === 0) {
    return { kind: "noRoute", text: t("module.vision.check.noRoute"), cached: false };
  }

  const currentModel = options.context.model
    ? { provider: options.context.model.provider, id: options.context.model.id }
    : undefined;
  const key = diagnosticCacheKey({
    generation: snapshot.catalogueGeneration,
    route,
    candidates: options.candidates,
    ...(currentModel ? { currentModel } : {}),
  });

  const cached = snapshot.diagnostic;
  if (cached?.key === key) {
    return cached.passed
      ? { kind: "passed", text: t("module.vision.check.passed", { elapsed: cached.elapsedMs }), cached: true }
      : { kind: "failed", text: t("module.vision.check.failed", { reason: cached.detail }), cached: true };
  }

  const selection = resolveRouteCandidate(route, registry, currentModel);
  if (!selection) {
    await runtime.save({ diagnostic: { key, passed: false, elapsedMs: 0, detail: "" } });
    return { kind: "noModel", text: t("module.vision.check.noModel"), cached: false };
  }

  const startedAt = Date.now();
  try {
    const probe = await probeVisionModel(registry, selection, options.signal);
    if (options.signal?.aborted) {
      return { kind: "cancelled", text: t("module.vision.cancelled"), cached: false };
    }
    const elapsedMs = Date.now() - startedAt;
    const detail = singleLine(probe.text || (probe.passed ? "OK" : "unknown error"));
    await runtime.save({ diagnostic: { key, passed: probe.passed, elapsedMs, detail } });
    return probe.passed
      ? { kind: "passed", text: t("module.vision.check.passed", { elapsed: elapsedMs }), cached: false }
      : { kind: "failed", text: t("module.vision.check.failed", { reason: detail }), cached: false };
  } catch (error) {
    if (options.signal?.aborted) {
      return { kind: "cancelled", text: t("module.vision.cancelled"), cached: false };
    }
    const elapsedMs = Date.now() - startedAt;
    const detail = singleLine(describeError(error));
    await runtime.save({ diagnostic: { key, passed: false, elapsedMs, detail } });
    return { kind: "failed", text: t("module.vision.check.failed", { reason: detail }), cached: false };
  }
}

export interface RefreshResult {
  readonly kind: "ok" | "cancelled" | "failed";
  readonly reason?: string;
}

export async function refreshVisionCatalogue(
  registry: VisionMenuRegistry,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  try {
    const result = await registry.refresh({ allowNetwork: false, ...(signal ? { signal } : {}) });
    if (result.aborted || signal?.aborted) return { kind: "cancelled" };
    if (result.errors.size > 0) {
      const detail = [...result.errors.entries()]
        .map(([provider, error]) => `${provider}: ${error.message}`)
        .join("; ");
      return { kind: "failed", reason: detail };
    }
    return { kind: "ok" };
  } catch (error) {
    if (signal?.aborted) return { kind: "cancelled" };
    return { kind: "failed", reason: describeError(error) };
  }
}

type StatusColor = "dim" | "warning" | "success" | "error";
type StatusSetter = (text: string, color: StatusColor, running?: boolean) => void;

interface Cancellable {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

function startCancellable(parent: AbortSignal | undefined): Cancellable {
  const controller = new AbortController();
  const forward = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => parent?.removeEventListener("abort", forward),
  };
}

interface PanelEnv {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly runtime: VisionMenuRuntime;
  readonly requestRender: () => void;
}

export interface VisionStatusPanelOptions extends PanelEnv {
  readonly title: string;
  readonly hint: string;
  readonly onClose: () => void;
  readonly onResult?: (text: string) => void;
  readonly run: (signal: AbortSignal, setStatus: StatusSetter) => Promise<void>;
}

export class VisionStatusPanel extends Container {
  private readonly options: VisionStatusPanelOptions;
  private readonly controller: Cancellable;
  private readonly body: Text;
  private token = 0;
  private running = true;

  constructor(options: VisionStatusPanelOptions) {
    super();
    this.options = options;
    this.controller = startCancellable(options.context.signal);
    this.addChild(new Text(options.theme.title(options.title), 1, 0));
    this.body = new Text(options.theme.fg("warning", `  ${options.t("module.vision.running")}`), 1, 0);
    this.addChild(this.body);
    this.addChild(new Text(options.theme.hint(options.hint), 1, 0));
    void this.start();
  }

  handleInput(data: string): void {
    if (!matchesKey(data, Key.escape)) return;
    if (this.running) {
      this.cancel();
      return;
    }
    this.options.onClose();
  }

  dispose(): void {
    this.token += 1;
    this.controller.dispose();
    this.controller.abort(new DOMException("Disposed", "AbortError"));
  }

  private async start(): Promise<void> {
    const token = ++this.token;
    const setStatus: StatusSetter = (text, color, running = false) => {
      if (token !== this.token) return;
      this.running = running;
      this.body.setText(this.options.theme.fg(color, `  ${text}`));
      if (!running) this.options.onResult?.(text);
      this.options.requestRender();
    };
    try {
      await this.options.run(this.controller.signal, setStatus);
    } catch (error) {
      setStatus(singleLine(describeError(error)), "error");
    } finally {
      if (token === this.token) {
        this.running = false;
        this.controller.dispose();
        this.options.requestRender();
      }
    }
  }

  private cancel(): void {
    this.token += 1;
    this.running = false;
    this.controller.abort(new DOMException("Cancelled", "AbortError"));
    this.body.setText(this.options.theme.fg("dim", `  ${this.options.t("module.vision.cancelled")}`));
    this.options.requestRender();
  }
}

export interface VisionModelPickerOptions extends PanelEnv {
  readonly selection: VisionRouteConfig;
  readonly candidates: readonly VisionCandidate[];
  readonly onSaved: () => void;
  readonly onDone: (value?: string) => void;
}

export class VisionModelPicker extends Container {
  private readonly options: VisionModelPickerOptions;
  private readonly initialValue: string;
  private list: SelectList;
  private readonly searchInput: Input;
  private readonly allItems: SelectItem[];
  private listChildIndex = 0;
  private readonly controller: Cancellable;
  private token = 0;

  private phase: "picking" | "busy" | "settled" = "picking";

  constructor(options: VisionModelPickerOptions) {
    super();
    this.options = options;
    this.initialValue = routeSelectionValue(options.selection);
    this.controller = startCancellable(options.context.signal);

    this.addChild(new Text(options.theme.title(options.t("module.vision.model.label")), 1, 0));
    this.allItems = this.buildItems();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    const currentIndex = this.allItems.findIndex((item) => item.value === this.initialValue);
    this.list = this.buildList(this.allItems);
    if (currentIndex > 0) this.list.setSelectedIndex(currentIndex);
    this.listChildIndex = this.children.length;
    this.addChild(this.list);
    if (options.candidates.length === 0) {
      this.addChild(new Text(options.theme.fg("warning", `  ${options.t("module.vision.model.empty")}`), 1, 0));
    }
    this.addChild(new Text(options.theme.hint(options.t("hint.filter")), 1, 0));
  }

  handleInput(data: string): void {
    if (this.phase === "picking") {

      const kb = getKeybindings();
      const isNav =
        kb.matches(data, "tui.select.up") ||
        kb.matches(data, "tui.select.down") ||
        kb.matches(data, "tui.select.confirm") ||
        kb.matches(data, "tui.select.cancel");
      if (isNav) {
        this.list.handleInput(data);
        return;
      }
      this.searchInput.handleInput(data);
      this.applyFilter(this.searchInput.getValue());
      return;
    }
    if (!matchesKey(data, Key.escape)) return;
    if (this.phase === "busy") {
      this.token += 1;
      this.controller.abort(new DOMException("Cancelled", "AbortError"));
      this.showStatus(this.options.t("module.vision.cancelled"), "dim", "settled");
      return;
    }
    this.options.onDone();
  }

  dispose(): void {
    this.token += 1;
    this.controller.dispose();
    this.controller.abort(new DOMException("Disposed", "AbortError"));
  }

  private buildList(items: readonly SelectItem[]): SelectList {
    const list = new SelectList([...items], Math.min(items.length, 10), this.options.theme.select);
    list.onSelect = (item) => {
      void this.choose(item.value);
    };
    list.onCancel = () => this.options.onDone();
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
      : this.allItems;
    const list = this.buildList(filtered);
    this.children[this.listChildIndex] = list;
    this.list = list;
  }

  private buildItems(): SelectItem[] {
    const t = this.options.t;
    const items: SelectItem[] = [
      {
        value: VALUE_AUTO,
        label: t("module.vision.value.auto"),
        description: t("module.vision.model.autoDescription"),
      },
    ];
    const unavailable = isModelValue(this.initialValue)
      && !this.options.candidates.some((candidate) => candidateKey(candidate) === this.initialValue);
    if (unavailable) {
      const selection = parseModelValue(this.initialValue);
      if (selection) {
        items.push({
          value: this.initialValue,
          label: `${selection.provider}/${selection.modelId}`,
          description: t("module.vision.model.unavailable"),
        });
      }
    }
    for (const candidate of this.options.candidates) {
      items.push({
        value: candidateKey(candidate),
        label: `${candidate.provider}/${candidate.modelId}`,
        description: candidate.authenticated
          ? t("module.vision.model.authenticated")
          : t("module.vision.model.noAuthRequired"),
      });
    }
    return items;
  }

  private async choose(value: string): Promise<void> {
    if (value === this.initialValue) {
      this.options.onDone();
      return;
    }
    const token = ++this.token;
    const t = this.options.t;

    if (isModelValue(value)) {
      const selection = parseModelValue(value);
      if (!selection) return;
      const model = `${selection.provider}/${selection.modelId}`;
      this.showStatus(t("module.vision.probe.running", { model }), "warning", "busy");
      let probe: ProbeOutcome;
      try {
        probe = await probeVisionModel(this.options.context.modelRegistry, selection, this.controller.signal);
      } catch (error) {
        if (this.token !== token) return;
        if (this.controller.signal.aborted) {
          this.showStatus(t("module.vision.cancelled"), "dim", "settled");
          return;
        }
        this.showStatus(`${t("module.vision.probe.failed", {
          model,
          matched: 0,
          total: VISION_PROBE_EXPECTED.length,
          reason: singleLine(describeError(error)),
        })} ${t("module.vision.probe.unchanged")}`, "error", "settled");
        return;
      }
      if (this.token !== token) return;
      if (this.controller.signal.aborted) {
        this.showStatus(t("module.vision.cancelled"), "dim", "settled");
        return;
      }
      if (!probe.passed) {
        this.showStatus(`${t("module.vision.probe.failed", {
          model,
          matched: probe.matched,
          total: probe.total,
          reason: singleLine(probe.text),
        })} ${t("module.vision.probe.unchanged")}`, "error", "settled");
        return;
      }
      this.showStatus(t("module.vision.probe.passed", {
        model,
        matched: probe.matched,
        total: probe.total,
        response: singleLine(probe.text),
      }), "success", "busy");
    }

    await this.save(value, token);
  }

  private async save(value: string, token: number): Promise<void> {
    const t = this.options.t;
    this.showStatus(t("module.vision.save.running"), "warning", "busy");
    const result = await saveRouteSelection({
      value,
      openedWith: this.options.candidates,
      registry: this.options.context.modelRegistry,
      runtime: this.options.runtime,
      context: this.options.context,
    });
    if (this.token !== token) return;
    if (result.kind === "modelsChanged") {
      this.showStatus(t("module.vision.save.modelsChanged"), "error", "settled");
      return;
    }
    if (result.kind === "failed" || !result.route) {
      this.showStatus(`${t("module.vision.save.failed", {
        reason: result.reason ?? "",
      })} ${t("module.vision.probe.unchanged")}`, "error", "settled");
      return;
    }
    this.options.onSaved();
    this.options.onDone(modelValueLabel(result.route, t));
  }

  private showStatus(text: string, color: StatusColor, phase: "busy" | "settled"): void {
    this.phase = phase;
    this.clear();
    this.addChild(new Text(this.options.theme.title(this.options.t("module.vision.model.label")), 1, 0));
    this.addChild(new Text(this.options.theme.fg(color, `  ${text}`), 1, 0));
    this.addChild(new Text(
      this.options.theme.hint(this.options.t(phase === "busy" ? "hint.cancel" : "hint.back")),
      1,
      0,
    ));
    this.options.requestRender();
  }
}

export interface VisionPanelOptions extends PanelEnv {
  readonly onDone: (value: string) => void;

  readonly enabledItem?: SettingItem;

  readonly onFieldChange?: (id: string, value: string) => void;
}

export class VisionPanel extends Container {
  private readonly options: VisionPanelOptions;
  private list: I18nSettingsList | undefined;
  private candidates: VisionCandidate[];
  private checkValue: string | undefined;

  constructor(options: VisionPanelOptions) {
    super();
    this.options = options;
    this.candidates = discoverCandidates(options.context.modelRegistry);
    this.list = new I18nSettingsList({
      items: this.buildItems(),
      maxVisible: 8,
      theme: options.theme.settings,
      t: options.t,
      enableSearch: true,
      onChange: (id, value) => {
        if (id === ROW_MODEL) this.refreshRows();
        if (id === ROW_ENABLED) this.options.onFieldChange?.(id, value);
      },
      onCancel: () => this.close(),
    });
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  updateValue(id: string, newValue: string): void {
    this.list?.updateValue(id, newValue);
  }

  private close(): void {
    this.options.onDone(visionEntryValue(this.options.runtime.snapshot().route, this.options.t));
  }

  private refreshRows(): void {
    const route = this.options.runtime.snapshot().route;
    this.list?.updateValue(ROW_MODEL, modelValueLabel(route, this.options.t));
    this.list?.updateValue(ROW_ROUTE, routeValueLabel(route, this.options.t));
    this.list?.updateValue(ROW_REFRESH, this.refreshValue());
    if (this.checkValue) this.list?.updateValue(ROW_CHECK, this.checkValue);
    this.options.requestRender();
  }

  private refreshValue(): string {
    return this.options.t("module.vision.refresh.value", { count: this.candidates.length });
  }

  private buildItems(): SettingItem[] {
    const t = this.options.t;
    const snapshot = this.options.runtime.snapshot();
    const route = snapshot.route;
    const items: SettingItem[] = [];
    if (this.options.enabledItem) {
      items.push(this.options.enabledItem);
    }
    items.push(
      {
        id: ROW_MODEL,
        label: t("module.vision.model.label"),
        description: t("module.vision.model.description"),
        currentValue: modelValueLabel(route, t),
        submenu: (_currentValue, done) =>
          new VisionModelPicker({
            ...this.options,
            selection: route,
            candidates: this.candidates,
            onSaved: () => this.refreshRows(),
            onDone: done,
          }),
      },
    );
    if (snapshot.projectLayer) {

      items.push({
        id: ROW_PROJECT_OVERRIDE,
        label: t("module.vision.projectOverride.label"),
        description: t("module.vision.projectOverride.description"),
        currentValue: "",
      });
    }
    items.push(
      {
        id: ROW_REFRESH,
        label: t("module.vision.refresh.label"),
        description: t("module.vision.refresh.description"),
        currentValue: this.refreshValue(),
        submenu: (_currentValue, done) =>
          new VisionStatusPanel({
            ...this.options,
            title: t("module.vision.refresh.label"),
            hint: t("hint.back"),
            onClose: () => done(),
            run: async (signal, setStatus) => {
              setStatus(t("module.vision.refresh.running"), "warning", true);
              const result = await refreshVisionCatalogue(this.options.context.modelRegistry, signal);
              if (signal.aborted) {
                setStatus(t("module.vision.cancelled"), "dim");
                return;
              }
              if (result.kind === "ok") {
                await this.options.runtime.save({ catalogueRefreshed: true });
                this.candidates = discoverCandidates(this.options.context.modelRegistry);
                setStatus(t("module.vision.refresh.complete"), "success");
                this.refreshRows();
                return;
              }
              if (result.kind === "cancelled") {
                setStatus(t("module.vision.cancelled"), "dim");
                return;
              }
              setStatus(t("module.vision.refresh.failed", { reason: result.reason ?? "" }), "error");
            },
          }),
      },
      {
        id: ROW_CHECK,
        label: t("module.vision.check.label"),
        description: t("module.vision.check.description"),
        currentValue: this.checkValue ?? t("module.vision.check.value"),
        submenu: (_currentValue, done) =>
          new VisionStatusPanel({
            ...this.options,
            title: t("module.vision.check.label"),
            hint: t("hint.back"),
            onClose: () => done(),
            onResult: (text) => {
              this.checkValue = text;
              this.list?.updateValue(ROW_CHECK, text);
            },
            run: async (signal, setStatus) => {
              setStatus(t("module.vision.check.running"), "warning", true);
              const result = await runVisionSelfCheck({
                t,
                registry: this.options.context.modelRegistry,
                runtime: this.options.runtime,
                context: this.options.context,
                candidates: this.candidates,
                signal,
              });
              setStatus(result.text, result.kind === "passed" ? "success" : result.kind === "cancelled" ? "dim" : "error");
            },
          }),
      },
      {
        id: ROW_ROUTE,
        label: t("module.vision.route.label"),
        description: t("module.vision.route.description"),
        currentValue: routeValueLabel(route, t),
      },
    );
    return items;
  }
}

export function buildVisionMenuItems(
  context: ModuleMenuContext,
  runtime: VisionMenuRuntime,
): readonly SettingItem[] {
  const t = context.t;
  const enabledItem = schemaFieldRow({
    t,
    id: ROW_ENABLED,
    field: VISION_ENABLED_FIELD,
    current: context.getConfig()["enabled"],
  });
  return [
    {
      id: VISION_MENU_ITEM_ID,
      label: t("module.vision.menu.label"),
      description: t("module.vision.menu.description"),
      currentValue: visionEntryValue(runtime.snapshot().route, t),
      submenu: (_currentValue, done) =>
        new VisionPanel({
          t,
          theme: context.theme,
          context: context.context,
          runtime,
          requestRender: () => context.requestRender(),
          enabledItem,
          onFieldChange: (id, value) => context.onChange(id, value),
          onDone: (value) => done(value),
        }),
    },
  ];
}
