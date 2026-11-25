import { EXTRACTION_SYSTEM_PROMPT, extractionJsonSchema, extractionUserPrompt, FloorPlanExtractionSchema } from "@/lib/floorPlan/ai/extraction";
import { applyProposal, buildProposal, defaultSelection, planChanges } from "@/lib/floorPlan/ai/proposal";
import {
  AI_LIMITS,
  originalToSent,
  type AiProviderId,
  type ExtractFailure,
  type ExtractRequest,
  type ExtractResponse,
  type ImageFrame,
} from "@/lib/floorPlan/ai/protocol";
import { validateFloorPlan } from "@/lib/floorPlan/validate";
import { AI_SERVER_LIMITS, estimateCost, ProviderError, type ProviderCall, type ProviderUsage } from "./config";

/**
 * 추출 요청 처리(Route Handler와 검증 스크립트 공용). 순서:
 *  1) 요청 문서를 S1 검증기로 검증하고 보정 정보를 확인한다. 이미지 머리글로 형식·크기를 확인한다.
 *  2) 모델을 호출한다. 응답을 같은 Zod 스키마로 검증하고, 형식 오류·출력 잘림이면 이유를 붙여 한도 안에서 다시 요청한다.
 *  3) 보정으로 도면 m 제안을 만들고, 기본 선택을 적용한 초안 문서를 S1 검증기(형식 + 문서 검증)로 다시 검증한다.
 * 이미지·응답 본문은 기록하지 않는다(로그는 route가 메타데이터만 남긴다).
 */

export interface ExtractContext {
  provider: AiProviderId;
  call: ProviderCall;
  /** 클라이언트 취소·전체 시간 한도를 합친 신호 */
  signal: AbortSignal;
  /** 전체 시간 한도로 중단되었는지(취소와 구분) */
  timedOut: () => boolean;
  now?: () => Date;
  maxAttempts?: number;
}

