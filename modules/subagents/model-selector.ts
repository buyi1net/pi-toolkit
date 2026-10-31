import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { modelOwnThinkingSuffix, type ThinkingLevel } from "./routing.ts";
import {
  baseModelRef,
  isHardBlockedVerdict,
  type ModelHealthMap,
} from "./model-health.ts";

export interface CatalogModel {
  provider: string;
  id: string;

  api?: string;

  baseUrl?: string;

  name?: string;

  reasoning: boolean;

  thinkingLevelMap?: Record<string, string | null>;

  input?: readonly ("text" | "image")[];
}

export type ModelCatalog = {
  getAvailable(): ReadonlyArray<CatalogModel>;
  getAll(): ReadonlyArray<CatalogModel>;
  hasConfiguredAuth?: (...args: any[]) => boolean;
};

export const MODEL_CAPABILITIES = ["vision", "reasoning"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

export function normalizeModelCapability(input: string): ModelCapability | null {
  const value = input.trim().toLowerCase();
  return isModelCapability(value) ? value : null;
}

export function supportedThinkingLevels(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> },
): readonly string[] {
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]);
}

export interface ModelReferenceResolution {
  readonly model: string;
  readonly entry: CatalogModel;
}

export interface ModelReferenceProblem {
  readonly model: string;
  readonly candidates: readonly string[];
  readonly reason: "ambiguous" | "wrong-provider" | "unknown-model";
  readonly message: string;
}

function catalogReference(entry: CatalogModel, thinking: string | null): string {
  return `${entry.provider}/${entry.id}${thinking ? `:${thinking}` : ""}`;
}

export function resolveKnownModelReference(
  modelRef: string,
  catalog: ModelCatalog,
): { resolution: ModelReferenceResolution } | { problem: ModelReferenceProblem } | null {
  const raw = modelRef.trim();
  const own = modelOwnThinkingSuffix(raw);
  const base = own ? raw.slice(0, raw.length - own.length - 1) : raw;
  const suffix = own ? own : null;
  const all = catalog.getAll();
  const exact = all.find((entry) => `${entry.provider}/${entry.id}` === base);
  if (exact) return { resolution: { model: catalogReference(exact, suffix), entry: exact } };

  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) {
    const byId = all.filter((entry) => entry.id === base);
    if (byId.length === 1) {
      return { resolution: { model: catalogReference(byId[0], suffix), entry: byId[0] } };
    }
    if (byId.length > 1) {
      const candidates = byId.map((entry) => catalogReference(entry, suffix));
      return {
        problem: {
          model: raw,
          candidates,
          reason: "ambiguous",
          message:
            `Model reference "${raw}" is ambiguous across providers. Use one exact route: ` +
            `${candidates.join(", ")}.`,
        },
      };
    }
    return null;
  }

  const provider = base.slice(0, slash);
  const id = base.slice(slash + 1);
  const sameId = all.filter((entry) => entry.id === id);
  if (sameId.length > 0) {
    const candidates = sameId.map((entry) => catalogReference(entry, suffix));
    return {
      problem: {
        model: raw,
        candidates,
        reason: "wrong-provider",
        message:
          `Model reference "${raw}" does not match the host model catalog. ` +
          `The model id "${id}" is available as: ${candidates.join(", ")}.`,
      },
    };
  }

  const sameProvider = all.filter((entry) => entry.provider === provider);
  if (sameProvider.length > 0) {
    const candidates = sameProvider.map((entry) => catalogReference(entry, suffix));
    return {
      problem: {
        model: raw,
        candidates,
        reason: "unknown-model",
        message:
          `Model "${raw}" is not available in provider "${provider}". ` +
          `Available routes for that provider: ${candidates.join(", ")}.`,
      },
    };
  }

  return null;
}

