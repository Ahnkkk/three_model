/**
 * 도면 인식 채점·평가 사례 검증(단기 계획 S5). 실제 모델을 호출하지 않는다.
 * 실행: npm run verify:score
 *  - 채점 규칙: 정답을 일부러 바꾼 결과(벽 누락·이동·분할, 개구부 종류·경첩·열림·소속 벽, 가구 누락·회전·종류,
 *    천장 높이, 치수 값·구간·충돌)에서 각 지표와 추정 수정 수가 의도대로 나오는지
 *  - 평가 사례: 생성 파일(JSON)이 생성기 결과와 같은지, 사례 형식·문서가 유효한지
 *  - 실행 흐름: 사례마다 "완벽한 모델" 고정 응답으로 추출 → 적용 → 채점했을 때 수정 수 0, 치수 충돌·천장 누락 감지
 *  - 보낼 이미지 준비: 평면도 영역 잘라내기·긴 변 축소
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { AI_LIMITS } from "../src/lib/floorPlan/ai/protocol";
import { createBlankDocument } from "../src/lib/floorPlan/editor";
import { scoreFloorPlan, type TruthDimension, type PredictedDimension } from "../src/lib/floorPlan/eval/score";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { buildEvalSamples } from "./floor-plan-eval-samples";
import { fakeCall, listCaseDirs, loadCase, prepareImage, runCase } from "./floor-plan-eval";
import { ROOT } from "./floor-plan-files";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const near = (a: number | null, b: number, eps = 1e-3) => a !== null && Math.abs(a - b) < eps;
const clone = <T>(v: T): T => structuredClone(v);

/* ------------------------------ 채점 규칙 ------------------------------ */

const truth = JSON.parse(readFileSync(path.join(ROOT, "examples/floor-plans/eval/studio-clean/truth.json"), "utf8")) as FloorPlanDocument;
const score = (pred: FloorPlanDocument, extra: Partial<Parameters<typeof scoreFloorPlan>[0]> = {}) => scoreFloorPlan({ truth, predicted: pred, ...extra });

{
  const s = score(clone(truth));
  check(
    "같은 문서: 모든 재현율·정밀도 100%, 추정 수정 수 0",
    [s.walls, s.openings, s.furniture].every((d) => d.recall === 1 && d.precision === 1) && s.walls.lengthRecall === 1 && s.corrections.total === 0 && s.frame.ok,
    JSON.stringify(s.corrections),
  );
}

// 벽
{
  const p = clone(truth);
  p.walls = p.walls.filter((w) => w.id !== "nook-glass");
  const s = score(p);
  check("벽 누락: 누락 1, 재현율 2/3, 수정 1", s.walls.missed.join() === "nook-glass" && near(s.walls.recall, 2 / 3) && s.corrections.walls === 1);
}
{
  const p = clone(truth);
  const w = p.walls.find((x) => x.id === "bath-west")!;
  w.start = [w.start[0] + 0.08, w.start[1]];
  w.end = [w.end[0] + 0.08, w.end[1]];
  const s = score(p);
  check("벽 0.08m 이동: 일치하지만 수정 필요, 끝점 오차 0.08m", s.walls.matched === 3 && s.walls.needsEdit.join() === "bath-west" && near(s.walls.endpointError.max, 0.08), JSON.stringify(s.walls.endpointError));
  check("벽 0.08m 이동: 길이 재현율 100%(덮임 기준 0.1m)", s.walls.lengthRecall === 1, String(s.walls.lengthRecall));
}
{
  const p = clone(truth);
  const w = p.walls.find((x) => x.id === "bath-west")!;
  w.start = [w.start[0] + 0.5, w.start[1]];
  w.end = [w.end[0] + 0.5, w.end[1]];
  const s = score(p);
  check("벽 0.5m 이동: 누락 1 + 오검출 1", s.walls.missed.join() === "bath-west" && s.walls.extra.join() === "bath-west" && s.corrections.walls === 2);
}
{
  const p = clone(truth);
  const w = p.walls.find((x) => x.id === "bath-west")!;
  p.walls = [...p.walls.filter((x) => x.id !== "bath-west"), { ...w, id: "bw-1", end: [3.2, 0.9] }, { ...w, id: "bw-2", start: [3.2, 0.9] }];
  const s = score(p);
  check("벽을 둘로 나눔: 항목 기준 누락 1·오검출 2, 길이 재현율·정밀도 100%", s.walls.missed.length === 1 && s.walls.extra.length === 2 && s.walls.lengthRecall === 1 && s.walls.lengthPrecision === 1);
}
{
  const p = clone(truth);
  p.walls.find((x) => x.id === "nook-glass")!.kind = "solid";
  p.walls.find((x) => x.id === "bath-south")!.thickness = 0.2;
  const s = score(p);
  check("벽 종류·두께 다름: 종류 오류 1, 수정 필요 2", s.walls.kindErrors.join() === "nook-glass" && s.walls.needsEdit.length === 2);
}

