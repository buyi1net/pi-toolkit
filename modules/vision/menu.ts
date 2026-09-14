// 视觉配置子菜单（工单 46 起在一级「模型与用量」分组下作为入口行，页内含模块开关）：
// 页面行：
//   视觉辅助     —— 模块总开关（工单 46 从一级收进页内；取值经统一改动入口落盘）
//   视觉模型     —— SelectList 选 auto / off / 具体模型；改模型前先跑真实图片探测，通过才写盘
//   项目层提示   —— 受信任项目层提供了路由时出现（只读）：菜单显示与写盘目标均为全局值
//   刷新模型目录 —— 重读 Pi 的模型目录（不联网），成功后候选列表与目录版本号都刷新
//   运行自检     —— 对当前生效路由发一张探测图（原向导 T 键的等价物），结果进诊断缓存
//   路由状态     —— 只读展示全局路由
//
// 菜单只画界面：路由解析、合并、写盘、描述与缓存协议都在 facade.ts；菜单运行态接口只有
// 「取门面快照」（snapshot）与「保存补丁」（save）两个动作。
//
// 原 setup.ts 里必须保留的业务流程都落在下面这些可单测的函数上：
//   discoverCandidates / routePatchFor / saveRouteSelection / runVisionSelfCheck / refreshVisionCatalogue
// Esc 取消长任务靠 startCancellable 的 AbortController；探测常量在 vision-probe.ts。

import {
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
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
  type VisionFacadePatch,
  type VisionRouteSnapshot,
  type VisionSaveOptions,
} from "./facade.ts";
import { selectAutomaticPiVisionModel, testPiVisionModel } from "./pi-model-backend.ts";
import { VISION_PROBE_EXPECTED, VISION_PROBE_IMAGE } from "./vision-probe.ts";

/** 分组页里的入口行 id */
export const VISION_MENU_ITEM_ID = "vision.settings";

/** 模块开关字段（工单 46）：菜单的开关行与 schema 同源（开关行收进视觉配置页） */
export const VISION_ENABLED_FIELD = enabledField(
  "module.vision.enabled.label",
  "module.vision.enabled.description",
);

/** 页内模块开关行 id（schema 行语义，走统一改动入口） */
const ROW_ENABLED = "vision.enabled";

const ROW_MODEL = "vision.settings.model";
const ROW_PROJECT_OVERRIDE = "vision.settings.projectOverride";
const ROW_REFRESH = "vision.settings.refresh";
const ROW_CHECK = "vision.settings.check";
const ROW_ROUTE = "vision.settings.route";

const VALUE_AUTO = "auto";
const VALUE_OFF = "off";
/** 模型取值编码：provider + NUL + modelId；provider / modelId 里不会出现 NUL */
const MODEL_VALUE_SEPARATOR = "\u0000";

/** 菜单需要的模型注册表能力（取 ModelRegistry 的子集，方便 headless 自测塞 stub） */
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
  /** 该供应商已配置认证；仅用于排序与候选描述 */
  readonly authenticated: boolean;
}

/** 菜单运行态接口（两个动作）：取门面快照、保存补丁 */
export interface VisionMenuRuntime {
  /** 取门面快照：菜单渲染与自检缓存需要的全部当前值 */
  snapshot(): VisionRouteSnapshot;
  /** 保存补丁：路由只写全局层并重读合并；目录刷新与自检结果只更新缓存协议 */
  save(patch: VisionFacadePatch, options?: VisionSaveOptions): Promise<VisionRouteSnapshot>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑：候选发现、取值编码、写盘补丁、诊断缓存键
// ─────────────────────────────────────────────────────────────

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

/** 候选 = 模型目录里声明支持 image 且当前可用的模型；已认证的排前面，其余按 provider/model 排序 */
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

/** 保存前重扫目录用的比较：只比 provider/model 联合键 */
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

/** 选择器取值 → 路由补丁。auto 写 null 白名单，off 写空白名单，固定模型写 fixedModel */
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

/** 当前路由实际会调用的模型；off 返回 undefined，auto 走 Pi 的自动选择规则 */
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

/** 诊断缓存键：目录版本 + 当前选择 + 候选清单 + 会话当前模型 */
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

/** 真实图片探测：发 6 格彩色格子图，6 格过 5 格判通过 */
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

/** 保存路由：先重扫目录，候选变了就中止；路由补丁交给门面（只写全局层），由门面重读并刷新视觉链 */
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

/** 运行自检：对当前生效路由发探测图，命中诊断缓存时直接回放，不重复请求 */
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

/** 重读 Pi 的模型目录（不联网）；provider 报错时把细节带出来 */
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

// ─────────────────────────────────────────────────────────────
// UI：取消控制器 + 状态面板 + 模型选择器 + 主面板
// ─────────────────────────────────────────────────────────────

type StatusColor = "dim" | "warning" | "success" | "error";
type StatusSetter = (text: string, color: StatusColor, running?: boolean) => void;

interface Cancellable {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

/** 自己的 AbortController，并把会话的 ctx.signal 一起接进来；Esc / 卸载时都从这里断路 */
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

/** 一次异步动作的展示面板：运行中显示进度，结束后显示结果，Esc 取消或返回 */
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

/** 视觉模型选择器：SelectList 形态；选具体模型先探测，auto / off 直接写盘 */
export class VisionModelPicker extends Container {
  private readonly options: VisionModelPickerOptions;
  private readonly initialValue: string;
  private readonly list: SelectList;
  private readonly controller: Cancellable;
  private token = 0;
  /** picking：选择列表；busy：探测/保存中（Esc 取消）；settled：结果显示中（Esc 返回） */
  private phase: "picking" | "busy" | "settled" = "picking";

