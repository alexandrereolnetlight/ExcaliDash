import type { EnvVarSpec } from "./types";

export const AI_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const aiEnv: readonly EnvVarSpec[] = [
  {
    name: "AI_ASSISTANT_ENABLED",
    group: "AI",
    kind: "boolean",
    default: "false",
    doc: "Enable the in-editor AI assistant (chat sidebar that can read and edit the open drawing).",
  },
  {
    name: "AI_PROXY_BASE_URL",
    group: "AI",
    kind: "string",
    doc: "Base URL of the Anthropic Messages API compatible LLM proxy (e.g. LiteLLM); requests go to {base}/v1/messages and keys are validated with {base}/v1/models.",
    example: "https://llm.netlight.ai",
  },
  {
    name: "AI_PROXY_API_KEY",
    group: "AI",
    kind: "string",
    secret: true,
    doc: "Shared proxy key (sent as Authorization: Bearer) used for users who have not saved a personal key; unset means every user needs their own key.",
  },
  {
    name: "AI_MODEL",
    group: "AI",
    kind: "string",
    default: "claude-opus-5-5",
    doc: "Model id the assistant requests from the proxy.",
  },
  {
    name: "AI_EFFORT",
    group: "AI",
    kind: "enum",
    values: AI_EFFORT_VALUES,
    default: "medium",
    doc: "Thinking effort (output_config.effort) for the assistant model; higher is slower and more expensive.",
  },
  {
    name: "AI_KEY_ENCRYPTION_KEY",
    group: "AI",
    kind: "string",
    secret: true,
    doc: "32-byte key (base64 or 64 hex chars) used to encrypt personal proxy keys at rest with AES-256-GCM; unset disables personal keys.",
  },
  {
    name: "AI_SERVER_FALLBACKS",
    group: "AI",
    kind: "boolean",
    default: "false",
    doc: 'Send fallbacks: "default" (beta server-side-fallback-2026-07-01) so a model refusal is retried on a fallback model; off by default because proxies may reject the unknown parameter.',
  },
];