// 개구부
{
  const p = clone(truth);
  p.openings.find((o) => o.id === "north-window")!.kind = "passage";
  const s = score(p);
  check("개구부 종류 다름: 종류 오류 1, 수정 1", s.openings.kindErrors.join() === "north-window" && s.corrections.openings === 1);
}
{
  const p = clone(truth);
  p.openings.find((o) => o.id === "bath-door")!.door!.hinge = "end";
  p.openings.find((o) => o.id === "entrance")!.door!.swing = "neg";
  const s = score(p);
  check(
    "문 경첩·열림 방향 바뀜: 각각 1개 감지",
    s.openings.doorsCompared === 2 && s.openings.hingeErrors.join() === "bath-door" && s.openings.swingErrors.join() === "entrance" && s.corrections.openings === 2,
  );
}
{
  // 소속 벽을 0.2m 어긋나게 그리면 문도 따라 움직인다 → 짝은 짓지만 소속 벽이 다르다
  const p = clone(truth);
  const w = p.walls.find((x) => x.id === "bath-south")!;
  w.start = [w.start[0], 2.0];
  w.end = [w.end[0], 2.0];
  const s = score(p);
  check("소속 벽이 어긋남: 문 짝짓기 유지, 소속 벽 오류", s.openings.matched === 4 && s.openings.hostErrors.join() === "bath-door");
}
{
  // 소속 벽을 문 중심에서 둘로 나눠도 소속 벽은 맞다
  const p = clone(truth);
  const w = p.walls.find((x) => x.id === "bath-south")!;
  const door = p.openings.find((o) => o.id === "bath-door")!;
  p.walls = [...p.walls.filter((x) => x.id !== "bath-south"), { ...w, id: "bs-1", end: [4.1, 1.8] }, { ...w, id: "bs-2", start: [4.1, 1.8] }];
  door.wallId = "bs-1";
  const s = score(p);
  check("소속 벽을 나눠 그림: 소속 벽 오류 없음", s.openings.matched === 4 && s.openings.hostErrors.length === 0, JSON.stringify(s.openings.hostErrors));
}
{
  const p = clone(truth);
  p.openings = p.openings.filter((o) => o.id !== "south-window");
  p.openings.push({ id: "ghost", wallId: "west", kind: "window", offset: 2, width: 1, height: 1.2, bottom: 0.9 });
  const s = score(p);
  check("개구부 누락 1·오검출 1", s.openings.missed.join() === "south-window" && s.openings.extra.join() === "ghost" && near(s.openings.precision, 0.75), String(s.openings.precision));
}

// 가구
{
  const p = clone(truth);
  p.furniture = p.furniture!.filter((f) => f.id !== "plant");
  p.furniture.find((f) => f.id === "sofa")!.rotation = 90;
  p.furniture.find((f) => f.id === "coffee-table")!.rotation = 180;
  p.furniture.find((f) => f.id === "desk")!.kind = "lowCabinet";
  const s = score(p);
  check("가구 누락 1", s.furniture.missed.join() === "plant");
  check("가구 방향: 소파 90° 회전은 오류, 커피 테이블 180°는 대칭이라 오류 아님", s.furniture.rotationErrors.join() === "sofa", JSON.stringify(s.furniture.rotationErrors));
  check("가구 종류 다름 1, 수정 수 = 누락 1 + 소파 1 + 책상 1", s.furniture.kindErrors.join() === "desk" && s.corrections.furniture === 3, JSON.stringify(s.corrections));
}
{
  const p = clone(truth);
  const sofa = p.furniture!.find((f) => f.id === "sofa")!;
  sofa.size = [sofa.size[0] + 0.3, sofa.size[1], sofa.size[2]];
  sofa.position = [sofa.position[0] + 0.1, 0, sofa.position[2]];
  const s = score(p);
  check("가구 크기 0.3m·위치 0.1m 차이: 크기 오차 0.3m, 수정 필요", near(s.furniture.sizeError.max, 0.3) && s.furniture.needsEdit.join() === "sofa");
}

