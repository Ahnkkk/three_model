import type { AiProviderId, ExtractErrorCode } from "@/lib/floorPlan/ai/protocol";

/**
 * AI 추출 서버 설정. 키는 서버 환경 변수에서만 읽고 브라우저로 보내지 않는다(.env.local, 커밋 금지).
 *
 *   ANTHROPIC_API_KEY                 Claude 키
 *   OPENAI_API_KEY                    GPT 키
 *   FLOOR_PLAN_AI_CLAUDE_MODEL        기본 claude-opus-5-5
 *   FLOOR_PLAN_AI_CLAUDE_EFFORT       low|medium|high|xhigh|max, 기본 high
 *   FLOOR_PLAN_AI_OPENAI_MODEL        기본 gpt-6.2-astra
 *   FLOOR_PLAN_AI_OPENAI_EFFORT       none|minimal|low|medium|high|xhigh|max. 비우면 모델 기본값
 *   FLOOR_PLAN_AI_REQUESTS_PER_HOUR   서버 프로세스당 시간당 요청 상한, 기본 30
 */

export interface ProviderConfig {
  id: AiProviderId;
  apiKey: string | undefined;
  model: string;
  effort: string | undefined;
}

export const AI_SERVER_LIMITS = {
  /** 형식 오류·출력 잘림 시 재요청을 포함한 최대 호출 수 */
  maxAttempts: 2,
  /** 호출 1회 시간 상한(ms) */
  attemptTimeoutMs: 150_000,
  /** 요청 전체 시간 상한(ms). route의 maxDuration보다 짧게 둔다. */
  totalTimeoutMs: 240_000,
  /** 응답 토큰 상한(사고 토큰 포함) */
  maxOutputTokens: 32_000,
  /** 동시에 처리하는 추출 요청 수(서버 프로세스당) */
  maxConcurrent: 2,
} as const;

export const requestsPerHour = () => positiveInt(process.env.FLOOR_PLAN_AI_REQUESTS_PER_HOUR, 30);

export function providerConfig(id: AiProviderId): ProviderConfig {
  if (id === "claude") {
    return {
      id,
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
      model: process.env.FLOOR_PLAN_AI_CLAUDE_MODEL || "claude-opus-5-5",
      effort: process.env.FLOOR_PLAN_AI_CLAUDE_EFFORT || "high",
    };
  }
  return {
    id,
    apiKey: process.env.OPENAI_API_KEY || undefined,
    model: process.env.FLOOR_PLAN_AI_OPENAI_MODEL || "gpt-6.2-astra",
    effort: process.env.FLOOR_PLAN_AI_OPENAI_EFFORT || undefined,
  };
}

/**
 * 공개 단가(USD / 1M 토큰, 2026-11-25 확인). 비용 표시는 추정치이며 청구 금액이 아니다.
 * 표에 없는 모델은 비용을 표시하지 않는다.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-fable-5-2": { input: 8, output: 40 },
  "gpt-6.2-astra": { input: 8, output: 40 },
  "gpt-6.2-sol": { input: 2, output: 10 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 10_000) / 10_000;
}

export const AI_POLICY =
  "추출을 실행하면 선택한 평면도 영역 이미지(긴 변 최대 2576px)와 외곽 위치를 선택한 공급자(Anthropic 또는 OpenAI) API로 전송합니다. " +
  "이 앱 서버는 이미지와 모델 응답을 저장하거나 로그에 남기지 않고, 공급자·모델·토큰 수·소요 시간만 기록합니다. " +
  "OpenAI에는 응답 저장 안 함(store: false)으로 요청합니다. 공급자 측 보존 기간은 각 공급자의 API 데이터 정책을 따릅니다.";

/* ------------------------------ 공급자 호출 인터페이스 ------------------------------ */

export interface ProviderRequest {
  system: string;
  userText: string;
  image: { mimeType: "image/png" | "image/jpeg"; data: string };
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderReply =
  | { kind: "ok"; text: string; model: string; usage: ProviderUsage }
  | { kind: "refusal" | "truncated"; model: string; usage: ProviderUsage; detail?: string };

export type ProviderCall = (req: ProviderRequest) => Promise<ProviderReply>;

/** 공급자 호출 실패(키·한도·연결 등). message는 사용자에게 보여 줄 수 있는 내용만 담는다. */
export class ProviderError extends Error {
  // Node 형식 제거(strip-only) 실행을 위해 매개변수 속성 대신 필드를 직접 선언한다.
  readonly code: ExtractErrorCode;
  readonly retryable: boolean;
  constructor(code: ExtractErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
