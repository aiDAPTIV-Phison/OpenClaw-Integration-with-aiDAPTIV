import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../../src/plugin-sdk/agent-dir-compat.js";
import { resolveContextWindowInfo } from "../../src/agents/context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import {
  HYBRID_GATEWAY_CLOUD_FALLBACK_KEY,
  setHybridGatewayCompactionReserveTokens,
  setHybridGatewayEdgeMaxContextTokens,
} from "../../src/agents/hybrid-gateway-cloud-fallback.js";
import { resolveModel } from "../../src/agents/pi-embedded-runner/model.js";
import { resolvePayloadEscalationThreshold } from "../../src/agents/hybrid-gateway-stream-guard.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { createClassifier } from "./classifier.js";
import { route } from "./router.js";
import { COMPLEXITY_LEVELS, type HybridGatewayConfig, type Tier } from "./types.js";

const VALID_TIERS: readonly Tier[] = ["classifier", "edge", "cloud"];

// Minimal plugin API type (avoids importing from openclaw/plugin-sdk which
// fails when the plugin lives outside the OpenClaw package tree).
type BeforeModelResolveEvent = {
  prompt: string;
  approximateContextTokens?: number;
  contextTokensFresh?: boolean;
};

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  /** OpenClaw main config (present when loaded via the plugin host). */
  config?: OpenClawConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void };
  on: (
    hookName: string,
    handler: (
      event: BeforeModelResolveEvent,
      ctx: unknown,
    ) => Promise<{ modelOverride?: string; providerOverride?: string } | void> | void,
  ) => void;
};

// ---- Global routing-decision store (read by gateway chat handler) ----

type StoredRoutingDecision = { tier: string; provider: string; model: string; reason: string; ts: number };
const LAST_DECISION_KEY = "__hybridGatewayLastDecision";

function setLastDecision(decision: StoredRoutingDecision) {
  (globalThis as Record<string, unknown>)[LAST_DECISION_KEY] = decision;
}

// ---- File Logger ----

const LOG_DIR = process.platform === "win32" ? "C:\\tmp\\openclaw" : "/tmp/openclaw";
const LOG_FILE = path.join(LOG_DIR, "hybrid-gateway.log");

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function fileLog(tier: string, provider: string, model: string, complexity: string, skills: string[], prompt: string) {
  const ts = new Date().toISOString();
  const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
  const line = `${ts} | ${tier.padEnd(5)} | ${provider}/${model} | complexity=${complexity} skills=[${skills}] | "${promptPreview}"\n`;
  fsp.appendFile(LOG_FILE, line).catch(() => {});
}

// ---- Defaults ----

const DEFAULT_CONFIG: HybridGatewayConfig = {
  classifier: {
    mode: "model",
    baseUrl: "http://127.0.0.1:13142/v1",
    apiKey: "empty",
    model: "qwen2.5-3b-instruct-q4_k_m",
    maxLatencyMs: 30000,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
  },
  routing: {
    policy: "cost-optimize-L2",
    skillRoutes: [],
    fallbackEnabled: true,
    contextReserveTokens: 0,
    newSessionTier: "cloud",
  },
  models: {
    classifier: { provider: "llamacpp", model: "qwen2.5-3b-instruct-q4_k_m" },
    edge: { provider: "llamacpp", model: "gpt-oss-120b-Q4_K_M" },
    cloud: { provider: "google", model: "gemini-2.5-flash" },
  },
};

