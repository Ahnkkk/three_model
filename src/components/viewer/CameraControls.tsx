"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three/webgpu";
import { sceneKey, type RoomConfig, type Vec3, type ViewPreset } from "@/config/sceneTypes";
import { publishViewZoom } from "@/lib/three/cameraPose";
import { activeColliders, buildColliders, nearestFreeSpot, stepWalker, type WalkerConfig } from "@/lib/three/collision";
import {
  KEY_AXES,
  LOOK_RAD_PER_PX,
  POINTER_LOCK_RAD_PER_PX,
  clampZoom,
  dragLook,
  keyLook,
  lookFromDirection,
  pitchRangeFromPolar,
  walkDelta,
  wheelZoom,
  zoomedFov,
  type Look,
} from "@/lib/three/firstPerson";
import { useViewerStore } from "@/store/viewerStore";
import { useResolvedScene } from "./SceneConfigContext";

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const FAST_MULTIPLIER = 2.5;
/** 점프 중력 가속도(m/s²) */
const GRAVITY = 9.8;
/** 1인칭 화면에서 OrbitControls 회전 중심(target)을 두는 시선 앞 거리(m). 조감도로 돌아갈 때 전환 시작점이 된다. */
const LOOK_DISTANCE = 2;
/** 확대·축소 화각이 목표 화각을 따라가는 빠르기(1/s) */
const ZOOM_SMOOTHING = 14;

/** 보행 키를 받지 않을 대상: 입력란, 열린 대화상자(확인 창 버튼에서 Space·Enter가 버튼으로 동작하게) */
function ignoresWalkKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest('[role="dialog"]') !== null
  );
}

