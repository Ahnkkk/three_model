/**
 * 도면 인식 평가 사례(단기 계획 S5) — 사례 형식, 불러오기, 보낼 이미지 준비, 추출·적용·채점 실행.
 * 평가 실행기(eval-floor-plan.ts)와 검증 스크립트(verify-floor-plan-score.ts)가 함께 쓴다.
 *
 * 사례 폴더(examples/floor-plans/eval/<id>/case.json):
 *   image  원본 도면 이미지(PNG·JPG)
 *   base   AI 추출 전 문서: 이미지 보정(calibration)과 평면도 영역(source.crop)을 적용한 상태. 편집기에서 보정 후 저장한 JSON.
 *   truth  정답 문서: base와 같은 보정 기준(같은 외곽·원점)에서 사람이 입력·확인한 벽·개구부·가구·천장 높이.
 *   dimensions  정답 치수: 도면에 적힌 값(m)과 그 치수가 재는 구간(도면 m). 기하와 다르게 적힌 치수는 conflict: true.
 *   ceilingHeightMissing  도면에 천장 높이 표기가 없으면 true(결과가 '누락'을 표시해야 맞음).
 *   fakeExtraction  키 없이 실행 흐름을 확인하는 고정 응답(모델 응답 형식, 보낸 이미지 픽셀). 없으면 null.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { applyProposal, defaultSelection, planChanges } from "../src/lib/floorPlan/ai/proposal";
import { AI_LIMITS, type AiProviderId, type ExtractRequest, type ExtractResponse } from "../src/lib/floorPlan/ai/protocol";
import { scoreFloorPlan, type FloorPlanScore } from "../src/lib/floorPlan/eval/score";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { validateFloorPlan } from "../src/lib/floorPlan/validate";
import { AI_SERVER_LIMITS, type ProviderCall } from "../src/server/floorPlanAi/config";
import { runExtraction } from "../src/server/floorPlanAi/extract";
import { EXAMPLES_DIR } from "./floor-plan-files";

export const EVAL_DIR = path.join(EXAMPLES_DIR, "eval");

export const EVAL_CATEGORIES = ["clean", "missing-height", "dimension-conflict", "unsupported", "low-quality"] as const;

const PlanPoint = z.tuple([z.number(), z.number()]);

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string(),
  categories: z.array(z.enum(EVAL_CATEGORIES)).min(1),
  /** 프로그램이 정답 문서에서 그린 합성 도면인지(실제 대상 도면이 아님) */
  synthetic: z.boolean(),
  image: z.string(),
  base: z.string(),
  truth: z.string(),
  fakeExtraction: z.string().nullable(),
  ceilingHeightMissing: z.boolean(),
  dimensions: z.array(
    z.strictObject({
      text: z.string().optional(),
      value: z.number().positive(),
      a: PlanPoint,
      b: PlanPoint,
      conflict: z.boolean().optional(),
    }),
  ),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface LoadedCase {
  dir: string;
  spec: EvalCase;
  base: FloorPlanDocument;
  truth: FloorPlanDocument;
  image: Buffer;
}

/** 사례 폴더 목록(case.json이 있는 하위 폴더, 이름순) */
export function listCaseDirs(root = EVAL_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "case.json")))
    .map((d) => path.join(root, d.name))
    .sort();
}

function readDocument(file: string, what: string): FloorPlanDocument {
  const result = validateFloorPlan(JSON.parse(readFileSync(file, "utf8")));
  const errors = result.issues.filter((i) => i.severity === "error");
  if (!result.document || errors.length) throw new Error(`${what}(${file}) 문서 오류: ${errors.map((e) => `${e.code}@${e.path}`).join(", ")}`);
  return result.document;
}

export function loadCase(dir: string): LoadedCase {
  const spec = EvalCaseSchema.parse(JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8")));
  const base = readDocument(path.join(dir, spec.base), "base");
  const truth = readDocument(path.join(dir, spec.truth), "truth");
  if (!base.calibration || base.source?.kind !== "image" || !base.source.image) throw new Error(`${spec.id}: base 문서에 이미지 보정이 없습니다.`);
  return { dir, spec, base, truth, image: readFileSync(path.join(dir, spec.image)) };
}

/**
 * 보낼 이미지 준비 — 편집기(AiExtractPanel의 prepareImage)와 같은 규칙: 평면도 영역(없으면 전체)을 잘라
 * 긴 변 AI_LIMITS.maxImageEdge 이하로 줄여 PNG로, 용량 상한을 넘으면 JPEG로 다시 인코딩한다.
 */
export async function prepareImage(image: Buffer, doc: FloorPlanDocument): Promise<Pick<ExtractRequest, "image" | "frame">> {
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const c = doc.source?.crop ?? { x: 0, y: 0, width: W, height: H };
  const x = Math.max(0, Math.round(c.x));
  const y = Math.max(0, Math.round(c.y));
  const crop = { x, y, width: Math.min(W - x, Math.round(c.width)), height: Math.min(H - y, Math.round(c.height)) };
  const scale = Math.min(1, AI_LIMITS.maxImageEdge / Math.max(crop.width, crop.height));
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));
  const pipeline = sharp(image).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).resize(width, height, { fit: "fill" });
  let mimeType: "image/png" | "image/jpeg" = "image/png";
  let buf = await pipeline.clone().png().toBuffer();
  for (const quality of [92, 85, 75]) {
    if (buf.length <= AI_LIMITS.maxImageBytes) break;
    mimeType = "image/jpeg";
    buf = await pipeline.clone().flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
  }
  return { image: { mimeType, data: buf.toString("base64"), width, height }, frame: { crop } };
}

/** 고정 응답(파일 내용을 모델 응답으로 돌려준다. 토큰 0) */
export function fakeCall(file: string): ProviderCall {
  const text = readFileSync(file, "utf8");
  return async () => ({ kind: "ok", text, model: "fake", usage: { inputTokens: 0, outputTokens: 0 } });
}

export interface CaseRun {
  caseId: string;
  provider: AiProviderId;
  response: ExtractResponse;
  /** 이 실행기에서 잰 전체 시간(이미지 준비 제외) */
  wallMs: number;
  /** 기본 선택을 적용한 초안 문서 */
  draft: FloorPlanDocument | null;
  score: FloorPlanScore | null;
}

/** 사례 하나를 추출 → 기본 선택 적용 → 채점한다. 편집기에서 "선택 항목 적용"을 바로 누른 결과와 같다. */
export async function runCase(c: LoadedCase, provider: AiProviderId, call: ProviderCall, timeoutMs: number = AI_SERVER_LIMITS.totalTimeoutMs): Promise<CaseRun> {
  const prepared = await prepareImage(c.image, c.base);
  const timeout = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const response = await runExtraction({ provider, ...prepared, document: c.base }, { provider, call, signal: timeout, timedOut: () => timeout.aborted });
  const wallMs = Date.now() - started;
  if (!response.ok) return { caseId: c.spec.id, provider, response, wallMs, draft: null, score: null };
  const draft = applyProposal(c.base, response.proposal, defaultSelection(planChanges(c.base, response.proposal))).doc;
  const score = scoreFloorPlan({
    truth: c.truth,
    predicted: draft,
    truthDimensions: c.spec.dimensions,
    predictedDimensions: response.proposal.dimensions,
    ceilingHeightMissing: c.spec.ceilingHeightMissing,
  });
  return { caseId: c.spec.id, provider, response, wallMs, draft, score };
}