// 천장 높이
{
  const blank = createBlankDocument({ id: "p", width: 5, depth: 4 });
  const p: FloorPlanDocument = { ...clone(truth), ceilingHeight: 2.6, provenance: blank.provenance };
  check("천장: 기본값 출처는 값이 같아도 읽은 것이 아님", !score(p).ceiling.ok);
  const q: FloorPlanDocument = { ...p, provenance: [{ path: "/ceilingHeight", origin: "source", confirmed: false }] };
  check("천장: 원본에서 읽은 같은 값은 맞음", score(q).ceiling.ok);
  check("천장: 표기 없는 도면에서 누락 표시가 없으면 다름", !score(q, { ceilingHeightMissing: true }).ceiling.ok);
  const r: FloorPlanDocument = { ...p, issues: [{ id: "i1", kind: "missing", path: "/ceilingHeight", message: "x", resolved: false }] };
  check("천장: 표기 없는 도면에서 누락 표시가 있으면 맞음", score(r, { ceilingHeightMissing: true }).ceiling.ok && score(r, { ceilingHeightMissing: true }).corrections.ceiling === 0);
}

// 외곽 기준
{
  const p = clone(truth);
  p.envelope = { ...p.envelope, width: 5.2 };
  check("외곽 크기가 다르면 기준 경고", !score(p).frame.ok);
}

// 치수
{
  const td: TruthDimension[] = [
    { text: "5000", value: 5, a: [0, -0.7], b: [5, -0.7] },
    { text: "3200", value: 3.2, a: [0, -0.5], b: [3.2, -0.5] },
    { text: "1800", value: 1.8, a: [3.2, -0.5], b: [5, -0.5] },
    { text: "4000", value: 4, a: [-0.7, 0], b: [-0.7, 4] },
    { text: "3600", value: 3.6, a: [0, 4.7], b: [3.6, 4.7], conflict: true },
  ];
  const ok = (d: TruthDimension, status: PredictedDimension["status"] = "ok"): PredictedDimension => ({ text: d.text!, stated: d.value, a: d.a, b: d.b, status });
  const perfect = td.map((d) => ok(d, d.conflict ? "conflict" : "ok"));
  const s1 = score(clone(truth), { truthDimensions: td, predictedDimensions: perfect });
  check("치수 그대로: 연결·정확 100%, 충돌 감지 1/1", s1.dimensions!.linkAccuracy === 1 && s1.dimensions!.exactAccuracy === 1 && s1.dimensions!.conflictsDetected === 1);
  // 치수선이 아닌 벽 위 점으로 보고해도(수직 위치만 다름) 같은 구간이다
  const onWall = td.map((d) => ({ ...ok(d, d.conflict ? "conflict" : "ok"), a: [d.a[0], d.a[1] === d.b[1] ? 0 : d.a[1]] as [number, number], b: [d.b[0], d.a[1] === d.b[1] ? 0 : d.b[1]] as [number, number] }));
  check("치수: 수직 위치만 다른 구간은 같은 구간", score(clone(truth), { truthDimensions: td, predictedDimensions: onWall }).dimensions!.linked === 5);
  const wrong = perfect.map((d, i) => (i === 1 ? { ...d, stated: 3.5 } : d));
  const s2 = score(clone(truth), { truthDimensions: td, predictedDimensions: wrong });
  check("치수 값 오독: 연결 100%, 정확 80%, 값 오독 1", s2.dimensions!.linkAccuracy === 1 && near(s2.dimensions!.exactAccuracy, 0.8) && s2.dimensions!.valueErrors.join() === "3200");
  // 1800을 3200 구간에 붙이고 3200은 빠뜨림 → 1800은 오독(구간은 맞음 아님), 다른 구간 연결 판정
  const swapped = [perfect[0], { ...perfect[2], a: [0, -0.5] as [number, number], b: [1.8, -0.5] as [number, number] }, perfect[3], perfect[4]];
  const s3 = score(clone(truth), { truthDimensions: td, predictedDimensions: swapped });
  check("치수 다른 구간 연결: 누락 2·오검출 1·다른 구간 연결 1", s3.dimensions!.missed.length === 2 && s3.dimensions!.extra.length === 1 && s3.dimensions!.misattached.join() === "1800", JSON.stringify(s3.dimensions));
  const noConflict = perfect.map((d) => ({ ...d, status: "ok" as const }));
  const falseConflict = perfect.map((d, i) => (i === 0 ? { ...d, status: "conflict" as const } : d));
  check("치수 충돌을 놓치면 감지 0/1", score(clone(truth), { truthDimensions: td, predictedDimensions: noConflict }).dimensions!.conflictsDetected === 0);
  check("충돌이 아닌 치수를 충돌로 표시하면 기록", score(clone(truth), { truthDimensions: td, predictedDimensions: falseConflict }).dimensions!.falseConflicts.join() === "5000");
}

