/**
 * FloorPlanDocument v1 규격·검증기 비브라우저 검증(단기 계획 S1).
 * 실행: npm run verify:floor-plan
 *  - 생성 파일(JSON Schema·사무실 예제)이 Zod 스키마·officePlan.ts와 일치하는지
 *  - 정상 예제(소형 원룸·사무실) 통과와 경고 목록
 *  - 사무실 예제가 기존 OFFICE_SCENE과 같은 구조·좌표인지
 *  - 오류 예제별 검출 결과 재현(examples/floor-plans/invalid/expected.json)
 *  - 저장 왕복, 파일 크기·구문 오류, 규칙별 경계 사례
 */
import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OFFICE_SCENE } from "../src/config/officeScene";
import { resolveDisplayMode, sceneKey, type PartitionSegment, type Vec2 } from "../src/config/sceneTypes";
import { FLOOR_PLAN_LIMITS } from "../src/lib/floorPlan/limits";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { floorPlanToScene } from "../src/lib/floorPlan/toScene";
import { parseFloorPlanJson, validateFloorPlan, type FloorPlanIssue, type FloorPlanValidationResult } from "../src/lib/floorPlan/validate";
import { activeColliders, buildColliders, penetration } from "../src/lib/three/collision";
import { validateSceneLayout } from "../src/lib/three/layoutValidation";
import { planToWorld } from "../src/lib/three/officeLayout";
import { resolveWallJunctions } from "../src/lib/three/wallJunctions";
import { EXAMPLES_DIR, ROOT, generatedFiles } from "./floor-plan-files";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const key = (i: FloorPlanIssue) => `${i.code}@${i.path}`;
const keysOf = (r: FloorPlanValidationResult, severity: FloorPlanIssue["severity"]) => r.issues.filter((i) => i.severity === severity).map(key).sort();
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const readText = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const clone = <T>(v: T): T => structuredClone(v);

/* ------------------------------ 생성 파일 ------------------------------ */

for (const [file, text] of generatedFiles()) {
  let current = "";
  try {
    current = readText(file);
  } catch {
    // 파일 없음
  }
  check(`생성 파일 최신: ${path.relative(ROOT, file)}`, current === text, current === text ? "" : "npm run schema:floor-plan 으로 다시 생성하세요");
}

const jsonSchema = JSON.parse(generatedFiles()[0][1]) as { required?: string[]; additionalProperties?: unknown };
check(
  "JSON Schema: 필수 필드·추가 필드 금지",
  ["schemaVersion", "id", "revision", "unit", "envelope", "ceilingHeight", "walls", "openings"].every((k) => jsonSchema.required?.includes(k)) &&
    jsonSchema.additionalProperties === false,
  `required=${jsonSchema.required?.join(",")}`,
);

/* ------------------------------ 정상 예제 ------------------------------ */

const studio = parseFloorPlanJson(readFileSync(path.join(EXAMPLES_DIR, "small-studio.json"), "utf8"));
check("정상 예제: 소형 원룸 통과", studio.ok, keysOf(studio, "error").join(", "));
check(
  "정상 예제: 소형 원룸 경고(미확인 기본값·미확인 추출값·미분류 가구·확인 항목·가구 미검토)",
  sameSet(keysOf(studio, "warning"), [
    "provenance.unconfirmed@/ceilingHeight",
    "provenance.unconfirmedSource@/provenance",
    "furniture.unknownKind@/furniture/0/kind",
    "document.open.unsupported@/furniture/0/kind",
    "completeness.unreviewed@/completeness/furniture",
  ]),
  keysOf(studio, "warning").join(", "),
);

