/**
 * 보행·점프 검증 공용 도구(verify-office.ts·verify-viewer.ts). 렌더러 없이 충돌 함수(lib/three/collision)만 쓴다.
 */
import type { CameraConfig, SceneConfig, Vec2 } from "../src/config/sceneTypes";
import { buildColliders, moveCircle, penetration, stepWalker, type Collider, type WalkerConfig, type WalkerState } from "../src/lib/three/collision";

/** PASS/FAIL 출력과 실패 수 집계. done()은 결과를 출력하고 프로세스를 끝낸다. */
export function createChecker() {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
    if (!ok) failed++;
  };
  const done = (okMessage = "모든 검증 통과") => {
    console.log(failed ? `\n${failed}개 실패` : `\n${okMessage}`);
    process.exit(failed ? 1 : 0);
  };
  return { check, done };
}

/** 카메라 위치 범위 → 평면 이동 범위 [x, z] */
export const toBounds = (c: CameraConfig) => ({
  min: [c.positionBounds.min[0], c.positionBounds.min[2]] as Vec2,
  max: [c.positionBounds.max[0], c.positionBounds.max[2]] as Vec2,
});

/** 반지름 radius 원을 from → to로 미끄러지듯 옮긴 끝 위치 */
export const walkTo = (cols: Collider[], from: Vec2, to: Vec2, radius: number, bounds: ReturnType<typeof toBounds>) =>
  moveCircle(cols, from, [to[0] - from[0], to[1] - from[1]], radius, bounds);

/** 점 p에서 장애물 침투 깊이의 최댓값 */
export const maxDepth = (cols: Collider[], p: Vec2, radius: number) => Math.max(0, ...cols.map((c) => penetration(c, p[0], p[1], radius).depth));

export const walkerConfig = (c: CameraConfig): WalkerConfig => ({
  radius: c.keyboard!.bodyRadius,
  jumpHeight: c.keyboard!.jumpHeight,
  gravity: 9.8,
  bounds: toBounds(c),
  eyeMax: c.positionBounds.max[1],
});

/** start에서 dir 방향으로 speed(m/s)로 seconds 동안 걷고, jumpAt 초에 Space. 60fps */
export function simulateWalk(scene: SceneConfig, c: CameraConfig, start: Vec2, dir: Vec2, speed: number, seconds: number, jumpAt: number[] = [], from?: WalkerState) {
  const cols = buildColliders(scene);
  const cfg = walkerConfig(c);
  const dt = 1 / 60;
  let s: WalkerState = from ?? { x: start[0], z: start[1], feet: 0, vy: 0, eye: 1.6 };
  let maxFeet = s.feet;
  let maxEye = s.feet + s.eye;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const jump = jumpAt.some((t) => Math.abs(t - i * dt) < dt / 2);
    s = stepWalker(cols, s, { dx: dir[0] * speed * dt, dz: dir[1] * speed * dt, jump }, dt, cfg);
    maxFeet = Math.max(maxFeet, s.feet);
    maxEye = Math.max(maxEye, s.feet + s.eye);
  }
  return { s, maxFeet, maxEye, cfg };
}

export const fmtWalk = (r: { s: WalkerState; maxFeet: number }) =>
  `끝 (${r.s.x.toFixed(2)}, ${r.s.z.toFixed(2)}) 발 ${r.s.feet.toFixed(2)}m, 최고 발 ${r.maxFeet.toFixed(2)}m`;