export async function runExtraction(req: ExtractRequest, ctx: ExtractContext): Promise<ExtractResponse> {
  const started = Date.now();
  const fail = (code: ExtractFailure["code"], message: string, retryable = false, extra: Partial<ExtractFailure> = {}): ExtractFailure => ({
    ok: false,
    code,
    message,
    retryable,
    ...extra,
  });

  /* 1. 요청 검증 */
  const checked = validateFloorPlan(req.document);
  if (!checked.document) return fail("document.invalid", `도면 문서 형식 오류 ${checked.issues.length}개: ${checked.issues[0]?.message ?? ""}`);
  const doc = checked.document;
  if (!doc.calibration || doc.source?.kind !== "image" || !doc.source.image) {
    return fail("document.notCalibrated", "이미지 보정을 적용한 문서에서만 추출할 수 있습니다.");
  }
  const header = readImageHeader(req.image.data);
  if (!header || header.mimeType !== req.image.mimeType) return fail("request.invalid", "이미지 데이터가 PNG·JPG가 아니거나 선언한 형식과 다릅니다.");
  if (header.width !== req.image.width || header.height !== req.image.height) {
    return fail("request.invalid", `이미지 크기(${header.width}×${header.height})가 선언한 크기(${req.image.width}×${req.image.height})와 다릅니다.`);
  }
  if (header.bytes > AI_LIMITS.maxImageBytes) return fail("request.tooLarge", `이미지 용량이 상한 ${(AI_LIMITS.maxImageBytes / 1e6).toFixed(1)}MB를 넘습니다.`);
  const src = doc.source.image;
  const crop = req.frame.crop;
  if (crop.x + crop.width > src.width + 1 || crop.y + crop.height > src.height + 1) {
    return fail("request.invalid", "잘라낸 영역이 문서의 원본 이미지 범위를 벗어납니다.");
  }
  // 잘라낸 뒤 비율을 유지해 줄인 이미지만 허용한다(가로·세로 배율이 같아야 보정이 맞는다).
  const sx = req.image.width / crop.width;
  const sy = req.image.height / crop.height;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) return fail("request.invalid", "보낸 이미지의 가로·세로 축소 비율이 다릅니다.");
  const frame: ImageFrame = { crop, width: req.image.width, height: req.image.height };

  // 사용자가 지정한 외곽(도면 (0,0)–(W,D))을 보낸 이미지 좌표로 바꿔 모델에 알려 준다.
  const inv = invertAffine(doc.calibration.pixelToPlan);
  const envelopeSent = inv
    ? (() => {
        const p0 = originalToSent(frame, applyAffine(inv, [0, 0]));
        const p1 = originalToSent(frame, applyAffine(inv, [doc.envelope.width, doc.envelope.depth]));
        return { x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) };
      })()
    : null;

  /* 2. 모델 호출 */
  const schema = extractionJsonSchema();
  const maxAttempts = ctx.maxAttempts ?? AI_SERVER_LIMITS.maxAttempts;
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
  let model = "";
  let retryReason: string | undefined;
  let attempts = 0;
  const usageOut = () => ({ ...usage, estimatedCostUsd: model ? estimateCost(model, usage.inputTokens, usage.outputTokens) : null });

  while (attempts < maxAttempts) {
    attempts++;
    let reply;
    try {
      reply = await ctx.call({
        system: EXTRACTION_SYSTEM_PROMPT,
        userText: extractionUserPrompt({ width: frame.width, height: frame.height, envelope: envelopeSent, retryReason }),
        image: { mimeType: req.image.mimeType, data: req.image.data },
        schema,
        maxOutputTokens: AI_SERVER_LIMITS.maxOutputTokens,
        signal: ctx.signal,
      });
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("provider.error", e instanceof Error ? e.message.slice(0, 300) : "공급자 호출 실패", false);
      if (err.code === "cancelled" && ctx.timedOut()) return fail("timeout", `전체 시간 한도 ${AI_SERVER_LIMITS.totalTimeoutMs / 1000}초를 넘었습니다.`, true, { attempts, usage: usageOut() });
      return fail(err.code, err.message, err.retryable, { attempts, usage: usageOut() });
    }
    model = reply.model;
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;

    if (reply.kind === "refusal") {
      return fail("provider.refusal", `모델이 이 요청에 응답하지 않았습니다${reply.detail ? `(${reply.detail.slice(0, 200)})` : ""}. 수동으로 입력하세요.`, false, { attempts, usage: usageOut() });
    }
    if (reply.kind !== "ok") {
      // 출력 한도에서 잘림
      retryReason = "The answer was cut off at the output limit. Be concise: keep walls, openings and dimensions, and leave out small furniture.";
      if (attempts >= maxAttempts) return fail("provider.truncated", "모델 응답이 출력 한도에서 잘렸습니다.", true, { attempts, usage: usageOut() });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(reply.text);
    } catch {
      retryReason = "The answer was not valid JSON.";
      if (attempts >= maxAttempts) return fail("extract.invalidResponse", "모델 응답이 JSON이 아닙니다.", true, { attempts, usage: usageOut() });
      continue;
    }
    const parsed = FloorPlanExtractionSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      retryReason = `It did not match the schema (${first.join("; ")}).`;
      if (attempts >= maxAttempts) {
        return fail("extract.invalidResponse", `모델 응답이 추출 형식과 맞지 않습니다: ${first.join("; ")}`, true, { attempts, usage: usageOut() });
      }
      continue;
    }

    /* 3. 제안·초안 검증 */
    const extraction = parsed.data;
    if (!extraction.readable) {
      return fail("extract.unreadable", `모델이 이미지를 평면도로 읽지 못했습니다.${extraction.notes[0] ? ` ${extraction.notes[0]}` : ""} 수동으로 입력하세요.`, false, { attempts, usage: usageOut() });
    }
    const proposal = buildProposal(doc, extraction, frame, { provider: ctx.provider, model, at: (ctx.now?.() ?? new Date()).toISOString() });
    if ("error" in proposal) return fail("document.notCalibrated", proposal.error, false, { attempts, usage: usageOut() });
    if (!proposal.walls.length && !proposal.openings.length && !proposal.furniture.length && !proposal.issues.some((s) => s.kind === "conflict")) {
      return fail(
        "extract.empty",
        `벽·개구부·가구를 하나도 추출하지 못했습니다${proposal.dropped.length ? `(버린 항목 ${proposal.dropped.length}개)` : ""}. 평면도 영역과 보정을 확인하거나 수동으로 입력하세요.`,
        true,
        { attempts, usage: usageOut() },
      );
    }
    const draft = applyProposal(doc, proposal, defaultSelection(planChanges(doc, proposal)));
    const validation = validateFloorPlan(draft.doc);
    const errors = validation.issues.filter((i) => i.severity === "error").length;
    return {
      ok: true,
      provider: ctx.provider,
      model,
      attempts,
      durationMs: Date.now() - started,
      usage: usageOut(),
      proposal,
      draftValidation: { ok: validation.ok, errors, warnings: validation.issues.length - errors, issues: validation.issues.slice(0, 100) },
    };
  }
  return fail("extract.invalidResponse", "모델 응답을 받지 못했습니다.", true, { attempts, usage: usageOut() });
}

/* ------------------------------ 보조 ------------------------------ */

type Affine = [number, number, number, number, number, number];

/** u = a·x + c·y + e, v = b·x + d·y + f 의 역변환 */
function invertAffine([a, b, c, d, e, f]: Affine): Affine | null {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-15) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

const applyAffine = (m: Affine, p: [number, number]): [number, number] => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** base64 이미지의 형식·크기를 머리글에서 읽는다(PNG IHDR, JPEG SOF). */
export function readImageHeader(base64: string): { mimeType: "image/png" | "image/jpeg"; width: number; height: number; bytes: number } | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  const head = Buffer.from(base64.slice(0, 4096 * 4), "base64");
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.toString("ascii", 12, 16) === "IHDR") {
    return { mimeType: "image/png", width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes };
  }
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    // SOF 표식을 찾을 때까지 세그먼트를 건너뛴다(머리글 범위 안에서).
    // EXIF 썸네일 등으로 SOF가 뒤에 있을 수 있으므로 앞쪽 최대 약 1MB를 읽는다.
    let i = 2;
    const all = Buffer.from(base64.slice(0, Math.min(base64.length, 1_400_000) & ~3), "base64");
    while (i + 9 < all.length) {
      if (all[i] !== 0xff) return null;
      const marker = all[i + 1];
      const len = all.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", height: all.readUInt16BE(i + 5), width: all.readUInt16BE(i + 7), bytes };
      }
      i += 2 + len;
    }
  }
  return null;
}