const officeResult = parseFloorPlanJson(readFileSync(path.join(EXAMPLES_DIR, "office.json"), "utf8"));
check("정상 예제: 사무실 통과", officeResult.ok, keysOf(officeResult, "error").join(", "));
check(
  "정상 예제: 사무실 경고에 치수 충돌·가정값·미확인 기본값 표시",
  ["document.open.conflict@/zones/6", "provenance.unconfirmed@/ceilingHeight", "provenance.unconfirmed@/envelope/wallThickness"].every((k) =>
    keysOf(officeResult, "warning").includes(k),
  ) && keysOf(officeResult, "warning").filter((k) => k.startsWith("document.open.assumption")).length === 4,
  keysOf(officeResult, "warning").join(", "),
);

/* ------------------------------ 사무실 예제 ↔ 기존 장면 ------------------------------ */

const office = officeResult.document!;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
check("사무실: 외곽 18×8·높이 2.8", office.envelope.width === OFFICE_SCENE.room.width && office.envelope.depth === OFFICE_SCENE.room.depth && office.ceilingHeight === OFFICE_SCENE.room.height);
check("사무실: 내부 벽 = 기존 파티션", office.walls.length === OFFICE_SCENE.partitions.length, `${office.walls.length} / ${OFFICE_SCENE.partitions.length}`);
check(
  "사무실: 내부 벽 좌표가 기존 파티션과 일치(도면 → 월드)",
  office.walls.every((w) => {
    const p = OFFICE_SCENE.partitions.find((x) => x.id === w.id);
    if (!p) return false;
    const [a, b] = [planToWorld(...w.start), planToWorld(...w.end)];
    return near(a[0], p.a[0]) && near(a[1], p.a[1]) && near(b[0], p.b[0]) && near(b[1], p.b[1]) && w.thickness === p.thickness;
  }),
);
const partitionOpenings = OFFICE_SCENE.partitions.reduce((n, p) => n + p.openings.length, 0);
check(
  "사무실: 개구부 = 외벽 개구부 + 파티션 개구부",
  office.openings.length === OFFICE_SCENE.room.openings.length + partitionOpenings,
  `${office.openings.length} = ${OFFICE_SCENE.room.openings.length} + ${partitionOpenings}`,
);
check("사무실: 문짝 없는 파티션 개구부는 통로(passage)", office.openings.filter((o) => o.kind === "passage").map((o) => o.id).sort().join(",") === "lounge-entry,pantry-entry");
check(
  "사무실: 가구 수·좌표·회전이 기존 장면과 일치(도면 → 월드 왕복)",
  office.furniture!.length === OFFICE_SCENE.furniture.length &&
    office.furniture!.every((f) => {
      const s = OFFICE_SCENE.furniture.find((x) => x.id === f.id);
      if (!s) return false;
      const [x, z] = planToWorld(f.position[0], f.position[2]);
      return near(x, s.position[0]) && near(z, s.position[2]) && f.position[1] === s.position[1] && (f.rotation ?? 0) === (s.rotationY ?? 0) && f.size.every((n, i) => n === s.size[i]);
    }),
  `${office.furniture!.length}개`,
);
check("사무실: 서쪽 창 사이 기둥 3개", office.columns?.length === 3);

/* ------------------------------ 오류 예제 ------------------------------ */

const manifest = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, "invalid", "expected.json"), "utf8")) as {
  cases: { file: string; rule: string; errors: string[] }[];
};
for (const c of manifest.cases) {
  const r = parseFloorPlanJson(readFileSync(path.join(EXAMPLES_DIR, "invalid", c.file), "utf8"));
  const errors = keysOf(r, "error");
  check(`오류 예제: ${c.rule} (${c.file})`, !r.ok && sameSet(errors, c.errors), errors.join(", "));
}

/* ------------------------------ 저장 왕복 ------------------------------ */

for (const [name, doc] of [
  ["소형 원룸", studio.document!],
  ["사무실", office],
] as const) {
  const again = parseFloorPlanJson(JSON.stringify(doc));
  let equal = true;
  try {
    deepStrictEqual(again.document, doc);
  } catch {
    equal = false;
  }
  check(`저장 왕복: ${name} JSON 직렬화 후 같은 문서·같은 결과`, again.ok && equal && sameSet(again.issues.map(key), (name === "사무실" ? officeResult : studio).issues.map(key)));
}

