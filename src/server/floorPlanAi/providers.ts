import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AI_SERVER_LIMITS, ProviderError, type ProviderCall, type ProviderConfig } from "./config";

/**
 * 공급자별 호출. 두 공급자 모두 같은 JSON Schema(Zod에서 생성)로 구조화 출력을 요청하고,
 * 응답 검증은 호출한 쪽(extract.ts)이 같은 Zod 스키마로 다시 수행한다.
 * SDK 자체 재시도는 1회로 두고(429·5xx·연결 오류), 형식 오류 재요청은 extract.ts가 횟수 한도 안에서 수행한다.
 */

export function providerCall(cfg: ProviderConfig): ProviderCall {
  if (!cfg.apiKey) throw new ProviderError("provider.notConfigured", "서버에 API 키가 설정되지 않았습니다.", false);
  return cfg.id === "claude" ? claudeCall(cfg, cfg.apiKey) : openaiCall(cfg, cfg.apiKey);
}

/* ------------------------------ Claude ------------------------------ */

/** 서버 측 대체 모델(fallbacks: "default")을 받는 모델. 안전 분류기가 거절하면 같은 호출 안에서 대체 모델이 이어 받는다. */
const CLAUDE_FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function claudeCall(cfg: ProviderConfig, apiKey: string): ProviderCall {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: AI_SERVER_LIMITS.attemptTimeoutMs });
  const effort = cfg.effort && CLAUDE_EFFORTS.has(cfg.effort) ? (cfg.effort as "low" | "medium" | "high" | "xhigh" | "max") : "high";
  const fallback = CLAUDE_FALLBACK_MODELS.has(cfg.model);
  return async (req) => {
    try {
      // 긴 출력(사고 포함)에서 HTTP 시간 초과를 피하려고 스트리밍으로 받고 최종 메시지만 쓴다.
      const stream = client.beta.messages.stream(
        {
          model: cfg.model,
          max_tokens: req.maxOutputTokens,
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          thinking: { type: "adaptive" },
          output_config: { effort, format: { type: "json_schema", schema: req.schema } },
          system: req.system,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: req.image.mimeType, data: req.image.data } },
                { type: "text", text: req.userText },
              ],
            },
          ],
        },
        { signal: req.signal },
      );
      const msg = await stream.finalMessage();
      const usage = {
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
      };
      if (msg.stop_reason === "refusal") return { kind: "refusal", model: msg.model, usage, detail: msg.stop_details?.explanation ?? undefined };
      if (msg.stop_reason === "max_tokens") return { kind: "truncated", model: msg.model, usage };
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { kind: "ok", text, model: msg.model, usage };
    } catch (e) {
      throw mapAnthropicError(e);
    }
  };
}

function mapAnthropicError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ProviderError("cancelled", "요청이 취소되었습니다.", true);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Claude 응답 시간이 한도를 넘었습니다.", true);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("provider.auth", "Claude API 키가 유효하지 않거나 권한이 없습니다.", false);
  }
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("provider.rateLimited", "Claude 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.", true);
  if (e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
    return new ProviderError("provider.unavailable", "Claude API에 연결하지 못했거나 일시적으로 사용할 수 없습니다.", true);
  }
  if (e instanceof Anthropic.APIError) return new ProviderError("provider.error", `Claude API 오류(${e.status ?? "?"}): ${brief(e.message)}`, false);
  return new ProviderError("provider.error", `Claude 호출 실패: ${brief(e instanceof Error ? e.message : String(e))}`, false);
}

/* ------------------------------ OpenAI ------------------------------ */

const OPENAI_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function openaiCall(cfg: ProviderConfig, apiKey: string): ProviderCall {
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: AI_SERVER_LIMITS.attemptTimeoutMs });
  const effort = cfg.effort && OPENAI_EFFORTS.has(cfg.effort) ? (cfg.effort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") : undefined;
  return async (req) => {
    try {
      const res = await client.responses.create(
        {
          model: cfg.model,
          instructions: req.system,
          input: [
            {
              role: "user",
              content: [
                // original: 보낸 크기 그대로 처리(모델 좌표 = 보낸 이미지 픽셀)
                { type: "input_image", image_url: `data:${req.image.mimeType};base64,${req.image.data}`, detail: "original" },
                { type: "input_text", text: req.userText },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "floor_plan_extraction", schema: req.schema, strict: true } },
          max_output_tokens: req.maxOutputTokens,
          store: false,
          ...(effort ? { reasoning: { effort } } : {}),
        },
        { signal: req.signal },
      );
      const usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
      const refusal = res.output.flatMap((item) => (item.type === "message" ? item.content.flatMap((c) => (c.type === "refusal" ? [c.refusal] : [])) : []))[0];
      if (refusal !== undefined) return { kind: "refusal", model: res.model, usage, detail: refusal };
      if (res.status === "incomplete") {
        const reason = res.incomplete_details?.reason;
        if (reason === "content_filter") return { kind: "refusal", model: res.model, usage, detail: "content_filter" };
        return { kind: "truncated", model: res.model, usage, detail: reason ?? undefined };
      }
      return { kind: "ok", text: res.output_text, model: res.model, usage };
    } catch (e) {
      throw mapOpenAIError(e);
    }
  };
}

function mapOpenAIError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof OpenAI.APIUserAbortError) return new ProviderError("cancelled", "요청이 취소되었습니다.", true);
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError("timeout", "GPT 응답 시간이 한도를 넘었습니다.", true);
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError("provider.auth", "OpenAI API 키가 유효하지 않거나 권한이 없습니다.", false);
  }
  if (e instanceof OpenAI.RateLimitError) return new ProviderError("provider.rateLimited", "OpenAI 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.", true);
  if (e instanceof OpenAI.InternalServerError || e instanceof OpenAI.APIConnectionError) {
    return new ProviderError("provider.unavailable", "OpenAI API에 연결하지 못했거나 일시적으로 사용할 수 없습니다.", true);
  }
  if (e instanceof OpenAI.APIError) return new ProviderError("provider.error", `OpenAI API 오류(${e.status ?? "?"}): ${brief(e.message)}`, false);
  return new ProviderError("provider.error", `GPT 호출 실패: ${brief(e instanceof Error ? e.message : String(e))}`, false);
}

/** 공급자 오류 문구를 짧게(키·본문이 길게 섞이지 않도록) */
const brief = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").slice(0, 300);
