"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { DoorSpec, PartitionSegment } from "@/config/sceneTypes";
import { applyMetricBoxUV, metricBox } from "@/lib/three/geometry";
import { useOwnedGeometries, useSceneResources } from "@/components/viewer/SceneResourcesContext";
import { useSceneConfig } from "@/components/viewer/SceneConfigContext";

/**
 * 파티션 시스템.
 * 시작점·끝점·두께·개구부를 가진 선분 데이터(scene.partitions)에서 3D 프레임·유리·벽·문을 만든다.
 * 2D 평면도(FloorPlanSvg)도 같은 데이터를 사용한다.
 *
 * 로컬 좌표: 원점 = 선분 시작점 a, +x = a→b 방향, +y = 위, +z = 선분의 왼쪽 법선(swing "pos" 방향).
 * 개구부 구간에는 벽·유리·하부 레일을 만들지 않는다(실제로 통과 가능한 개구부).
 */

const FRAME_W = 0.05;
const FRAME_D = 0.07;
const CAP_H = 0.025;

interface Span {
  x0: number;
  x1: number;
}

function segmentInfo(p: PartitionSegment) {
  const dx = p.b[0] - p.a[0];
  const dz = p.b[1] - p.a[1];
  const length = Math.hypot(dx, dz);
  // three.js Y축 회전: 로컬 +x → (cos, -sin). 선분 방향과 맞추려면 θ = atan2(-dz, dx)
  const rotationY = Math.atan2(-dz / length, dx / length);
  const openings = [...p.openings].sort((a, b) => a.offset - b.offset).map((o) => ({ ...o, x0: o.offset - o.width / 2, x1: o.offset + o.width / 2 }));
  const spans: Span[] = [];
  let s = 0;
  for (const o of openings) {
    if (o.x0 > s) spans.push({ x0: s, x1: o.x0 });
    s = Math.max(s, o.x1);
  }
  if (s < length) spans.push({ x0: s, x1: length });
  return { length, rotationY, openings, spans };
}

/** 문짝. 경첩 쪽 끝을 기준으로 회전한다(DoorSpec 규칙은 sceneTypes.ts 참고). */
export function DoorLeaf({ width, height, spec }: { width: number; height: number; spec: DoorSpec }) {
  const { materials } = useSceneResources();
  const start = spec.hinge === "start";
  const a = THREE.MathUtils.degToRad(spec.angle);
  const rotY = start ? (spec.swing === "pos" ? -a : a) : spec.swing === "pos" ? a : -a;
  const dir = start ? 1 : -1;
  const leafW = width - 0.02;
  const leafH = height - 0.012;
  const g = useOwnedGeometries(
    () => ({
      slab: metricBox(leafW, leafH, 0.04),
      stile: metricBox(0.045, leafH, 0.045),
      rail: metricBox(leafW, 0.06, 0.045),
      pane: new THREE.PlaneGeometry(leafW - 0.09, leafH - 0.12),
      handle: metricBox(0.02, 0.32, 0.03),
    }),
    [leafW, leafH],
  );
  if (spec.leaf === "none") return null;
  const cx = dir * (0.01 + leafW / 2);
  return (
    <group position={[start ? 0 : width, 0, 0]} rotation={[0, rotY, 0]}>
      {spec.leaf === "glass" ? (
        <group position={[cx, 0, 0]}>
          {[-1, 1].map((s) => (
            <mesh key={s} geometry={g.stile} material={materials.partitionFrame} position={[s * (leafW / 2 - 0.0225), leafH / 2, 0]} castShadow />
          ))}
          <mesh geometry={g.rail} material={materials.partitionFrame} position={[0, 0.03, 0]} castShadow />
          <mesh geometry={g.rail} material={materials.partitionFrame} position={[0, leafH - 0.03, 0]} castShadow />
          <mesh geometry={g.pane} material={materials.officePartitionGlass} position={[0, leafH / 2, 0]} renderOrder={10} />
          <mesh geometry={g.handle} material={materials.stainless} position={[dir * (leafW / 2 - 0.1), 1.05, 0.04]} />
        </group>
      ) : (
        <group position={[cx, 0, 0]}>
          <mesh geometry={g.slab} material={spec.leaf === "wood" ? materials.doorWood : materials.doorPaint} position={[0, leafH / 2, 0]} castShadow receiveShadow />
          <mesh geometry={g.handle} material={materials.stainless} position={[dir * (leafW / 2 - 0.08), 1.0, 0.035]} rotation={[0, 0, Math.PI / 2]} />
        </group>
      )}
    </group>
  );
}

