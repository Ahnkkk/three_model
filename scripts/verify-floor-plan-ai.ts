/**
 * AI 추출 초안 연결 비브라우저 검증(단기 계획 S4). 실제 모델을 호출하지 않는다.
 * 실행: npm run verify:ai
 *  - 응답 형식: Zod 정본에서 만든 JSON Schema가 공급자 구조화 출력 제약(모든 필드 필수, additionalProperties false,
 *    숫자·길이 제약 없음)을 지키는지, 고정 응답(examples/floor-plans/ai/info-extraction.json)이 형식을 통과하는지
 *  - 좌표: 보낸 이미지 픽셀 ↔ 원본 픽셀 ↔ 도면 m 변환(잘라내기·축소 포함)
 *  - 제안: 외곽 중복 벽 제거, 끝점 맞춤, 소속 벽 찾기, 문 경첩·열림 방향, 치수 충돌·합계 불일치, 천장 높이 누락
 *  - 차이·적용: 추가/변경/동일, 사용자 확정값 보호, 선택 적용, 재적용 시 동일 처리, 적용 결과의 문서 검증·장면 변환
 *  - 서버 처리: 재요청(형식 오류·출력 잘림), 거절, 판독 불가, 빈 결과, 취소, 시간 초과, 요청 검증(이미지 머리글·보정 없음)
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { applyCalibration } from "../src/lib/floorPlan/calibration";
import { createBlankDocument, translateWall } from "../src/lib/floorPlan/editor";
import { extractionJsonSchema, FloorPlanExtractionSchema, type FloorPlanExtraction } from "../src/lib/floorPlan/ai/extraction";
import { applyProposal, buildProposal, defaultSelection, planChanges, type AiProposal } from "../src/lib/floorPlan/ai/proposal";
import { ExtractRequestSchema, originalToSent, sentToOriginal, type ExtractRequest, type ImageFrame } from "../src/lib/floorPlan/ai/protocol";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { floorPlanToScene } from "../src/lib/floorPlan/toScene";
import { validateFloorPlan } from "../src/lib/floorPlan/validate";
import { validateSceneLayout } from "../src/lib/three/layoutValidation";
import { ProviderError, type ProviderCall, type ProviderReply } from "../src/server/floorPlanAi/config";
import { readImageHeader, runExtraction } from "../src/server/floorPlanAi/extract";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const errorsOf = (doc: unknown) => validateFloorPlan(doc).issues.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.path}`);

/* ------------------------------ 응답 형식 ------------------------------ */

const schema = extractionJsonSchema();
const text = JSON.stringify(schema);
check(
  "응답 JSON Schema: 공급자 미지원 키워드 없음",
  ["minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "minItems", "maxItems", "prefixItems", "pattern", "$schema"].every((k) => !text.includes(`"${k}"`)),
);
const strictProblems: string[] = [];
(function walk(node: unknown, path: string) {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "object") {
    const keys = Object.keys((n.properties as object) ?? {});
    const req = (n.required as string[]) ?? [];
    if (n.additionalProperties !== false) strictProblems.push(`${path}: additionalProperties`);
    if (keys.some((k) => !req.includes(k))) strictProblems.push(`${path}: 필수가 아닌 필드`);
  }
  for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
})(schema, "");
check("응답 JSON Schema: 모든 객체가 strict(모든 필드 필수, 추가 필드 금지)", strictProblems.length === 0, strictProblems.slice(0, 3).join(", "));
check("응답 JSON Schema: 크기 12KB 이하", text.length < 12_000, `${text.length} byte`);

const fixtureText = readFileSync("examples/floor-plans/ai/info-extraction.json", "utf8");
const fixtureParsed = FloorPlanExtractionSchema.safeParse(JSON.parse(fixtureText));
check("고정 응답(info.png): 형식 통과", fixtureParsed.success, fixtureParsed.success ? "" : fixtureParsed.error.issues[0]?.message);
const fixture = fixtureParsed.data as FloorPlanExtraction;
check("형식: 필드 누락은 실패", !FloorPlanExtractionSchema.safeParse({ ...fixture, walls: undefined }).success);
check("형식: 정의하지 않은 필드는 실패", !FloorPlanExtractionSchema.safeParse({ ...fixture, extra: 1 }).success);
check("형식: 카탈로그 밖 가구 종류는 실패", !FloorPlanExtractionSchema.safeParse({ ...fixture, furniture: [{ ...fixture.furniture[0], kind: "piano" }] }).success);