/* ------------------------------ 파일 단위 ------------------------------ */

check("파일: JSON 구문 오류", keysOf(parseFloorPlanJson("{ \"schemaVersion\": 1,"), "error").join() === "file.invalidJson@");
check("파일: 크기 상한 초과", keysOf(parseFloorPlanJson(" ".repeat(FLOOR_PLAN_LIMITS.maxJsonBytes + 1)), "error").join() === "file.tooLarge@");
check("파일: 객체가 아닌 값", keysOf(validateFloorPlan([]), "error").join() === "schema.invalid_type@");

/* ------------------------------ 규칙별 경계 사례 ------------------------------ */

const base: FloorPlanDocument = {
  schemaVersion: 1,
  id: "rule-case",
  revision: 1,
  unit: "m",
  envelope: { width: 4, depth: 3, wallThickness: 0.2 },
  ceilingHeight: 2.6,
  walls: [{ id: "w1", kind: "solid", start: [2, 0], end: [2, 3], thickness: 0.1 }],
  openings: [{ id: "d1", wallId: "w1", kind: "door", offset: 1.5, width: 0.8, height: 2, bottom: 0 }],
  completeness: { walls: "reviewed", openings: "reviewed", furniture: "reviewed" },
};
const variant = (name: string, mutate: (d: FloorPlanDocument) => void, expectErrors: string[], expectWarnings: string[] = []) => {
  const d = clone(base);
  mutate(d);
  const r = validateFloorPlan(d);
  const [e, w] = [keysOf(r, "error"), keysOf(r, "warning")];
  check(`규칙: ${name}`, sameSet(e, expectErrors) && sameSet(w, expectWarnings) && r.ok === (expectErrors.length === 0), [...e, ...w].join(", ") || "문제 없음");
};

