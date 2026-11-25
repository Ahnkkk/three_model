/**
 * 도면 편집 연산·이미지 배율 보정 비브라우저 검증(단기 계획 S3).
 * 실행: npm run verify:editor
 *  - 새 도면·벽·개구부 추가/이동/수정/삭제, 삭제 시 출처 경로 재번호, 실행 취소·다시 실행
 *  - 맞춤(끝점·직교·격자·벽 몸체), 이미지 파일 검증, 배율 보정
 *  - AI 없이 수동 입력·이미지 보정으로 만든 문서가 검증 → 장면 변환 → 배치 검사까지 통과하는지
 *  - JSON 저장 왕복 후 치수·좌표 유지
 */
import { deepStrictEqual } from "node:assert";
import { applyCalibration, checkImageFile, computeCalibration, imageMatchesSource, pixelToPlan } from "../src/lib/floorPlan/calibration";
import {
  addOpening,
  addWall,
  confirmPath,
  createBlankDocument,
  deleteOpening,
  deleteWall,
  documentForExport,
  editorReducer,
  initEditor,
  moveOpening,
  setCeilingHeight,
  setCompleteness,
  setEnvelope,
  snapPoint,
  toDocumentId,
  translateWall,
  updateOpening,
  updateWall,
} from "../src/lib/floorPlan/editor";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { floorPlanToScene } from "../src/lib/floorPlan/toScene";
import { parseFloorPlanJson, validateFloorPlan } from "../src/lib/floorPlan/validate";
import { activeColliders, buildColliders, penetration } from "../src/lib/three/collision";
import { validateSceneLayout } from "../src/lib/three/layoutValidation";
import { resolveDisplayMode } from "../src/config/sceneTypes";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const errorsOf = (doc: unknown) => validateFloorPlan(doc).issues.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.path}`);
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("값이 없습니다");
  return v;
};

/* ------------------------------ 새 도면·기본값 ------------------------------ */

const blank = createBlankDocument({ id: "manual-room", title: "수동 입력 방", width: 6, depth: 4.5 });
const blankResult = validateFloorPlan(blank);
check("새 도면: 검증 통과(내부 벽·가구 없음)", blankResult.ok, errorsOf(blank).join(", "));
check(
  "새 도면: 기본값(외벽 두께·천장 높이)은 미확인 경고",
  ["provenance.unconfirmed@/envelope/wallThickness", "provenance.unconfirmed@/ceilingHeight"].every((k) => blankResult.issues.some((i) => `${i.code}@${i.path}` === k)),
);
check("문서 ID: 파일 이름에서 만들기", toDocumentId("2층 평면도 (최종).png") === "2" && toDocumentId("office_plan v2.jpg") === "office_plan-v2" && toDocumentId("###.png") === "plan");

/* ------------------------------ 수동 입력 흐름 ------------------------------ */

let doc: FloorPlanDocument = blank;
// 욕실: 위쪽 오른쪽 L자(외곽 북쪽 면·동쪽 면에 닿음)
const w1 = addWall(doc, [4, 0], [4, 2]);
doc = w1.doc;
const w2 = addWall(doc, [4, 2], [6, 2]);
doc = w2.doc;
const bathDoor = must(addOpening(doc, w2.id, "door", 1.0));
doc = bathDoor.doc;
const entrance = must(addOpening(doc, "west", "door", 3.2));
doc = entrance.doc;
const win = must(addOpening(doc, "north", "window", 2.0));
doc = win.doc;
check("수동 입력: 벽 2·문 2·창 1 추가 후 검증 통과", errorsOf(doc).length === 0, errorsOf(doc).join(", "));
check("수동 입력: 새 벽 ID·기본 두께", w1.id === "wall-1" && w2.id === "wall-2" && doc.walls[0].thickness === 0.12);
check("수동 입력: 내부 벽에는 창을 추가하지 않음", addOpening(doc, w1.id, "window", 1) === null);
check("수동 입력: 벽 길이를 넘는 위치는 벽 안으로 제한", must(addOpening(doc, w2.id, "passage", 99)).doc.openings.at(-1)!.offset === 1.55);
const scene = floorPlanToScene(must(validateFloorPlan(doc).document));
check("수동 입력: 장면 변환·배치 검사 통과", validateSceneLayout(scene).length === 0, validateSceneLayout(scene).join(" / "));
const start = resolveDisplayMode(scene, "interior").camera.views[0];
check(
  "수동 입력: 실내 시작 위치가 서쪽 출입문 안쪽·장애물 밖",
  near(start.position[0], -2) && near(start.position[2], -0.95) && activeColliders(buildColliders(scene), start.position[1]).every((c) => penetration(c, start.position[0], start.position[2], 0.2).depth < 1e-6),
  `(${start.position[0]}, ${start.position[2]})`,
);

/* ------------------------------ 수정·이동·삭제 ------------------------------ */

const moved = translateWall(doc, w1.id, -0.5, 5);
check("이동: 벽 전체 이동은 외곽 안으로 제한", moved.walls[0].start[0] === 3.5 && moved.walls[0].end[1] === 4.5 && moved.walls[0].start[1] === 2.5);
const glass = updateWall(doc, w1.id, { kind: "glass" });
check("수정: 종류를 바꾸면 기본 두께도 바뀜", glass.walls[0].thickness === 0.08 && updateWall(updateWall(doc, w1.id, { thickness: 0.2 }), w1.id, { kind: "glass" }).walls[0].thickness === 0.2);
const asWindow = updateOpening(doc, entrance.id, { kind: "window" });
check("수정: 문 → 창이면 문짝을 없애고 하단 높이를 창 기본값으로", !asWindow.openings[1].door && asWindow.openings[1].bottom === 0.9 && errorsOf(asWindow).length === 0);
const slid = moveOpening(doc, bathDoor.id, w2.id, 0.1);
check("이동: 개구부를 벽 끝 너머로 옮기면 폭 절반 위치에서 멈춤", slid.openings[0].offset === 0.45);
check("이동: 창은 내부 벽으로 옮기지 않음", moveOpening(doc, win.id, w1.id, 1) === doc);
const tooTall = updateOpening(doc, win.id, { height: 2.5 });
check("수정: 벽보다 높은 창은 문서 검증 오류로 표시", errorsOf(tooTall).includes("opening.tooTall@/openings/2/height"));

// 출처 경로 재번호: wall-1 삭제 → wall-2가 /walls/0, 욕실 문은 그대로 /openings/0
const withNote = { ...doc, issues: [{ id: "n1", kind: "assumption" as const, path: "/walls/1/thickness", message: "두께 가정", resolved: false }] };
const removed = deleteWall(withNote, w1.id);
check(
  "삭제: 벽을 지우면 뒤 항목의 출처·확인 항목 경로 번호를 당김",
  removed.walls.length === 1 &&
    removed.provenance!.some((p) => p.path === "/walls/0") &&
    !removed.provenance!.some((p) => p.path === "/walls/1") &&
    removed.issues![0].path === "/walls/0/thickness" &&
    errorsOf(removed).length === 0,
);
const removedWithOpenings = deleteWall(doc, w2.id);
check(
  "삭제: 벽을 지우면 그 벽의 개구부와 출처도 지움",
  removedWithOpenings.openings.every((o) => o.wallId !== w2.id) && removedWithOpenings.openings.length === 2 && errorsOf(removedWithOpenings).length === 0,
);
const noEntrance = deleteOpening(doc, entrance.id);
check("삭제: 개구부 삭제 후 출처 경로가 남은 항목을 가리킴", noEntrance.provenance!.every((p) => !p.path.startsWith("/openings/") || Number(p.path.split("/")[2]) < noEntrance.openings.length));

const resized = setCeilingHeight(setEnvelope(doc, { width: 6.5 }), 3);
check("수정: 외곽·천장 입력값은 사용자 확인 출처", resized.provenance!.filter((p) => ["/envelope/width", "/ceilingHeight"].includes(p.path)).every((p) => p.origin === "user" && p.confirmed));
const confirmed = confirmPath(doc, "/envelope");
check("확인: 경로 하위의 미확인 출처를 확인 처리", confirmed.provenance!.filter((p) => p.path.startsWith("/envelope")).every((p) => p.confirmed));
const reviewed = setCompleteness(doc, "walls", "reviewed");
check("검토 상태: 목록별로 표시", reviewed.completeness?.walls === "reviewed" && reviewed.completeness?.furniture === "unreviewed");

/* ------------------------------ 실행 취소·다시 실행 ------------------------------ */

let st = initEditor(blank);
st = editorReducer(st, { type: "apply", update: (d) => addWall(d, [1, 0], [1, 4.5]).doc });
st = editorReducer(st, { type: "apply", update: (d) => addWall(d, [1, 2], [3, 2]).doc });
const afterTwo = st.doc;
st = editorReducer(st, { type: "undo" });
check("실행 취소: 마지막 벽 추가를 되돌림", st.doc.walls.length === 1 && st.future.length === 1 && st.dirty);
st = editorReducer(st, { type: "redo" });
check("다시 실행: 같은 문서로 복원", st.doc === afterTwo);
st = editorReducer(st, { type: "undo" });
st = editorReducer(st, { type: "apply", update: (d) => setCeilingHeight(d, 3) });
check("실행 취소: 새 편집 후에는 다시 실행 기록을 비움", st.future.length === 0 && st.past.length === 2);
check("실행 취소: 바뀌지 않은 편집은 기록하지 않음", editorReducer(st, { type: "apply", update: (d) => d }) === st);

/* ------------------------------ 맞춤 ------------------------------ */

const snapDoc = addWall(blank, [2, 0], [2, 3]).doc;
const opts = { radius: 0.15, grid: 0.05 };
check("맞춤: 가까운 벽 끝점", JSON.stringify(snapPoint(snapDoc, [2.08, 2.9], opts)) === JSON.stringify({ point: [2, 3], kind: "endpoint" }));
check("맞춤: 외곽 모서리", snapPoint(snapDoc, [5.95, 4.4], opts).point.join() === "6,4.5");
check("맞춤: 시작점 기준 직교 고정 + 격자", JSON.stringify(snapPoint(snapDoc, [4.37, 1.04], { ...opts, from: [3, 1] })) === JSON.stringify({ point: [4.35, 1], kind: "ortho" }));
check("맞춤: 벽 몸체 위로 투영(T자 접합)", JSON.stringify(snapPoint(snapDoc, [2.1, 1.52], { ...opts, from: [4, 1.5] })) === JSON.stringify({ point: [2, 1.5], kind: "edge" }));
check("맞춤: 외곽 밖은 외곽 안으로 제한", snapPoint(snapDoc, [7, -1], { radius: 0.01, grid: 0 }).point.join() === "6,0");

/* ------------------------------ 이미지·배율 보정 ------------------------------ */

check("이미지 검증: PNG·JPG만", checkImageFile({ type: "image/gif", size: 10 }) !== null && checkImageFile({ type: "image/png", size: 10 }) === null);
check("이미지 검증: 용량·픽셀 상한", checkImageFile({ type: "image/jpeg", size: 21 * 1024 * 1024 }) !== null && checkImageFile({ type: "image/png", size: 10 }, { width: 8000, height: 6000 }) !== null);

const refs = [
  { label: "하단 폭", a: [100, 950] as [number, number], b: [1100, 950] as [number, number], length: 5 },
  { label: "우측 깊이", a: [1150, 100] as [number, number], b: [1150, 900] as [number, number], length: 4 },
];
const cal = computeCalibration({ references: refs, envelope: { x: 100, y: 100, width: 1000, height: 800 } });
check(
  "보정: 기준 구간 200 px/m, 외곽 사각형 → 5 × 4 m, 왼쪽 위가 원점",
  !("error" in cal) && near(cal.scale, 0.005) && cal.width === 5 && cal.depth === 4 && pixelToPlan(cal.pixelToPlan, [100, 100]).every((n) => near(n, 0)) && near(pixelToPlan(cal.pixelToPlan, [1100, 900])[0], 5),
);
check("보정: 기준 구간·외곽이 없으면 계산하지 않음", "error" in computeCalibration({ references: [], envelope: { x: 0, y: 0, width: 10, height: 10 } }) && "error" in computeCalibration({ references: refs, envelope: { x: 0, y: 0, width: 0, height: 0 } }));

const image = { name: "studio-scan.png", mimeType: "image/png" as const, width: 1200, height: 1000 };
const calibrated = applyCalibration(null, { image, crop: { x: 50, y: 50, width: 1100, height: 900 }, references: refs, envelope: { x: 100, y: 100, width: 1000, height: 800 } }, "studio-scan");
if ("error" in calibrated) throw new Error(calibrated.error);
const calResult = validateFloorPlan(calibrated);
check("보정 → 새 문서: 이미지 원본·선택 영역·기준 구간·변환 기록, 검증 통과", calResult.ok && calibrated.source?.kind === "image" && calibrated.source.crop?.width === 1100 && calibrated.calibration?.references.length === 2, errorsOf(calibrated).join(", "));
check(
  "보정 → 새 문서: 외곽 크기는 계산값(미확인)으로 경고, 보정 경고 없음",
  calResult.issues.some((i) => i.code === "provenance.unconfirmed" && i.path === "/envelope/width") && !calResult.issues.some((i) => i.code.startsWith("calibration.")),
);
const oneRef = applyCalibration(null, { image, references: [refs[0]], envelope: { x: 100, y: 100, width: 1000, height: 800 } }, "one-ref");
check("보정: 기준 구간이 한 방향뿐이면 경고", !("error" in oneRef) && validateFloorPlan(oneRef).issues.some((i) => i.code === "calibration.singleAxis"));
const skew = applyCalibration(null, { image, references: [refs[0], { ...refs[1], length: 4.4 }], envelope: { x: 100, y: 100, width: 1000, height: 800 } }, "skew");
check(
  "보정: 두 기준 구간의 배율이 다르면 평균을 쓰고 불일치를 경고",
  !("error" in skew) && validateFloorPlan(skew).issues.filter((i) => i.code === "calibration.mismatch").length === 2,
);

// 이미지 보정 → 벽·문 입력 → 3D 생성(AI 없음)
let imageDoc: FloorPlanDocument = calibrated;
imageDoc = addWall(imageDoc, [3.2, 0], [3.2, 1.8]).doc;
imageDoc = addWall(imageDoc, [3.2, 1.8], [5, 1.8]).doc;
imageDoc = must(addOpening(imageDoc, "wall-2", "door", 0.9)).doc;
imageDoc = must(addOpening(imageDoc, "east", "door", 3)).doc;
imageDoc = confirmPath(confirmPath(imageDoc, "/envelope/width"), "/envelope/depth");
const imageResult = validateFloorPlan(imageDoc);
const imageScene = floorPlanToScene(must(imageResult.document));
check("이미지 흐름: 보정·벽·문 입력 후 검증·장면 변환·배치 검사 통과", imageResult.ok && validateSceneLayout(imageScene).length === 0, validateSceneLayout(imageScene).join(" / "));
check("이미지 흐름: 외곽 크기 확인 후 미확인 경고 해소", !imageResult.issues.some((i) => i.code === "provenance.unconfirmed" && i.path.startsWith("/envelope/width")));
check("이미지 재연결: 원본과 같은 크기만 허용", imageMatchesSource(imageDoc, { width: 1200, height: 1000 }) && !imageMatchesSource(imageDoc, { width: 600, height: 500 }));

/* ------------------------------ 저장 왕복 ------------------------------ */

for (const [name, d] of [
  ["수동 입력", doc],
  ["이미지 보정", imageDoc],
] as const) {
  const out = documentForExport(d, true);
  const back = parseFloorPlanJson(`${JSON.stringify(out, null, 2)}\n`);
  let same = true;
  try {
    deepStrictEqual(back.document, out);
  } catch {
    same = false;
  }
  check(`저장 왕복: ${name} — revision 증가, 치수·좌표·출처 유지`, back.ok && same && out.revision === d.revision + 1);
}
check("저장: 바뀌지 않았으면 revision 유지", documentForExport(doc, false) === doc);

console.log(failed ? `\n${failed}개 실패` : "\n모든 검증 통과");
process.exitCode = failed ? 1 : 0;