/* ------------------------------ 좌표 ------------------------------ */

const downFrame: ImageFrame = { crop: { x: 100, y: 50, width: 1000, height: 500 }, width: 500, height: 250 };
const o = sentToOriginal(downFrame, { x: 250, y: 100 });
check("좌표: 보낸 이미지(1/2 축소) → 원본", near(o[0], 600) && near(o[1], 250));
const back = originalToSent(downFrame, o);
check("좌표: 원본 → 보낸 이미지 왕복", near(back.x, 250) && near(back.y, 100));

/* ------------------------------ 보정 문서(info.png) ------------------------------ */

const IMAGE = { name: "info.png", mimeType: "image/png" as const, width: 1804, height: 403 };
const CROP = { x: 300, y: 20, width: 600, height: 383 };
const calibrated = applyCalibration(
  null,
  {
    image: IMAGE,
    crop: CROP,
    references: [
      { label: "10.0 m", a: [465, 38], b: [750, 38], length: 10 },
      { label: "8.0 m", a: [335, 78], b: [335, 343], length: 8 },
    ],
    envelope: { x: 363, y: 78, width: 490, height: 265 },
  },
  "info",
);
if ("error" in calibrated) throw new Error(calibrated.error);
const doc: FloorPlanDocument = calibrated;
check("보정 문서: 형식·문서 검증 오류 없음", errorsOf(doc).length === 0, errorsOf(doc).join(", "));
const frame: ImageFrame = { crop: CROP, width: 600, height: 383 };
const meta = { provider: "claude" as const, model: "test-model", at: "2026-11-25T00:00:00.000Z" };
const W = doc.envelope.width;
const D = doc.envelope.depth;

/* ------------------------------ 제안 ------------------------------ */

const built = buildProposal(doc, fixture, frame, meta);
if ("error" in built) throw new Error(built.error);
const proposal: AiProposal = built;
check("제안: 외곽 벽을 다시 그린 선분은 버림", proposal.walls.length === 6 && proposal.dropped.some((d) => d.includes("외곽 벽과 겹침")), `벽 ${proposal.walls.length}개`);
const [wA, wB, wC] = proposal.walls;
check("제안: 외곽 가까운 끝점은 외곽선에 맞춤", wA.start[1] === 0 && wA.end[1] === D, `${wA.start} → ${wA.end}`);
check("제안: 다른 벽 몸체 가까운 끝점은 그 벽 위로(T 접합)", near(wB.start[0], wA.start[0], 1e-3), `B 시작 ${wB.start}, A u=${wA.start[0]}`);
check("제안: 가까운 끝점끼리 합침(L 접합)", near(wB.end[0], wC.start[0], 1e-3) && near(wB.end[1], wC.start[1], 1e-3));
check("제안: 수평·수직 벽 유지", wA.start[0] === wA.end[0] && wB.start[1] === wB.end[1]);
check("제안: 두께를 픽셀에서 환산(유리 4px)", wA.thicknessRead && wA.thickness > 0.1 && wA.thickness < 0.15, `${wA.thickness}m`);
check("제안: 개구부 8개, 가구 12개", proposal.openings.length === 8 && proposal.furniture.length === 12);
const sofa = proposal.furniture.find((f) => f.kind === "sofa");
const armchair = proposal.furniture.find((f) => f.kind === "armchair");
const benchRight = proposal.furniture.find((f) => f.kind === "bench" && f.rotation === 90);
check(
  "제안: 가구 정면 방향 → 회전(아래 0, 왼쪽 −90, 오른쪽 90), 옆으로 돌면 폭·깊이 교환",
  sofa?.rotation === 0 && armchair?.rotation === -90 && !!benchRight && benchRight.size[0] > 5 * benchRight.size[2],
  JSON.stringify(benchRight?.size),
);
check("제안: 가구 높이는 종류별 기본값", sofa?.size[1] === 0.8);
check(
  "제안: 연속 치수 합계 불일치(3.6 + 3.4 ≠ 8.0)",
  proposal.issues.some((s) => s.key.startsWith("chain:side") && s.message.includes("7m") && s.message.includes("8m")),
  proposal.issues.map((s) => s.key).join(", "),
);
check("제안: 같은 축척이 아닌 표기 치수는 충돌(5.0 m)", proposal.dimensions.find((d) => d.text === "5.0 m")?.status === "conflict");
check("제안: 기준 구간으로 쓴 치수(10.0 m)는 대체로 일치", proposal.dimensions.find((d) => d.text === "10.0 m")?.status !== "unread");
check("제안: 천장 높이 표기 없음 → 누락 확인 항목", proposal.issues.some((s) => s.key === "ceiling:missing" && s.path === "/ceilingHeight"));
check("제안: 외곽은 사용자 보정과 일치(충돌 없음)", !proposal.issues.some((s) => s.key === "envelope") && !!proposal.envelope && near(proposal.envelope.width, W, 0.05));

