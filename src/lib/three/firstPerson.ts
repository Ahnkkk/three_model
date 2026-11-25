import type { Vec2 } from "@/config/sceneTypes";

/**
 * 1인칭(걷기) 시점 계산 — 거실, 사무실 실내처럼 키보드로 걸어 다니는 화면.
 *
 * 3D 게임(FPS)처럼 눈(카메라 위치)이 회전 중심이다. 화면을 클릭하면 포인터가 잠기고(커서 숨김) 마우스를 움직이는 대로
 * 시선이 따라간다(Esc로 해제). 터치는 드래그로 돌린다. 어느 쪽이든 위치·높이는 바뀌지 않고,
 * 휠은 화면 중심 기준으로 화각을 좁히거나 넓혀 확대·축소한다(위치 불변). W·A·S·D는 지금 보는 방향 기준으로 움직인다.
 * three.js에 의존하지 않는 순수 함수로 두어 브라우저 없이 검증한다(scripts/verify-office.ts).
 *
 * 시선은 yaw·pitch 두 각으로 둔다(기울기 roll 없음). three.js Euler(pitch, yaw, 0, "YXZ")와 같다.
 * - yaw: 위(+y)에서 볼 때 반시계 방향(왼쪽으로 돌면 +). 0이면 북쪽(-z)을 본다.
 * - pitch: 위를 보면 +.
 */

export interface Look {
  yaw: number;
  pitch: number;
}

/**
 * 키보드 입력 축(KeyboardEvent.code 기준 — 한/영 입력 상태와 무관).
 * move: 앞(+)·뒤, strafe: 오른쪽(+)·왼쪽 — 위치가 움직인다(W·A·S·D).
 * turn: 왼쪽(+)·오른쪽, pitch: 위(+)·아래 — 제자리에서 보는 방향만 바뀐다(방향키, Q·E).
 * 키 배치를 바꾸면 ControlPanel의 KEY_HELP 안내도 함께 바꾼다.
 */
export const KEY_AXES: ReadonlyMap<string, { move?: number; strafe?: number; turn?: number; pitch?: number }> = new Map([
  ["KeyW", { move: 1 }],
  ["KeyS", { move: -1 }],
  ["KeyA", { strafe: -1 }],
  ["KeyD", { strafe: 1 }],
  ["ArrowLeft", { turn: 1 }],
  ["ArrowRight", { turn: -1 }],
  ["ArrowUp", { pitch: 1 }],
  ["ArrowDown", { pitch: -1 }],
  ["KeyQ", { turn: 1 }],
  ["KeyE", { turn: -1 }],
]);

/** 드래그(터치·포인터 잠금 실패 시) 시점 회전 감도(라디안/px, 기본 화각 기준). 확대하면 화각에 비례해 느려진다. */
export const LOOK_RAD_PER_PX = (0.2 * Math.PI) / 180;
/** 마우스 시점(포인터 잠금) 감도(라디안/마우스 이동 px, 기본 화각·감도 1 기준). 확대하면 화각에 비례해 느려진다. */
export const POINTER_LOCK_RAD_PER_PX = (0.12 * Math.PI) / 180;
/** 마우스 감도 배율 범위(설정 패널 슬라이더) */
export const SENSITIVITY_RANGE: readonly [number, number] = [0.3, 3];
/** 휠 확대 배율 범위(1 = 기본 화각). 1보다 작으면 기본보다 넓게 본다(축소). */
export const ZOOM_RANGE: readonly [number, number] = [0.75, 4];
/** 휠 감도(배율 = exp(-deltaY·k)) — 한 칸(약 100px)에 약 1.2배 */
const WHEEL_ZOOM_PER_PX = 0.002;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** 방향 벡터 → 시선 각도 */
export function lookFromDirection(x: number, y: number, z: number): Look {
  const len = Math.hypot(x, y, z) || 1;
  return { yaw: Math.atan2(-x, -z), pitch: Math.asin(clamp(y / len, -1, 1)) };
}

/** 시선 각도 → 단위 방향 벡터 */
export function directionFromLook(l: Look): [number, number, number] {
  const c = Math.cos(l.pitch);
  return [-Math.sin(l.yaw) * c, Math.sin(l.pitch), -Math.cos(l.yaw) * c];
}

/** OrbitControls 극각 범위(카메라 설정 min/maxPolarAngle) → 1인칭 pitch 범위. 0.12π~0.86π면 아래 68°~위 65°. */
export function pitchRangeFromPolar(minPolar: number, maxPolar: number): [number, number] {
  return [minPolar - Math.PI / 2, maxPolar - Math.PI / 2];
}

/**
 * 마우스 이동·드래그(px) → 새 시선. 마우스를 오른쪽으로 움직이면 오른쪽을, 위로 움직이면 위를 본다(게임식).
 * 회전 중심은 눈이므로 위치는 바뀌지 않는다. pitch는 range로 제한한다.
 */
export function dragLook(l: Look, dxPx: number, dyPx: number, radPerPx: number, range: [number, number]): Look {
  return { yaw: wrapAngle(l.yaw - dxPx * radPerPx), pitch: clamp(l.pitch - dyPx * radPerPx, range[0], range[1]) };
}

/**
 * 키(방향키·Q·E)로 시선만 돌린다(위치 불변). turn: 왼쪽(+)·오른쪽, pitch: 위(+)·아래, radPerSec: 회전 속도.
 * 위아래는 range로 제한한다.
 */
export function keyLook(l: Look, turn: number, pitch: number, radPerSec: number, dt: number, range: [number, number]): Look {
  return {
    yaw: wrapAngle(l.yaw + Math.sign(turn) * radPerSec * dt),
    pitch: clamp(l.pitch + Math.sign(pitch) * radPerSec * dt, range[0], range[1]),
  };
}

/**
 * 지금 보는 방향 기준 수평 이동량(m). move: 앞(+)·뒤, strafe: 오른쪽(+)·왼쪽.
 * 위·아래를 보고 있어도 바닥과 평행하게 움직이고, 대각선(W+D 등)도 같은 속도로 움직인다.
 */
export function walkDelta(yaw: number, move: number, strafe: number, distance: number): Vec2 {
  const len = Math.hypot(move, strafe);
  if (len < 1e-9) return [0, 0];
  const m = (move / Math.max(1, len)) * distance;
  const s = (strafe / Math.max(1, len)) * distance;
  // 앞 = (-sin yaw, -cos yaw), 오른쪽 = 앞을 시계 방향으로 90° = (cos yaw, -sin yaw)
  return [-Math.sin(yaw) * m + Math.cos(yaw) * s, -Math.cos(yaw) * m - Math.sin(yaw) * s];
}

/** 확대 배율 → 세로 화각(도). 화면 중심을 기준으로 zoom배 커 보인다. */
export function zoomedFov(baseFovDeg: number, zoom: number): number {
  const half = (baseFovDeg * Math.PI) / 360;
  return (Math.atan(Math.tan(half) / zoom) * 360) / Math.PI;
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, ZOOM_RANGE[0], ZOOM_RANGE[1]);
}

/** 휠 deltaY(px)만큼 배율을 바꾼다. 휠을 위로(deltaY < 0) 굴리면 확대, 아래로 굴리면 축소. */
export function wheelZoom(zoom: number, deltaYPx: number): number {
  return clampZoom(zoom * Math.exp(-deltaYPx * WHEEL_ZOOM_PER_PX));
}
