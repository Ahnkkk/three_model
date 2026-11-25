import * as THREE from "three/webgpu";
import { LIVING_SCENE } from "@/config/interior";
import type { BakeVariant, SceneConfig } from "@/config/sceneTypes";
import { getSurfaceFrames, surfacePoint } from "./roomSurfaces";

/**
 * 실내용 기본 반사 환경.
 *
 * 실외 HDRI를 그대로 쓰면 방 안의 바닥이 바깥 풍경을 반사하는 문제가 생기므로,
 * 장면과 같은 크기의 단순화된 실내(벽·바닥·천장 색, 밝은 창, 램프)를 만들어 PMREM으로 캡처한다.
 * - closed: 닫힌 실내(램프 켜짐/꺼짐 두 가지)
 * - open:   천장 없는 조감도. 천장 자리에 밝은 하늘을 둔다.
 * 실제 지역 반사 프로브(박스 투영·방별 전환)는 후속 단계에서 이 자리를 대체한다.
 */

function basic(color: THREE.ColorRepresentation, scale = 1): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  m.color.set(color).multiplyScalar(scale);
  return m;
}

function buildEnvironmentScene(scene: SceneConfig, variant: BakeVariant, lampsOn: boolean): { scene: THREE.Scene; dispose: () => void } {
  const env = new THREE.Scene();
  const disposables: { dispose: () => void }[] = [];
  const { room, lighting, environmentPalette: palette } = scene;
  const W = room.width;
  const D = room.depth;
  const H = room.height;

  // 방 상자: 면별 재질(+x, -x, +y, -y, +z, -z)
  const wall = basic(palette.wall, 0.55);
  const floor = basic(palette.floor, 0.35);
  const top = variant === "open" ? basic("#dfeaf6", 2.2) : basic(palette.ceiling, 0.6);
  const box = new THREE.BoxGeometry(W, H, D);
  const mesh = new THREE.Mesh(box, [wall, wall, top, floor, wall, wall]);
  mesh.position.y = H / 2;
  env.add(mesh);
  disposables.push(box, wall, floor, top);

  // 창(밝은 면광원)
  const frames = getSurfaceFrames(room);
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  skyMat.color.set("#cfe2ff").multiplyScalar(lighting.environment.windowLuminance);
  disposables.push(skyMat);
  for (const o of room.openings.filter((op) => op.kind === "window")) {
    const frame = frames.find((f) => f.id === o.wall)!;
    const plane = new THREE.PlaneGeometry(o.width, o.height);
    const win = new THREE.Mesh(plane, skyMat);
    const center = surfacePoint(frame, o.center, o.bottom + o.height / 2);
    win.position.copy(center).addScaledVector(frame.normal, 0.01);
    win.lookAt(center.clone().add(frame.normal));
    env.add(win);
    disposables.push(plane);
  }

  // 램프(작은 발광체)
  if (lampsOn && variant === "closed") {
    const bulb = new THREE.SphereGeometry(0.12, 16, 8);
    disposables.push(bulb);
    for (const lamp of lighting.lamps) {
      const m = new THREE.MeshBasicNodeMaterial();
      m.color.set(lamp.color).multiplyScalar(lamp.intensity * 4);
      const b = new THREE.Mesh(bulb, m);
      b.position.set(...lamp.position);
      env.add(b);
      disposables.push(m);
    }
  }

  return { scene: env, dispose: () => disposables.forEach((d) => d.dispose()) };
}

export interface EnvironmentMaps {
  /** 표시 모드의 베이크 변형과 램프 상태에 맞는 환경맵 */
  get: (variant: BakeVariant, lampsOn: boolean) => THREE.Texture;
  dispose: () => void;
}

export function createEnvironmentMaps(
  renderer: THREE.WebGPURenderer,
  scene: SceneConfig = LIVING_SCENE,
  variants: BakeVariant[] = ["closed"],
): EnvironmentMaps {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const far = Math.max(30, Math.hypot(scene.room.width, scene.room.depth, scene.room.height) * 1.5);
  const capture = (variant: BakeVariant, lampsOn: boolean) => {
    const env = buildEnvironmentScene(scene, variant, lampsOn);
    const target = pmrem.fromScene(env.scene, 0.02, 0.05, far, {
      position: new THREE.Vector3(0, scene.room.height * 0.5, 0),
    });
    env.dispose();
    return target;
  };

  const targets = new Map<string, THREE.CubeRenderTarget | THREE.RenderTarget>();
  for (const variant of variants) {
    if (variant === "closed") {
      targets.set("closed:on", capture("closed", true));
      targets.set("closed:off", capture("closed", false));
    } else {
      targets.set("open", capture("open", false));
    }
  }
  pmrem.dispose();

  const fallback = targets.values().next().value!;
  return {
    get: (variant, lampsOn) => (targets.get(variant === "open" ? "open" : lampsOn ? "closed:on" : "closed:off") ?? fallback).texture,
    dispose: () => targets.forEach((t) => t.dispose()),
  };
}