/* 단위 없는 치수·천장 높이 */
const unitless = buildProposal(
  doc,
  { ...fixture, dimensions: [{ ...fixture.dimensions[1], unit: null, value: 10000, text: "10,000" }], ceilingHeight: { text: "CH 2,700", value: 2700, unit: null } },
  frame,
  meta,
) as AiProposal;
check("단위 없는 치수: 잰 길이에 가장 가까운 단위(mm)로 해석", unitless.dimensions[0].unitAssumed && unitless.dimensions[0].stated === 10);
check("천장 높이 표기(CH 2,700) → 2.7m 제안", unitless.ceilingHeight?.value === 2.7);
const conflictEnv = buildProposal(doc, { ...fixture, envelope: { ...fixture.envelope!, x1: fixture.envelope!.x1 - 60 } }, frame, meta) as AiProposal;
check("외곽이 보정과 다르면 충돌 확인 항목", conflictEnv.issues.some((s) => s.key === "envelope"));
check("보정 없는 문서는 제안을 만들지 않음", "error" in buildProposal(createBlankDocument({ id: "x", width: 5, depth: 4 }), fixture, frame, meta));

/* ------------------------------ 차이·적용 ------------------------------ */

const changes = planChanges(doc, proposal);
const byKey = new Map(changes.map((c) => [c.key, c]));
check("차이: 빈 문서에서는 벽·개구부·가구 모두 추가", changes.filter((c) => c.category !== "issue" && c.action !== "add").length === 0);
check("차이: 벽 없는 곳의 창은 적용 불가로 표시·기본 선택 제외", !!byKey.get("opening:o8")?.blocked && !byKey.get("opening:o8")?.defaultSelected);
check("차이: 추가할 벽 위의 문은 그 벽을 소속으로 제안", !!byKey.get("opening:o1")?.detail?.includes("추가할 벽 w1"), byKey.get("opening:o1")?.detail);
check("차이: 서쪽 외벽 창", !!byKey.get("opening:o4")?.detail?.includes("벽 'west'"));

