import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Hybrid-gateway plugin registers cloud tier here so the embedded runner can
 * retry once on context-overflow without requiring agents.defaults.models.fallbacks.
 */
export const HYBRID_GATEWAY_CLOUD_FALLBACK_KEY = "__hybridGatewayCloudFallback";

/** Stable substring in {@link HybridGatewayPayloadTooLargeForEdgeError} messages (session cleanup / UI). */
export const HYBRID_GATEWAY_PAYLOAD_ESCALATION_ERR_MARKER =
  "Hybrid gateway: estimated LLM payload";

const HYBRID_GATEWAY_LAST_DECISION_UI_KEY = "__hybridGatewayLastDecision";

export function isHybridGatewayPayloadEscalationAssistantMessage(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  const a = msg as AssistantMessage;
  return (
    a.stopReason === "error" &&
    typeof a.errorMessage === "string" &&
    a.errorMessage.includes(HYBRID_GATEWAY_PAYLOAD_ESCALATION_ERR_MARKER)
  );
}

/**
 * Removes the synthetic assistant error emitted by the edge payload guard so the agent can
 * {@link Agent#continue} on cloud without appending a duplicate user turn.
 */
export function stripTrailingHybridGatewayPayloadEscalationAssistant(
  messages: AgentMessage[],
): AgentMessage[] {
  if (messages.length === 0) {
    return messages;
  }
  const last = messages[messages.length - 1];
  if (!isHybridGatewayPayloadEscalationAssistantMessage(last)) {
    return messages;
  }
  return messages.slice(0, -1);
}

/**
 * Publishes a routing decision for the gateway WebChat handler (`consumeLastHybridGatewayDecision`).
 * Used when the embedded runner escalates to cloud mid-run (no second classifier pass).
 */
export function publishHybridGatewayRoutingDecisionForUi(params: {
  tier: string;
  provider: string;
  model: string;
  reason?: string;
}): void {
  const g = globalThis as Record<string, unknown>;
  g[HYBRID_GATEWAY_LAST_DECISION_UI_KEY] = {
    tier: params.tier,
    provider: params.provider,
    model: params.model,
    reason: params.reason ?? "routing",
    ts: Date.now(),
  };
}

/** Effective edge context budget (tokens) for per-request payload checks (tool loops). */
export const HYBRID_GATEWAY_EDGE_MAX_CONTEXT_KEY = "__hybridGatewayEdgeMaxContextTokens";

/** routing.contextReserveTokens mirrored for Pi auto-compaction shouldCompact alignment. */
export const HYBRID_GATEWAY_COMPACTION_RESERVE_KEY = "__hybridGatewayCompactionReserveTokens";

export type HybridGatewayPayloadTooLargeDetails = {
  estimatedTokens: number;
  edgeMaxTokens: number;
  reserveTokens: number;
  safeHeadroomTokens: number;
  escalationThresholdTokens: number;
};

export class HybridGatewayPayloadTooLargeForEdgeError extends Error {
  readonly code = "hybrid_gateway_payload_cloud_escalation" as const;

  constructor(readonly details: HybridGatewayPayloadTooLargeDetails) {
    super(
      `${HYBRID_GATEWAY_PAYLOAD_ESCALATION_ERR_MARKER} ${details.estimatedTokens} tokens >= escalation threshold ${details.escalationThresholdTokens} ` +
        `(edgeMax=${details.edgeMaxTokens} reserve=${details.reserveTokens} safeHeadroom=${details.safeHeadroomTokens}); retry with cloud model.`,
    );
    this.name = "HybridGatewayPayloadTooLargeForEdgeError";
  }
}

export function setHybridGatewayEdgeMaxContextTokens(value: number | undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (value == null || !Number.isFinite(value) || value <= 0) {
    delete g[HYBRID_GATEWAY_EDGE_MAX_CONTEXT_KEY];
    return;
  }
  g[HYBRID_GATEWAY_EDGE_MAX_CONTEXT_KEY] = Math.floor(value);
}

export function getHybridGatewayEdgeMaxContextTokens(): number | undefined {
  const v = (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_EDGE_MAX_CONTEXT_KEY];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    return undefined;
  }
  return Math.floor(v);
}

export function setHybridGatewayCompactionReserveTokens(value: number | undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (value == null || !Number.isFinite(value) || value < 0) {
    delete g[HYBRID_GATEWAY_COMPACTION_RESERVE_KEY];
    return;
  }
  g[HYBRID_GATEWAY_COMPACTION_RESERVE_KEY] = Math.floor(value);
}

export function getHybridGatewayCompactionReserveTokens(): number | undefined {
  const v = (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_COMPACTION_RESERVE_KEY];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return undefined;
  }
  return Math.floor(v);
}

export type HybridGatewayCloudFallback = {
  provider: string;
  model: string;
};

export function getHybridGatewayCloudFallback(): HybridGatewayCloudFallback | undefined {
  const raw = (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const provider = (raw as { provider?: unknown }).provider;
  const model = (raw as { model?: unknown }).model;
  if (typeof provider !== "string" || typeof model !== "string") {
    return undefined;
  }
  const p = provider.trim();
  const m = model.trim();
  if (!p || !m) {
    return undefined;
  }
  return { provider: p, model: m };
}
