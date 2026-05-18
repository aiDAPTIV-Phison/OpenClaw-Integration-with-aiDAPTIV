import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  HYBRID_GATEWAY_CLOUD_FALLBACK_KEY,
  setHybridGatewayCompactionReserveTokens,
  setHybridGatewayEdgeMaxContextTokens,
} from "./hybrid-gateway-cloud-fallback.js";
import {
  estimateHybridGatewayOutboundTokens,
  resolvePayloadEscalationThreshold,
  takeHybridGatewayPayloadEscalationPending,
  wrapStreamFnHybridGatewayEdgePayloadGuard,
} from "./hybrid-gateway-stream-guard.js";

describe("estimateHybridGatewayOutboundTokens", () => {
  it("includes OpenAI tool definitions in the total (schemas are not in message bodies)", () => {
    const base = {
      messages: [{ role: "user", content: "hi" }] as AgentMessage[],
      systemPrompt: "",
    };
    const withoutTools = estimateHybridGatewayOutboundTokens(base);
    const withTools = estimateHybridGatewayOutboundTokens({
      ...base,
      tools: [
        {
          type: "function",
          function: {
            name: "example_tool",
            description: "d".repeat(12_000),
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(withoutTools).toBeDefined();
    expect(withTools).toBeDefined();
    expect((withTools ?? 0) - (withoutTools ?? 0)).toBeGreaterThan(2000);
  });
});

describe("resolvePayloadEscalationThreshold", () => {
  afterEach(() => {
    setHybridGatewayCompactionReserveTokens(undefined);
  });

  it("uses edgeMax - reserve - uncertainty margin as escalation threshold", () => {
    setHybridGatewayCompactionReserveTokens(8192);
    const t = resolvePayloadEscalationThreshold(18432);
    expect(t.reserveTokens).toBe(8192);
    expect(t.safeHeadroomTokens).toBe(18432 - 8192);
    expect(t.uncertaintyMarginTokens).toBe(Math.max(4096, Math.floor(18432 * 0.12)));
    expect(t.escalationThresholdTokens).toBe(
      Math.max(1, 18432 - 8192 - t.uncertaintyMarginTokens),
    );
  });

  it("applies uncertainty margin when reserve is zero", () => {
    setHybridGatewayCompactionReserveTokens(0);
    const t = resolvePayloadEscalationThreshold(18432);
    expect(t.safeHeadroomTokens).toBe(18432);
    expect(t.uncertaintyMarginTokens).toBe(Math.max(4096, Math.floor(18432 * 0.12)));
    expect(t.escalationThresholdTokens).toBe(
      Math.max(1, 18432 - t.uncertaintyMarginTokens),
    );
  });
});

describe("wrapStreamFnHybridGatewayEdgePayloadGuard", () => {
  afterEach(() => {
    setHybridGatewayEdgeMaxContextTokens(undefined);
    setHybridGatewayCompactionReserveTokens(undefined);
    delete (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY];
  });

  it("returns a synthetic error stream (no inner call) when over threshold and exposes pending details", async () => {
    setHybridGatewayEdgeMaxContextTokens(10_000);
    setHybridGatewayCompactionReserveTokens(0);
    (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY] = {
      provider: "openrouter",
      model: "cloud-model",
    };

    const inner = vi.fn();
    const wrapped = wrapStreamFnHybridGatewayEdgePayloadGuard({
      baseFn: inner as Parameters<typeof wrapStreamFnHybridGatewayEdgePayloadGuard>[0]["baseFn"],
      attemptProvider: "llamacpp-large",
      attemptModelId: "google/gemma",
    });

    const threshold = resolvePayloadEscalationThreshold(10_000).escalationThresholdTokens;
    const filler = "x".repeat(Math.ceil((threshold + 800) * 4));
    const messages: AgentMessage[] = [{ role: "user", content: filler, timestamp: Date.now() }];
    let estimated = 0;
    for (const m of messages) {
      estimated += estimateTokens(m);
    }
    expect(estimated).toBeGreaterThanOrEqual(threshold);

    const model = { api: "openai-completions", provider: "x", id: "y" } as never;
    const stream = await Promise.resolve(
      wrapped(model, { messages, systemPrompt: "" } as never, {} as never),
    );
    for await (const _ of stream) {
      /* consume */
    }
    const finalMessage = await stream.result();
    expect(finalMessage.stopReason).toBe("error");
    expect(finalMessage.errorMessage).toContain("Hybrid gateway:");

    const pending = takeHybridGatewayPayloadEscalationPending();
    expect(pending).toMatchObject({
      estimatedTokens: estimated,
      edgeMaxTokens: 10_000,
    });
    expect(pending?.escalationThresholdTokens).toBe(threshold);

    expect(inner).not.toHaveBeenCalled();
  });

  it("escalates when tools JSON pushes total over threshold even with a short user message", async () => {
    setHybridGatewayEdgeMaxContextTokens(20_000);
    setHybridGatewayCompactionReserveTokens(0);
    (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY] = {
      provider: "openrouter",
      model: "cloud-model",
    };
    const inner = vi.fn();
    const wrapped = wrapStreamFnHybridGatewayEdgePayloadGuard({
      baseFn: inner as Parameters<typeof wrapStreamFnHybridGatewayEdgePayloadGuard>[0]["baseFn"],
      attemptProvider: "llamacpp-large",
      attemptModelId: "google/gemma",
    });
    const threshold = resolvePayloadEscalationThreshold(20_000).escalationThresholdTokens;
    const tools = [
      {
        type: "function",
        function: {
          name: "bulk_schema",
          description: "p".repeat(threshold * 4 + 8000),
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const est = estimateHybridGatewayOutboundTokens({
      messages: [{ role: "user", content: "short" }],
      systemPrompt: "",
      tools,
    });
    expect(est).toBeDefined();
    expect(est!).toBeGreaterThanOrEqual(threshold);

    const model = { api: "openai-completions", provider: "x", id: "y" } as never;
    const stream = await Promise.resolve(
      wrapped(
        model,
        {
          messages: [{ role: "user", content: "short", timestamp: Date.now() }],
          systemPrompt: "",
          tools,
        } as never,
        {} as never,
      ),
    );
    for await (const _ of stream) {
      /* consume */
    }
    expect((await stream.result()).stopReason).toBe("error");
    expect(takeHybridGatewayPayloadEscalationPending()).toBeDefined();
    expect(inner).not.toHaveBeenCalled();
  });

  it("calls inner when under threshold", async () => {
    setHybridGatewayEdgeMaxContextTokens(50_000);
    setHybridGatewayCompactionReserveTokens(0);
    (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY] = {
      provider: "openrouter",
      model: "cloud-model",
    };

    const inner = vi.fn().mockResolvedValue(undefined);
    const wrapped = wrapStreamFnHybridGatewayEdgePayloadGuard({
      baseFn: inner as Parameters<typeof wrapStreamFnHybridGatewayEdgePayloadGuard>[0]["baseFn"],
      attemptProvider: "llamacpp-large",
      attemptModelId: "google/gemma",
    });

    await wrapped(
      {} as never,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], systemPrompt: "" } as never,
      {} as never,
    );

    expect(inner).toHaveBeenCalledTimes(1);
  });
});
