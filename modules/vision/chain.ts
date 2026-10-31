import {
  callPiVisionModel,
  piVisionModelKey,
  selectAutomaticPiVisionModel,
  type PiVisionModelRegistry,
  type PiVisionModelSelection,
} from "./pi-model-backend.ts";
import { VisionCircuit, TurnMemory, classifyFailure, buildFailureJson, type FailureKind } from "./resilience.ts";
import type { VisionImage } from "./vision-types.ts";

export interface VisionAnswerOk {
  ok: true;
  text: string;
  backend: string;
}

export interface VisionAnswerFail {
  ok: false;
  json: string;
}

export type VisionAnswer = VisionAnswerOk | VisionAnswerFail;

export interface VisionRoutingConfig {
  route: {
    mode: "automatic" | "fixed";
    allowedModels: PiVisionModelSelection[] | null;
    fixedModel?: PiVisionModelSelection;
  };
}

const DEFAULT_ROUTING: VisionRoutingConfig = {
  route: { mode: "automatic", allowedModels: null },
};

export class VisionChain {
  readonly circuit = new VisionCircuit();
  readonly turnMemory = new TurnMemory();
  private turnCount = 0;
  private routing: VisionRoutingConfig = DEFAULT_ROUTING;
  private stickyAutomaticModel?: PiVisionModelSelection;
  private readonly failedAutomaticModels = new Set<string>();

  setRouting(config: VisionRoutingConfig): void {
    if (config.route.mode === "fixed" && !config.route.fixedModel) {
      throw new Error("fixed 路由必须指定 fixedModel");
    }
    this.routing = {
      route: {
        mode: config.route.mode,
        allowedModels: config.route.allowedModels?.map((model) => ({ ...model })) ?? null,
        ...(config.route.fixedModel ? { fixedModel: { ...config.route.fixedModel } } : {}),
      },
    };
    this.stickyAutomaticModel = undefined;
    this.failedAutomaticModels.clear();
  }

  beginTurn(): void {
    this.turnCount += 1;
    this.turnMemory.newTurn(this.turnCount);
  }

  selectTarget(
    registry: PiVisionModelRegistry,
    currentModel?: PiVisionModelSelection,
  ): PiVisionModelSelection | undefined {
    return this.selectPiTarget(registry, currentModel);
  }

  private selectPiTarget(
    registry: PiVisionModelRegistry,
    currentModel?: PiVisionModelSelection,
  ): PiVisionModelSelection | undefined {
    if (this.routing.route.mode === "fixed") return this.routing.route.fixedModel;

    if (this.stickyAutomaticModel) {
      const availableSticky = selectAutomaticPiVisionModel(registry, {
        allowedModels: [this.stickyAutomaticModel],
        excludedModels: this.failedAutomaticModels,
      });
      if (availableSticky) return availableSticky;
      this.stickyAutomaticModel = undefined;
    }
    const selected = selectAutomaticPiVisionModel(registry, {
      currentModel,
      allowedModels: this.routing.route.allowedModels,
      excludedModels: this.failedAutomaticModels,
    });
    this.stickyAutomaticModel = selected;
    return selected;
  }

  async ask(
    registry: PiVisionModelRegistry,
    images: VisionImage[],
    prompt: string,
    options: {
      signal?: AbortSignal;
      deadlineAt: number;
      perCallMs?: number;
      currentModel?: PiVisionModelSelection;
    },
  ): Promise<VisionAnswer> {
    options.signal?.throwIfAborted();
    if (this.turnMemory.allFailed) {
      return { ok: false, json: buildFailureJson(["OTHER"], this.turnMemory.attempts) };
    }

    const piSelection = this.selectPiTarget(registry, options.currentModel);
    if (!piSelection) {
      const attempted = ["pi: no available vision model"];
      this.turnMemory.recordAttempt(attempted[0]);
      this.turnMemory.markAllFailed();
      return { ok: false, json: buildFailureJson(["OTHER"], attempted) };
    }

    const targetId = `${piSelection.provider}/${piSelection.modelId}`;
    const attempted: string[] = [];
    const failureKinds: FailureKind[] = [];
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) {
      failureKinds.push("TIMEOUT");
      attempted.push(`${targetId}: skipped (task deadline exhausted)`);
    } else {
      const gate = this.circuit.inspect(targetId, this.turnCount);
      if (gate.blocked) {
        attempted.push(`${targetId}: skipped (circuit open: ${gate.reason})`);
      } else {
        options.signal?.throwIfAborted();
        const perCall = Math.min(options.perCallMs ?? 60_000, remaining);
        const callSignal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(perCall)])
          : AbortSignal.timeout(perCall);
        try {
          const text = await callPiVisionModel(registry, piSelection, prompt, images, {
            signal: callSignal,
            maxTokens: 4096,
          });
          this.circuit.clear(targetId);
          return { ok: true, text, backend: targetId };
        } catch (error) {
          if (options.signal?.aborted) options.signal.throwIfAborted();
          const failure = classifyFailure({
            message: error instanceof Error ? error.message : String(error),
          });
          this.circuit.record(targetId, failure, this.turnCount);
          if (this.routing.route.mode === "automatic" && failure.kind !== "INVALID_REQUEST") {
            this.failedAutomaticModels.add(piVisionModelKey(piSelection.provider, piSelection.modelId));
            this.stickyAutomaticModel = undefined;
          }
          this.turnMemory.recordAttempt(`${targetId}: ${failure.kind}`);
          attempted.push(`${targetId}: ${failure.kind}`);
          failureKinds.push(failure.kind);
        }
      }
    }

    const automaticCanTryAnotherModel =
      this.routing.route.mode === "automatic" && piSelection !== undefined;

    if (!failureKinds.includes("INVALID_REQUEST") && !automaticCanTryAnotherModel) this.turnMemory.markAllFailed();
    return { ok: false, json: buildFailureJson(failureKinds.length > 0 ? failureKinds : ["OTHER"], attempted) };
  }
}