export function findCatalogModel(
  modelRef: string,
  catalog: ModelCatalog,
): CatalogModel | null {
  const own = modelOwnThinkingSuffix(modelRef);
  const base = own ? modelRef.slice(0, modelRef.length - own.length - 1) : modelRef;
  const all = catalog.getAll();
  const exact = all.find((entry) => `${entry.provider}/${entry.id}` === base);
  if (exact) return exact;
  const bare = all.filter((entry) => entry.id === base);
  return bare.length === 1 ? bare[0] : null;
}

export function resolveModelThinkingSupport(
  modelRef: string,
  catalog: ModelCatalog,
): readonly string[] | null {
  const model = findCatalogModel(modelRef, catalog);
  return model ? supportedThinkingLevels(model) : null;
}

export function modelMissingCapabilities(
  modelRef: string,
  required: readonly ModelCapability[],
  catalog: ModelCatalog,
): readonly ModelCapability[] | null {
  const entry = findCatalogModel(modelRef, catalog);
  if (!entry) return null;
  return required.filter((capability) => !entryHasCapability(entry, capability));
}

export interface ModelCandidateRejection {

  readonly model: string;

  readonly kind: "capability" | "thinking" | "status";

  readonly reason: string;
}

export const STATUS_SKIP_REASON_PREFIX = "runtime status ";

export const UNSTABLE_SKIP_REASON_PREFIX = "persistent provider instability, skipped";

export const FAILOVER_EXCLUSION_REASON_PREFIX = "excluded by failover policy";

export interface ModelSelectionRequirements {

  capabilities?: readonly ModelCapability[];

  thinking?: ThinkingLevel | null;
}

export interface ModelCandidateSelection {

  readonly model: string;

  readonly rank: number;

  readonly skipped: readonly ModelCandidateRejection[];
}

export interface ModelSelectionFailure {

  readonly pool: readonly string[];

  readonly requirements: ModelSelectionRequirements;

  readonly rejections: readonly ModelCandidateRejection[];
}

function entryHasCapability(entry: CatalogModel, capability: ModelCapability): boolean {
  if (capability === "reasoning") return entry.reasoning === true;

  return entry.input?.includes("image") === true;
}

