import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { integrationEnv } from "../integrations";

/** Provider-neutral chat types so the agent can be tested with a scripted model. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
}

export interface LlmClient {
  readonly name: string;
  complete(args: { messages: LlmMessage[]; tools: LlmToolDef[] }): Promise<LlmResponse>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class OpenAiLlm implements LlmClient {
  readonly name: string;
  private client: OpenAI;
  private model: string;
  constructor(opts: { apiKey: string | undefined; model: string; timeoutMs: number }) {
    if (!opts.apiKey) throw new LlmUnavailableError("OPENAI_API_KEY is not configured");
    this.model = opts.model;
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 2 });
    this.name = `openai:${opts.model}`;
  }

  async complete({ messages, tools }: { messages: LlmMessage[]; tools: LlmToolDef[] }): Promise<LlmResponse> {
    const mapped: ChatCompletionMessageParam[] = messages.map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      if (m.role === "assistant")
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) }
            : {}),
        };
      return { role: m.role, content: m.content };
    });
    const toolDefs: ChatCompletionTool[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const reasoningModel = /^(o\d|gpt-5)/.test(this.model);
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: mapped,
        tools: toolDefs,
        tool_choice: "auto",
        ...(reasoningModel ? {} : { temperature: 0.3 }),
      });
      const msg = res.choices[0]?.message;
      if (!msg) throw new LlmUnavailableError("empty completion");
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? [])
          .filter((t) => t.type === "function")
          .map((t) => ({ id: t.id, name: (t as { function: { name: string } }).function.name, arguments: (t as { function: { arguments: string } }).function.arguments })),
      };
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      throw new LlmUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Deterministic model used in automated tests: returns queued responses in order. */
export class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  public calls: LlmMessage[][] = [];
  constructor(private script: (LlmResponse | ((messages: LlmMessage[]) => LlmResponse) | Error)[]) {}
  async complete({ messages }: { messages: LlmMessage[]; tools: LlmToolDef[] }): Promise<LlmResponse> {
    this.calls.push(messages);
    const next = this.script.shift();
    if (!next) throw new LlmUnavailableError("scripted model has no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(messages) : next;
  }
}

export async function defaultLlm(): Promise<LlmClient> {
  const e = await integrationEnv();
  return new OpenAiLlm({ apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL, timeoutMs: e.OPENAI_TIMEOUT_MS });
}