function GlassPartition({ p }: { p: PartitionSegment }) {
  const { materials } = useSceneResources();
  const roomHeight = useSceneConfig().room.height;
  const H = p.height ?? roomHeight;
  const info = useMemo(() => segmentInfo(p), [p]);

  const g = useOwnedGeometries(() => {
    const frame: THREE.BufferGeometry[] = [];
    const panes: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number) => {
      const b = new THREE.BoxGeometry(w, h, d);
      b.translate(x, y, 0);
      frame.push(b);
    };
    const pane = (w: number, h: number, x: number, y: number) => {
      if (w < 0.05 || h < 0.05) return;
      const pl = new THREE.PlaneGeometry(w, h);
      pl.translate(x, y, 0);
      panes.push(pl);
    };
    // 상부 레일(전체 길이)
    box(info.length, FRAME_W, FRAME_D, info.length / 2, H - FRAME_W / 2);
    // 기둥 위치: 양 끝, 개구부 양옆, 1.2m 이하 간격
    for (const span of info.spans) {
      const len = span.x1 - span.x0;
      const bays = Math.max(1, Math.ceil(len / 1.2));
      const bay = len / bays;
      box(len, 0.07, FRAME_D, (span.x0 + span.x1) / 2, 0.035); // 하부 레일
      for (let i = 0; i <= bays; i++) {
        const x = Math.min(Math.max(span.x0 + i * bay, FRAME_W / 2), info.length - FRAME_W / 2);
        box(FRAME_W, H, FRAME_D, x, H / 2);
      }
      for (let i = 0; i < bays; i++) pane(bay - FRAME_W, H - 0.07 - FRAME_W, span.x0 + (i + 0.5) * bay, 0.07 + (H - 0.07 - FRAME_W) / 2);
    }
    // 개구부: 문틀 상부와 위쪽 유리(트랜섬)
    for (const o of info.openings) {
      box(o.width, FRAME_W, FRAME_D, o.offset, o.height + FRAME_W / 2);
      pane(o.width - FRAME_W, H - o.height - FRAME_W * 2, o.offset, o.height + FRAME_W + (H - o.height - FRAME_W * 2) / 2);
    }
    const frameGeo = mergeGeometries(frame);
    const paneGeo = panes.length ? mergeGeometries(panes) : null;
    frame.forEach((f) => f.dispose());
    panes.forEach((f) => f.dispose());
    return { frame: applyMetricBoxUV(frameGeo), ...(paneGeo ? { panes: paneGeo } : {}) } as Record<string, THREE.BufferGeometry>;
  }, [info, H]);

  return (
    <group position={[p.a[0], 0, p.a[1]]} rotation={[0, info.rotationY, 0]} name={`partition:${p.id}`}>
      <mesh geometry={g.frame} material={materials.partitionFrame} castShadow receiveShadow />
      {g.panes && <mesh geometry={g.panes} material={materials.officePartitionGlass} renderOrder={10} />}
      {info.openings.map((o) =>
        o.door ? (
          <group key={o.id} position={[o.x0, 0, 0]}>
            <DoorLeaf width={o.width} height={o.height} spec={o.door} />
          </group>
        ) : null,
      )}
    </group>
  );
}

function SolidPartition({ p }: { p: PartitionSegment }) {
  const { materials } = useSceneResources();
  const roomHeight = useSceneConfig().room.height;
  const H = p.height ?? roomHeight;
  const info = useMemo(() => segmentInfo(p), [p]);
  const t = p.thickness;

  const g = useOwnedGeometries(() => {
    // 바닥에 닿는 개구부는 외곽 윤곽을 잘라낸 홈으로 만든다.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (const o of info.openings) {
      shape.lineTo(o.x0, 0);
      shape.lineTo(o.x0, o.height);
      shape.lineTo(o.x1, o.height);
      shape.lineTo(o.x1, 0);
    }
    shape.lineTo(info.length, 0);
    shape.lineTo(info.length, H);
    shape.lineTo(0, H);
    shape.closePath();
    const wall = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
    wall.translate(0, 0, -t / 2);
    wall.clearGroups();
    const cap = new THREE.BoxGeometry(info.length, CAP_H, t + 0.004);
    cap.translate(info.length / 2, H + CAP_H / 2, 0);
    // 문틀(양면)
    const casings: THREE.BufferGeometry[] = [];
    for (const o of info.openings) {
      for (const side of [-1, 1]) {
        const z = side * (t / 2 + 0.01);
        for (const x of [o.x0 - 0.03, o.x1 + 0.03]) {
          const b = new THREE.BoxGeometry(0.06, o.height + 0.06, 0.02);
          b.translate(x, (o.height + 0.06) / 2, z);
          casings.push(b);
        }
        const head = new THREE.BoxGeometry(o.width + 0.12, 0.06, 0.02);
        head.translate(o.offset, o.height + 0.03, z);
        casings.push(head);
      }
    }
    const casing = casings.length ? mergeGeometries(casings) : null;
    casings.forEach((c) => c.dispose());
    return { wall: applyMetricBoxUV(wall), cap, ...(casing ? { casing } : {}) } as Record<string, THREE.BufferGeometry>;
  }, [info, H, t]);

  return (
    <group position={[p.a[0], 0, p.a[1]]} rotation={[0, info.rotationY, 0]} name={`partition:${p.id}`}>
      <mesh geometry={g.wall} material={materials.officeWall} castShadow receiveShadow />
      <mesh geometry={g.cap} material={materials.sectionCap} castShadow />
      {g.casing && <mesh geometry={g.casing} material={materials.deskWhite} castShadow receiveShadow />}
      {info.openings.map((o) =>
        o.door ? (
          <group key={o.id} position={[o.x0, 0, 0]}>
            <DoorLeaf width={o.width} height={o.height} spec={o.door} />
          </group>
        ) : null,
      )}
    </group>
  );
}

export default function PartitionSystem() {
  const { partitions } = useSceneConfig();
  return (
    <group name="partitions">
      {partitions.map((p) => (p.kind === "glass" ? <GlassPartition key={p.id} p={p} /> : <SolidPartition key={p.id} p={p} />))}
    </group>
  );
}
