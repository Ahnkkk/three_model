"use client";

import { availableModes, resolveDisplayMode, type DisplayMode } from "@/config/sceneTypes";
import { SENSITIVITY_RANGE } from "@/lib/three/firstPerson";
import { QUALITY_PRESETS, type QualityLevel } from "@/lib/three/quality";
import { useViewerStore, type EffectToggles, type ToneMappingKind } from "@/store/viewerStore";
import LookHint from "./LookHint";
import Minimap from "./Minimap";
import { useResolvedScene, useSceneConfig } from "./SceneConfigContext";

const EFFECTS: { key: keyof EffectToggles; label: string; hint: string; experimental?: boolean }[] = [
  { key: "lamps", label: "램프", hint: "램프 점광원 + 조명 상태별 라이트맵 교체" },
  { key: "shadows", label: "그림자", hint: "창으로 들어오는 햇빛 그림자" },
  { key: "lightmap", label: "베이크 간접광", hint: "방 표면 라이트맵(uv1)" },
  { key: "environment", label: "환경 반사", hint: "실내형 환경맵(IBL)" },
  { key: "ao", label: "AO", hint: "GTAO, 간접광에만 적용" },
  { key: "ssr", label: "SSR", hint: "화면 공간 반사", experimental: true },
];

const TONE_MAPPINGS: { id: ToneMappingKind; label: string }[] = [
  { id: "aces", label: "ACES" },
  { id: "agx", label: "AgX" },
  { id: "neutral", label: "Neutral" },
];

/** 1인칭 조작 안내(lib/three/firstPerson의 KEY_AXES·CameraControls의 마우스 처리와 같게 유지) */
const KEY_HELP: { keys: string[]; label: string }[] = [
  { keys: ["W"], label: "앞으로" },
  { keys: ["S"], label: "뒤로" },
  { keys: ["A"], label: "왼쪽으로" },
  { keys: ["D"], label: "오른쪽으로" },
  { keys: ["Shift"], label: "빠르게 이동" },
  { keys: ["Space"], label: "점프" },
  { keys: ["←", "→", "Q", "E"], label: "좌·우 보기(제자리)" },
  { keys: ["↑", "↓"], label: "위·아래 보기(제자리)" },
  { keys: ["클릭"], label: "마우스 시점 시작" },
  { keys: ["마우스"], label: "시점 따라 회전" },
  { keys: ["Esc"], label: "마우스 해제" },
  { keys: ["휠"], label: "화면 중심 확대·축소" },
];