const applied = applyProposal(doc, proposal, defaultSelection(changes));
const next = applied.doc;
check("적용: 문서 검증 오류 없음", errorsOf(next).length === 0, errorsOf(next).slice(0, 5).join(", "));
check("적용: 벽 6 · 개구부 7 · 가구 12", next.walls.length === 6 && next.openings.length === 7 && (next.furniture ?? []).length === 12, `${next.walls.length}/${next.openings.length}/${next.furniture?.length}`);
const doorA = next.openings.find((x) => x.wallId === next.walls[0].id);
check("적용: 문이 추가한 벽에 놓임(소속 벽 ID 연결)", !!doorA && doorA.kind === "door");
const southDoor = next.openings.find((x) => x.wallId === "south");
check("적용: 남쪽 출입문 경첩·열림 방향(실내 쪽 = pos)", southDoor?.door?.hinge === "start" && southDoor.door.swing === "pos", JSON.stringify(southDoor?.door));
// 위→아래로 진행하는 벽의 왼쪽 법선은 서쪽(−u) = 대회의실 쪽, 경첩은 위쪽 문설주 = 벽 시작 쪽
check("적용: 문 경첩·열림 방향(대회의실 쪽 = 왼쪽 법선 pos)", doorA?.door?.swing === "pos" && doorA.door.hinge === "start", JSON.stringify(doorA?.door));
const smallDoor = next.openings.find((x) => x.wallId === next.walls[1].id);
// 왼→오 진행 벽의 왼쪽 법선은 아래(+v) = 소회의실 쪽, 경첩은 오른쪽 문설주 = 벽 끝 쪽
check("적용: 소회의실 문(아래쪽 pos, 경첩 end)", smallDoor?.door?.swing === "pos" && smallDoor.door.hinge === "end", JSON.stringify(smallDoor?.door));
const p0 = next.provenance?.find((p) => p.path === "/walls/0");
check("적용: 출처 source·미확인·원본 근거 위치·신뢰도 기록", p0?.origin === "source" && p0.confirmed === false && !!p0.region && p0.confidence === 0.8);
check("적용: 개구부 높이는 기본값 출처로 기록", next.provenance?.some((p) => p.path.match(/^\/openings\/\d+\/height$/) && p.origin === "default") ?? false);
check("적용: 확인 항목(합계 불일치·천장 높이 누락)을 문서 issues에 기록", (next.issues ?? []).some((s) => s.kind === "conflict" && s.message.includes("합계")) && (next.issues ?? []).some((s) => s.kind === "missing"));
check("적용: 목록 검토 상태를 미검토로", next.completeness?.walls === "unreviewed" && next.completeness?.furniture === "unreviewed");
check("적용: 선택했지만 적용 못 한 항목 없음(기본 선택)", applied.skipped.length === 0, applied.skipped.join(", "));
const scene = floorPlanToScene(next);
check("적용: 장면 변환", scene.partitions.length === 6 && (scene.furniture ?? []).length >= 12);
const layoutProblems = validateSceneLayout(scene);
check("적용: 배치 검사(관통·문 열림·동선) 통과 — 벽에 붙여 그린 벤치는 벽 밖으로 밀어냄", layoutProblems.length === 0, layoutProblems.join(", "));

const again = planChanges(next, proposal);
check(
  "재분석: 같은 결과를 다시 적용하면 모두 '일치'",
  again.filter((c) => c.category !== "issue" && !c.blocked).every((c) => c.action === "same") && again.filter((c) => c.category === "issue").every((c) => c.action === "same"),
  again.filter((c) => c.action !== "same" && !c.blocked).map((c) => c.key).join(", "),
);
check("재분석: 기본 선택 없음(중복 추가 방지)", defaultSelection(again).size === 0);

// 사용자가 벽을 옮기면(확정값) 재분석 결과가 그 벽을 덮어쓰지 않는다.
const edited = translateWall(next, next.walls[0].id, 0.2, 0);
const editedChanges = planChanges(edited, proposal);
const wallChange = editedChanges.find((c) => c.key === "wall:w1");
check("확정값 보호: 사용자가 옮긴 벽은 '변경' + 보호 + 기본 선택 제외", wallChange?.action === "update" && wallChange.protectedValue && !wallChange.defaultSelected);
const reapplied = applyProposal(edited, proposal, defaultSelection(editedChanges)).doc;
check("확정값 보호: 기본 선택으로 적용해도 사용자 값 유지", reapplied.walls[0].start[0] === edited.walls[0].start[0]);
const forced = applyProposal(edited, proposal, new Set(["wall:w1"])).doc;
check("확정값 보호: 사용자가 직접 고르면 변경 적용(출처 source로)", near(forced.walls[0].start[0], wA.start[0], 1e-6) && forced.provenance?.find((p) => p.path === "/walls/0")?.origin === "source");