variant("기본 문서는 문제 없음", () => {}, []);
variant("가구·내부 벽·개구부 없는 도면도 유효", (d) => {
  d.walls = [];
  d.openings = [];
}, []);
variant("schemaVersion 2는 지원하지 않음", (d) => {
  (d as { schemaVersion: number }).schemaVersion = 2;
}, ["schema.invalid_value@/schemaVersion"]);
variant("외곽 폭 지원 범위 초과", (d) => {
  d.envelope.width = 80;
}, ["range.envelope@/envelope/width"]);
variant("벽 끝점이 외곽 면에서 3cm 떨어짐 → 접합 틈 경고", (d) => {
  d.walls[0].end = [2, 2.97];
}, [], ["wall.gap@/walls/0/end"]);
variant("일직선으로 끝점만 닿는 두 벽은 겹침 아님", (d) => {
  d.walls = [
    { id: "w1", kind: "solid", start: [2, 0], end: [2, 1.5], thickness: 0.1 },
    { id: "w2", kind: "glass", start: [2, 1.5], end: [2, 3], thickness: 0.06 },
  ];
  d.openings = [];
}, []);
variant("T자 접합(끝점이 다른 벽 몸체에 닿음)", (d) => {
  d.walls.push({ id: "w2", kind: "solid", start: [0, 1], end: [2, 1], thickness: 0.1 });
}, []);
variant("교차하는 두 벽(X자)은 형식상 허용", (d) => {
  d.walls.push({ id: "w2", kind: "solid", start: [0, 0.5], end: [4, 0.5], thickness: 0.1 });
}, []);
variant("외곽 면 위의 내부 벽", (d) => {
  d.walls.push({ id: "w2", kind: "solid", start: [0, 0], end: [0, 3], thickness: 0.1 });
}, ["wall.onEnvelope@/walls/1"]);
variant("외곽 밖으로 나간 벽", (d) => {
  d.walls[0].end = [2, 3.5];
}, ["wall.outOfBounds@/walls/0/end"]);
variant("천장보다 높은 벽", (d) => {
  d.walls[0].height = 3;
}, ["wall.tallerThanCeiling@/walls/0/height"]);
variant("바닥에서 떨어진 문", (d) => {
  d.openings[0].bottom = 0.1;
}, ["opening.doorNotOnFloor@/openings/0/bottom"]);
variant("문짝이 있는 통로", (d) => {
  d.openings[0] = { ...d.openings[0], kind: "passage", door: { leaf: "wood", hinge: "start", swing: "pos", angle: 60 } };
}, ["opening.passageWithDoor@/openings/0/door"]);
variant("벽보다 높은 개구부", (d) => {
  d.openings[0].height = 2.7;
}, ["opening.tooTall@/openings/0/height"]);
variant("외벽의 바닥까지 내려온 창 → 경고", (d) => {
  d.openings.push({ id: "win", wallId: "north", kind: "window", offset: 1, width: 1, height: 2, bottom: 0 });
}, [], ["opening.windowOnFloor@/openings/1/bottom"]);
variant("외벽 개구부 범위: 남쪽 벽 길이 4m 끝까지", (d) => {
  d.openings.push({ id: "win", wallId: "south", kind: "window", offset: 3.5, width: 1, height: 1, bottom: 1 });
}, []);
variant("높이가 다른 창·문은 같은 구간이어도 겹침 아님", (d) => {
  d.openings = [
    { id: "door", wallId: "east", kind: "door", offset: 1, width: 0.9, height: 2, bottom: 0 },
    { id: "transom", wallId: "east", kind: "window", offset: 1, width: 0.9, height: 0.3, bottom: 2.1 },
  ];
}, []);
variant("회전 후 외곽 밖으로 나간 가구", (d) => {
  d.furniture = [{ id: "f1", kind: "lowCabinet", position: [0.6, 0, 0.6], size: [1, 0.5, 1], rotation: 45 }];
}, ["furniture.outOfBounds@/furniture/0/position"]);
variant("회전 전에는 외곽 안의 같은 가구", (d) => {
  d.furniture = [{ id: "f1", kind: "lowCabinet", position: [0.6, 0, 0.6], size: [1, 0.5, 1] }];
}, []);
variant("가구 ID가 벽 ID와 중복", (d) => {
  d.furniture = [{ id: "w1", kind: "plant", position: [1, 0, 1], size: [0.4, 1, 0.4] }];
}, ["id.duplicate@/furniture/0/id"]);
variant("잘못된 영역 사각형", (d) => {
  d.zones = [{ id: "z1", name: "영역", rect: [2, 2, 1, 3] }];
}, ["zone.invalidRect@/zones/0/rect"]);
variant("존재하지 않는 출처 경로 → 경고", (d) => {
  d.provenance = [{ path: "/walls/5/thickness", origin: "default", confirmed: true }];
}, [], ["provenance.pathNotFound@/provenance/0/path"]);
variant("검토 상태 없음 → 경고", (d) => {
  delete d.completeness;
}, [], ["completeness.missing@/completeness"]);

const studioDoc = studio.document!;
const calibrated = (name: string, mutate: (d: FloorPlanDocument) => void, expectWarnings: string[]) => {
  const d = clone(studioDoc);
  mutate(d);
  const r = validateFloorPlan(d);
  const w = keysOf(r, "warning").filter((k) => k.startsWith("calibration."));
  check(`보정: ${name}`, r.ok && sameSet(w, expectWarnings), w.join(", ") || "경고 없음");
};
calibrated("두 방향 기준 구간이 맞으면 경고 없음", () => {}, []);
calibrated("기준 구간 길이와 변환 결과 불일치", (d) => {
  d.calibration!.references[0].length = 5.2;
}, ["calibration.mismatch@/calibration/references/0"]);
calibrated("기준 구간이 한 방향뿐", (d) => {
  d.calibration!.references = [d.calibration!.references[0]];
}, ["calibration.singleAxis@/calibration/references"]);
calibrated("가로·세로 배율이 다름(늘려 맞춘 왜곡)", (d) => {
  d.calibration!.pixelToPlan[3] = 0.0052;
}, ["calibration.anisotropic@/calibration/pixelToPlan", "calibration.mismatch@/calibration/references/1"]);