  constructor(options: VisionModelPickerOptions) {
    super();
    this.options = options;
    this.initialValue = routeSelectionValue(options.selection);
    this.controller = startCancellable(options.context.signal);

    this.addChild(new Text(options.theme.title(options.t("module.vision.model.label")), 1, 0));
    const items = this.buildItems();
    const currentIndex = items.findIndex((item) => item.value === this.initialValue);
    this.list = new SelectList(items, Math.min(items.length, 10), options.theme.select);
    if (currentIndex > 0) this.list.setSelectedIndex(currentIndex);
    this.list.onSelect = (item) => {
      void this.choose(item.value);
    };
    this.list.onCancel = () => this.options.onDone();
    this.addChild(this.list);
    if (options.candidates.length === 0) {
      this.addChild(new Text(options.theme.fg("warning", `  ${options.t("module.vision.model.empty")}`), 1, 0));
    }
    this.addChild(new Text(options.theme.hint(options.t("hint.chooseOptions")), 1, 0));
  }

  handleInput(data: string): void {
    if (this.phase === "picking") {
      this.list.handleInput(data);
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

  private buildItems(): SelectItem[] {
    const t = this.options.t;
    const items: SelectItem[] = [
      {
        value: VALUE_AUTO,
        label: t("module.vision.model.auto"),
        description: t("module.vision.model.autoDescription"),
      },
      {
        value: VALUE_OFF,
        label: t("module.vision.model.off"),
        description: t("module.vision.model.offDescription"),
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
  /** 页内模块开关行（工单 46）：由 buildVisionMenuItems 预构造后传入 */
  readonly enabledItem?: SettingItem;
  /** 开关行取值变化经它走统一改动入口（onChange → applyMenuChange）落盘并提示重载 */
  readonly onFieldChange?: (id: string, value: string) => void;
}

/** 视觉配置页：SettingsList 默认开搜索、无标题行（搜索栏即页头，工单 46），子菜单各自负责自己的异步动作 */
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

  /** 行显示回滚入口（与 SettingsPanel.updateValue 同名契约）：委托内层列表 */
  updateValue(id: string, newValue: string): void {
    this.list?.updateValue(id, newValue);
  }

  private close(): void {
    this.options.onDone(routeValueLabel(this.options.runtime.snapshot().route, this.options.t));
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
      // 决策 7：项目层提供了路由就提示（不预设值与全局一定不同），菜单仍显示与写盘全局值
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

/** 模块的菜单行：一行入口，进去是视觉配置页（页内首行是模块开关，项目层提供路由时多一行提示） */
export function buildVisionMenuItems(
  context: ModuleMenuContext,
  runtime: VisionMenuRuntime,
): readonly SettingItem[] {
  const t = context.t;
  const enabledItem = schemaFieldRow({
    t,
    theme: context.theme,
    id: ROW_ENABLED,
    field: VISION_ENABLED_FIELD,
    current: context.getConfig()["enabled"],
  });
  return [
    {
      id: VISION_MENU_ITEM_ID,
      label: t("module.vision.menu.label"),
      description: t("module.vision.menu.description"),
      currentValue: routeValueLabel(runtime.snapshot().route, t),
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
