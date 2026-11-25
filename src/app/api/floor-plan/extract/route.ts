import { readFile } from "node:fs/promises";
import { AI_LIMITS, AI_PROVIDER_LABELS, AI_PROVIDERS, ExtractRequestSchema, type ExtractFailure, type ExtractResponse, type ExtractStatus } from "@/lib/floorPlan/ai/protocol";
import { AI_POLICY, AI_SERVER_LIMITS, ProviderError, providerConfig, requestsPerHour, type ProviderCall } from "@/server/floorPlanAi/config";
import { runExtraction } from "@/server/floorPlanAi/extract";
import { providerCall } from "@/server/floorPlanAi/providers";

/**
 * 도면 이미지 AI 추출(단기 계획 S4). 모델 API 키는 서버에만 있고 브라우저는 이 경계만 호출한다.
 *   GET  → 사용할 수 있는 공급자·한도·전송 정책
 *   POST → 추출 실행(ExtractRequest → ExtractResponse)
 *
 * 개발 전용: NODE_ENV가 production이 아니고 FLOOR_PLAN_AI_FAKE_FILE이 있으면 모든 공급자가 그 파일 내용(보낸 이미지 픽셀 좌표의
 * 추출 결과 JSON)을 응답으로 돌려준다. 키 없이 화면 흐름을 확인할 때만 쓴다.
 */

// 모델 응답(사고 포함)이 길 수 있으므로 플랫폼 실행 한도를 서버 전체 시간 한도보다 길게 둔다.
export const maxDuration = 300;

const fakeFile = () => (process.env.NODE_ENV !== "production" ? process.env.FLOOR_PLAN_AI_FAKE_FILE || undefined : undefined);

/** 서버 프로세스 안의 동시 실행 수·최근 1시간 요청 시각 */
let active = 0;
const recent: number[] = [];

export async function GET() {
  const fake = fakeFile();
  const status: ExtractStatus = {
    providers: AI_PROVIDERS.map((id) => {
      const cfg = providerConfig(id);
      return { id, label: AI_PROVIDER_LABELS[id], configured: !!cfg.apiKey || !!fake, model: fake ? "개발용 고정 응답" : cfg.model };
    }),
    limits: {
      maxAttempts: AI_SERVER_LIMITS.maxAttempts,
      timeoutSeconds: AI_SERVER_LIMITS.totalTimeoutMs / 1000,
      maxOutputTokens: AI_SERVER_LIMITS.maxOutputTokens,
      requestsPerHour: requestsPerHour(),
    },
    policy: AI_POLICY,
  };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > AI_LIMITS.maxRequestBytes) return reply(failure("request.tooLarge", "요청 본문이 너무 큽니다."));
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > AI_LIMITS.maxRequestBytes) return reply(failure("request.tooLarge", "요청 본문이 너무 큽니다."));
    body = JSON.parse(text);
  } catch {
    return reply(failure("request.invalid", "요청 본문이 JSON이 아닙니다."));
  }
  const parsed = ExtractRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return reply(failure("request.invalid", `요청 형식 오류: ${first ? `${first.path.join(".")} ${first.message}` : ""}`));
  }
  const req = parsed.data;

  let call: ProviderCall;
  let model: string;
  const fake = fakeFile();
  if (fake) {
    call = fakeCall(fake);
    model = "fake";
  } else {
    const cfg = providerConfig(req.provider);
    model = cfg.model;
    try {
      call = providerCall(cfg);
    } catch (e) {
      if (e instanceof ProviderError) return reply(failure(e.code, `${AI_PROVIDER_LABELS[req.provider]}: ${e.message}`));
      throw e;
    }
  }

  // 비용·부하 한도(서버 프로세스당)
  const now = Date.now();
  while (recent.length && now - recent[0] > 3_600_000) recent.shift();
  if (active >= AI_SERVER_LIMITS.maxConcurrent) return reply(failure("limit.busy", "다른 추출이 진행 중입니다. 잠시 후 다시 시도하세요.", true));
  if (recent.length >= requestsPerHour()) return reply(failure("limit.hourly", `시간당 추출 한도(${requestsPerHour()}회)를 넘었습니다.`, true));
  recent.push(now);
  active++;

  const timeout = AbortSignal.timeout(AI_SERVER_LIMITS.totalTimeoutMs);
  const signal = AbortSignal.any([request.signal, timeout]);
  let result: ExtractResponse;
  try {
    result = await runExtraction(req, { provider: req.provider, call, signal, timedOut: () => timeout.aborted });
  } finally {
    active--;
  }

  // 운영 로그에는 메타데이터만 남긴다(이미지·응답 본문 없음).
  console.info(
    JSON.stringify({
      event: "floorPlanAi.extract",
      provider: req.provider,
      model: result.ok ? result.model : model,
      ok: result.ok,
      code: result.ok ? undefined : result.code,
      attempts: result.attempts,
      durationMs: Date.now() - now,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    }),
  );
  return reply(result);
}

function failure(code: ExtractFailure["code"], message: string, retryable = false): ExtractFailure {
  return { ok: false, code, message, retryable };
}

const STATUS: Partial<Record<ExtractFailure["code"], number>> = {
  "request.invalid": 400,
  "request.tooLarge": 413,
  "document.invalid": 422,
  "document.notCalibrated": 422,
  "provider.notConfigured": 503,
  "provider.auth": 502,
  "provider.rateLimited": 429,
  "provider.unavailable": 503,
  "provider.error": 502,
  "limit.busy": 429,
  "limit.hourly": 429,
  timeout: 504,
  cancelled: 499,
};

function reply(result: ExtractResponse) {
  // 모델 결과 실패(거절·판독 불가·형식 오류 등)는 422, 그 밖은 표의 상태 코드
  const status = result.ok ? 200 : (STATUS[result.code] ?? 422);
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}

/** 개발용 고정 응답(파일 내용 = 모델이 반환할 추출 JSON) */
function fakeCall(file: string): ProviderCall {
  return async (req) => {
    if (req.signal.aborted) throw new ProviderError("cancelled", "요청이 취소되었습니다.", true);
    const text = await readFile(file, "utf8");
    // 실제 호출처럼 약간 기다린다(취소·진행 표시 확인용).
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(resolve, 1500);
      req.signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new ProviderError("cancelled", "요청이 취소되었습니다.", true));
      });
    });
    return { kind: "ok", text, model: "fake", usage: { inputTokens: 0, outputTokens: 0 } };
  };
}