function mergeConfig(
  userCfg: Record<string, unknown> | undefined,
): { config: HybridGatewayConfig; rawPolicyArray: unknown; rawPolicyArrayKey: string | undefined } {
  if (!userCfg) {
    return { config: DEFAULT_CONFIG, rawPolicyArray: undefined, rawPolicyArrayKey: undefined };
  }

  const cls = (userCfg.classifier as Record<string, unknown>) ?? {};
  const rt = (userCfg.routing as Record<string, unknown>) ?? {};
  const mdl = (userCfg.models as Record<string, unknown>) ?? {};

  // Accept both kebab-case and camelCase. Kebab-case wins if both are present.
  let rawPolicyArrayKey: string | undefined;
  let rawPolicyArray: unknown;
  if (Object.prototype.hasOwnProperty.call(rt, "policy-array")) {
    rawPolicyArrayKey = "policy-array";
    rawPolicyArray = (rt as Record<string, unknown>)["policy-array"];
  } else if (Object.prototype.hasOwnProperty.call(rt, "policyArray")) {
    rawPolicyArrayKey = "policyArray";
    rawPolicyArray = (rt as Record<string, unknown>).policyArray;
  }

  // Strip both raw aliases from the spread so they don't leak in as untyped props.
  const { ["policy-array"]: _ignoredKebab, policyArray: _ignoredCamel, ...rtRest } = rt as Record<string, unknown> & {
    policyArray?: unknown;
  };
  void _ignoredKebab;
  void _ignoredCamel;

  return {
    config: {
      classifier: { ...DEFAULT_CONFIG.classifier, ...cls } as HybridGatewayConfig["classifier"],
      routing: { ...DEFAULT_CONFIG.routing, ...rtRest } as HybridGatewayConfig["routing"],
      models: {
        classifier: { ...DEFAULT_CONFIG.models.classifier, ...(mdl.classifier as Record<string, unknown> ?? {}) } as HybridGatewayConfig["models"]["classifier"],
        edge: { ...DEFAULT_CONFIG.models.edge, ...(mdl.edge as Record<string, unknown> ?? {}) } as HybridGatewayConfig["models"]["edge"],
        cloud: { ...DEFAULT_CONFIG.models.cloud, ...(mdl.cloud as Record<string, unknown> ?? {}) } as HybridGatewayConfig["models"]["cloud"],
      },
    },
    rawPolicyArray,
    rawPolicyArrayKey,
  };
}

/**
 * Validate `routing.policy-array` (or `routing.policyArray`) from plugin config.
 *
 * Returns the parsed Tier[] when valid (exactly 5 items, each one of
 * "classifier" | "edge" | "cloud"). Returns undefined when not provided.
 * Returns null when the value is present but invalid (caller should log/fall back).
 */
function validatePolicyArray(raw: unknown): { ok: true; value: Tier[] } | { ok: false; reason: string } | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (!Array.isArray(raw)) {
    return { ok: false, reason: `expected an array, got ${typeof raw} (${JSON.stringify(raw)})` };
  }
  if (raw.length !== 5) {
    return { ok: false, reason: `expected exactly 5 items, got ${raw.length}` };
  }
  const invalid: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || !VALID_TIERS.includes(item as Tier)) {
      invalid.push(`[${i}]=${JSON.stringify(item)}`);
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      reason: `each item must be one of [${VALID_TIERS.join(", ")}]; invalid: ${invalid.join(", ")}`,
    };
  }
  return { ok: true, value: raw as Tier[] };
}

function formatPolicyArrayMapping(arr: Tier[]): string {
  return COMPLEXITY_LEVELS.map((lvl, idx) => `${lvl}(${idx})->${arr[idx]}`).join(", ");
}

/**
 * Accepts tier ids plus legacy `"gateway"` (same model slot as `models.classifier`).
 */
function normalizeNewSessionTierInput(raw: unknown): Tier | undefined {
  if (raw === "gateway") return "classifier";
  if (raw === "classifier" || raw === "edge" || raw === "cloud") return raw;
  return undefined;
}

// ---- User Text Extraction ----

/**
 * Strip OpenClaw sender metadata envelope and timestamp prefix from a raw
 * prompt so the classifier only sees the actual user text.
 *
 * Handles the following envelope format injected by OpenClaw:
 *
 *   Sender (untrusted metadata):
 *   ```json
 *   { "label": "...", "id": "..." }
 *   ```
 *
 *   [Wed 2026-04-08 12:25 GMT+8] <actual user text>
 */
export function extractUserText(prompt: string): string {
  let text = prompt;

  // Remove "Sender (untrusted metadata):" block (header + fenced JSON block)
  text = text.replace(/Sender \(untrusted metadata\):\s*```[\s\S]*?```\s*/g, "");

  // Remove leading timestamp prefix like "[Wed 2026-04-08 12:25 GMT+8] "
  text = text.replace(/^\[.*?\]\s*/gm, "");

  return text.trim();
}