// 기존 AI 값(미확인)은 보호 대상이 아니다.
const aiMoved = { ...next, walls: next.walls.map((w, i) => (i === 0 ? { ...w, start: [w.start[0] + 0.2, w.start[1]] as [number, number], end: [w.end[0] + 0.2, w.end[1]] as [number, number] } : w)) };
const aiChange = planChanges(aiMoved, proposal).find((c) => c.key === "wall:w1");
check("미확인 AI 값은 보호하지 않음(변경 기본 선택)", aiChange?.action === "update" && !aiChange.protectedValue && aiChange.defaultSelected);

const onlyDoor = applyProposal(doc, proposal, new Set(["opening:o1"]));
check("선택 적용: 소속 벽을 고르지 않은 문은 건너뜀(이유 표시)", onlyDoor.doc.openings.length === 0 && onlyDoor.skipped.length === 1, onlyDoor.skipped.join(", "));
const onlyWindows = applyProposal(doc, proposal, new Set(["opening:o4", "opening:o5"]));
check("선택 적용: 고른 항목만", onlyWindows.doc.openings.length === 2 && onlyWindows.doc.walls.length === 0);

/* ------------------------------ 서버 처리 ------------------------------ */

const cropPng = await sharp("info.png").extract({ left: CROP.x, top: CROP.y, width: CROP.width, height: CROP.height }).png().toBuffer();
const cropJpg = await sharp(cropPng).jpeg({ quality: 85 }).toBuffer();
const pngHeader = readImageHeader(cropPng.toString("base64"));
const jpgHeader = readImageHeader(cropJpg.toString("base64"));
check("이미지 머리글: PNG 형식·크기", pngHeader?.mimeType === "image/png" && pngHeader.width === 600 && pngHeader.height === 383);
check("이미지 머리글: JPEG 형식·크기", jpgHeader?.mimeType === "image/jpeg" && jpgHeader.width === 600 && jpgHeader.height === 383, JSON.stringify(jpgHeader));
check("이미지 머리글: 이미지가 아니면 null", readImageHeader(Buffer.from("hello world, not an image").toString("base64")) === null);

