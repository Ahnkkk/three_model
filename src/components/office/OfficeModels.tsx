"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import type { FurnitureItem, FurnitureKind } from "@/config/sceneTypes";
import { metricBox, metricCylinder, metricRoundedBox, metricRoundedSlab, metricSphere } from "@/lib/three/geometry";
import { hDeskLayout } from "@/lib/three/layoutGeometry";
import { useOwnedGeometries, useSceneResources } from "@/components/viewer/SceneResourcesContext";

/**
 * 사무실 가구 모델(코드 제작). 로컬 좌표: 원점 = 바닥 중심, 정면 = +z, 크기는 item.size.
 * 기존 거실 가구 함수는 그대로 두고 새 kind만 이 파일에 둔다.
 */

interface ModelProps {
  item: FurnitureItem;
}

const deg = THREE.MathUtils.degToRad;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ 의자(부품 정의 공용) ------------------------------ */

type ChairKind = "meetingChair" | "officeChair";
type ChairMat = "upholstery" | "frame" | "plastic";

interface ChairPart {
  key: string;
  make: () => THREE.BufferGeometry;
  mat: ChairMat;
  locals: THREE.Matrix4[];
}

const local = (x: number, y: number, z: number, rx = 0, ry = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1));

function chairParts(kind: ChairKind): ChairPart[] {
  if (kind === "meetingChair") {
    return [
      { key: "seat", make: () => metricRoundedBox(0.48, 0.07, 0.46, 0.03), mat: "upholstery", locals: [local(0, 0.455, 0.02)] },
      { key: "back", make: () => metricRoundedBox(0.46, 0.36, 0.05, 0.022), mat: "upholstery", locals: [local(0, 0.69, -0.215, -0.12)] },
      {
        key: "leg",
        make: () => metricCylinder(0.011, 0.011, 0.42, 8),
        mat: "frame",
        locals: [local(-0.2, 0.21, -0.18), local(0.2, 0.21, -0.18), local(-0.2, 0.21, 0.18), local(0.2, 0.21, 0.18)],
      },
    ];
  }
  const star = (r: number, y: number) => Array.from({ length: 5 }, (_, k) => k * ((2 * Math.PI) / 5)).map((a) => local(Math.sin(a) * r, y, Math.cos(a) * r, 0, a));
  return [
    { key: "seat", make: () => metricRoundedBox(0.5, 0.08, 0.48, 0.035), mat: "upholstery", locals: [local(0, 0.49, 0.03)] },
    { key: "back", make: () => metricRoundedBox(0.46, 0.52, 0.06, 0.03), mat: "upholstery", locals: [local(0, 0.86, -0.22, -0.1)] },
    { key: "spine", make: () => metricBox(0.05, 0.36, 0.03), mat: "frame", locals: [local(0, 0.62, -0.25, -0.05)] },
    { key: "column", make: () => metricCylinder(0.024, 0.024, 0.34, 10), mat: "frame", locals: [local(0, 0.27, 0)] },
    { key: "spoke", make: () => metricBox(0.04, 0.03, 0.28), mat: "plastic", locals: star(0.14, 0.085) },
    { key: "caster", make: () => metricSphere(0.026, 8, 6), mat: "plastic", locals: star(0.28, 0.028) },
    { key: "arm", make: () => metricRoundedBox(0.05, 0.03, 0.26, 0.012, 2), mat: "plastic", locals: [local(-0.27, 0.68, 0.02), local(0.27, 0.68, 0.02)] },
    { key: "armPost", make: () => metricBox(0.03, 0.18, 0.03), mat: "plastic", locals: [local(-0.27, 0.58, 0.02), local(0.27, 0.58, 0.02)] },
  ];
}

function useChairMaterials(color: string | undefined) {
  const { materials, tinted } = useSceneResources();
  return useMemo(
    () => ({
      upholstery: color ? tinted("meetingFabric", color) : materials.meetingFabric,
      frame: materials.blackMetal,
      plastic: materials.plasticDark,
    }),
    [materials, tinted, color],
  );
}

/** 단일 의자(GLB 교체 실패 시 대체 모델) */
function Chair({ item, kind }: ModelProps & { kind: ChairKind }) {
  const parts = useMemo(() => chairParts(kind), [kind]);
  const geos = useOwnedGeometries(() => Object.fromEntries(parts.map((p) => [p.key, p.make()])), [parts]);
  const mats = useChairMaterials(item.variant?.color);
  return (
    <group>
      {parts.flatMap((p) =>
        p.locals.map((m, i) => (
          <mesh key={`${p.key}-${i}`} geometry={geos[p.key]} material={mats[p.mat]} matrixAutoUpdate={false} matrix={m} castShadow receiveShadow />
        )),
      )}
    </group>
  );
}

