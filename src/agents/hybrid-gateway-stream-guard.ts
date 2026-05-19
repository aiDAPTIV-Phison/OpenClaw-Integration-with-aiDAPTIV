import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  getHybridGatewayCloudFallback,
  getHybridGatewayCompactionReserveTokens,
  getHybridGatewayEdgeMaxContextTokens,
  HybridGatewayPayloadTooLargeForEdgeError,
  type HybridGatewayPayloadTooLargeDetails,
} from "./hybrid-gateway-cloud-fallback.js";
import { normalizeProviderId } from "./model-selection.js";

/** Floor slack vs coarse token estimates (chars/4 + JSON.stringify tools). */
const TOKEN_ESTIMATE_UNCERTAINTY_MARGIN_BASE = 4096;

let pendingPayloadEscalationDetails: HybridGatewayPayloadTooLargeDetails | undefined;

/**
 * Consumes payload→cloud escalation metadata after a guard-triggered synthetic LLM error stream.
 * pi-agent-core starts `agentLoop` in a fire-and-forget async IIFE; if `streamFn` rejects (or the
 * wrapped stream throws before yielding), `runLoop` rejects and Node reports an unhandled rejection.
 */
export function takeHybridGatewayPayloadEscalationPending(): HybridGatewayPayloadTooLargeDetails | undefined {
  const d = pendingPayloadEscalationDetails;
  pendingPayloadEscalationDetails = undefined;
  return d;
}

type StreamModel = Parameters<StreamFn>[0];

function createPayloadTooLargeAssistantStream(
  model: StreamModel,
  error: HybridGatewayPayloadTooLargeForEdgeError,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [] as [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: error.message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
}

/** Exported for unit tests and diagnostics. */
export function resolvePayloadEscalationThreshold(edgeMax: number): {
  reserveTokens: number;
  safeHeadroomTokens: number;
  escalationThresholdTokens: number;
  uncertaintyMarginTokens: number;
} {
  const reserveTokens = getHybridGatewayCompactionReserveTokens() ?? 0;
  const safeHeadroomTokens = Math.max(0, edgeMax - reserveTokens);
  const scaledMargin = Math.floor(edgeMax * 0.12);
  const uncertaintyMarginTokens = Math.max(TOKEN_ESTIMATE_UNCERTAINTY_MARGIN_BASE, scaledMargin);
  const escalationThresholdTokens = Math.max(
    1,
    safeHeadroomTokens - uncertaintyMarginTokens,
  );
  return { reserveTokens, safeHeadroomTokens, escalationThresholdTokens, uncertaintyMarginTokens };
}

/**
 * Mirrors what actually hits the wire on OpenAI-compat chat completions: messages,
 * system prompt, and the serialized `tools` JSON (schemas are omitted from per-message
 * token estimates but still consume context on the server).
 */
export function estimateHybridGatewayOutboundTokens(context: unknown): number | undefined {
  const breakdown = estimateHybridGatewayOutboundTokensBreakdown(context);
  return breakdown?.total;
}

/**
 * Component-level breakdown for diagnostics: tells you whether the base cost is
 * dominated by system prompt, tools schema, or accumulated message history.
 */
export function estimateHybridGatewayOutboundTokensBreakdown(context: unknown):
  | {
      total: number;
      messages: number;
      messageCount: number;
      systemPrompt: number;
      tools: number;
      toolCount: number;
    }
  | undefined {
  const ctx = context as {
    messages?: unknown;
    systemPrompt?: unknown;
    tools?: unknown;
  };
  const messages = ctx.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  let messagesTokens = 0;
  for (const m of messages) {
    messagesTokens += estimateTokens(m as AgentMessage);
  }
  let systemPromptTokens = 0;
  if (typeof ctx.systemPrompt === "string" && ctx.systemPrompt.length > 0) {
    systemPromptTokens = Math.ceil(ctx.systemPrompt.length / 4);
  }
  let toolsTokens = 0;
  let toolCount = 0;
  if (ctx.tools != null) {
    try {
      toolsTokens = Math.ceil(JSON.stringify(ctx.tools).length / 4);
      if (Array.isArray(ctx.tools)) {
        toolCount = ctx.tools.length;
      } else if (typeof ctx.tools === "object") {
        toolCount = Object.keys(ctx.tools as Record<string, unknown>).length;
      }
    } catch {
      /* ignore non-serializable tools */
    }
  }
  return {
    total: messagesTokens + systemPromptTokens + toolsTokens,
    messages: messagesTokens,
    messageCount: messages.length,
    systemPrompt: systemPromptTokens,
    tools: toolsTokens,
    toolCount,
  };
}

/**
 * Before each outbound LLM call (including tool-result continuation rounds), estimate
 * prompt+history tokens. If hybrid-gateway set an edge budget and we're not already on
 * the configured cloud model, return a synthetic LLM error stream (not `throw`) so
 * `pi-agent-core` does not surface an unhandled rejection; call sites should read
 * {@link takeHybridGatewayPayloadEscalationPending} after `prompt()` and map to
 * {@link HybridGatewayPayloadTooLargeForEdgeError} for cloud retry.
 *
 * Escalation uses the same safe headroom as hybrid-gateway routing (`edgeMax - reserve`),
 * minus a fixed underestimate margin so we cloud-escape before the edge backend hits a hard
 * context overflow on large tool results.
 */
export function wrapStreamFnHybridGatewayEdgePayloadGuard(params: {
  baseFn: StreamFn;
  attemptProvider: string;
  attemptModelId: string;
}): StreamFn {
  const inner = params.baseFn;
  return ((model, context, options) => {
    takeHybridGatewayPayloadEscalationPending();
    const edgeMax = getHybridGatewayEdgeMaxContextTokens();
    const cloudFb = getHybridGatewayCloudFallback();
    if (edgeMax == null || cloudFb == null) {
      return inner(model, context, options);
    }
    if (
      normalizeProviderId(params.attemptProvider) === normalizeProviderId(cloudFb.provider) &&
      params.attemptModelId === cloudFb.model
    ) {
      return inner(model, context, options);
    }
    let estimated: number;
    let breakdown:
      | ReturnType<typeof estimateHybridGatewayOutboundTokensBreakdown>
      | undefined;
    try {
      breakdown = estimateHybridGatewayOutboundTokensBreakdown(context);
      if (breakdown == null) {
        return inner(model, context, options);
      }
      estimated = breakdown.total;
    } catch {
      return inner(model, context, options);
    }
    const thresholdParts = resolvePayloadEscalationThreshold(edgeMax);
    if (estimated >= thresholdParts.escalationThresholdTokens) {
      const details: HybridGatewayPayloadTooLargeDetails = {
        estimatedTokens: estimated,
        edgeMaxTokens: edgeMax,
        reserveTokens: thresholdParts.reserveTokens,
        safeHeadroomTokens: thresholdParts.safeHeadroomTokens,
        escalationThresholdTokens: thresholdParts.escalationThresholdTokens,
      };
      pendingPayloadEscalationDetails = details;
      return createPayloadTooLargeAssistantStream(
        model,
        new HybridGatewayPayloadTooLargeForEdgeError(details),
      );
    }
    return inner(model, context, options);
  }) as StreamFn;
}
