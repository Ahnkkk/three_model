import { z } from "zod";
import type { FloorPlanIssue } from "../validate";
import type { AiProposal } from "./proposal";

/**
 * /api/floor-plan/extract 요청·응답 규격(브라우저와 서버 공용).
 *
 * 좌표 체계는 세 가지다.
 *   보낸 이미지 픽셀(모델 좌표) → 원본 이미지 픽셀(문서의 calibration·source 기준) → 도면 m
 * frame.crop은 보낸 이미지가 원본의 어느 영역인지, image.width·height는 보낸 이미지 크기다.
 * 원본 x = crop.x + 보낸 x · crop.width / image.width (y도 같은 방식, 잘라낸 뒤 비율 유지 축소만 허용)
 */

export const AI_PROVIDERS = ["claude", "openai"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = { claude: "Claude", openai: "GPT" };

export const AI_LIMITS = {
  /** 보낸 이미지 긴 변 상한(px). Claude 고해상도 비전 상한 2576px에 맞춘다(그 이하에서 모델 좌표가 픽셀과 1:1). */
  maxImageEdge: 2576,
  /** 보낸 이미지 용량 상한(디코딩 후 byte). 공급자 이미지 상한(5MB)보다 작게 둔다. */
  maxImageBytes: 4_500_000,
  /** 요청 본문 상한(byte). base64는 원본의 약 4/3 */
  maxRequestBytes: 7_000_000,
} as const;

const PixelRect = z.strictObject({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() });

export const ExtractRequestSchema = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  image: z.strictObject({
    mimeType: z.enum(["image/png", "image/jpeg"]),
    /** base64(데이터 URL 접두사 없이) */
    data: z.string().min(1).max(Math.ceil((AI_LIMITS.maxImageBytes * 4) / 3) + 4),
    width: z.int().positive().max(AI_LIMITS.maxImageEdge),
    height: z.int().positive().max(AI_LIMITS.maxImageEdge),
  }),
  frame: z.strictObject({ crop: PixelRect }),
  /** 현재 편집 문서(보정·외곽 기준). 서버가 문서 검증을 다시 수행한다. */
  document: z.unknown(),
});
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export interface ImageFrame {
  /** 원본 이미지에서 잘라낸 영역(원본 픽셀) */
  crop: { x: number; y: number; width: number; height: number };
  /** 보낸 이미지 크기(px) */
  width: number;
  height: number;
}

/** 보낸 이미지 픽셀 → 원본 이미지 픽셀 */
export function sentToOriginal(frame: ImageFrame, p: { x: number; y: number }): [number, number] {
  return [frame.crop.x + (p.x * frame.crop.width) / frame.width, frame.crop.y + (p.y * frame.crop.height) / frame.height];
}

/** 원본 이미지 픽셀 → 보낸 이미지 픽셀 */
export function originalToSent(frame: ImageFrame, p: [number, number]): { x: number; y: number } {
  return { x: ((p[0] - frame.crop.x) * frame.width) / frame.crop.width, y: ((p[1] - frame.crop.y) * frame.height) / frame.crop.height };
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** 공급자 공개 단가로 계산한 추정 비용(USD). 단가를 모르는 모델이면 null */
  estimatedCostUsd: number | null;
}

export interface ExtractSuccess {
  ok: true;
  provider: AiProviderId;
  /** 실제 응답한 모델(서버 측 대체 모델이 응답하면 요청 모델과 다를 수 있다) */
  model: string;
  attempts: number;
  durationMs: number;
  usage: AiUsage;
  proposal: AiProposal;
  /** 현재 문서에 제안 전체를 적용했을 때의 문서 검증 결과(S1 Zod 형식 검증 + 문서 검증) */
  draftValidation: { ok: boolean; errors: number; warnings: number; issues: FloorPlanIssue[] };
}

export type ExtractErrorCode =
  | "request.invalid"
  | "request.tooLarge"
  | "document.invalid"
  | "document.notCalibrated"
  | "provider.notConfigured"
  | "provider.auth"
  | "provider.rateLimited"
  | "provider.unavailable"
  | "provider.refusal"
  | "provider.truncated"
  | "provider.error"
  | "extract.invalidResponse"
  | "extract.unreadable"
  | "extract.empty"
  | "limit.busy"
  | "limit.hourly"
  | "timeout"
  | "cancelled";

export interface ExtractFailure {
  ok: false;
  code: ExtractErrorCode;
  message: string;
  /** 같은 요청을 다시 보내면 성공할 수 있는지 */
  retryable: boolean;
  attempts?: number;
  usage?: AiUsage;
}

export type ExtractResponse = ExtractSuccess | ExtractFailure;

/** GET /api/floor-plan/extract — 사용할 수 있는 공급자(키는 노출하지 않는다) */
export interface ExtractStatus {
  providers: { id: AiProviderId; label: string; configured: boolean; model: string }[];
  limits: { maxAttempts: number; timeoutSeconds: number; maxOutputTokens: number; requestsPerHour: number };
  /** 화면에 표시하는 전송·보존 정책 */
  policy: string;
}
