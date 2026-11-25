"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  builtinAOContext,
  float,
  metalness,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  roughness,
  sample,
  screenUV,
  unpackRGBToNormal,
  vec2,
  vec4,
} from "three/tsl";
import { ao as gtao } from "three/addons/tsl/display/GTAONode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { QUALITY_PRESETS } from "@/lib/three/quality";
import { useViewerStore, type ToneMappingKind } from "@/store/viewerStore";

/**
 * 렌더 루프 + TSL 후처리 + 성능 통계.
 *
 * - AO(GTAO): 노멀·깊이 사전 패스로 계산하고 builtinAOContext로 "간접광에만" 적용한다
 *   (직접광·베이크된 음영과의 과도한 중복을 줄인다).
 * - SSR(실험): 화면에 보이는 정보만 반사한다. 광선이 화면 밖으로 나가면 반사가 없고, 장면 색에 이미 포함된
 *   환경맵 반사가 그대로 남아 대체 반사 역할을 한다. 환경 반사 위에 가산되므로 약간의 중복이 있다.
 * - 효과가 모두 꺼져 있으면 후처리 없이 renderer.render()로 그린다(기본 품질 경로).
 * - 후처리 구성에 실패하면 경고를 표시하고 기본 경로로 돌아간다.
 */

const TONE_MAPPING: Record<ToneMappingKind, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

interface PipelineHandle {
  pipeline: THREE.RenderPipeline;
  dispose: () => void;
}

export default function Effects() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const renderer = gl as unknown as THREE.WebGPURenderer;

  const aoOn = useViewerStore((s) => s.effects.ao);
  const ssrOn = useViewerStore((s) => s.effects.ssr);
  const quality = useViewerStore((s) => s.quality);
  const toneMapping = useViewerStore((s) => s.toneMapping);
  const exposure = useViewerStore((s) => s.exposure);
  const addWarning = useViewerStore((s) => s.addWarning);
  const toggleEffect = useViewerStore((s) => s.toggleEffect);
  const setStats = useViewerStore((s) => s.setStats);

  const pipelineRef = useRef<PipelineHandle | null>(null);

  // 노출·톤 매핑
  useEffect(() => {
    renderer.toneMapping = TONE_MAPPING[toneMapping];
    renderer.toneMappingExposure = exposure;
    if (pipelineRef.current) pipelineRef.current.pipeline.needsUpdate = true;
  }, [renderer, toneMapping, exposure]);

  // 통계는 프레임 단위로 직접 초기화한다(후처리 시 렌더 호출이 여러 번이므로).
  useEffect(() => {
    renderer.info.autoReset = false;
    return () => {
      renderer.info.autoReset = true;
    };
  }, [renderer]);

  // 후처리 파이프라인 구성
  useEffect(() => {
    if (!aoOn && !ssrOn) {
      pipelineRef.current = null;
      return;
    }
    const preset = QUALITY_PRESETS[quality];
    const disposables: { dispose: () => void }[] = [];
    try {
      const pipeline = new THREE.RenderPipeline(renderer);
      const scenePass = pass(scene, camera);
      disposables.push(scenePass);
      const sceneColor = scenePass.getTextureNode("output");
      let outputNode: THREE.Node = scenePass;

      if (ssrOn) {
        scenePass.setMRT(
          mrt({
            output,
            normal: packNormalToRGB(normalView),
            metalrough: vec2(metalness, roughness),
          }),
        );
        const normalTex = scenePass.getTextureNode("normal");
        const metalRough = scenePass.getTextureNode("metalrough");
        const sceneNormal = sample((uv) => unpackRGBToNormal(normalTex.sample(uv)));
        const ssrNode = ssr(sceneColor, scenePass.getTextureNode("depth"), sceneNormal, {
          metalnessNode: metalRough.r,
          roughnessNode: metalRough.g,
          reflectNonMetals: true,
          camera,
        });
        ssrNode.resolutionScale = preset.ssrResolutionScale;
        ssrNode.maxDistance.value = 2.5;
        ssrNode.thickness.value = 0.03;
        disposables.push(ssrNode);
        // SSR 출력: rgb = 감쇠·프레넬이 적용된 반사색, a = 반사 거리(불투명도 아님).
        // 금속도·거칠기로 반사율을 근사해 가산 합성한다. 거친 표면(벽 등)은 거의 반사하지 않는다.
        const reflectance = mix(float(0.2), float(1), metalRough.r).mul(metalRough.g.oneMinus().pow(2));
        outputNode = vec4(sceneColor.rgb.add(ssrNode.getTextureNode().rgb.mul(reflectance)), sceneColor.a);
      }

      if (aoOn) {
        const prePass = pass(scene, camera, { samples: 0 });
        prePass.setMRT(mrt({ output: normalView }));
        const aoNode = gtao(prePass.getTextureNode("depth"), prePass.getTextureNode(), camera);
        aoNode.resolutionScale = preset.aoResolutionScale;
        aoNode.samples.value = preset.aoSamples;
        aoNode.radius.value = 0.4;
        aoNode.distanceExponent.value = 1.2;
        scenePass.contextNode = builtinAOContext(aoNode.getTextureNode().sample(screenUV).r);
        disposables.push(prePass, aoNode);
      }

      pipeline.outputNode = outputNode;
      pipelineRef.current = {
        pipeline,
        dispose: () => {
          disposables.forEach((d) => d.dispose());
          pipeline.dispose();
        },
      };
    } catch (error) {
      console.error(error);
      disposables.forEach((d) => d.dispose());
      pipelineRef.current = null;
      addWarning("후처리(AO/SSR) 구성에 실패해 기본 렌더링으로 전환했습니다.");
      toggleEffect("ao", false);
      toggleEffect("ssr", false);
    }
    return () => {
      pipelineRef.current?.dispose();
      pipelineRef.current = null;
    };
  }, [renderer, scene, camera, aoOn, ssrOn, quality, addWarning, toggleEffect]);

  // 렌더 루프(priority > 0 이면 R3F 기본 렌더를 대체한다)
  const acc = useRef({ frames: 0, time: 0 });
  useFrame((_, delta) => {
    renderer.info.reset();
    const handle = pipelineRef.current;
    if (handle) handle.pipeline.render();
    else renderer.render(scene, camera);

    const a = acc.current;
    a.frames += 1;
    a.time += delta;
    if (a.time >= 0.5) {
      const info = renderer.info;
      setStats({
        fps: Math.round(a.frames / a.time),
        frameMs: Math.round((a.time / a.frames) * 1000 * 10) / 10,
        drawCalls: info.render.drawCalls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      });
      a.frames = 0;
      a.time = 0;
    }
  }, 1);

  return null;
}
