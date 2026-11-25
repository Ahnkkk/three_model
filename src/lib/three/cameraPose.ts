/**
 * 카메라 평면 위치 알림(3D 프레임 루프 → 미니맵 같은 HTML 오버레이).
 * 프레임마다 바뀌는 값이라 React 상태·zustand에 두지 않고, 구독자가 DOM 속성을 직접 갱신한다.
 */

export interface CameraPose {
  /** 월드 x, z(m) */
  x: number;
  z: number;
  /** 평면(xz)에서 시선 방향 = atan2(dz, dx)(라디안). SVG(x 오른쪽, y = 월드 z 아래쪽) 회전각과 같다. */
  heading: number;
  /** 수평 시야각(라디안) */
  hfov: number;
}

type Listener = (pose: CameraPose | null) => void;

let current: CameraPose | null = null;
const listeners = new Set<Listener>();

export function publishCameraPose(pose: CameraPose | null): void {
  current = pose;
  for (const l of listeners) l(pose);
}

/** 구독하면 마지막 값을 바로 한 번 받는다. 반환값으로 구독을 해제한다. */
export function subscribeCameraPose(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/* 1인칭 화면의 휠 확대 배율(1 = 기본 화각). 하단 배율 표시(LookHint)용 */

let zoom = 1;
const zoomListeners = new Set<(zoom: number) => void>();

export function publishViewZoom(value: number): void {
  if (value === zoom) return;
  zoom = value;
  for (const l of zoomListeners) l(value);
}

/** 구독하면 현재 배율을 바로 한 번 받는다. 반환값으로 구독을 해제한다. */
export function subscribeViewZoom(listener: (zoom: number) => void): () => void {
  zoomListeners.add(listener);
  listener(zoom);
  return () => {
    zoomListeners.delete(listener);
  };
}
