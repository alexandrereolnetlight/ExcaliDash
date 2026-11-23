/**
 * The assistant's agent loop: the Anthropic SDK Tool Runner (beta) in
 * streaming mode, with the shared drawing tools. Each iteration yields a
 * message stream whose text deltas are forwarded as they arrive; tool calls
 * report a short summary when they finish.
 *
 * Request shape (sent to {AI_PROXY_BASE_URL}/v1/messages):
 * - model AI_MODEL, max_tokens 16000, stream
 * - thinking { type: "adaptive" } + output_config.effort = AI_EFFORT (no
 *   budget_tokens, no temperature: thinking can't be disabled on Opus 5.5)
 * - system: one static text block with cache_control (caches tools + system)
 * - metadata.user_id: the Excalight user id, so LiteLLM attributes spend
 * - tools without eager_input_streaming (it goes through a proxy), no
 *   tool_choice (auto), no assistant prefill
 * - full history every turn (`thread: false`: no message-threads beta)
 * - optional fallbacks: "default" + beta server-side-fallback-2026-07-01
 */
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import type { AiEffort } from "../config/ai";
import { DRAWING_TOOLS, type DrawingToolContext } from "../tools/drawingTools";
import { ASSISTANT_SYSTEM_PROMPT } from "./prompt";

export const AGENT_MAX_TOKENS = 16_000;
export const AGENT_MAX_ITERATIONS = 15;
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string; isError: boolean };

export type AgentUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type AgentOutcome =
  "completed" | "max_iterations" | "refusal" | "max_tokens";

export type AgentRunResult = {
  outcome: AgentOutcome;
  stopReason: string | null;
  iterations: number;
  usage: AgentUsage;
  changedDrawing: boolean;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type RunAgentOptions = {
  client: Anthropic;
  model: string;
  effort: AiEffort;
  serverFallbacks: boolean;
  /** Stable pseudonymous id for metadata.user_id. */
  userId: string;
  history: readonly ChatTurn[];
  /** Latest user turn: the <context> block and the user's message. */
  contextBlock: string;
  message: string;
  toolContext: DrawingToolContext;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
};

const addUsage = (
  total: AgentUsage,
  usage: Partial<Record<keyof AgentUsage, number | null>> | undefined,
) => {
  if (!usage) return;
  for (const key of Object.keys(total) as (keyof AgentUsage)[]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total[key] += value;
    }
  }
};

export const toInlineInputSchema = (
  schema: z.ZodObject<z.ZodRawShape>,
): Anthropic.Beta.BetaTool.InputSchema => {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, {
    reused: "inline",
    io: "input",
  }) as Record<string, unknown>;
  return { ...jsonSchema, type: "object" };
};

export const buildAgentMessages = (
  history: readonly ChatTurn[],
  contextBlock: string,
  message: string,
): Anthropic.Beta.BetaMessageParam[] => {
  const turns = history.filter((turn) => turn.content.trim().length > 0);
  // The first message must come from the user.
  const firstUser = turns.findIndex((turn) => turn.role === "user");
  const prior = firstUser === -1 ? [] : turns.slice(firstUser);
  return [
    ...prior.map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: "user",
      content: [
        { type: "text", text: contextBlock },
        { type: "text", text: message },
      ],
    },
  ];
};

export const runAgent = async ({
  client,
  model,
  effort,
  serverFallbacks,
  userId,
  history,
  contextBlock,
  message,
  toolContext,
  emit,
  signal,
}: RunAgentOptions): Promise<AgentRunResult> => {
  let changedDrawing = false;
  const tools = DRAWING_TOOLS.map((definition) => {
    const inputSchema = z.object(definition.inputShape);
    const tool = betaZodTool({
      name: definition.name,
      description: definition.description,
      inputSchema,
      run: async (input) => {
        let result;
        try {
          result = await definition.handler(toolContext, input);
        } catch {
          emit({
            type: "tool",
            name: definition.name,
            summary: `${definition.title} failed`,
            isError: true,
          });
          throw new ToolError("The tool failed unexpectedly. Try again.");
        }
        if (result.changedDrawing) changedDrawing = true;
        emit({
          type: "tool",
          name: definition.name,
          summary: result.summary,
          isError: Boolean(result.isError),
        });
        if (result.isError) throw new ToolError(result.text);
        return result.text;
      },
    });
    // betaZodTool still validates inputs with zod before run(); only the
    // schema sent to the API is replaced by a plain inline one (no $ref/$defs
    // or $schema) to keep the request simple for the proxy.
    return { ...tool, input_schema: toInlineInputSchema(inputSchema) };
  });

  const runner = client.beta.messages.toolRunner(
    {
      model,
      max_tokens: AGENT_MAX_TOKENS,
      system: [
        {
          type: "text",
          text: ASSISTANT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort },
      metadata: { user_id: userId },
      tools,
      messages: buildAgentMessages(history, contextBlock, message),
      max_iterations: AGENT_MAX_ITERATIONS,
      // Send the full history every turn. The runner otherwise uses
      // server-side message threads (a beta header plus a `thread` field and
      // delta-only turns), which an LLM proxy cannot be assumed to support.
      thread: false,
      stream: true,
      ...(serverFallbacks
        ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const }
        : {}),
    },
    { signal },
  );

  const usage: AgentUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let iterations = 0;
  let anyText = false;
  let outcome: AgentOutcome | null = null;
  let lastStopReason: string | null = null;

  for await (const messageStream of runner) {
    iterations++;
    let needSeparator = false;
    for await (const event of messageStream) {
      if (
        event.type === "content_block_start" &&
        event.content_block.type === "text"
      ) {
        needSeparator = anyText;
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        if (needSeparator) emit({ type: "text", text: "\n\n" });
        needSeparator = false;
        anyText = true;
        emit({ type: "text", text: event.delta.text });
      }
    }
    const finalMessage = await messageStream.finalMessage();
    addUsage(usage, finalMessage.usage);
    lastStopReason = finalMessage.stop_reason ?? null;
    // The runner does not run tools after these, but stop explicitly: a
    // refusal or a cut-off reply can end mid tool_use.
    if (finalMessage.stop_reason === "refusal") {
      outcome = "refusal";
      break;
    }
    if (finalMessage.stop_reason === "max_tokens") {
      outcome = "max_tokens";
      break;
    }
  }

  const note = (text: string) => {
    emit({ type: "text", text: anyText ? `\n\n${text}` : text });
    anyText = true;
  };
  if (outcome === "refusal") {
    note("The model declined to continue with this request.");
  } else if (outcome === "max_tokens") {
    note(
      "My reply was cut off because it got too long. Try asking for a smaller change.",
    );
  } else if (lastStopReason === "tool_use" || lastStopReason === "pause_turn") {
    outcome = "max_iterations";
    note(
      `I stopped after ${AGENT_MAX_ITERATIONS} steps to keep this manageable. Ask me to continue if there is more to do.`,
    );
  } else {
    outcome = "completed";
  }
  if (changedDrawing) {
    note("You can undo these changes from the History panel.");
  }
  return {
    outcome,
    stopReason: lastStopReason,
    iterations,
    usage,
    changedDrawing,
  };
};
