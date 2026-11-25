/**
 * 공용 3D 뷰어 동작·거실 회귀 검증(비브라우저).
 * 실행: npm run verify:viewer
 *  - 거실 장면 값 유지(사무실·도면 작업이 거실 상수를 바꾸지 않았는지)
 *  - 거실 보행 충돌(소파 앞 시점)·점프(커피 테이블)
 *  - 1인칭 조작(W·A·S·D·Q·E·방향키, 드래그, 포인터 잠금 감도, 휠 확대). 조작 범위 값은 사무실 실내 카메라 설정을 쓴다.
 */
import { CAMERA, LIVING_SCENE, ROOM } from "../src/config/interior";
import { OFFICE_SCENE } from "../src/config/officeScene";
import { resolveDisplayMode, type CameraConfig, type Vec2 } from "../src/config/sceneTypes";
import { activeColliders, buildColliders } from "../src/lib/three/collision";
import {
  KEY_AXES,
  LOOK_RAD_PER_PX,
  POINTER_LOCK_RAD_PER_PX,
  SENSITIVITY_RANGE,
  ZOOM_RANGE,
  directionFromLook,
  dragLook,
  keyLook,
  lookFromDirection,
  pitchRangeFromPolar,
  walkDelta,
  wheelZoom,
  zoomedFov,
} from "../src/lib/three/firstPerson";
import { createChecker, fmtWalk, simulateWalk, toBounds, walkTo } from "./verify-walk";

const { check, done } = createChecker();

// 장면 분리: 거실 값 유지
check("거실 방 크기 유지(6×5×2.8)", ROOM.width === 6 && ROOM.depth === 5 && ROOM.height === 2.8);
check("거실 카메라 최대 거리 유지(4.6)", CAMERA.maxDistance === 4.6);
check("거실 장면이 기존 거실 상수를 사용", LIVING_SCENE.room === ROOM && LIVING_SCENE.camera === CAMERA);

// ------------------------------ 거실 보행·점프 ------------------------------
{
  const R = resolveDisplayMode(OFFICE_SCENE, "interior").camera.keyboard!.bodyRadius;
  const walk = (cols: Parameters<typeof walkTo>[0], from: Vec2, to: Vec2, b: ReturnType<typeof toBounds>) => walkTo(cols, from, to, R, b);
  // 거실: 소파 앞 시점은 일부러 소파에 가깝다 → 튀지 않고, 더 들어가지는 못하며, 뒤로는 빠져나온다.
  const lb = toBounds(CAMERA);
  const living = activeColliders(buildColliders(LIVING_SCENE), 1.15);
  const sofaView: Vec2 = [0.4, -1.45];
  const deeper = walk(living, sofaView, [0.4, -2.2], lb);
  const away = walk(living, sofaView, [0.4, -0.9], lb);
  check("보행: 거실 소파 시점에서 더 파고들지 않음", Math.abs(deeper[1] - sofaView[1]) < 1e-6, `z=${deeper[1].toFixed(3)}`);
  check("보행: 거실 소파 시점에서 뒤로 빠져나옴", away[1] > -1.3, `z=${away[1].toFixed(3)}`);
  const front = walk(living, [0.4, -1.25], [0.4, -2.3], lb);
  check("보행: 거실 소파 앞에서 멈춤", Math.abs(front[1] - (-1.52 + R)) < 0.01, `z=${front[1].toFixed(3)}`);

  // 거실 커피 테이블(0.4m): 걸으며 점프하면 위에 올라섰다가 소파 쪽 바닥으로 내려간다.
  const coffee = simulateWalk(LIVING_SCENE, CAMERA as unknown as CameraConfig, [0.9, 0.3], [0, -1], 1.2, 2.5, [0.2]);
  check("점프: 거실 커피 테이블 위를 지나 건너편으로", coffee.s.z < -1.2 && coffee.s.feet === 0 && coffee.maxFeet >= 0.4, fmtWalk(coffee));
}