/* ------------------------------ 평가 사례 ------------------------------ */

const generated = await buildEvalSamples();
const stale = generated.filter(([file, content]) => typeof content === "string" && readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== content).map(([f]) => path.relative(ROOT, f));
check("합성 사례 JSON이 생성기 결과와 같음(npm run eval:samples)", stale.length === 0, stale.join(", "));

const dirs = listCaseDirs();
check("평가 사례 4개 이상", dirs.length >= 4, `${dirs.length}개`);
for (const dir of dirs) {
  let c;
  try {
    c = loadCase(dir);
  } catch (e) {
    check(`사례 ${path.basename(dir)}: 불러오기`, false, String(e));
    continue;
  }
  const id = c.spec.id;
  if (!c.spec.fakeExtraction) continue;
  const run = await runCase(c, "claude", fakeCall(path.join(dir, c.spec.fakeExtraction)));
  if (!run.response.ok || !run.score) {
    check(`사례 ${id}: 고정 응답 추출`, false, run.response.ok ? "" : `${run.response.code} ${run.response.message}`);
    continue;
  }
  const s = run.score;
  if (c.spec.synthetic) {
    check(`사례 ${id}: 완벽한 응답 → 추정 수정 수 0`, s.corrections.total === 0, JSON.stringify(s.corrections));
    check(`사례 ${id}: 완벽한 응답 → 치수 연결·정확 100%`, s.dimensions?.linkAccuracy === 1 && s.dimensions?.exactAccuracy === 1);
    check(`사례 ${id}: 적용 결과 문서 검증 오류 없음`, run.response.draftValidation.errors === 0, `${run.response.draftValidation.errors}개`);
  }
  const expected = c.spec.dimensions.filter((d) => d.conflict).length;
  check(`사례 ${id}: 치수 충돌 감지 ${expected}/${expected}`, s.dimensions?.conflictsDetected === expected);
  if (expected) {
    check(`사례 ${id}: 합계 불일치 확인 항목`, (run.draft?.issues ?? []).some((i) => i.message.startsWith("치수 합계 불일치")));
  }
  check(`사례 ${id}: 천장 높이 ${c.spec.ceilingHeightMissing ? "누락 표시" : "읽음"}`, s.ceiling.ok);
}

/* ------------------------------ 보낼 이미지 준비 ------------------------------ */

{
  const big = await sharp({ create: { width: 3200, height: 1400, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const doc: FloorPlanDocument = {
    ...createBlankDocument({ id: "big", width: 10, depth: 4 }),
    source: { kind: "image", image: { mimeType: "image/png", width: 3200, height: 1400 }, crop: { x: 100, y: 50, width: 3000, height: 1200 } },
  };
  const prepared = await prepareImage(big, doc);
  check(
    "이미지 준비: 평면도 영역을 잘라 긴 변 상한으로 축소",
    prepared.image.width === AI_LIMITS.maxImageEdge && prepared.image.height === Math.round((1200 * AI_LIMITS.maxImageEdge) / 3000) && prepared.frame.crop.x === 100 && prepared.frame.crop.width === 3000,
    `${prepared.image.width}×${prepared.image.height}`,
  );
  const small = await prepareImage(big, { ...doc, source: { ...doc.source!, crop: undefined } });
  check("이미지 준비: 영역이 없으면 전체(상한 이하로 축소)", small.frame.crop.width === 3200 && small.image.width === AI_LIMITS.maxImageEdge);
}

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