/** 같은 종류·색상의 의자를 부품별 InstancedMesh로 그린다(의자 34개 → 수십 회가 아닌 부품 수만큼의 드로콜). */
function ChairGroup({ kind, color, items }: { kind: ChairKind; color?: string; items: FurnitureItem[] }) {
  const parts = useMemo(() => chairParts(kind), [kind]);
  const geos = useOwnedGeometries(() => Object.fromEntries(parts.map((p) => [p.key, p.make()])), [parts]);
  const mats = useChairMaterials(color);
  const itemMatrices = useMemo(
    () =>
      items.map((it) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(...it.position),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, deg(it.rotationY ?? 0), 0)),
          new THREE.Vector3(1, 1, 1),
        ),
      ),
    [items],
  );
  return (
    <>
      {parts.map((p) => (
        <PartInstances key={p.key} geometry={geos[p.key]} material={mats[p.mat]} matrices={itemMatrices.flatMap((im) => p.locals.map((l) => im.clone().multiply(l)))} />
      ))}
    </>
  );
}

function PartInstances({ geometry, material, matrices }: { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices, geometry, material]); // 재질 교체(조명 갱신)로 인스턴스가 다시 생기면 다시 배치
  return <instancedMesh key={matrices.length} ref={ref} args={[geometry, material, matrices.length]} castShadow receiveShadow />;
}

export const INSTANCED_KINDS = new Set<FurnitureKind>(["meetingChair", "officeChair"]);

/** 장면의 의자 전체(모델 교체가 없는 항목)를 종류·색상별로 묶어 인스턴싱 */
export function ChairInstances({ items }: { items: FurnitureItem[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, { kind: ChairKind; color?: string; items: FurnitureItem[] }>();
    for (const it of items) {
      const kind = it.kind as ChairKind;
      const key = `${kind}|${it.variant?.color ?? ""}`;
      if (!map.has(key)) map.set(key, { kind, color: it.variant?.color, items: [] });
      map.get(key)!.items.push(it);
    }
    return [...map.entries()];
  }, [items]);
  return (
    <group name="chairs-instanced">
      {groups.map(([key, g]) => (
        <ChairGroup key={key} kind={g.kind} color={g.color} items={g.items} />
      ))}
    </group>
  );
}

/* ------------------------------ 회의 테이블 ------------------------------ */

function ConferenceTable({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, l] = item.size;
  const top = 0.045;
  const ports = item.variant?.ports ?? 0;
  const g = useOwnedGeometries(
    () => ({
      top: metricRoundedSlab(w, l, top, Math.min(w, l) * 0.22),
      leg: metricBox(0.055, h - top, 0.055),
      rail: metricBox(0.04, 0.06, l - 0.5),
      plate: metricBox(0.16, 0.012, 0.26),
      port: metricBox(0.12, 0.014, 0.2),
    }),
    [w, h, l],
  );
  const legZ = l >= 3 ? [-l / 2 + 0.35, 0, l / 2 - 0.35] : [-l / 2 + 0.22, l / 2 - 0.22];
  const legX = w / 2 - 0.16;
  return (
    <group>
      <mesh geometry={g.top} material={materials.conferenceWood} position={[0, h - top, 0]} castShadow receiveShadow />
      {legZ.flatMap((z) =>
        [-1, 1].map((s) => <mesh key={`${z}-${s}`} geometry={g.leg} material={materials.blackMetal} position={[s * legX, (h - top) / 2, z]} castShadow />),
      )}
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={g.rail} material={materials.blackMetal} position={[s * legX, h - top - 0.05, 0]} />
      ))}
      {Array.from({ length: ports }, (_, i) => {
        const z = -l / 2 + ((i + 1) / (ports + 1)) * l;
        return (
          <group key={i} position={[0, h + 0.006, z]}>
            <mesh geometry={g.plate} material={materials.deskWhite} receiveShadow />
            <mesh geometry={g.port} material={materials.plasticDark} position={[0, 0.002, 0]} />
          </group>
        );
      })}
    </group>
  );
}

