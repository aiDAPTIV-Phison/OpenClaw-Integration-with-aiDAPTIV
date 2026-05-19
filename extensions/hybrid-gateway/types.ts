// Complexity levels ordered by severity (index = numeric value)
export const COMPLEXITY_LEVELS = [
  "trivial",
  "simple",
  "moderate",
  "complex",
  "expert",
] as const;

export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

export type Skill =
  | "coding"
  | "math"
  | "creative"
  | "analysis"
  | "translation"
  | "search"
  | "tool-use"
  | "image-gen"
  | "conversation"
  | "summarization"
  | "reasoning";

export type Tier = "classifier" | "edge" | "cloud";

export type RoutingPolicy =
  | "edge-first"
  | "cloud-first"
  | "cost-optimize"
  | "quality-first"
  | "cost-optimize-L1"
  | "cost-optimize-L2"
  | "cost-optimize-L3";

// --- Classifier output ---

export type ClassifyResult = {
  complexity: ComplexityLevel;
  skills: Skill[];
};

// --- Router output ---

export type RoutingDecision = {
  provider: string;
  model: string;
  tier: Tier;
  reason: string;
};

// --- Skill route rule ---

export type SkillRoute = {
  skillPattern: string;
  forceTier?: Tier;
  preferModel?: string;
  reason?: string;
};

// --- Model mapping per tier ---

export type TierModelMapping = {
  provider: string;
  model: string;
  /**
   * Hard cap on context tokens for this tier when routing / overflow checks cannot rely on the
   * OpenClaw catalog alone (e.g. llama.cpp `n_ctx` is 18432 but `models.json` still lists 200k).
   * Applied after `resolveContextWindowInfo` as `min(effectiveFromRegistry, contextWindow)`.
   */
  contextWindow?: number;
};

// --- Plugin config (matches openclaw plugin config section) ---

export type ThinkingStrategy = "auto" | "gemma4-raw" | "qwen-nothink";

export type HybridGatewayConfig = {
  classifier: {
    mode: "model" | "heuristic";
    baseUrl: string;
    apiKey: string;
    model: string;
    maxLatencyMs: number;
    cacheEnabled: boolean;
    cacheTtlSeconds: number;
    /** Override the built-in classifier system prompt. */
    systemPrompt?: string;
    /** Suppress model thinking during classification to reduce latency. */
    disableThinking?: boolean;
    /**
     * How to suppress thinking:
     * - "auto": inject /nothink in system prompt (universal) + use raw completions for Gemma 4
     * - "gemma4-raw": raw /v1/completions with no-thinking prompt template
     * - "qwen-nothink": inject /nothink in system prompt (Qwen 3/3.5)
     */
    thinkingStrategy?: ThinkingStrategy;
  };
  routing: {
    policy: RoutingPolicy;
    /**
     * Optional override for `policy`. If provided, this 5-item Tier array is used as a direct
     * complexity → tier lookup table (index 0-4 = trivial, simple, moderate, complex, expert).
     * Each item must be one of "classifier" | "edge" | "cloud".
     *
     * When valid and present, `policy` is ignored. When invalid, an error is logged and the
     * gateway falls back to `policy`.
     *
     * Source key in plugin config can be either `policy-array` (kebab-case) or `policyArray`.
     */
    policyArray?: Tier[];
    skillRoutes: SkillRoute[];
    fallbackEnabled: boolean;
    /** Regex patterns (case-insensitive). Prompts matching any pattern bypass routing override. */
    bypassPatterns?: string[];
    /**
     * When set (tokens), overrides the auto-detected edge context budget (see below).
     * If omitted, OpenClaw uses the registered Edge model effective context window
     * (`models.json` / provider entry, then `agents.defaults.contextTokens` cap), same as the main agent.
     */
    edgeMaxContextTokens?: number;
    /** Reserved tokens for the current turn (system prompt, tools, new user text). Default 8192. */
    contextReserveTokens?: number;
    /**
     * Tier to force when a /new or /reset session-startup prompt is detected.
     * Defaults to `"cloud"`. Use `"classifier"`, `"edge"`, or `"cloud"` (legacy config may use `"gateway"` for the classifier slot).
     */
    newSessionTier?: Tier;
    /**
     * Custom display labels for each tier shown in the chat UI badge.
     * When omitted, defaults to "Edge" for `classifier`/`edge` and "Cloud" for `cloud`.
     */
    tierLabels?: {
      classifier?: string;
      edge?: string;
      cloud?: string;
    };
  };
  models: {
    classifier: TierModelMapping;
    edge: TierModelMapping;
    cloud: TierModelMapping;
  };
};
