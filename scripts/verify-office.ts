/**
 * 사무실 회귀 검증(비브라우저). 기존 사무실 장면(OFFICE_SCENE)이 바뀌지 않았는지 확인한다.
 * 실행: npm run verify:office
 *  - 좌표 변환 왕복, 회전 footprint, 필수 수량
 *  - 방 경계, 가구 겹침, 파티션 관통, 문 열림 간섭, 입구에서 각 공간까지의 동선(음성 테스트 포함)
 *  - 키보드 보행 충돌(파티션·문 개구부·가구, 무작위 보행 침투, 가구까지 고려한 동선), 미니맵 이동
 *  - 점프(사물 위로 올라서기·넘어가기·천장·벽)
 * 장면과 무관한 1인칭 조작과 거실 회귀는 verify-viewer.ts, 일반 도면(FloorPlanDocument) 검증은 verify-floor-plan.ts 등에 있다.
 */
import { OFFICE_SCENE } from "../src/config/officeScene";
import { resolveDisplayMode, type Vec2 } from "../src/config/sceneTypes";
import { FOOT_RADIUS, activeColliders, buildColliders, nearestFreeSpot, penetration, stepWalker, type Collider, type WalkerState } from "../src/lib/three/collision";
import { buildOfficeZones, footprintObb, planToWorld, summarizeOffice, validateOfficeLayout, worldToPlan } from "../src/lib/three/officeLayout";
import { createChecker, fmtWalk, maxDepth, simulateWalk, toBounds, walkerConfig, walkTo } from "./verify-walk";

const { check, done } = createChecker();

// 좌표 변환
const [x, z] = planToWorld(14.25, 8);
const [u, v] = worldToPlan(x, z);
check("도면↔월드 좌표 왕복", Math.abs(u - 14.25) < 1e-9 && Math.abs(v - 8) < 1e-9, `(14.25, 8) → (${x}, ${z})`);
check("월드 원점 = 도면 중심(9, 4)", planToWorld(9, 4).every((n) => n === 0));

// 회전 footprint: 90° 회전한 박스의 로컬 x축은 월드 -z
const o = footprintObb({ position: [0, 0, 0], size: [1, 1, 0.5], rotationY: 90 });
check("회전 footprint 축(90°)", Math.abs(o.ax[0]) < 1e-9 && Math.abs(o.ax[1] + 1) < 1e-9, `ax=${o.ax.map((n) => n.toFixed(3))}`);

// 수량
const s = summarizeOffice(OFFICE_SCENE.furniture);
console.log("요약", s);
check("대회의실 14석", s.largeMeetingSeats === 14);
check("소회의실 6석", s.smallMeetingSeats === 6);
check("H형 데스크 2세트", s.hDeskSets === 2);
check("원형 미팅 테이블 2개", s.roundTables === 2);
check("의자 합계 34(가정 포함)", s.totalChairs === 34, `${s.totalChairs}`);

// 배치 검증
const issues = validateOfficeLayout(OFFICE_SCENE);
check("배치 검증(경계·겹침·관통·문 열림·동선)", issues.length === 0, issues.join(" / "));

// 검증기 자체 확인: 일부러 잘못된 배치를 넣으면 문제를 보고해야 한다.
const broken = {
  ...OFFICE_SCENE,
  furniture: OFFICE_SCENE.furniture.map((f) => (f.id === "round-1-chair-1" ? { ...f, position: [-0.4, 0, 0.5] as [number, number, number] } : f)),
  partitions: OFFICE_SCENE.partitions.map((p) => (p.id === "small-meeting-north" ? { ...p, openings: [] } : p)),
};
const brokenIssues = validateOfficeLayout(broken);
check(
  "음성 테스트: 파티션 관통·동선 단절 검출",
  brokenIssues.some((i) => i.startsWith("파티션 관통")) && brokenIssues.some((i) => i.includes("소회의실")),
  brokenIssues.join(" / "),
);


// 장면 설정
check("사무실 외곽 18×8", OFFICE_SCENE.room.width === 18 && OFFICE_SCENE.room.depth === 8);
check("가구 id 중복 없음", new Set(OFFICE_SCENE.furniture.map((f) => f.id)).size === OFFICE_SCENE.furniture.length);