export default function ControlPanel({ showModeSwitch = true }: { showModeSwitch?: boolean }) {
  const s = useViewerStore();
  const scene = useSceneConfig();
  const resolved = useResolvedScene();
  const views = resolved.view.camera.views;
  const modes = availableModes(scene);
  const modeSwitch = showModeSwitch && modes.length > 1;
  const keyboard = resolved.view.camera.keyboard;

  return (
    <>
      {/* 1인칭 화면: 마우스 시점 안내·확대 배율(시점 버튼 위) */}
      {keyboard && <LookHint />}

      {/* 대표 시점(장면·표시 모드별). 좁은 화면에서 여러 줄로 접혀 3D 화면을 가리지 않도록 한 줄로 두고 넘치면 가로로 넘긴다. */}
      <div className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-nowrap gap-1 overflow-x-auto rounded-3xl border border-white/10 bg-stone-900/75 p-1 shadow-lg backdrop-blur [scrollbar-width:none]">
        {views.map((v) => (
          <button
            key={v.id}
            onClick={() => s.goToView(v.id)}
            className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition-colors ${
              s.activeView === v.id ? "bg-stone-100 text-stone-900" : "text-stone-200 hover:bg-white/10"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* 우측 상단: 미니맵(실내 화면) → 처음으로·렌더링 설정 */}
      <div className="pointer-events-none absolute bottom-16 right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2">
        {resolved.view.minimap && (
          <div className="shrink-0">
            <Minimap />
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {/* 현재 화면에 처음 들어왔을 때의 시점·장소(기본 시점)로 돌아간다. */}
          <button
            onClick={() => s.goToView(resolved.view.camera.defaultView)}
            title="처음 시점과 장소로 이동"
            className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-stone-900/80 px-3 py-1.5 text-sm shadow-lg backdrop-blur hover:bg-stone-800/90"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
              <path d="M2 7.5 8 2.5l6 5M3.8 6.2V13.5h3V10h2.4v3.5h3V6.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>처음으로</span>
          </button>
          <button
            onClick={() => s.setPanelOpen(!s.panelOpen)}
            className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/10 bg-stone-900/80 px-3 py-1.5 text-sm shadow-lg backdrop-blur hover:bg-stone-800/90"
          >
            <span>렌더링 설정</span>
            <span className="text-stone-400">{s.panelOpen ? "▲" : "▼"}</span>
          </button>
        </div>

        {s.panelOpen && (
          <div className="pointer-events-auto min-h-0 w-[min(18rem,calc(100vw-2rem))] space-y-4 overflow-y-auto rounded-xl border border-white/10 bg-stone-900/85 p-4 text-sm shadow-2xl backdrop-blur">
            {keyboard && (
              <Section title="키보드·마우스 조작">
                <ul className="space-y-1 text-xs">
                  {KEY_HELP.map((k) => (
                    <li key={k.label} className="flex items-center justify-between gap-3">
                      <span className="flex flex-wrap gap-1">
                        {k.keys.map((key) => (
                          <kbd key={key} className="min-w-5 rounded border border-white/15 bg-stone-800 px-1 text-center font-sans text-[11px] text-stone-200">
                            {key}
                          </kbd>
                        ))}
                      </span>
                      <span className="text-stone-300">{k.label}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2">
                  <Slider
                    label="마우스 감도"
                    value={s.mouseSensitivity}
                    min={SENSITIVITY_RANGE[0]}
                    max={SENSITIVITY_RANGE[1]}
                    step={0.1}
                    onChange={s.setMouseSensitivity}
                  />
                </div>
              </Section>
            )}

            {(modeSwitch || (modes.length > 1 && resolved.view.annotations)) && (
              <Section title={modeSwitch ? "표시 모드" : "표시"}>
                {modeSwitch && (
                  <Segmented
                    value={s.displayMode}
                    options={modes.map((m) => ({ id: m, label: resolveDisplayMode(scene, m).label }))}
                    onChange={(m) => s.setDisplayMode(scene, m as DisplayMode)}
                  />
                )}
                {resolved.view.annotations && (
                  <div className={`flex items-center justify-between gap-3 ${modeSwitch ? "mt-2" : ""}`}>
                    <span>설명 표식</span>
                    <Toggle label="설명 표식" checked={s.annotations} onChange={s.setAnnotations} />
                  </div>
                )}
              </Section>
            )}

            <Section title="품질">
              <Segmented
                value={s.quality}
                options={(Object.keys(QUALITY_PRESETS) as QualityLevel[]).map((q) => ({ id: q, label: QUALITY_PRESETS[q].label }))}
                onChange={(q) => s.setQuality(q as QualityLevel)}
              />
            </Section>

            <Section title="효과 비교">
              <ul className="space-y-1.5">
                {EFFECTS.map((e) => (
                  <li key={e.key} className="flex items-center justify-between gap-3">
                    <span>
                      {e.label}
                      {e.experimental && <span className="ml-1.5 rounded bg-amber-400/20 px-1 text-[10px] text-amber-300">실험</span>}
                      <span className="block text-[11px] leading-tight text-stone-400">{e.hint}</span>
                    </span>
                    <Toggle label={e.label} checked={s.effects[e.key]} onChange={(v) => s.toggleEffect(e.key, v)} />
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="노출·톤 매핑">
              <Slider label="노출" value={s.exposure} min={0.3} max={2.5} step={0.05} onChange={s.setExposure} />
              <div className="mt-2">
                <Segmented value={s.toneMapping} options={TONE_MAPPINGS} onChange={(v) => s.setToneMapping(v as ToneMappingKind)} />
              </div>
            </Section>

            <Section title="간접광 강도">
              <Slider label="환경광" value={s.environmentIntensity} min={0} max={2} step={0.05} onChange={s.setEnvironmentIntensity} />
              <Slider label="라이트맵" value={s.lightmapIntensity} min={0} max={2.5} step={0.05} onChange={s.setLightmapIntensity} />
            </Section>
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-amber-400" : "bg-stone-600"}`}
    >
      <span className={`absolute left-0 top-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`} />
    </button>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: { id: string; label: string }[]; onChange: (id: string) => void }) {
  return (
    <div className="flex rounded-lg bg-stone-800 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${value === o.id ? "bg-stone-100 text-stone-900" : "text-stone-300 hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="mt-1 block">
      <span className="flex justify-between text-xs text-stone-300">
        <span>{label}</span>
        <span className="tabular-nums text-stone-400">{value.toFixed(2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-amber-400" />
    </label>
  );
}