/** 반직선 origin + dir·t 가 상자 [min, max] 안에 있는 t 구간(t ≥ 0). 만나지 않으면 t0 > t1. */
function rayBoxInterval(origin: THREE.Vector3, dir: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3): [number, number] {
  let t0 = 0;
  let t1 = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    if (Math.abs(dir[k]) < 1e-9) {
      if (origin[k] < min[k] || origin[k] > max[k]) return [1, 0];
      continue;
    }
    let a = (min[k] - origin[k]) / dir[k];
    let b = (max[k] - origin[k]) / dir[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  return [t0, t1];
}

/**
 * fit 시점: position→target 방향은 유지하고, 방 전체 bounds가 화면 비율에 맞게 들어오도록 거리를 계산한다.
 */
function resolveViewPosition(view: ViewPreset, room: RoomConfig, fovDeg: number, aspect: number): THREE.Vector3 {
  const target = new THREE.Vector3(...view.target);
  const pos = new THREE.Vector3(...view.position);
  if (!view.fit) return pos;
  const dir = pos.clone().sub(target).normalize();
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  const tanY = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanX = tanY * aspect;
  let distance = 0;
  const t = room.wallThickness;
  for (const x of [-room.width / 2 - t, room.width / 2 + t])
    for (const y of [0, room.height])
      for (const z of [-room.depth / 2 - t, room.depth / 2 + t]) {
        const p = new THREE.Vector3(x, y, z).sub(target);
        const depth = p.dot(dir);
        distance = Math.max(distance, depth + Math.abs(p.dot(right)) / tanX, depth + Math.abs(p.dot(up)) / tanY);
      }
  return target.addScaledVector(dir, distance * 1.06);
}

const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/** 카메라가 보는 방향(yaw·pitch) */
function cameraLook(camera: THREE.Camera): Look {
  _dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return lookFromDirection(_dir.x, _dir.y, _dir.z);
}

/** 카메라를 yaw·pitch로 돌린다(기울기 없음, 위치 불변) */
function applyLook(camera: THREE.Camera, l: Look) {
  camera.quaternion.setFromEuler(_euler.set(l.pitch, l.yaw, 0, "YXZ"));
}

function lookToward(from: THREE.Vector3, to: Vec3): Look {
  return lookFromDirection(to[0] - from.x, to[1] - from.y, to[2] - from.z);
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Transition {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  /** 조감도(OrbitControls): 회전 중심을 보간한다. */
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
  /** 1인칭: 시선 각도를 보간한다(눈이 회전 중심, 기울기 없음). */
  look: { from: Look; to: Look } | null;
  fromFov: number;
  toFov: number;
  duration: number;
  t: number;
  /** fit 시점이면 전환 중에도 현재 화면 비율로 도착 위치를 다시 계산한다(전체 화면 ↔ 패널 전환 중 크기 변화 대응). */
  fitView: ViewPreset | null;
}

/**
 * 카메라 조작 + 이동 범위 제한 + 대표 시점 전환.
 * - 범위·시점·FOV는 장면과 표시 모드(실내/조감도)별 설정을 따른다.
 * - 전환 애니메이션은 프레임 루프에서 참조로 처리하고 React 상태를 갱신하지 않는다.
 * - 같은 투영 카메라를 유지하므로 후처리(AO·SSR)의 카메라 참조가 바뀌지 않는다.
 *
 * 조감도(카메라 설정에 keyboard 없음): OrbitControls — 드래그로 대상 주위를 돌고, 휠로 다가가거나 물러난다.
 *
 * 1인칭(keyboard 있음 — 거실, 사무실 실내): FPS 게임처럼 눈이 회전 중심이다(lib/three/firstPerson.ts).
 * - 마우스: 화면을 클릭하면 포인터가 잠기고(커서 숨김) 마우스를 움직이는 대로 시선이 따라간다. Esc로 해제.
 *   제자리에서 시선만 돌고 위치·눈높이는 바뀌지 않는다. 터치는 드래그로 돌린다. 감도는 설정 패널에서 바꾼다.
 * - 휠(터치는 두 손가락 벌리기): 화면 중심 기준으로 화각을 좁혀 확대, 넓혀 축소한다. 위치는 그대로다.
 * - W·A·S·D: 보는 방향 기준 앞·왼쪽·뒤·오른쪽으로 걷는다. Shift 빠르게.
 * - 방향키: 제자리에서 보는 방향만 바꾼다(← → 좌우, ↑ ↓ 위아래). Q·E도 좌우 회전.
 *   가구·파티션·문짝과 충돌한다(lib/three/collision.ts).
 * - Space 점프: 낮은 사물 위에 올라서거나 넘어갈 수 있다. 눈높이(발 → 눈)는 시점에 도착할 때 정해지고
 *   걷거나 점프해도 바뀌지 않으므로, 사물에서 내려오면 올라가기 전 높이로 정확히 돌아온다.
 * - 미니맵 클릭 이동(moveRequest): 클릭 지점에서 가장 가까운 빈자리로 미끄러지듯 이동한다(바닥 기준 눈높이).
 *   빈 곳을 누르면 시선 방향을 유지하고, 가구·벽 위를 눌러 옆으로 옮겨지면 누른 대상을 바라본다.
 */
export default function CameraControls() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const activeView = useViewerStore((s) => s.activeView);
  const viewRequest = useViewerStore((s) => s.viewRequest);
  const moveRequest = useViewerStore((s) => s.moveRequest);
  const scene = useResolvedScene();
  const cam = scene.view.camera;
  const room = scene.room;
  const keyboard = cam.keyboard;
  /** 1인칭(걷기) 화면인가 */
  const walk = !!keyboard;

  const bounds = useMemo(
    () => ({
      posMin: new THREE.Vector3(...cam.positionBounds.min),
      posMax: new THREE.Vector3(...cam.positionBounds.max),
      tgtMin: new THREE.Vector3(...cam.targetBounds.min),
      tgtMax: new THREE.Vector3(...cam.targetBounds.max),
    }),
    [cam],
  );
  const pitchRange = useMemo(() => pitchRangeFromPolar(cam.minPolarAngle, cam.maxPolarAngle), [cam]);

  const transition = useRef<Transition | null>(null);

  const aspect = size.width / Math.max(1, size.height);
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;
  /** 사용자가 직접 카메라를 움직였는지(움직였다면 화면 비율이 바뀌어도 시점을 다시 맞추지 않는다) */
  const userMovedRef = useRef(false);

  /** 몸 상태: 발 높이(feet, 바닥 = 0 · 사물 위에 서면 그 윗면), 세로 속도(vy), Space 요청. */
  const bodyRef = useRef({ feet: 0, vy: 0, jumpRequested: false });
  /** 시점 이동(절대 위치)은 바닥에 선 상태로 끝나므로 몸 상태를 초기화한다. */
  const resetBody = () => Object.assign(bodyRef.current, { feet: 0, vy: 0, jumpRequested: false });
  /** 눈높이(발 → 카메라, m). 시점에 도착하면 그 높이로 정하고, 걷기·점프·마우스 조작으로는 바뀌지 않는다. */
  const eyeRef = useRef(1.6);
  /** 휠 확대 배율(1 = 기본 화각). 화각은 프레임마다 이 값을 부드럽게 따라간다. */
  const zoomRef = useRef(1);
  /** 마우스 이동·드래그로 쌓인 회전량(라디안, 기본 화각·감도 1 기준). 프레임 루프에서 한 번에 반영한다(전환 중에는 버린다). */
  const dragRef = useRef({ dx: 0, dy: 0 });
  const mouseSensitivity = useViewerStore((s) => s.mouseSensitivity);

  const setZoom = (z: number) => {
    zoomRef.current = z;
    publishViewZoom(z);
  };
  useEffect(() => () => publishViewZoom(1), []);

  /** 1인칭: OrbitControls 회전 중심을 시선 앞에 맞춰 둔다(조감도로 돌아갈 때 그 지점에서 전환을 시작). */
  const syncTarget = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    _dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).addScaledVector(_dir, LOOK_DISTANCE);
  };

  // 초기 시점(장면 진입 시)
  const key = sceneKey(scene);
  useEffect(() => {
    resetBody();
    setZoom(1);
    const view = cam.views.find((v) => v.id === cam.defaultView) ?? cam.views[0];
    const controls = controlsRef.current;
    camera.fov = cam.fov;
    camera.near = cam.near;
    camera.far = cam.far;
    camera.updateProjectionMatrix();
    camera.position.copy(resolveViewPosition(view, room, cam.fov, aspectRef.current));
    if (walk) {
      applyLook(camera, lookToward(camera.position, view.target));
      eyeRef.current = camera.position.y;
      syncTarget();
    } else {
      controls?.target.set(...view.target);
      controls?.update();
    }
    userMovedRef.current = false;
    // 장면이 바뀔 때만 초기화한다(모드 전환은 아래 시점 전환으로 처리).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, key]);

  // 1인칭에서는 OrbitControls를 끄고 아래 드래그·휠 처리를 쓴다(전환 중이면 전환이 끝날 때 맞춘다).
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls && !transition.current) controls.enabled = !walk;
  }, [walk]);

  // 시점 전환 요청(시점 버튼·처음으로·표시 모드 전환)
  useEffect(() => {
    if (viewRequest === 0) return;
    const view = cam.views.find((v) => v.id === activeView) ?? cam.views.find((v) => v.id === cam.defaultView);
    const controls = controlsRef.current;
    if (!view || !controls) return;
    camera.near = cam.near;
    camera.far = cam.far;
    const toPos = resolveViewPosition(view, room, cam.fov, aspectRef.current);
    transition.current = {
      fromPos: camera.position.clone(),
      toPos,
      fromTgt: controls.target.clone(),
      toTgt: new THREE.Vector3(...view.target),
      look: walk ? { from: cameraLook(camera), to: lookToward(toPos, view.target) } : null,
      fromFov: camera.fov,
      toFov: cam.fov,
      duration: cam.transitionSeconds,
      t: 0,
      fitView: view.fit && !walk ? view : null,
    };
    setZoom(1); // 시점 이동은 확대 배율도 처음으로
    resetBody(); // 공중·사물 위에서 눌러도 시점 위치(바닥 기준 절대값)로 이동한다.
    userMovedRef.current = false;
    controls.enabled = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest, activeView, camera, cam, room, walk]);

  // 화면 비율이 바뀌면(창 크기 변경·화면 분할) fit 시점을 현재 비율로 다시 맞춘다.
  useEffect(() => {
    const controls = controlsRef.current;
    const view = cam.views.find((v) => v.id === activeView);
    if (walk || !controls || !view?.fit || userMovedRef.current || transition.current) return;
    camera.position.copy(resolveViewPosition(view, room, camera.fov, aspect));
    controls.target.set(...view.target);
    controls.update();
    // 비율 변화에만 반응한다(시점·모드 변경은 위 전환 효과가 처리)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  // 키보드 입력 상태(눌린 키). 프레임 루프에서 읽고 React 상태는 갱신하지 않는다.
  const pressedRef = useRef(new Set<string>());
  const fastRef = useRef(false);
  /**
   * 눌린 키를 모두 놓은 것으로 한다. 포인터 잠금을 푸는 Esc·창 전환처럼 keyup이 오지 않을 수 있는 순간에 부른다
   * (안 그러면 W를 누른 채 Esc를 눌렀을 때 마지막 방향으로 계속 걸어간다). 실제로 계속 누르고 있으면 키 반복 입력으로 다시 이어진다.
   */
  const releaseKeys = () => {
    pressedRef.current.clear();
    fastRef.current = false;
    bodyRef.current.jumpRequested = false;
  };
  useEffect(() => {
    const pressed = pressedRef.current;
    if (!keyboard) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        releaseKeys();
        return;
      }
      fastRef.current = e.shiftKey;
      if (e.ctrlKey || e.metaKey || e.altKey || ignoresWalkKeys(e.target)) return;
      if (e.code === "Space") {
        // 페이지 스크롤·포커스된 버튼 누름을 막고 점프한다(누르고 있어도 한 번만).
        e.preventDefault();
        if (!e.repeat) bodyRef.current.jumpRequested = true;
        return;
      }
      if (!KEY_AXES.has(e.code)) return;
      e.preventDefault(); // 방향키 페이지 스크롤 방지
      pressed.add(e.code);
    };
    const onUp = (e: KeyboardEvent) => {
      fastRef.current = e.shiftKey;
      // 버튼은 Space를 뗄 때 눌리므로 여기서도 막는다.
      if (e.code === "Space" && !ignoresWalkKeys(e.target)) e.preventDefault();
      pressed.delete(e.code);
    };
    const onVisibility = () => {
      if (document.hidden) releaseKeys();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", releaseKeys);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", releaseKeys);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseKeys();
    };
    // releaseKeys는 참조만 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard]);

  // 1인칭 마우스·터치(lib/three/firstPerson.ts)
  // - 마우스: 화면을 클릭하면 포인터를 잠그고(커서 숨김) 마우스를 움직이는 대로 시선이 따라간다(FPS 게임식). Esc는 브라우저가 잠금을 푼다.
  //   잠금을 못 쓰는 환경(지원 안 함·Esc 직후 재잠금 제한 등)에서는 누른 채 끌어 돌린다.
  // - 터치: 한 손가락 드래그 = 회전, 두 손가락 벌리기·오므리기 = 확대·축소.
  // - 휠: 화면 중심 확대·축소.
  useEffect(() => {
    if (!walk) return;
    const el = gl.domElement;
    const drag = dragRef.current;
    const setLocked = useViewerStore.getState().setPointerLocked;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const locked = () => document.pointerLockElement === el;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    type Lockable = { requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void };
    const lock = () => {
      if (locked() || !("requestPointerLock" in el)) return;
      const plain = () => {
        try {
          void Promise.resolve((el as unknown as Lockable).requestPointerLock()).catch(() => {});
        } catch {
          /* 잠금 불가 — 드래그로 돌린다 */
        }
      };
      try {
        // 운영체제 마우스 가속을 빼고 게임처럼 실제 이동량을 받는다. 지원하지 않으면 일반 잠금.
        const r = (el as unknown as Lockable).requestPointerLock({ unadjustedMovement: true });
        if (r) r.catch((err: unknown) => (err as { name?: string })?.name === "NotSupportedError" && plain());
      } catch {
        plain();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (locked()) return; // 잠금 중 클릭은 무시(Esc로 풀고 화면 UI를 누른다)
      if (e.pointerType === "mouse" && e.button > 2) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch = pointers.size === 2 ? spread() : 0;
      if (e.pointerType === "mouse" && e.button === 0) lock();
      // 드래그(잠금을 못 쓸 때)가 캔버스 밖으로 나가도 이어지도록 포인터를 붙잡는다.
      // 잠금이 걸리는 중에는 붙잡을 수 없으므로(InvalidStateError) 건너뛴다.
      if (document.pointerLockElement) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 잠금 전환 중 — 잠금이 걸리면 마우스 이동량으로 돌린다 */
      }
    };
    const onMove = (e: PointerEvent) => {
      if (locked()) return; // 잠금 중에는 아래 mousemove가 처리한다.
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size >= 2) {
        const d = spread();
        if (pinch > 0 && d > 0) setZoom(clampZoom(zoomRef.current * (d / pinch)));
        pinch = d;
        return;
      }
      drag.dx += dx * LOOK_RAD_PER_PX;
      drag.dy += dy * LOOK_RAD_PER_PX;
    };
    const onLockedMove = (e: MouseEvent) => {
      if (!locked()) return;
      // 일부 환경에서 잠금 직후·창 경계에서 이동량이 크게 튀는 경우가 있어 비정상 값은 버린다.
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      drag.dx += e.movementX * POINTER_LOCK_RAD_PER_PX;
      drag.dy += e.movementY * POINTER_LOCK_RAD_PER_PX;
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try {
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* 이미 풀림 */
      }
      pinch = pointers.size === 2 ? spread() : 0;
    };
    const onLockChange = () => {
      const on = locked();
      if (on) {
        // 잠금 전 드래그로 쌓인 값·누른 포인터는 버리고 마우스 이동량만 쓴다.
        pointers.clear();
        drag.dx = 0;
        drag.dy = 0;
      } else {
        // Esc로 잠금이 풀릴 때 브라우저가 이동 키의 keyup을 보내지 않을 수 있어 눌린 키를 놓는다.
        releaseKeys();
      }
      setLocked(on);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 페이지 스크롤·브라우저 확대 대신 화면 확대
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      setZoom(wheelZoom(zoomRef.current, px));
    };
    const onContextMenu = (e: Event) => e.preventDefault(); // 오른쪽 버튼 드래그도 회전
    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("mousemove", onLockedMove);
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("mousemove", onLockedMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      // 조감도 전환·장면 이동 시 잠금을 풀어 커서를 돌려준다.
      if (locked()) document.exitPointerLock();
      setLocked(false);
      el.style.touchAction = prevTouchAction;
      drag.dx = 0;
      drag.dy = 0;
    };
    // setZoom·releaseKeys는 참조와 알림만 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk, gl]);

  // 보행 장애물(장면 데이터에서 한 번 생성). 높이 판정은 이동할 때의 발·눈높이로 한다.
  const { furniture, partitions, columns } = scene;
  const colliders = useMemo(() => buildColliders({ furniture, partitions, room, columns }), [furniture, partitions, room, columns]);
  const walkBounds = useMemo(
    () => ({ min: [bounds.posMin.x, bounds.posMin.z] as [number, number], max: [bounds.posMax.x, bounds.posMax.z] as [number, number] }),
    [bounds],
  );
  const walker = useMemo<WalkerConfig | null>(
    () =>
      keyboard
        ? { radius: keyboard.bodyRadius, jumpHeight: keyboard.jumpHeight, gravity: GRAVITY, bounds: walkBounds, eyeMax: bounds.posMax.y }
        : null,
    [keyboard, walkBounds, bounds],
  );

  /** 조감도: origin에서 look 방향으로 target을 둔다. 범위를 벗어나면 같은 방향으로 거리만 줄인다(시선 방향 유지). */
  const placeTarget = (out: THREE.Vector3, origin: THREE.Vector3, look: THREE.Vector3, distance: number) => {
    const desired = THREE.MathUtils.clamp(Math.max(distance, LOOK_DISTANCE), cam.minDistance, cam.maxDistance);
    const [t0, t1] = rayBoxInterval(origin, look, bounds.tgtMin, bounds.tgtMax);
    if (t0 <= t1) return out.copy(origin).addScaledVector(look, THREE.MathUtils.clamp(desired, t0, t1));
    return out.copy(origin).addScaledVector(look, desired).clamp(bounds.tgtMin, bounds.tgtMax);
  };

  // 미니맵 클릭 이동: 같은 요청 번호는 한 번만 처리한다(표시 모드 전환 등으로 이펙트가 다시 돌 때 재이동 방지).
  const handledMoveRef = useRef(0);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!moveRequest || !controls || moveRequest.seq === handledMoveRef.current) return;
    handledMoveRef.current = moveRequest.seq;
    // 점프 중·사물 위에서도 바닥에 선 높이 기준으로 이동한다(도착점은 바닥).
    const baseY = walk ? eyeRef.current : camera.position.y - bodyRef.current.feet;
    const radius = keyboard?.bodyRadius ?? 0.2;
    const spot = nearestFreeSpot(activeColliders(colliders, baseY), [moveRequest.x, moveRequest.z], radius, walkBounds);
    if (!spot) return;
    const toPos = new THREE.Vector3(spot[0], baseY, spot[1]).clamp(bounds.posMin, bounds.posMax);
    // 가구·벽 위를 눌러 옆 빈자리로 옮겨졌다면 누른 대상을 바라본다(위아래 시선 각도는 유지).
    const fx = moveRequest.x - toPos.x;
    const fz = moveRequest.z - toPos.z;
    const away = Math.hypot(fx, fz);
    let look: Transition["look"] = null;
    const toTgt = new THREE.Vector3();
    if (walk) {
      const from = cameraLook(camera);
      look = { from, to: away > 0.05 ? { yaw: Math.atan2(-fx, -fz), pitch: from.pitch } : from };
    } else {
      const dir = controls.target.clone().sub(camera.position);
      const distance = dir.length();
      if (distance < 1e-6) camera.getWorldDirection(dir);
      dir.normalize();
      if (away > 0.05) {
        const horizontal = Math.sqrt(Math.max(0, 1 - dir.y * dir.y));
        dir.set((fx / away) * horizontal, dir.y, (fz / away) * horizontal).normalize();
      }
      placeTarget(toTgt, toPos, dir, distance);
    }
    const travel = camera.position.distanceTo(toPos);
    transition.current = {
      fromPos: camera.position.clone(),
      toPos,
      fromTgt: controls.target.clone(),
      toTgt,
      look,
      fromFov: camera.fov,
      toFov: camera.fov,
      duration: THREE.MathUtils.clamp(0.35 + travel * 0.06, 0.4, 1.0),
      t: 0,
      fitView: null,
    };
    resetBody();
    userMovedRef.current = true;
    controls.enabled = false;
    // placeTarget은 렌더마다 새로 만들어지지만 cam·bounds에만 의존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveRequest, camera, colliders, walkBounds, keyboard, bounds, cam, walk]);

  /**
   * 1인칭 보행·점프 한 프레임(lib/three/collision.stepWalker). 위치·시선이 바뀌었으면 true.
   * 사물 위에 서 있거나 공중이면 키를 누르지 않아도 계속 계산한다.
   * 카메라 높이 = 발 높이 + 눈높이(고정)이므로, 사물에서 내려오면 올라가기 전 높이로 돌아온다.
   */
  const stepBody = (delta: number): boolean => {
    if (!keyboard || !walker) return false;
    const body = bodyRef.current;
    let move = 0;
    let strafe = 0;
    let turn = 0;
    let pitch = 0;
    for (const code of pressedRef.current) {
      const a = KEY_AXES.get(code);
      move += a?.move ?? 0;
      strafe += a?.strafe ?? 0;
      turn += a?.turn ?? 0;
      pitch += a?.pitch ?? 0;
    }
    const jump = body.jumpRequested;
    body.jumpRequested = false;
    const looking = turn !== 0 || pitch !== 0;
    if (!move && !strafe && !looking && !jump && body.feet === 0 && body.vy === 0) return false;
    const dt = Math.min(delta, 0.05);

    // 방향키·Q·E: 제자리에서 보는 방향만 돌린다(확대 중이면 화각에 비례해 느리게).
    const look = looking
      ? keyLook(cameraLook(camera), turn, pitch, THREE.MathUtils.degToRad(keyboard.turnSpeed) * (camera.fov / cam.fov), dt, pitchRange)
      : cameraLook(camera);
    const speed = keyboard.moveSpeed * (fastRef.current ? FAST_MULTIPLIER : 1) * dt;
    const [dx, dz] = walkDelta(look.yaw, move, strafe, speed);

    const pos = camera.position;
    const eye = eyeRef.current;
    const next = stepWalker(colliders, { x: pos.x, z: pos.z, feet: body.feet, vy: body.vy, eye }, { dx, dz, jump }, dt, walker);
    body.feet = next.feet;
    body.vy = next.vy;
    const y = next.feet + eye;
    if (!looking && next.x === pos.x && next.z === pos.z && y === pos.y) return false;
    pos.set(next.x, y, next.z);
    if (looking) applyLook(camera, look);
    return true;
  };

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const drag = dragRef.current;
    const tr = transition.current;
    if (tr) {
      drag.dx = 0;
      drag.dy = 0;
      tr.t = Math.min(1, tr.t + delta / tr.duration);
      const k = easeInOut(tr.t);
      camera.position.lerpVectors(tr.fromPos, tr.toPos, k);
      if (tr.fromFov !== tr.toFov) {
        camera.fov = THREE.MathUtils.lerp(tr.fromFov, tr.toFov, k);
        camera.updateProjectionMatrix();
      }
      if (tr.look) {
        const { from, to } = tr.look;
        applyLook(camera, { yaw: from.yaw + wrapAngle(to.yaw - from.yaw) * k, pitch: THREE.MathUtils.lerp(from.pitch, to.pitch, k) });
      } else {
        if (tr.fitView) tr.toPos.copy(resolveViewPosition(tr.fitView, room, tr.toFov, aspectRef.current));
        controls.target.lerpVectors(tr.fromTgt, tr.toTgt, k);
        controls.update();
      }
      if (tr.t >= 1) {
        transition.current = null;
        controls.enabled = !walk;
        if (walk) {
          eyeRef.current = camera.position.y; // 바닥(발 0)에 선 눈높이
          syncTarget();
        }
      }
      return;
    }
    if (!walk) return; // 조감도는 OrbitControls가 처리한다.

    // 마우스 이동·드래그 → 제자리 회전(감도 배율, 확대 중이면 화각에 비례해 느리게)
    let changed = false;
    if (drag.dx || drag.dy) {
      const scale = mouseSensitivity * (camera.fov / cam.fov);
      applyLook(camera, dragLook(cameraLook(camera), drag.dx, drag.dy, scale, pitchRange));
      drag.dx = 0;
      drag.dy = 0;
      changed = true;
    }
    // 휠 → 화면 중심 확대·축소(화각만 바꾼다)
    const goal = zoomedFov(cam.fov, zoomRef.current);
    if (camera.fov !== goal) {
      camera.fov = Math.abs(camera.fov - goal) < 0.01 ? goal : THREE.MathUtils.damp(camera.fov, goal, ZOOM_SMOOTHING, delta);
      camera.updateProjectionMatrix();
    }
    // 키보드 보행·점프
    if (stepBody(delta)) changed = true;
    if (changed) {
      userMovedRef.current = true;
      syncTarget();
    }
  });

  // 조감도: 허용 범위 밖으로 나가지 않도록 위치·회전 중심을 제한한다.
  const clamp = () => {
    const controls = controlsRef.current;
    if (!controls || transition.current || walk) return;
    controls.target.clamp(bounds.tgtMin, bounds.tgtMax);
    camera.position.clamp(bounds.posMin, bounds.posMax);
  };

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.7}
      panSpeed={0.6}
      minDistance={cam.minDistance}
      maxDistance={cam.maxDistance}
      minPolarAngle={cam.minPolarAngle}
      maxPolarAngle={cam.maxPolarAngle}
      onChange={clamp}
      onStart={() => {
        userMovedRef.current = true;
      }}
    />
  );
}