// ------------------------------ 키보드 보행 충돌 ------------------------------
{
  const interior = resolveDisplayMode(OFFICE_SCENE, "interior").camera;
  const R = interior.keyboard!.bodyRadius;
  const EYE = 1.6;
  const ob = toBounds(interior);
  const office = activeColliders(buildColliders(OFFICE_SCENE), EYE);
  const walk = (cols: Collider[], from: Vec2, to: Vec2, b = ob) => walkTo(cols, from, to, R, b);
  const depthAt = (cols: Collider[], p: Vec2) => maxDepth(cols, p, R);

  // 유리 파티션(소회의실 동쪽, x = -0.4)은 통과하지 못하고 앞에서 멈춘다.
  const glass = walk(office, [0, 3], [-1.5, 3]);
  check("보행: 유리 파티션 통과 불가", glass[0] > -0.4 && glass[0] < -0.1, `x=${glass[0].toFixed(3)}`);

  // 회의실 문은 회의실 안쪽으로 열린다(문 끝이 회의실 영역 안).
  const zones = buildOfficeZones();
  const allColliders = buildColliders(OFFICE_SCENE);
  const tipOf = (c: Collider): Vec2 => (c.shape === "box" ? [c.box.cx + c.box.ax[0] * c.box.hx, c.box.cz + c.box.ax[1] * c.box.hx] : [c.cx, c.cz]);
  const inZone = (p: Vec2, id: string) => {
    const r = zones.find((zn) => zn.id === id)!.rect;
    return p[0] > r[0] && p[0] < r[2] && p[1] > r[1] && p[1] < r[3];
  };
  const doorInside = [
    ["large-meeting-door:leaf", "large-meeting"],
    ["small-meeting-door:leaf", "small-meeting"],
  ].map(([leafId, zoneId]) => {
    const c = allColliders.find((cl) => cl.id === leafId)!;
    const tip = tipOf(c);
    return { leafId, ok: inZone(tip, zoneId), tip };
  });
  check(
    "회의실 문짝이 회의실 안쪽으로 열림",
    doorInside.every((d) => d.ok),
    doorInside.map((d) => `${d.leafId} 끝 (${d.tip.map((n) => n.toFixed(2))})`).join(" / "),
  );

  // 열린 문짝이 가구와 겹치지 않는다(문짝 선분을 2cm 간격으로 확인).
  const furnitureIds = new Set(OFFICE_SCENE.furniture.map((f) => f.id));
  const furnitureCols = allColliders.filter((c) => furnitureIds.has(c.id.split(":")[0]));
  const leafHits: string[] = [];
  for (const c of allColliders.filter((cl) => cl.id.endsWith(":leaf") && cl.shape === "box")) {
    if (c.shape !== "box") continue;
    const n = Math.ceil((c.box.hx * 2) / 0.02);
    for (let i = 0; i <= n; i++) {
      const s = -c.box.hx + (i / n) * c.box.hx * 2;
      const p: Vec2 = [c.box.cx + c.box.ax[0] * s, c.box.cz + c.box.ax[1] * s];
      for (const f of furnitureCols) if (penetration(f, p[0], p[1], c.box.hz).depth > 0) leafHits.push(`${c.id} ↔ ${f.id}`);
    }
  }
  check("열린 문짝이 가구와 겹치지 않음", leafHits.length === 0, [...new Set(leafHits)].join(", "));

  // 대회의실 문(열린 유리문)은 통과한다: H형 ① 옆 통로 → 문 → 대회의실
  const aisle = walk(office, [-3.6, -1.0], [-3.6, -3.0]);
  const inside = walk(office, aisle, [-5.5, aisle[1]]);
  check("보행: 대회의실 문 통과", aisle[1] < -2.9 && inside[0] < -5.4, `통로 끝 ${aisle.map((n) => n.toFixed(2))}, 문 통과 후 ${inside.map((n) => n.toFixed(2))}`);

  // 가구: H형 ① 좌석 사이로 들어가 중앙 수납부 앞에서 멈춘다(수납부 북쪽 면 z ≈ -2.16).
  const desk = walk(office, [-1.6, -3.7], [-1.6, -1.0]);
  check("보행: H형 중앙 수납부 앞에서 멈춤", desk[1] < -2.16 - R + 0.01 && desk[1] > -3.7, `z=${desk[1].toFixed(3)}`);

  // 무작위 보행: 어떤 방향으로 걸어도 장애물에 새로 파고들지 않는다.
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let pos: Vec2 = [4.9, 3.4]; // 입구 시점
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const a = rand() * Math.PI * 2;
    const step = 0.02 + rand() * 0.4;
    pos = walk(office, pos, [pos[0] + Math.cos(a) * step, pos[1] + Math.sin(a) * step]);
    worst = Math.max(worst, depthAt(office, pos));
  }
  check("보행: 무작위 4000걸음 동안 장애물 침투 없음", worst < 1e-3, `최대 침투 ${worst.toFixed(4)}m`);

  // 실내 대표 시점이 장애물 안에서 시작하지 않는다(시작하면 첫 이동이 어색해진다).
  const stuck = interior.views.filter((v) => depthAt(activeColliders(buildColliders(OFFICE_SCENE), v.position[1]), [v.position[0], v.position[2]]) > 1e-3);
  check("보행: 사무실 실내 시점이 장애물 밖", stuck.length === 0, stuck.map((v) => v.label).join(", "));

  // 가구까지 고려한 동선: 입구 시점에서 반지름 R 원이 모든 공간에 도달할 수 있어야 한다(0.05m 격자).
  const cell = 0.05;
  const nx = Math.round((ob.max[0] - ob.min[0]) / cell) + 1;
  const nz = Math.round((ob.max[1] - ob.min[1]) / cell) + 1;
  const at = (i: number, k: number): Vec2 => [ob.min[0] + i * cell, ob.min[1] + k * cell];
  const free = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) free[k * nx + i] = depthAt(office, at(i, k)) <= 0 ? 1 : 0;
  const seen = new Uint8Array(nx * nz);
  const start = Math.round((3.4 - ob.min[1]) / cell) * nx + Math.round((4.9 - ob.min[0]) / cell);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const c = queue.pop()!;
    const i = c % nx;
    const k = (c - i) / nx;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
      const n = nk * nx + ni;
      if (seen[n] || !free[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  const unreachable = buildOfficeZones().filter((zn) => {
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        const [px, pz] = at(i, k);
        if (seen[k * nx + i] && px > zn.rect[0] && px < zn.rect[2] && pz > zn.rect[1] && pz < zn.rect[3]) return false;
      }
    return true;
  });
  check("보행: 입구에서 모든 공간 도달(가구 포함)", unreachable.length === 0, unreachable.map((zn) => zn.label).join(", "));

  // 미니맵 클릭 이동: 빈 곳은 그대로, 가구·벽 위는 가장 가까운 빈자리, 방 밖은 범위 안으로.
  const spotFree = nearestFreeSpot(office, [4.9, 3.4], R, ob);
  check("미니맵 이동: 빈 곳은 그대로", !!spotFree && Math.hypot(spotFree[0] - 4.9, spotFree[1] - 3.4) < 1e-9);
  const table: Vec2 = [-6.5, -0.1]; // 대회의 테이블 중앙
  const spotTable = nearestFreeSpot(office, table, R, ob);
  check(
    "미니맵 이동: 대회의 테이블 위를 누르면 가까운 빈자리",
    !!spotTable && depthAt(office, spotTable) <= 0 && Math.hypot(spotTable[0] - table[0], spotTable[1] - table[1]) < 2,
    spotTable ? `(${spotTable.map((n) => n.toFixed(2))}), ${Math.hypot(spotTable[0] - table[0], spotTable[1] - table[1]).toFixed(2)}m` : "없음",
  );
  const spotOutside = nearestFreeSpot(office, [20, 0], R, ob);
  check(
    "미니맵 이동: 방 밖을 누르면 범위 안",
    !!spotOutside && spotOutside[0] <= ob.max[0] && depthAt(office, spotOutside) <= 0,
    spotOutside ? `(${spotOutside.map((n) => n.toFixed(2))})` : "없음",
  );


  // ------------------------------ 점프(Space): 사물 위로 올라서기·넘어가기 ------------------------------
  // H형 ① 왼쪽 데스크(높이 0.74m, 바깥 면 x = -3.25): 그냥 걸으면 막히고, 걸으며 점프하면 올라선다.
  const noJump = simulateWalk(OFFICE_SCENE, interior, [-3.6, -2.0], [1, 0], 1.8, 2);
  check("점프: 점프 없이는 책상에 막힘", noJump.s.x < -3.4 && noJump.s.feet === 0, fmtWalk(noJump));
  const onDesk = simulateWalk(OFFICE_SCENE, interior, [-3.6, -2.0], [1, 0], 1.8, 1.2, [0]);
  check("점프: 책상 위로 올라섬", Math.abs(onDesk.s.feet - 0.74) < 1e-6 && onDesk.s.vy === 0 && onDesk.s.x > -3.25, fmtWalk(onDesk));
  // 책상 위에서 계속 걸으면 수납부·오른쪽 데스크를 지나 건너편 가장자리에서 떨어져 반대쪽 바닥에 선다.
  const across = simulateWalk(OFFICE_SCENE, interior, [-3.6, -2.0], [1, 0], 1.8, 3.5, [0]);
  check("점프: 책상 위를 지나 건너편 바닥으로 내려감", across.s.x > 0.25 && across.s.feet === 0 && across.maxFeet >= 0.74, fmtWalk(across));
  // 천장: 책상 위에서 다시 점프해도 눈이 카메라 위치 범위(천장 아래)를 넘지 않는다.
  const bonk = simulateWalk(OFFICE_SCENE, interior, [0, 0], [0, 0], 0, 1.5, [0.1], { ...onDesk.s });
  check("점프: 천장 아래에서 멈춤", bonk.maxEye <= bonk.cfg.eyeMax + 1e-9 && Math.abs(bonk.s.feet - 0.74) < 1e-6, `최고 눈높이 ${bonk.maxEye.toFixed(2)}m / 한계 ${bonk.cfg.eyeMax}m`);
  // 라운지 테이블(0.42m): 달리며(Shift) 점프하면 한 번에 뛰어넘는다.
  const loungeBlocked = simulateWalk(OFFICE_SCENE, interior, [6.3, -2.0], [1, 0], 4.5, 1.2);
  const loungeOver = simulateWalk(OFFICE_SCENE, interior, [6.3, -2.0], [1, 0], 4.5, 1.2, [0]);
  check("점프: 라운지 테이블을 뛰어넘음", loungeBlocked.s.x < 6.71 && loungeOver.s.x > 7.8 && loungeOver.s.feet === 0, `점프 없음 x=${loungeBlocked.s.x.toFixed(2)} / ${fmtWalk(loungeOver)}`);
  // 유리 파티션(바닥~천장)은 점프로도 넘지 못한다.
  const wall = simulateWalk(OFFICE_SCENE, interior, [0, 3], [-1, 0], 4.5, 1.5, [0]);
  check("점프: 유리 파티션은 넘지 못함", wall.s.x > -0.4, fmtWalk(wall));

  // 사물에서 내려오면 올라가기 전 높이: 발(몸 중심)이 가장자리를 벗어나는 즉시 떨어지고, 카메라 높이(발 + 눈높이)가 원래대로 돌아온다.
  {
    const cols = buildColliders(OFFICE_SCENE);
    const cfg = walkerConfig(interior);
    const dt = 1 / 60;
    const eyeBefore = 1.6; // 올라가기 전 카메라 높이(바닥 + 눈높이)
    let s: WalkerState = { ...onDesk.s };
    let dropX: number | null = null;
    for (let i = 0; i < 120; i++) {
      s = stepWalker(cols, s, { dx: -1.8 * dt, dz: 0, jump: false }, dt, cfg);
      if (dropX === null && s.feet < 0.74 - 1e-9) dropX = s.x;
    }
    const edge = -3.25;
    check(
      "점프: 책상 가장자리를 벗어나면 바로 떨어짐",
      dropX !== null && dropX <= edge - FOOT_RADIUS + 1e-3 && dropX > edge - FOOT_RADIUS - 1.8 * dt - 1e-3,
      `떨어진 지점 x=${dropX?.toFixed(3)} (가장자리 ${edge}, 발 반지름 ${FOOT_RADIUS}m)`,
    );
    check("점프: 내려오면 올라가기 전 카메라 높이로", s.feet === 0 && s.vy === 0 && s.feet + s.eye === eyeBefore, `카메라 높이 ${(s.feet + s.eye).toFixed(3)}m`);
  }
}

done();
