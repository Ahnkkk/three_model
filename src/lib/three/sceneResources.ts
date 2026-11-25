import * as THREE from "three/webgpu";
import { MATERIALS, type MaterialDef, type MaterialId, type RoomSurfaceId } from "@/config/materials";
import { bakeVariantsOf, sceneKey, type BakeVariant, type SceneConfig } from "@/config/sceneTypes";
import { createEnvironmentMaps, type EnvironmentMaps } from "./environment";
import { BakeCancelledError, bakeLightmapsAsync, type BakeControl, type LightmapSet } from "./lightmapBaker";
import { generateArtwork, generateSkyTexture, generateTexture } from "./proceduralTextures";

/**
 * 장면 공유 리소스(재질·텍스처·라이트맵·환경맵)의 소유자.
 * 장면이 마운트될 때 한 번 생성하고, 언마운트 시 dispose()로 함께 해제한다.
 * 개별 컴포넌트는 공유 리소스를 직접 dispose 하지 않는다.
 * 장면마다 별도로 생성하므로 거실과 사무실이 재질·텍스처를 공유하지 않는다(사무실 색이 거실 재질을 덮어쓰지 않음).
 */
export interface SceneResources {
  /** 리소스를 만든 장면의 sceneKey(id + revision) */
  sceneKey: string;
  /** 재질 라이브러리. scene.preloadMaterials는 미리 만들고, 나머지는 처음 접근할 때 만든다. */
  materials: Record<MaterialId, THREE.MeshStandardNodeMaterial>;
  /** 라이트맵이 개별 연결되는 방 표면 재질 */
  surfaceMaterials: Record<RoomSurfaceId, THREE.MeshStandardNodeMaterial>;
  /** 바닥 마감이 다른 영역의 재질(바닥 라이트맵을 함께 사용) */
  floorOverlays: Record<string, THREE.MeshStandardNodeMaterial>;
  /** 표시 모드의 베이크 변형과 램프 상태에 맞는 라이트맵 */
  lightmapFor: (variant: BakeVariant, lampsOn: boolean) => LightmapSet;
  environment: EnvironmentMaps;
  sky: THREE.Texture;
  /** 가구 id → 액자 그림 */
  artworks: Record<string, THREE.Texture>;
  /** 여러 모델이 재활용하는 공유 지오메트리(인스턴싱용 단위 형상) */
  geometries: { leaf: THREE.BufferGeometry; book: THREE.BufferGeometry };
  /** 변형 색상 재질 캐시(원본 재질 + 색상 → 복제본) */
  tinted: (id: MaterialId, color: string) => THREE.MeshStandardNodeMaterial;
  dispose: () => void;
}

export type BuildProgress = (message: string, ratio: number) => void;

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

function createMaterial(def: MaterialDef, textures: THREE.Texture[]): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    color: def.color,
    roughness: def.roughness,
    metalness: def.metalness,
  });
  if (def.texture) {
    const maps = generateTexture(def.texture.kind, def.texture.seed ?? 1);
    const repeat = def.texture.metersPerTile > 0 ? 1 / def.texture.metersPerTile : 1;
    for (const t of [maps.map, maps.roughnessMap]) {
      t.repeat.set(repeat, repeat);
      textures.push(t);
    }
    m.map = maps.map;
    m.roughnessMap = maps.roughnessMap;
  }
  if (def.emissive) {
    m.emissive.set(def.emissive);
    m.emissiveIntensity = def.emissiveIntensity ?? 1;
  }
  if (def.doubleSided) m.side = THREE.DoubleSide;
  if (def.transparent) {
    m.transparent = true;
    m.opacity = def.opacity ?? 1;
    m.depthWrite = false;
  }
  return m;
}

/**
 * control을 주면 라이트맵을 시간 조각으로 나눠 굽고(bakeLightmapsAsync), 취소되면 만든 리소스를 해제한 뒤
 * BakeCancelledError를 던진다(편집 중 품질 갱신이 새 편집으로 대체될 때).
 */
