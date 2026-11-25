"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { FloorZone, RoomConfig, SceneColumn, WallId, WallOpening } from "@/config/sceneTypes";
import { metricBox } from "@/lib/three/geometry";
import { createSurfaceGeometry, createWallSolidGeometry, frameMatrix, getSurfaceFrames, type SurfaceFrame } from "@/lib/three/roomSurfaces";
import { useResolvedScene } from "@/components/viewer/SceneConfigContext";
import { useOwnedGeometries, useSceneResources } from "@/components/viewer/SceneResourcesContext";
import PartitionSystem, { DoorLeaf } from "./PartitionSystem";

/**
 * 도면형(plan) 외곽 구조 — 사무실과 외부 도면 문서가 함께 쓴다.
 * - 바닥(라이트맵) + 영역별 바닥 마감(바닥 라이트맵 공유)
 * - 두께가 있는 외벽(모든 방위의 창 구멍·문 홈·문짝) + 단면 상단(주황 캡) + 바닥 슬래브 테두리
 * - 천장까지 닿는 기둥(scene.columns)
 * - 표시 모드: 조감도는 천장을 숨기고 벽을 낮게 절단, 실내는 천장·전체 벽·천장등 표시
 * - 내부 구획은 PartitionSystem(같은 선분 데이터를 2D 평면도도 사용)
 */

function FrameGroup({ frame, su, sv, sz = 0, children }: { frame: SurfaceFrame; su: number; sv: number; sz?: number; children: React.ReactNode }) {
  const { position, quaternion } = useMemo(() => {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    frameMatrix(frame, su, sv, sz).decompose(p, q, new THREE.Vector3());
    return { position: p, quaternion: q };
  }, [frame, su, sv, sz]);
  return (
    <group position={position} quaternion={quaternion}>
      {children}
    </group>
  );
}