const request: ExtractRequest = ExtractRequestSchema.parse({
  provider: "claude",
  image: { mimeType: "image/png", data: cropPng.toString("base64"), width: 600, height: 383 },
  frame: { crop: CROP },
  document: doc,
});
const ok = (textOut: string, model = "test-model"): ProviderReply => ({ kind: "ok", text: textOut, model, usage: { inputTokens: 1000, outputTokens: 500 } });
const scripted = (replies: (ProviderReply | Error)[], seen: string[] = []): ProviderCall => {
  let i = 0;
  return async (req) => {
    seen.push(req.userText);
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
};
const run = (call: ProviderCall, req: ExtractRequest = request, signal = new AbortController().signal, timedOut = () => false) =>
  runExtraction(req, { provider: "claude", call, signal, timedOut, now: () => new Date("2026-11-25T00:00:00Z") });

const seen: string[] = [];
const success = await run(scripted([ok(fixtureText, "claude-opus-5-5")], seen));
check("서버: 정상 응답 → 제안 + 초안 검증", success.ok && success.attempts === 1 && success.proposal.walls.length === 6 && success.draftValidation.errors === 0, success.ok ? "" : success.message);
check("서버: 사용자가 지정한 외곽을 보낸 이미지 좌표로 안내(63–553, 58–323)", seen[0]?.includes("x 63-553, y 58-323") ?? false, seen[0]);
check("서버: 토큰·추정 비용(공개 단가표 모델)", success.ok && success.usage.inputTokens === 1000 && success.usage.estimatedCostUsd === 0.014);

const seen2: string[] = [];
const retried = await run(scripted([ok("{ not json"), ok(fixtureText)], seen2));
check("서버: JSON 아님 → 이유를 붙여 재요청 후 성공", retried.ok && retried.attempts === 2 && seen2[1].includes("not valid JSON"));
const schemaRetry = await run(scripted([ok(JSON.stringify({ ...fixture, walls: [{ kind: "brick" }] })), ok(fixtureText)], []));
check("서버: 형식 오류 → 재요청 후 성공, 사용량 합산", schemaRetry.ok && schemaRetry.attempts === 2 && schemaRetry.usage.inputTokens === 2000);
const invalidTwice = await run(scripted([ok("{}")]));
check("서버: 재요청 한도(2회) 후 형식 오류 실패", !invalidTwice.ok && invalidTwice.code === "extract.invalidResponse" && invalidTwice.attempts === 2 && invalidTwice.retryable);
const truncated = await run(scripted([{ kind: "truncated", model: "m", usage: { inputTokens: 10, outputTokens: 32000 } }, ok(fixtureText)], []));
check("서버: 출력 잘림 → 간결하게 재요청", truncated.ok && truncated.attempts === 2);
const refusal = await run(scripted([{ kind: "refusal", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }]));
check("서버: 거절 → 재요청 없이 실패(수동 입력 안내)", !refusal.ok && refusal.code === "provider.refusal" && refusal.attempts === 1 && !refusal.retryable);
const unreadable = await run(scripted([ok(JSON.stringify({ ...fixture, readable: false, walls: [], openings: [], furniture: [] }))]));
check("서버: 판독 불가 → 실패(빈 도면을 성공으로 반환하지 않음)", !unreadable.ok && unreadable.code === "extract.unreadable");
const empty = await run(scripted([ok(JSON.stringify({ ...fixture, walls: [], openings: [], furniture: [], dimensions: [] }))]));
check("서버: 추출 항목 없음 → 실패", !empty.ok && empty.code === "extract.empty");
const authFail = await run(scripted([new ProviderError("provider.auth", "키 오류", false)]));
check("서버: 공급자 인증 오류 전달", !authFail.ok && authFail.code === "provider.auth" && !authFail.retryable);
const aborted = new AbortController();
aborted.abort();
const cancelled = await run(scripted([new ProviderError("cancelled", "취소", true)]), request, aborted.signal);
check("서버: 취소", !cancelled.ok && cancelled.code === "cancelled");
const timedOut = await run(scripted([new ProviderError("cancelled", "취소", true)]), request, aborted.signal, () => true);
check("서버: 전체 시간 한도 → timeout", !timedOut.ok && timedOut.code === "timeout" && timedOut.retryable);
const noCal = await run(scripted([ok(fixtureText)]), { ...request, document: createBlankDocument({ id: "x", width: 5, depth: 4 }) });
check("서버: 보정 없는 문서 거부", !noCal.ok && noCal.code === "document.notCalibrated");
const badDoc = await run(scripted([ok(fixtureText)]), { ...request, document: { schemaVersion: 2 } });
check("서버: 형식 오류 문서 거부", !badDoc.ok && badDoc.code === "document.invalid");
const wrongSize = await run(scripted([ok(fixtureText)]), { ...request, image: { ...request.image, width: 300 } });
check("서버: 선언한 크기와 이미지 머리글이 다르면 거부", !wrongSize.ok && wrongSize.code === "request.invalid");
const wrongRatio = await run(scripted([ok(fixtureText)]), { ...request, frame: { crop: { ...CROP, width: 900 } } });
check("서버: 가로·세로 축소 비율이 다르면 거부", !wrongRatio.ok && wrongRatio.code === "request.invalid");
check("요청 형식: 알 수 없는 공급자 거부", !ExtractRequestSchema.safeParse({ ...request, provider: "gemini" }).success);
check("요청 형식: 긴 변 2576px 초과 거부", !ExtractRequestSchema.safeParse({ ...request, image: { ...request.image, width: 3000 } }).success);

console.log(failed ? `\n${failed}개 실패` : "\n모든 AI 추출 검증 통과");
process.exit(failed ? 1 : 0);