export async function buildSceneResources(
  renderer: THREE.WebGPURenderer,
  scene: SceneConfig,
  onProgress: BuildProgress,
  control: BakeControl = { isCancelled: () => false },
): Promise<SceneResources> {
  const textures: THREE.Texture[] = [];
  const extraMaterials: THREE.Material[] = [];
  const created = new Map<MaterialId, THREE.MeshStandardNodeMaterial>();
  try {
    return await build();
  } catch (e) {
    created.forEach((m) => m.dispose());
    extraMaterials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    throw e;
  }

  async function build(): Promise<SceneResources> {
    // 1) 재질·텍스처(장면이 쓰는 재질은 미리, 나머지는 지연 생성)
    const getMaterial = (id: MaterialId) => {
      let m = created.get(id);
      if (!m) {
        m = createMaterial(MATERIALS[id] as MaterialDef, textures);
        m.name = id;
        created.set(id, m);
      }
      return m;
    };
    const materials = {} as Record<MaterialId, THREE.MeshStandardNodeMaterial>;
    for (const id of Object.keys(MATERIALS) as MaterialId[]) {
      Object.defineProperty(materials, id, { enumerable: true, get: () => getMaterial(id) });
    }
    const preload = scene.preloadMaterials;
    for (let i = 0; i < preload.length; i++) {
      onProgress(`재질 생성: ${preload[i]}`, (i / preload.length) * 0.55);
      getMaterial(preload[i]);
      await nextFrame(); // UI 응답성 유지
      if (control.isCancelled()) throw new BakeCancelledError();
    }

    // 2) 라이트맵(간이 베이크) — 표시 모드별 변형(closed/open)과 램프 켜짐/꺼짐을 미리 준비한다.
    const variants = bakeVariantsOf(scene);
    const lightmaps = new Map<string, LightmapSet>();
    for (const { variant, sun } of variants) {
      onProgress(`간접광 라이트맵 베이크(${variant === "open" ? "조감도" : "실내"})`, 0.6);
      await nextFrame();
      // 완성된 세트는 바로 textures에 넣어 취소·오류 시 함께 해제한다.
      const bake = async (key: string, lampsOn: boolean) => {
        const set = await bakeLightmapsAsync(scene, { variant, lampsOn, sun }, control);
        textures.push(...Object.values(set));
        lightmaps.set(key, set);
      };
      if (variant === "closed") {
        await bake("closed:on", true);
        await bake("closed:off", false);
      } else {
        await bake("open", false);
      }
    }
    const firstSet = lightmaps.values().next().value!;
    const lightmapFor = (variant: BakeVariant, lampsOn: boolean) =>
      lightmaps.get(variant === "open" ? "open" : lampsOn ? "closed:on" : "closed:off") ?? firstSet;

    // 3) 방 표면 재질(라이트맵 연결 정보: 표면 id → 재질 + 텍스처 + uv1 채널 + 강도)
    const surfaceMaterials = {} as Record<RoomSurfaceId, THREE.MeshStandardNodeMaterial>;
    for (const [surface, base] of Object.entries(scene.surfaceMaterials) as [RoomSurfaceId, MaterialId][]) {
      const m = materials[base].clone();
      m.name = `surface:${surface}`;
      m.lightMap = firstSet[surface];
      m.lightMapIntensity = 1;
      surfaceMaterials[surface] = m;
      extraMaterials.push(m);
    }

    const floorOverlays: Record<string, THREE.MeshStandardNodeMaterial> = {};
    for (const zone of scene.floorZones) {
      const m = materials[zone.material].clone();
      m.name = `floor-zone:${zone.id}`;
      // 바닥 바로 위에 겹쳐 그리므로 깊이 충돌(z-fighting)을 막는다.
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -2;
      m.lightMap = firstSet.floor;
      m.lightMapIntensity = 1;
      floorOverlays[zone.id] = m;
      extraMaterials.push(m);
    }

    // 4) 환경 반사
    onProgress("환경 반사 생성", 0.8);
    await nextFrame();
    if (control.isCancelled()) throw new BakeCancelledError();
    const environment = createEnvironmentMaps(
      renderer,
      scene,
      variants.map((v) => v.variant),
    );
    if (control.isCancelled()) {
      environment.dispose();
      throw new BakeCancelledError();
    }

    // 5) 기타 텍스처
    onProgress("소품 텍스처 생성", 0.9);
    const sky = generateSkyTexture();
    textures.push(sky);
    const artworks: Record<string, THREE.Texture> = {};
    for (const item of scene.furniture.filter((f) => f.kind === "wallArt")) {
      const t = generateArtwork(item.variant?.seed ?? 1);
      artworks[item.id] = t;
      textures.push(t);
    }

    const tintCache = new Map<string, THREE.MeshStandardNodeMaterial>();
    const tinted = (id: MaterialId, color: string) => {
      const key = `${id}:${color}`;
      let m = tintCache.get(key);
      if (!m) {
        m = materials[id].clone();
        m.color.set(color);
        tintCache.set(key, m);
        extraMaterials.push(m);
      }
      return m;
    };

    const geometries = {
      leaf: new THREE.SphereGeometry(1, 10, 6), // 납작하게 스케일해 잎으로 사용
      book: new THREE.BoxGeometry(1, 1, 1),
    };

    onProgress("리소스 준비 완료", 1);

    return {
      sceneKey: sceneKey(scene),
      materials,
      surfaceMaterials,
      floorOverlays,
      lightmapFor,
      environment,
      sky,
      artworks,
      geometries,
      tinted,
      dispose: () => {
        Object.values(geometries).forEach((g) => g.dispose());
        created.forEach((m) => m.dispose());
        extraMaterials.forEach((m) => m.dispose());
        textures.forEach((t) => t.dispose());
        environment.dispose();
      },
    };
  }
}