const DEFAULT_CONTEXT_RESERVE_TOKENS = 8192;
const STALE_CONTEXT_TOKEN_BUFFER = 2048;

/**
 * Align with {@link resolvePayloadEscalationThreshold} / outbound payload guard:
 * force cloud when session estimate already meets escalation threshold (not only full edge window).
 */
function shouldEscalateContextToCloud(params: {
  approximateContextTokens?: number;
  contextTokensFresh?: boolean;
  edgeMaxContextTokens?: number;
}): boolean {
  const max = params.edgeMaxContextTokens;
  if (max == null || params.approximateContextTokens == null) return false;
  const staleBump = params.contextTokensFresh === false ? STALE_CONTEXT_TOKEN_BUFFER : 0;
  const { escalationThresholdTokens } = resolvePayloadEscalationThreshold(max);
  const effectiveThreshold = Math.max(1, escalationThresholdTokens - staleBump);
  return params.approximateContextTokens >= effectiveThreshold;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

/**
 * Effective edge context budget for overflow routing: explicit `edgeMaxContextTokens` wins;
 * otherwise same effective window as the main agent (`resolveModel` + `resolveContextWindowInfo`).
 */
function resolveEffectiveEdgeMaxContextTokens(params: {
  routing: HybridGatewayConfig["routing"];
  edge: HybridGatewayConfig["models"]["edge"];
  openClawConfig: OpenClawConfig | undefined;
  log: Pick<PluginApi["logger"], "info" | "warn">;
}): number | undefined {
  const explicit = normalizePositiveInt(params.routing.edgeMaxContextTokens);
  if (explicit != null) {
    return explicit;
  }

  const provider = params.edge.provider?.trim();
  const modelId = params.edge.model?.trim();
  if (!provider || !modelId) {
    params.log.warn(`[hybrid-gw] edgeMaxContextTokens: missing edge provider/model; context overflow routing disabled`);
    return undefined;
  }

  try {
    const agentDir = resolveOpenClawAgentDir();
    const { model, error } = resolveModel(provider, modelId, agentDir, params.openClawConfig);
    if (!model) {
      params.log.warn(
        `[hybrid-gw] edgeMaxContextTokens: unknown edge model ${provider}/${modelId}${error ? ` (${error})` : ""}; set routing.edgeMaxContextTokens or register the model`,
      );
      return undefined;
    }
    const ctxInfo = resolveContextWindowInfo({
      cfg: params.openClawConfig,
      provider,
      modelId,
      modelContextWindow: model.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    const pluginEdgeCap = normalizePositiveInt(params.edge.contextWindow);
    let tokens = ctxInfo.tokens;
    let sourceLabel: string = ctxInfo.source;
    if (pluginEdgeCap != null && tokens > pluginEdgeCap) {
      tokens = pluginEdgeCap;
      sourceLabel = `${ctxInfo.source}+models.edge.contextWindow`;
    }
    params.log.info(
      `[hybrid-gw] edgeMaxContextTokens: using effective context (${tokens} tokens, source=${sourceLabel}` +
        (pluginEdgeCap != null ? `, models.edge.contextWindow cap=${pluginEdgeCap}` : "") +
        `) for ${provider}/${modelId}`,
    );
    return tokens;
  } catch (err) {
    params.log.warn(
      `[hybrid-gw] edgeMaxContextTokens: failed to resolve ${provider}/${modelId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

// ---- Plugin Definition ----

const hybridGatewayPlugin = {
  id: "hybrid-gateway",
  name: "Hybrid Gateway",
  description:
    "Routes requests between local (edge) and cloud models based on complexity classification. Prioritizes local models for cost reduction.",

  register(api: PluginApi) {
    const merged = mergeConfig(api.pluginConfig);
    const config = merged.config;
    const log = api.logger;

    ensureLogDir();

    // Validate routing.policy-array (overrides routing.policy when valid).
    const policyArrayKey = merged.rawPolicyArrayKey ?? "policy-array";
    const validation = validatePolicyArray(merged.rawPolicyArray);
    if (validation === undefined) {
      // Not provided -> fall through to existing routing.policy logic. No special handling.
    } else if (!validation.ok) {
      log.error(
        `[hybrid-gw] config.routing.${policyArrayKey} invalid: ${validation.reason}. ` +
          `Falling back to routing.policy="${config.routing.policy}".`,
      );
    } else {
      config.routing.policyArray = validation.value;
      log.info(
        `[hybrid-gw] config.routing.${policyArrayKey} enabled: routing.policy="${config.routing.policy}" is IGNORED.`,
      );
      log.info(
        `[hybrid-gw] policy-array mapping: ${formatPolicyArrayMapping(validation.value)}`,
      );
    }

    // Clear stale hybrid-gateway globals before resolving edge max so inner
    // resolveContextWindowInfo() is not capped by a previous plugin registration.
    setHybridGatewayEdgeMaxContextTokens(undefined);
    setHybridGatewayCompactionReserveTokens(undefined);

    const effectiveEdgeMaxContextTokens = resolveEffectiveEdgeMaxContextTokens({
      routing: config.routing,
      edge: config.models.edge,
      openClawConfig: api.config,
      log,
    });

    (globalThis as Record<string, unknown>)[HYBRID_GATEWAY_CLOUD_FALLBACK_KEY] = {
      provider: config.models.cloud.provider,
      model: config.models.cloud.model,
    };
    setHybridGatewayEdgeMaxContextTokens(effectiveEdgeMaxContextTokens);
    setHybridGatewayCompactionReserveTokens(
      config.routing.contextReserveTokens ?? DEFAULT_CONTEXT_RESERVE_TOKENS,
    );

    const policyDescriptor = config.routing.policyArray
      ? `policy-array=[${config.routing.policyArray.join(",")}] (overrides policy="${config.routing.policy}")`
      : `policy=${config.routing.policy}`;

    // Validate newSessionTier (classifier / edge / cloud, or legacy "gateway" → classifier)
    const FAILSAFE_NEW_SESSION: Tier = "cloud";
    const rawNewSession = (config.routing as { newSessionTier?: unknown }).newSessionTier;
    let newSessionTier: Tier = normalizeNewSessionTierInput(rawNewSession) ?? FAILSAFE_NEW_SESSION;
    if (rawNewSession !== undefined && normalizeNewSessionTierInput(rawNewSession) === undefined) {
      log.warn(
        `[hybrid-gw] invalid routing.newSessionTier=${JSON.stringify(rawNewSession)}, falling back to "${FAILSAFE_NEW_SESSION}"`,
      );
      newSessionTier = FAILSAFE_NEW_SESSION;
    }
    if (!config.models[newSessionTier]?.provider || !config.models[newSessionTier]?.model) {
      log.warn(
        `[hybrid-gw] routing.newSessionTier="${newSessionTier}" has no provider/model configured, falling back to "${FAILSAFE_NEW_SESSION}"`,
      );
      newSessionTier = FAILSAFE_NEW_SESSION;
    }

    log.info(
      `[hybrid-gw] initializing: ${policyDescriptor}, ` +
      `classifier=${config.classifier.mode}, ` +
      `newSessionTier=${newSessionTier}, ` +
      `classifierModel=${config.models.classifier.provider}/${config.models.classifier.model}, ` +
      `edge=${config.models.edge.provider}/${config.models.edge.model}, ` +
      `cloud=${config.models.cloud.provider}/${config.models.cloud.model}` +
      (effectiveEdgeMaxContextTokens != null
        ? `, edgeMaxCtx=${effectiveEdgeMaxContextTokens}` +
          (normalizePositiveInt(config.routing.edgeMaxContextTokens) != null
            ? " (explicit)"
            : " (from OpenClaw model registry)") +
          ` reserve=${config.routing.contextReserveTokens ?? DEFAULT_CONTEXT_RESERVE_TOKENS}`
        : ""),
    );
    log.info(`[hybrid-gw] routing log -> ${LOG_FILE}`);

    const classifier = createClassifier({
      ...config.classifier,
      logger: log,
    });

    api.on("before_model_resolve", async (event, _ctx) => {
      const prompt = event.prompt;
      const approxTokens = event.approximateContextTokens;
      const approxFresh = event.contextTokensFresh;
      const t0 = performance.now();

      const reserve =
        config.routing.contextReserveTokens ?? DEFAULT_CONTEXT_RESERVE_TOKENS;
      const edgeMax = effectiveEdgeMaxContextTokens;

      const escalateContext = () =>
        shouldEscalateContextToCloud({
          approximateContextTokens: approxTokens,
          contextTokensFresh: approxFresh,
          edgeMaxContextTokens: edgeMax,
        });

      // /new or /reset startup → force the configured tier for this request
      if (prompt?.includes("A new session was started via /new or /reset")) {
        const target = config.models[newSessionTier];
        const reason = `force-${newSessionTier} (new session startup)`;
        log.info(`[hybrid-gw] ${reason} -> ${target.provider}/${target.model}`);
        setLastDecision({
          tier: newSessionTier,
          provider: target.provider,
          model: target.model,
          reason,
          ts: Date.now(),
        });
        return { providerOverride: target.provider, modelOverride: target.model };
      }

      // Session estimate already at/above payload escalation threshold → cloud (skip classifier)
      if (escalateContext()) {
        const cloud = config.models.cloud;
        const thr =
          edgeMax != null ? resolvePayloadEscalationThreshold(edgeMax).escalationThresholdTokens : undefined;
        log.info(
          `[hybrid-gw] force-cloud (edge payload escalation threshold) approxTokens=${approxTokens} edgeMax=${edgeMax} escalationThresholdTokens=${thr ?? "n/a"} reserve=${reserve} fresh=${approxFresh === undefined ? "n/a" : String(approxFresh)} -> ${cloud.provider}/${cloud.model}`,
        );
        setLastDecision({
          tier: "cloud",
          provider: cloud.provider,
          model: cloud.model,
          reason: `edge-payload-escalation approx=${approxTokens} max=${edgeMax} escalationThreshold=${thr ?? "?"} reserve=${reserve}`,
          ts: Date.now(),
        });
        return { providerOverride: cloud.provider, modelOverride: cloud.model };
      }

      if (!prompt?.trim()) return;

      const bypassPatterns = config.routing.bypassPatterns ?? [];
      for (const pattern of bypassPatterns) {
        if (new RegExp(pattern, "i").test(prompt)) {
          log.info(`[hybrid-gw] bypass: matched pattern "${pattern}", skipping routing`);
          return undefined;
        }
      }

      try {
        const t1 = performance.now();
        const classifyInput = extractUserText(prompt);
        const classifyResult = await classifier.classify(classifyInput);
        log.info(`[hybrid-gw] classify input (extracted): "${classifyInput.slice(0, 120)}${classifyInput.length > 120 ? "..." : ""}"`);
        const t2 = performance.now();
        const decision = route(classifyResult, config);
        const t3 = performance.now();

        log.info(
          `[hybrid-gw] route: ${decision.tier} -> ${decision.provider}/${decision.model} | ${decision.reason}`,
        );
        log.info(
          `[hybrid-gw] timing: classify=${(t2 - t1).toFixed(1)}ms route=${(t3 - t2).toFixed(1)}ms total=${(t3 - t0).toFixed(1)}ms`,
        );

        fileLog(
          decision.tier,
          decision.provider,
          decision.model,
          classifyResult.complexity,
          classifyResult.skills,
          prompt,
        );

        setLastDecision({
          tier: decision.tier,
          provider: decision.provider,
          model: decision.model,
          reason: decision.reason,
          ts: Date.now(),
        });

        return {
          providerOverride: decision.provider,
          modelOverride: decision.model,
        };
      } catch (err) {
        log.warn(
          `[hybrid-gw] routing failed, letting OpenClaw use default model: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    });
  },
};

export default hybridGatewayPlugin;