// ------------------------------ 1인칭 조작(마우스 드래그·휠·W/A/S/D) ------------------------------
{
  const interior = resolveDisplayMode(OFFICE_SCENE, "interior").camera;
  const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
  const deg = Math.PI / 180;
  // 키 → 보는 방향 기준 이동 방향. 동쪽(+x)을 보며 30° 내려다볼 때: W 동쪽, S 서쪽, A 북쪽(-z), D 남쪽(+z) — 위아래 시선과 무관하게 수평 이동.
  const east = lookFromDirection(1, -Math.tan(30 * deg), 0);
  const keyMove = (code: string, yaw: number): Vec2 => {
    const a = KEY_AXES.get(code)!;
    return walkDelta(yaw, a.move ?? 0, a.strafe ?? 0, 1);
  };
  const expected: [string[], Vec2][] = [
    [["KeyW"], [1, 0]],
    [["KeyS"], [-1, 0]],
    [["KeyA"], [0, -1]],
    [["KeyD"], [0, 1]],
  ];
  const keysOk = expected.every(([codes, v]) => codes.every((c) => { const d = keyMove(c, east.yaw); return near(d[0], v[0]) && near(d[1], v[1]); }));
  check("1인칭: W 앞·S 뒤·A 왼쪽·D 오른쪽(보는 방향 기준)", keysOk, `동쪽 보며 A → (${keyMove("KeyA", east.yaw).map((n) => n.toFixed(2)).join(", ")})`);
  // 임의 방향에서도 W는 시선의 수평 방향, D는 그 오른쪽(시계 방향 90°), 대각선도 같은 속도
  const anyOk = [0, 37, 128, -95, 180].every((d) => {
    const l = { yaw: d * deg, pitch: 0.4 };
    const [fx, , fz] = directionFromLook({ yaw: l.yaw, pitch: 0 });
    const w = walkDelta(l.yaw, 1, 0, 1);
    const r = walkDelta(l.yaw, 0, 1, 1);
    const diag = walkDelta(l.yaw, 1, 1, 1);
    return near(w[0], fx) && near(w[1], fz) && near(r[0], -fz) && near(r[1], fx) && near(Math.hypot(diag[0], diag[1]), 1);
  });
  check("1인칭: 어느 방향을 봐도 W는 시선 방향, 대각선 같은 속도", anyOk);
  check("1인칭: Q·E는 제자리 회전", KEY_AXES.get("KeyQ")?.turn === 1 && KEY_AXES.get("KeyE")?.turn === -1 && !KEY_AXES.get("KeyQ")?.move);
  // 방향키는 위치를 옮기지 않고 보는 방향만 바꾼다: ← 왼쪽, → 오른쪽, ↑ 위, ↓ 아래(위아래 범위 제한)
  {
    const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const noMove = arrows.every((c) => {
      const a = KEY_AXES.get(c)!;
      return !a.move && !a.strafe;
    });
    const lookRange = pitchRangeFromPolar(interior.minPolarAngle, interior.maxPolarAngle);
    const speed = (interior.keyboard!.turnSpeed * Math.PI) / 180;
    const hold = (code: string, seconds: number) => {
      const a = KEY_AXES.get(code)!;
      let l = { yaw: 0, pitch: 0 };
      for (let i = 0; i < Math.round(seconds * 60); i++) l = keyLook(l, a.turn ?? 0, a.pitch ?? 0, speed, 1 / 60, lookRange);
      return l;
    };
    const left = directionFromLook(hold("ArrowLeft", 0.5));
    const right = directionFromLook(hold("ArrowRight", 0.5));
    const lookUp = hold("ArrowUp", 0.5);
    const lookDown = hold("ArrowDown", 5);
    check(
      "1인칭: 방향키는 제자리에서 시점만(← 왼쪽·→ 오른쪽·↑ 위·↓ 아래)",
      noMove && left[0] < 0 && right[0] > 0 && lookUp.pitch > 0 && near(lookDown.pitch, lookRange[0]),
      `북쪽 보며 → 0.5초 = 오른쪽 ${(interior.keyboard!.turnSpeed * 0.5).toFixed(1)}°, ↓ 계속 누르면 ${(lookDown.pitch / deg).toFixed(0)}°에서 멈춤`,
    );
  }

  // 드래그: 오른쪽으로 끌면 오른쪽, 위로 끌면 위를 본다(눈이 회전 중심, 위치 불변). 위아래는 설정 범위로 제한.
  const range = pitchRangeFromPolar(interior.minPolarAngle, interior.maxPolarAngle);
  const north = { yaw: 0, pitch: 0 };
  const right = directionFromLook(dragLook(north, 100, 0, LOOK_RAD_PER_PX, range));
  const up = dragLook(north, 0, -100, LOOK_RAD_PER_PX, range);
  const clampDown = dragLook(north, 0, 100000, LOOK_RAD_PER_PX, range);
  check(
    "1인칭: 드래그 오른쪽 → 오른쪽(동쪽)으로, 위 → 위로, 위아래 범위 제한",
    right[0] > 0 && right[2] < 0 && up.pitch > 0 && near(clampDown.pitch, range[0]),
    `100px → ${(100 * LOOK_RAD_PER_PX / deg).toFixed(0)}°, 아래 한계 ${(range[0] / deg).toFixed(0)}°`,
  );
  // 마우스 시점(포인터 잠금): 마우스를 오른쪽으로 150px 움직이면 오른쪽으로 18°(감도 1), 감도 2면 두 배.
  const mouse1 = dragLook(north, 150 * POINTER_LOCK_RAD_PER_PX, 0, 1, range);
  const mouse2 = dragLook(north, 150 * POINTER_LOCK_RAD_PER_PX, 0, 2, range);
  check(
    "1인칭: 마우스 이동 방향으로 시점이 따라감(감도 배율 적용)",
    near(mouse1.yaw, -18 * deg, 1e-12) && near(mouse2.yaw, -36 * deg, 1e-12) && SENSITIVITY_RANGE[0] < 1 && SENSITIVITY_RANGE[1] > 1,
    `150px → 감도 1: ${(-mouse1.yaw / deg).toFixed(0)}°, 감도 2: ${(-mouse2.yaw / deg).toFixed(0)}° 오른쪽`,
  );
  const round = lookFromDirection(...directionFromLook({ yaw: 2.1, pitch: -0.7 }));
  check("1인칭: 시선 각도 ↔ 방향 왕복", near(round.yaw, 2.1, 1e-12) && near(round.pitch, -0.7, 1e-12));

  // 휠: 위로 굴리면 확대(화각 좁힘), 아래로 굴리면 축소, 범위 제한. 배율 2면 화면 중심 기준 2배(tan(화각/2)가 절반).
  const base = interior.fov;
  const zIn = wheelZoom(1, -100);
  const zOut = wheelZoom(1, 100);
  const half = (f: number) => Math.tan((f * deg) / 2);
  check(
    "1인칭: 휠 위 확대·아래 축소(화면 중심 기준 화각), 범위 제한",
    zIn > 1 && zOut < 1 && near(zoomedFov(base, 1), base, 1e-9) && near(half(zoomedFov(base, 2)), half(base) / 2, 1e-12) &&
      wheelZoom(1, -1e6) === ZOOM_RANGE[1] && wheelZoom(1, 1e6) === ZOOM_RANGE[0],
    `한 칸 ×${zIn.toFixed(2)}, 범위 ${zoomedFov(base, ZOOM_RANGE[1]).toFixed(0)}°~${zoomedFov(base, ZOOM_RANGE[0]).toFixed(0)}°`,
  );
}

done();