export function selectModelCandidate(
  pool: readonly string[],
  requirements: ModelSelectionRequirements,
  catalog: ModelCatalog | null | undefined,
  health?: ModelHealthMap,
  exclude?: ReadonlySet<string>,
): { selection: ModelCandidateSelection } | { failure: ModelSelectionFailure } {
  const requiredCapabilities = requirements.capabilities?.filter(Boolean) ?? [];
  const skipped: ModelCandidateRejection[] = [];
  for (let rank = 0; rank < pool.length; rank += 1) {
    const candidate = pool[rank];

    if (exclude?.has(baseModelRef(candidate))) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${FAILOVER_EXCLUSION_REASON_PREFIX} for this spawn (an earlier attempt on this candidate failed)`,
      });
      continue;
    }

    const entry = catalog ? findCatalogModel(candidate, catalog) : null;

    if (entry && requiredCapabilities.length > 0) {
      const missing = requiredCapabilities.filter(
        (capability) => !entryHasCapability(entry, capability),
      );
      if (missing.length > 0) {
        skipped.push({
          model: candidate,
          kind: "capability",
          reason: `missing capabilities: ${missing.join(", ")}`,
        });
        continue;
      }
    }

    const appliedThinking = requirements.thinking ?? modelOwnThinkingSuffix(candidate);
    if (entry && appliedThinking != null) {
      const supported = supportedThinkingLevels(entry);
      if (!supported.includes(appliedThinking)) {
        skipped.push({
          model: candidate,
          kind: "thinking",
          reason:
            `does not support thinking level "${appliedThinking}" ` +
            `(supported: ${supported.join(", ")})`,
        });
        continue;
      }
    }

    const status = health?.get(baseModelRef(candidate));
    if (status && isHardBlockedVerdict(status.verdict)) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${STATUS_SKIP_REASON_PREFIX}${status.verdict}${status.detail ? ` (${status.detail})` : ""}`,
      });
      continue;
    }

    if (status?.signals?.persistentlyUnstable === true) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${UNSTABLE_SKIP_REASON_PREFIX} (${status.detail ?? "repeated transient failures"})`,
      });
      continue;
    }

    return { selection: { model: candidate, rank, skipped } };
  }
  return {
    failure: {
      pool: [...pool],
      requirements: { ...requirements },
      rejections: skipped,
    },
  };
}

export type ModelDirectorySource = "current" | "pool:fast" | "pool:balanced" | "pool:flagship" | "catalog";
export interface ModelIdentity { readonly provider: string; readonly id: string; readonly api: string; readonly baseUrl: string; }
export interface ModelHealthSummary {
  readonly status: string;
  readonly request_count: number;
  readonly error_count: number;
  readonly consecutive_error_count: number;
  readonly last_error_at: number | null;
  readonly last_error_type: string | null;
  readonly detail: string | null;
}
export interface ModelDirectoryEntry extends ModelIdentity {
  readonly name: string;
  readonly sources: readonly ModelDirectorySource[];
  readonly reasoning_effort: readonly string[];
  readonly health: ModelHealthSummary;
}
export interface ModelDirectory { readonly generated_at: string; readonly models: readonly ModelDirectoryEntry[]; }
export interface ModelDirectoryInput {
  readonly currentModel?: CatalogModel | null;
  readonly pools?: Partial<Record<import("./routing.ts").ModelTier, readonly string[]>>;
  readonly modelRegistry: ModelCatalog;
  readonly health?: ModelHealthMap;
  readonly now?: () => number;
}
function directoryIdentity(model: Partial<ModelIdentity> & Pick<ModelIdentity, "provider" | "id">): ModelIdentity {
  return { provider: model.provider.trim(), id: model.id.trim(), api: (model.api ?? "").trim(), baseUrl: (model.baseUrl ?? "").trim() };
}
function directoryIdentityKey(identity: ModelIdentity): string { return JSON.stringify([identity.provider, identity.id, identity.api, identity.baseUrl]); }
function directoryPoolSource(tier: string): ModelDirectorySource { return `pool:${tier}` as ModelDirectorySource; }
function directoryHealth(identity: ModelIdentity, health?: ModelHealthMap): ModelHealthSummary {
  const observed = health?.get(`${identity.provider}/${identity.id}`);
  return {
    status: observed?.verdict ?? "unknown",
    request_count: observed?.request_count ?? 0,
    error_count: observed?.error_count ?? 0,
    consecutive_error_count: observed?.consecutive_error_count ?? 0,
    last_error_at: observed?.last_error_at ?? null,
    last_error_type: observed?.last_error_type ?? null,
    detail: observed?.detail ?? null,
  };
}
export function projectModelDirectoryHealth(directory: ModelDirectory, health?: ModelHealthMap): ModelDirectory {
  return {
    ...directory,
    models: directory.models.map((model) => ({
      ...model,
      health: directoryHealth({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl }, health),
    })),
  };
}

export function buildModelDirectory(input: ModelDirectoryInput): ModelDirectory {
  const isConfigured = (model: CatalogModel): boolean => input.modelRegistry.hasConfiguredAuth?.(model as unknown) ?? true;
  const registryModels = [...input.modelRegistry.getAvailable()].filter(isConfigured);
  const availableIdentityKeys = new Set(registryModels.map((model) => directoryIdentityKey(directoryIdentity(model))));
  type Draft = { identity: ModelIdentity; name: string; sources: Set<ModelDirectorySource>; model: CatalogModel };
  const drafts = new Map<string, Draft>();
  const add = (identity: ModelIdentity, source: ModelDirectorySource, model: CatalogModel) => {
    const key = directoryIdentityKey(identity);
    const existing = drafts.get(key);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    drafts.set(key, { identity, name: model.name?.trim() || identity.id, sources: new Set([source]), model });
  };
  const currentModel = input.currentModel;
  if (currentModel && availableIdentityKeys.has(directoryIdentityKey(directoryIdentity(currentModel)))) {
    const current = registryModels.find((model) => directoryIdentityKey(directoryIdentity(model)) === directoryIdentityKey(directoryIdentity(currentModel)));
    if (current) add(directoryIdentity(current), "current", current);
  }
  for (const tier of ["fast", "balanced", "flagship"] as const) for (const raw of input.pools?.[tier] ?? []) {
    const reference = raw.trim(); const base = baseModelRef(reference); const slash = base.indexOf("/");
    const provider = slash > 0 ? base.slice(0, slash).trim() : ""; const id = (slash > 0 ? base.slice(slash + 1) : base).trim();
    const matches = registryModels.filter((model) => model.provider.trim() === provider && model.id.trim() === id);
    const resolved = matches.length === 1
      ? matches[0]
      : !provider && registryModels.filter((model) => model.id.trim() === id).length === 1
        ? registryModels.find((model) => model.id.trim() === id) ?? null
        : null;
    if (resolved) add(directoryIdentity(resolved), directoryPoolSource(tier), resolved);
  }
  for (const model of registryModels) add(directoryIdentity(model), "catalog", model);
  const sorted = [...drafts.values()].sort((a, b) => directoryIdentityKey(a.identity).localeCompare(directoryIdentityKey(b.identity)));
  const models = sorted.map((draft): ModelDirectoryEntry => ({
    ...draft.identity,
    name: draft.name,
    sources: [...draft.sources].sort() as ModelDirectorySource[],
    reasoning_effort: [...supportedThinkingLevels(draft.model)],
    health: directoryHealth(draft.identity, input.health),
  }));
  const now = input.now ?? Date.now;
  return { generated_at: new Date(now()).toISOString(), models };
}

export interface ModelDirectoryReferenceCandidate extends ModelIdentity {
  readonly name: string;
}

export interface ModelDirectoryReferenceProblem {
  readonly code: "model_ambiguous" | "model_not_found";
  readonly selected_model: string;
  readonly candidates: readonly ModelDirectoryReferenceCandidate[];
  readonly message: string;
}

export interface ModelDirectoryReferenceResolution {
  readonly model: ModelDirectoryEntry;
}

function referenceCandidate(entry: ModelDirectoryEntry): ModelDirectoryReferenceCandidate {
  return {
    provider: entry.provider,
    id: entry.id,
    api: entry.api,
    baseUrl: entry.baseUrl,
    name: entry.name,
  };
}

export function resolveDirectoryModelReference(
  directory: ModelDirectory,
  modelRef: string,
): { resolution: ModelDirectoryReferenceResolution } | { problem: ModelDirectoryReferenceProblem } {
  const raw = modelRef.trim();
  const own = modelOwnThinkingSuffix(raw);
  const base = own ? raw.slice(0, raw.length - own.length - 1) : raw;
  const exact = base.includes("/")
    ? directory.models.filter((entry) => `${entry.provider}/${entry.id}` === base)
    : [];
  const matches = exact.length > 0
    ? exact
    : directory.models.filter((entry) => entry.id === base || entry.name === base);
  const candidates = matches.map(referenceCandidate);
  if (matches.length === 1) return { resolution: { model: matches[0]! } };
  if (matches.length > 1) {
    const routes = matches.map((entry) => `${entry.provider}/${entry.id}`).join(", ");
    return {
      problem: {
        code: "model_ambiguous",
        selected_model: raw,
        candidates,
        message: `Model reference "${raw}" matches multiple available models. Choose one exact provider/model route: ${routes}.`,
      },
    };
  }
  return {
    problem: {
      code: "model_not_found",
      selected_model: raw,
      candidates: [],
      message: `Model reference "${raw}" is not in the current /model available list.`,
    },
  };
}

export const createModelDirectory = buildModelDirectory;