/* ------------------------------ S2: 도면 → 장면 어댑터 ------------------------------ */

/** JSON으로 같은 구조이고 숫자는 1e-6 이내(기존 장면의 부동소수 잔여·어댑터의 0.1mm 반올림 허용) */
function sameJson(a: unknown, b: unknown): boolean {
  const x: unknown = JSON.parse(JSON.stringify(a ?? null));
  const y: unknown = JSON.parse(JSON.stringify(b ?? null));
  const eq = (p: unknown, r: unknown): boolean => {
    if (typeof p === "number" && typeof r === "number") return Math.abs(p - r) < 1e-6;
    if (Array.isArray(p) && Array.isArray(r)) return p.length === r.length && p.every((v, i) => eq(v, r[i]));
    if (p && r && typeof p === "object" && typeof r === "object") {
      const kp = Object.keys(p).sort();
      const kr = Object.keys(r).sort();
      return kp.join() === kr.join() && kp.every((k) => eq((p as Record<string, unknown>)[k], (r as Record<string, unknown>)[k]));
    }
    return p === r;
  };
  return eq(x, y);
}

// 사무실 문서 → 장면이 기존 OFFICE_SCENE과 같은 구조인지(렌더링 전용 값 제외)
const officeScene = floorPlanToScene(office);
check("어댑터(사무실): 외곽·외벽 개구부가 기존 장면과 같음", sameJson(officeScene.room, OFFICE_SCENE.room));
check(
  "어댑터(사무실): 내부 벽 = 기존 파티션에 같은 접합 규칙을 적용한 결과",
  sameJson(officeScene.partitions, resolveWallJunctions(OFFICE_SCENE.partitions)),
);
check(
  "어댑터(사무실): 가구 종류·위치·회전·크기·묶음이 기존 장면과 같음",
  officeScene.furniture.length === OFFICE_SCENE.furniture.length &&
    officeScene.furniture.every((f, i) => {
      const s = OFFICE_SCENE.furniture[i];
      return f.id === s.id && f.kind === s.kind && f.label === s.label && f.position.every((n, k) => near(n, s.position[k])) && (f.rotationY ?? 0) === (s.rotationY ?? 0) && sameJson(f.size, s.size) && f.group === s.group;
    }),
);
check(
  "어댑터(사무실): 기둥·바닥 마감 영역이 기존 장면과 같음",
  officeScene.columns!.every((c, i) => near(c.center[0], OFFICE_SCENE.columns![i].center[0]) && near(c.center[1], OFFICE_SCENE.columns![i].center[1]) && sameJson(c.size, OFFICE_SCENE.columns![i].size)) &&
    sameJson(officeScene.floorZones, OFFICE_SCENE.floorZones),
);
check("어댑터(사무실): 일반 배치 검증 통과", validateSceneLayout(officeScene).length === 0, validateSceneLayout(officeScene).join(" / "));
check(
  "어댑터(사무실): 실내 카메라 범위가 기존 사무실 상수와 같음(외곽 크기에서 계산)",
  sameJson(officeScene.modes!.interior!.camera.positionBounds, resolveDisplayMode(OFFICE_SCENE, "interior").camera.positionBounds) &&
    sameJson(officeScene.modes!.interior!.camera.targetBounds, resolveDisplayMode(OFFICE_SCENE, "interior").camera.targetBounds),
);