function RoundMeetingTable({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h] = item.size;
  const g = useOwnedGeometries(
    () => ({
      top: metricCylinder(w / 2, w / 2, 0.03, 48),
      pole: metricCylinder(0.04, 0.04, h - 0.05, 16),
      foot: metricBox(0.6, 0.025, 0.06),
    }),
    [w, h],
  );
  return (
    <group>
      <mesh geometry={g.top} material={materials.deskWhite} position={[0, h - 0.015, 0]} castShadow receiveShadow />
      <mesh geometry={g.pole} material={materials.walnut} position={[0, 0.02 + (h - 0.05) / 2, 0]} castShadow />
      <mesh geometry={g.foot} material={materials.blackMetal} position={[0, 0.0125, 0]} castShadow receiveShadow />
      <mesh geometry={g.foot} material={materials.blackMetal} position={[0, 0.0125, 0]} rotation={[0, Math.PI / 2, 0]} castShadow receiveShadow />
    </group>
  );
}

/* ------------------------------ H형 데스크 ------------------------------ */

function HDesk({ item }: ModelProps) {
  const { materials, geometries, tinted } = useSceneResources();
  const [w, h, d] = item.size;
  const layout = useMemo(() => hDeskLayout(item.size), [item.size]);
  const dw = layout.deskWidth;
  const spineW = layout.spine.width;
  const spineD = layout.spine.depth;
  const g = useOwnedGeometries(
    () => ({
      top: metricBox(dw, 0.03, d),
      end: metricBox(dw - 0.04, h - 0.03, 0.03),
      modesty: metricBox(0.02, 0.42, d - 0.08),
      spineBoard: metricBox(spineW, 0.025, spineD),
      spineBack: metricBox(spineW, h - 0.06, 0.015),
      monBase: metricBox(0.2, 0.012, 0.16),
      monNeck: metricBox(0.04, 0.22, 0.03),
      monPanel: metricRoundedBox(0.56, 0.34, 0.025, 0.006, 1),
      monScreen: new THREE.PlaneGeometry(0.535, 0.315),
      keyboard: metricBox(0.42, 0.015, 0.13),
      paper: metricBox(0.22, 0.03, 0.3),
    }),
    [dw, h, d, spineW, spineD],
  );

  // 중앙 수납부의 책·파일(양면)
  const books = useMemo(() => {
    const rand = rng(item.id.length * 31 + Math.round(w * 100));
    const palette = ["#c9b28c", "#8c6e54", "#e0d6c3", "#6f7f68", "#b4835a", "#d9cdb5", "#5f6f80"].map((c) => new THREE.Color(c));
    const out: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    for (const side of [-1, 1]) {
      for (const y0 of [0.0625, 0.3875]) {
        let x = -spineW / 2 + 0.04;
        while (x < spineW / 2 - 0.08) {
          if (rand() < 0.12) {
            x += 0.12;
            continue;
          }
          const bw = 0.03 + rand() * 0.035;
          const bh = 0.17 + rand() * 0.1;
          const bd = 0.15 + rand() * 0.03;
          out.push({
            m: new THREE.Matrix4().compose(new THREE.Vector3(x + bw / 2, y0 + bh / 2, side * (0.0075 + bd / 2 + 0.01)), new THREE.Quaternion(), new THREE.Vector3(bw, bh, bd)),
            c: palette[Math.floor(rand() * palette.length)],
          });
          x += bw + 0.004;
        }
      }
    }
    return out;
  }, [item.id, w, spineW]);
  const booksRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = booksRef.current;
    if (!mesh) return;
    books.forEach((b, i) => {
      mesh.setMatrixAt(i, b.m);
      mesh.setColorAt(i, b.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [books, geometries.book, materials.books]); // 리소스 교체로 인스턴스가 다시 생기면 다시 배치

  const folder = tinted("books", "#5f8a5a");
  return (
    <group>
      {layout.desks.map((desk, i) => (
        <group key={i} position={[desk.x, 0, 0]}>
          <mesh geometry={g.top} material={materials.deskWhite} position={[0, h - 0.015, 0]} castShadow receiveShadow />
          {[-1, 1].map((s) => (
            <mesh key={s} geometry={g.end} material={materials.deskWhite} position={[0, (h - 0.03) / 2, s * (d / 2 - 0.015)]} castShadow receiveShadow />
          ))}
          <mesh geometry={g.modesty} material={materials.deskWhite} position={[desk.outer * (dw / 2 - 0.03), h - 0.03 - 0.21, 0]} castShadow receiveShadow />
          <mesh geometry={g.paper} material={materials.deskWhite} position={[desk.outer * 0.12, h + 0.015, (i === 0 ? 1 : -1) * (d / 2 - 0.25)]} castShadow />
          <mesh geometry={g.paper} material={folder} position={[desk.outer * 0.1, h + 0.045, (i === 0 ? 1 : -1) * (d / 2 - 0.27)]} rotation={[0, 0.2, 0]} castShadow />
        </group>
      ))}
      {/* 중앙 연결 수납부(H의 가로획) */}
      {[0.05, 0.375, h - 0.0125].map((y) => (
        <mesh key={y} geometry={g.spineBoard} material={materials.deskWhite} position={[0, y, 0]} castShadow receiveShadow />
      ))}
      <mesh geometry={g.spineBack} material={materials.deskWhite} position={[0, 0.03 + (h - 0.06) / 2, 0]} castShadow receiveShadow />
      <instancedMesh key={books.length} ref={booksRef} args={[geometries.book, materials.books, books.length]} castShadow receiveShadow />
      {/* 좌석별 모니터·키보드 */}
      {layout.monitors.map((m, i) => (
        <group key={i}>
          <group position={[m.x, h, m.z]} rotation={[0, deg(m.rotationY), 0]}>
            <mesh geometry={g.monBase} material={materials.blackMetal} position={[0, 0.006, 0]} castShadow />
            <mesh geometry={g.monNeck} material={materials.blackMetal} position={[0, 0.11, -0.03]} castShadow />
            <mesh geometry={g.monPanel} material={materials.plasticDark} position={[0, 0.34, 0]} castShadow receiveShadow />
            <mesh geometry={g.monScreen} material={materials.screen} position={[0, 0.34, 0.0131]} />
          </group>
          <mesh geometry={g.keyboard} material={materials.plasticDark} position={[m.keyboardX, h + 0.0075, m.z]} rotation={[0, deg(m.rotationY), 0]} castShadow />
        </group>
      ))}
    </group>
  );
}

/* ------------------------------ 벤치·수납장·탕비 ------------------------------ */

function Bench({ item }: ModelProps) {
  const { materials, tinted } = useSceneResources();
  const [l, h, d] = item.size;
  const fabric = item.variant?.color ? tinted("benchFabric", item.variant.color) : materials.benchFabric;
  const seatTop = 0.46;
  const g = useOwnedGeometries(
    () => ({
      plinth: metricBox(l - 0.06, 0.06, d - 0.08),
      base: metricRoundedBox(l, 0.3, d, 0.02, 2),
      seat: metricRoundedBox(l - 0.02, 0.1, d - 0.14, 0.04),
      back: metricRoundedBox(l - 0.02, h - seatTop + 0.06, 0.13, 0.05),
    }),
    [l, h, d],
  );
  return (
    <group>
      <mesh geometry={g.plinth} material={materials.plasticDark} position={[0, 0.03, 0]} receiveShadow />
      <mesh geometry={g.base} material={fabric} position={[0, 0.21, 0]} castShadow receiveShadow />
      <mesh geometry={g.seat} material={fabric} position={[0, seatTop - 0.05, 0.06]} castShadow receiveShadow />
      <mesh geometry={g.back} material={fabric} position={[0, seatTop + (h - seatTop + 0.06) / 2 - 0.06, -d / 2 + 0.07]} rotation={[-0.06, 0, 0]} castShadow receiveShadow />
    </group>
  );
}

function LowCabinet({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, d] = item.size;
  const doors = Math.max(2, Math.round(w / 0.6));
  const g = useOwnedGeometries(
    () => ({
      body: metricRoundedBox(w, h - 0.06, d, 0.008, 2),
      plinth: metricBox(w - 0.04, 0.06, d - 0.04),
      groove: metricBox(0.004, h - 0.12, 0.004),
      handle: metricBox(0.1, 0.01, 0.012),
    }),
    [w, h, d],
  );
  return (
    <group>
      <mesh geometry={g.plinth} material={materials.plasticDark} position={[0, 0.03, 0]} receiveShadow />
      <mesh geometry={g.body} material={materials.deskWhite} position={[0, 0.06 + (h - 0.06) / 2, 0]} castShadow receiveShadow />
      {Array.from({ length: doors - 1 }, (_, i) => (
        <mesh key={i} geometry={g.groove} material={materials.plasticDark} position={[-w / 2 + (w / doors) * (i + 1), 0.06 + (h - 0.06) / 2, d / 2 + 0.001]} />
      ))}
      {Array.from({ length: doors }, (_, i) => (
        <mesh key={i} geometry={g.handle} material={materials.stainless} position={[-w / 2 + (w / doors) * (i + 0.5), h - 0.06, d / 2 + 0.007]} />
      ))}
    </group>
  );
}

function PantryCounter({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, d] = item.size;
  const doors = Math.max(2, Math.round(w / 0.6));
  const cabH = h - 0.1 - 0.04;
  const g = useOwnedGeometries(
    () => ({
      cabinet: metricBox(w, cabH, d - 0.03),
      plinth: metricBox(w - 0.02, 0.1, d - 0.08),
      top: metricBox(w + 0.02, 0.04, d + 0.02),
      groove: metricBox(0.004, cabH - 0.04, 0.004),
      handle: metricBox(0.012, 0.12, 0.012),
      sink: metricBox(0.5, 0.012, 0.36),
      faucet: metricCylinder(0.014, 0.016, 0.24, 12),
      spout: metricBox(0.022, 0.022, 0.17),
      coffee: metricRoundedBox(0.26, 0.36, 0.34, 0.02),
      microwave: metricRoundedBox(0.48, 0.28, 0.36, 0.015),
      mwDoor: new THREE.PlaneGeometry(0.32, 0.2),
      splash: metricBox(w, 0.62, 0.01),
    }),
    [w, h, d, cabH],
  );
  return (
    <group>
      <mesh geometry={g.plinth} material={materials.plasticDark} position={[0, 0.05, -0.04]} receiveShadow />
      <mesh geometry={g.cabinet} material={materials.deskWhite} position={[0, 0.1 + cabH / 2, -0.015]} castShadow receiveShadow />
      {Array.from({ length: doors - 1 }, (_, i) => (
        <mesh key={i} geometry={g.groove} material={materials.plasticDark} position={[-w / 2 + (w / doors) * (i + 1), 0.1 + cabH / 2, d / 2 - 0.028]} />
      ))}
      {Array.from({ length: doors }, (_, i) => (
        <mesh key={i} geometry={g.handle} material={materials.stainless} position={[-w / 2 + (w / doors) * (i + 0.5) + 0.2, 0.1 + cabH - 0.12, d / 2 - 0.02]} />
      ))}
      <mesh geometry={g.top} material={materials.counterTop} position={[0, h - 0.02, 0]} castShadow receiveShadow />
      <mesh geometry={g.splash} material={materials.backsplashTile} position={[0, h + 0.31, -d / 2 + 0.005]} receiveShadow />
      {/* 싱크·수전 */}
      <mesh geometry={g.sink} material={materials.stainless} position={[0, h + 0.003, 0.03]} receiveShadow />
      <mesh geometry={g.faucet} material={materials.stainless} position={[0, h + 0.12, -d / 2 + 0.09]} castShadow />
      <mesh geometry={g.spout} material={materials.stainless} position={[0, h + 0.235, -d / 2 + 0.16]} castShadow />
      {/* 커피머신·전자레인지 */}
      <mesh geometry={g.coffee} material={materials.applianceBlack} position={[-w / 2 + 0.38, h + 0.18, -0.05]} castShadow receiveShadow />
      <mesh geometry={g.microwave} material={materials.applianceBlack} position={[w / 2 - 0.42, h + 0.14, -0.05]} castShadow receiveShadow />
      <mesh geometry={g.mwDoor} material={materials.screen} position={[w / 2 - 0.47, h + 0.14, 0.131]} />
    </group>
  );
}

/* ------------------------------ 등록 ------------------------------ */

export const OFFICE_MODELS: Record<
  "conferenceTable" | "meetingChair" | "officeChair" | "hDesk" | "roundMeetingTable" | "bench" | "lowCabinet" | "pantryCounter",
  (props: ModelProps) => React.ReactNode
> = {
  conferenceTable: ConferenceTable,
  meetingChair: (p) => <Chair {...p} kind="meetingChair" />,
  officeChair: (p) => <Chair {...p} kind="officeChair" />,
  hDesk: HDesk,
  roundMeetingTable: RoundMeetingTable,
  bench: Bench,
  lowCabinet: LowCabinet,
  pantryCounter: PantryCounter,
};