/** 바닥 마감 영역: 월드 사각형 + 바닥 표면 기준 uv1(바닥 라이트맵과 같은 좌표) */
function floorZoneGeometry(zone: FloorZone, room: RoomConfig): THREE.BufferGeometry {
  const [x0, z0, x1, z1] = zone.rect;
  const y = 0.006;
  const corners = [
    [x0, z1],
    [x1, z1],
    [x1, z0],
    [x0, z0],
  ];
  const pos = new Float32Array(corners.flatMap(([x, z]) => [x, y, z]));
  const nrm = new Float32Array(corners.flatMap(() => [0, 1, 0]));
  const uv = new Float32Array(corners.flatMap(([x, z]) => [x, z]));
  const uv1 = new Float32Array(corners.flatMap(([x, z]) => [(x + room.width / 2) / room.width, (room.depth / 2 - z) / room.depth]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeBoundingSphere();
  return geo;
}

function WindowUnit({ frame, opening, room }: { frame: SurfaceFrame; opening: WallOpening; room: RoomConfig }) {
  const { materials } = useSceneResources();
  const t = room.wallThickness;
  const { width: w, height: h } = opening;
  const g = useOwnedGeometries(() => {
    const bars: THREE.BufferGeometry[] = [];
    const bar = (bw: number, bh: number, x: number, y: number) => {
      const b = new THREE.BoxGeometry(bw, bh, 0.08);
      b.translate(x, y, -t * 0.5);
      bars.push(b);
    };
    bar(0.06, h, -w / 2 + 0.03, 0);
    bar(0.06, h, w / 2 - 0.03, 0);
    bar(w, 0.06, 0, h / 2 - 0.03);
    bar(w, 0.06, 0, -h / 2 + 0.03);
    bar(0.05, h - 0.12, 0, 0);
    const frameGeo = mergeGeometries(bars);
    bars.forEach((b) => b.dispose());
    const glass = new THREE.PlaneGeometry(w - 0.1, h - 0.1);
    glass.translate(0, 0, -t * 0.5);
    return {
      frame: frameGeo,
      glass,
      sill: metricBox(w + 0.08, 0.03, t * 0.5 + 0.06),
      blind: metricBox(w + 0.14, 0.16, 0.13),
    };
  }, [w, h, t]);
  return (
    <FrameGroup frame={frame} su={opening.center} sv={opening.bottom + h / 2}>
      <mesh geometry={g.frame} material={materials.windowFrameDark} castShadow receiveShadow />
      <mesh geometry={g.glass} material={materials.glass} renderOrder={10} />
      <mesh geometry={g.sill} material={materials.deskWhite} position={[0, -h / 2 - 0.015, -t * 0.25 + 0.03]} receiveShadow castShadow />
      <mesh geometry={g.blind} material={materials.windowFrameDark} position={[0, h / 2 + 0.1, 0.065]} castShadow receiveShadow />
    </FrameGroup>
  );
}

/** 천장까지 닿는 기둥(월드 xz 중심·크기) + 단면 상단 캡 */
function Column({ column, height }: { column: SceneColumn; height: number }) {
  const { materials } = useSceneResources();
  const [sx, sz] = column.size;
  const g = useOwnedGeometries(() => ({ body: metricBox(sx, height, sz), cap: new THREE.BoxGeometry(sx, 0.025, sz) }), [sx, sz, height]);
  return (
    <group position={[column.center[0], 0, column.center[1]]} name={`column:${column.id}`}>
      <mesh geometry={g.body} material={materials.officeWall} position={[0, height / 2, 0]} castShadow receiveShadow />
      <mesh geometry={g.cap} material={materials.sectionCap} position={[0, height + 0.0125, 0]} />
    </group>
  );
}

function CeilingLights() {
  const { materials } = useSceneResources();
  const scene = useResolvedScene();
  const g = useOwnedGeometries(() => ({ panel: metricBox(1.2, 0.03, 0.3) }), []);
  return (
    <>
      {scene.lighting.lamps.map((lamp) => (
        <mesh key={lamp.id} geometry={g.panel} material={materials.ceilingPanel} position={[lamp.position[0], scene.room.height - 0.016, lamp.position[2]]} />
      ))}
    </>
  );
}

export default function OfficeShell() {
  const scene = useResolvedScene();
  const { room, view } = scene;
  const { materials, surfaceMaterials, floorOverlays } = useSceneResources();
  const frames = useMemo(() => getSurfaceFrames(room), [room]);
  const frameOf = (id: string) => frames.find((f) => f.id === id)!;
  const wallIds: WallId[] = ["north", "south", "west", "east"];
  const cutKey = wallIds.map((id) => view.wallCut[id] ?? room.height).join(",");

  const surfaces = useOwnedGeometries(
    () => ({
      floor: createSurfaceGeometry(frameOf("floor"), room),
      ceiling: createSurfaceGeometry(frameOf("ceiling"), room),
      slab: metricBox(room.width + room.wallThickness * 2, 0.16, room.depth + room.wallThickness * 2),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames, room],
  );

  // 표시 모드가 바뀌면(단면 높이) 외벽 지오메트리를 다시 만든다.
  const walls = useOwnedGeometries(() => {
    const out: Record<string, THREE.BufferGeometry> = {};
    for (const id of wallIds) {
      const height = view.wallCut[id] ?? room.height;
      const { wall, caps } = createWallSolidGeometry(frameOf(id), room, { height, extendEnds: id === "north" || id === "south" });
      out[id] = wall;
      out[`${id}:cap`] = caps;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, room, cutKey]);

  const zones = useOwnedGeometries(() => Object.fromEntries(scene.floorZones.map((z) => [z.id, floorZoneGeometry(z, room)])), [scene.floorZones, room]);

  // 벽이 문 높이보다 낮게 절단된 조감도에서는 문짝을 숨기고 개구부만 남긴다.
  const doorLeaves = room.openings.filter((o) => o.kind === "door" && o.door && (view.wallCut[o.wall] ?? room.height) >= o.height);

  return (
    <group name="office-shell">
      <mesh geometry={surfaces.slab} material={materials.sectionCap} position={[0, -0.082, 0]} receiveShadow />
      <mesh geometry={surfaces.floor} material={surfaceMaterials.floor} receiveShadow />
      {scene.floorZones.map((z) => (
        <mesh key={z.id} geometry={zones[z.id]} material={floorOverlays[z.id] ?? surfaceMaterials.floor} receiveShadow />
      ))}
      {/* 천장은 실내 모드에서만 표시(조감도에서 숨기면 그림자도 함께 사라진다 — 의도한 동작) */}
      <mesh geometry={surfaces.ceiling} material={surfaceMaterials.ceiling} castShadow receiveShadow visible={view.showCeiling} />
      {view.showCeiling && <CeilingLights />}

      {wallIds.map((id) => (
        <group key={id}>
          <mesh geometry={walls[id]} material={surfaceMaterials[id]} castShadow receiveShadow />
          <mesh geometry={walls[`${id}:cap`]} material={materials.sectionCap} castShadow />
        </group>
      ))}

      {room.openings
        .filter((o) => o.kind === "window" && o.bottom + o.height < (view.wallCut[o.wall] ?? room.height))
        .map((o) => (
          <WindowUnit key={o.id} frame={frameOf(o.wall)} opening={o} room={room} />
        ))}
      {scene.columns?.map((c) => (
        <Column key={c.id} column={c} height={room.height} />
      ))}

      {/* 외벽 문짝(모든 방위). 경첩은 벽 두께 가운데(충돌·2D와 같은 위치) */}
      {doorLeaves.map((o) => (
        <FrameGroup key={o.id} frame={frameOf(o.wall)} su={o.center - o.width / 2} sv={0} sz={-room.wallThickness / 2}>
          <DoorLeaf width={o.width} height={o.height} spec={o.door!} />
        </FrameGroup>
      ))}

      <PartitionSystem />
    </group>
  );
}