// 소형 원룸(사무실과 다른 도면)
const studioScene = floorPlanToScene(studioDoc);
check("어댑터(원룸): 코드 수정 없이 장면 생성·일반 배치 검증 통과", validateSceneLayout(studioScene).length === 0, validateSceneLayout(studioScene).join(" / "));
check("어댑터(원룸): 동쪽 외벽 출입문·북·남쪽 창", sameJson(studioScene.room.openings.map((o) => `${o.wall}:${o.kind}`), ["east:door", "north:window", "south:window"]));
check("어댑터(원룸): 미분류 가구는 unknown 종류", studioScene.furniture.find((f) => f.id === "desk")?.kind === "unknown");
const studioColliders = buildColliders(studioScene);
check("어댑터(원룸): 외벽 문짝·미분류 가구가 충돌에 포함", ["entrance:leaf", "desk"].every((id) => studioColliders.some((c) => c.id === id)));
const startView = resolveDisplayMode(studioScene, "interior").camera.views[0];
const startPos: Vec2 = [startView.position[0], startView.position[2]];
check(
  "어댑터(원룸): 실내 시작 위치가 장애물 밖·이동 범위 안",
  activeColliders(studioColliders, startView.position[1]).every((c) => penetration(c, startPos[0], startPos[1], 0.2).depth < 1e-6) &&
    Math.abs(startPos[0]) <= studioDoc.envelope.width / 2 - 0.15 &&
    Math.abs(startPos[1]) <= studioDoc.envelope.depth / 2 - 0.15,
  `(${startPos.join(", ")})`,
);
check("어댑터(원룸): 천장등 수 상한(12) 이내", studioScene.lighting.lamps.length > 0 && studioScene.lighting.lamps.length <= 12, `${studioScene.lighting.lamps.length}개`);
const big = clone(studioDoc);
big.envelope = { ...big.envelope, width: 60, depth: 50 };
check("어댑터: 큰 외곽(60×50m)에서도 천장등 12개 이하·베이크 밀도 하한", floorPlanToScene(big).lighting.lamps.length <= 12 && floorPlanToScene(big).bake.texelsPerMeter === 4);

// 내부 벽 접합
const seg = (id: string, a: Vec2, b: Vec2, thickness = 0.1, openings: PartitionSegment["openings"] = []): PartitionSegment => ({ id, kind: "solid", a, b, thickness, openings });
const [lA, lB] = resolveWallJunctions([seg("a", [0, 0], [2, 0]), seg("b", [2, 0], [2, 2], 0.2)]);
check("접합: L자 — 앞쪽 벽은 상대 두께 절반만큼 늘고 뒤쪽 벽은 줄어듦", near(lA.b[0], 2.1) && near(lB.a[1], 0.05), `a 끝 ${lA.b[0]}, b 시작 ${lB.a[1]}`);
const [, tStem] = resolveWallJunctions([seg("bar", [0, 0], [4, 0], 0.12), seg("stem", [2, 0], [2, 2], 0.1, [{ id: "d", offset: 1, width: 0.8, height: 2 }])]);
check("접합: T자 — 줄기 벽만 줄고 개구부 월드 위치 유지", near(tStem.a[1], 0.06) && near(tStem.openings[0].offset, 0.94));
const line = resolveWallJunctions([seg("p", [0, 0], [2, 0]), seg("q", [2, 0], [4, 0])]);
check("접합: 일직선 연결은 바꾸지 않음", sameJson(line, [seg("p", [0, 0], [2, 0]), seg("q", [2, 0], [4, 0])]));
const cross = resolveWallJunctions([seg("h", [0, 1], [4, 1]), seg("v", [2, 0], [2, 3])]);
check("접합: X자 교차는 바꾸지 않음", sameJson(cross, [seg("h", [0, 1], [4, 1]), seg("v", [2, 0], [2, 3])]));
const [, , tee] = resolveWallJunctions([seg("up", [0, 0], [0, 2]), seg("down", [0, 2], [0, 4]), seg("side", [0, 2], [3, 2], 0.08)]);
check("접합: 일직선으로 이어지는 두 벽의 연결점에 닿은 벽은 T자로 줄어듦", near(tee.a[0], 0.05));

// revision
check("revision: 같은 id의 수정본은 다른 장면 키", sceneKey(studioScene) !== sceneKey({ ...studioScene, revision: (studioScene.revision ?? 0) + 1 }));

console.log(failed ? `\n${failed}개 실패` : "\n모든 검증 통과");
process.exitCode = failed ? 1 : 0;
