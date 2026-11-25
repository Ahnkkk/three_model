"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import officeExample from "../../../examples/floor-plans/office.json";
import studioExample from "../../../examples/floor-plans/small-studio.json";
import { sceneKey, type SceneConfig } from "@/config/sceneTypes";
import { applyCalibration, checkImageFile, computeCalibration, imageMatchesSource, type CalibrationInput, type ImageInfo } from "@/lib/floorPlan/calibration";
import {
  createBlankDocument,
  deleteFurniture,
  deleteOpening,
  deleteWall,
  documentForExport,
  editorReducer,
  exportFileName,
  initEditor,
  toDocumentId,
} from "@/lib/floorPlan/editor";
import type { FloorPlanDocument } from "@/lib/floorPlan/schema";
import { floorPlanToScene } from "@/lib/floorPlan/toScene";
import { parseFloorPlanJson, validateFloorPlan } from "@/lib/floorPlan/validate";
import ViewerClient from "@/components/viewer/ViewerClient";
import AiExtractPanel, { type AiOverlay } from "./AiExtractPanel";
import CalibrationCanvas, { CALIBRATION_COLORS, EMPTY_DRAFT, type CalibrationDraft, type CalibrationTool } from "./CalibrationCanvas";
import { BUTTON, BUTTON_PRIMARY } from "./common";
import Inspector, { selectionPath } from "./Inspector";
import PlanEditorCanvas, { type EditorTool, type Selection } from "./PlanEditorCanvas";

/**
 * 도면 편집 화면(단기 계획 S3): AI 없이 이미지·수동 입력으로 도면 문서를 만들고 3D로 확인한다.
 *  1) 이미지 열기 → 평면도 영역·기준 구간(실제 길이)·외곽(실내 마감면) 지정 → 보정 적용(새 문서)
 *  2) 원본 위에 벽·문·창·통로를 그리고 치수를 고친다(실행 취소·다시 실행)
 *  3) 문서 검증을 통과한 변경만 3D에 반영한다. 형상은 바로, 조명(라이트맵·환경맵)은 편집이 멈춘 뒤 다시 굽는다.
 *  4) JSON으로 저장하고 다시 연다. 원본 이미지는 문서에 넣지 않으므로 다시 연결한다(크기 확인).
 *  5) (S4) 보정한 이미지를 서버 경계로 보내 AI 초안을 받고, 현재 문서와의 차이에서 고른 항목만 적용한다.
 *     AI 없이도 1)~4)로 같은 결과를 만들 수 있다.
 */

interface ImageState {
  url: string;
  info: ImageInfo;
  /** attached = 현재 문서의 원본(보정 적용됨), new = 아직 보정하지 않은 새 이미지 */
  mode: "attached" | "new";
}

type Stage = "calibrate" | "edit";

const EXAMPLES: { name: string; data: unknown }[] = [
  { name: "소형 원룸", data: studioExample },
  { name: "사무실", data: officeExample },
];

const TOOLS: { id: EditorTool; label: string; key: string }[] = [
  { id: "select", label: "선택·이동", key: "V" },
  { id: "wall-solid", label: "벽", key: "W" },
  { id: "wall-glass", label: "유리 벽", key: "G" },
  { id: "door", label: "문", key: "D" },
  { id: "window", label: "창", key: "N" },
  { id: "passage", label: "통로", key: "P" },
];

const CAL_TOOLS: { id: CalibrationTool; label: string }[] = [
  { id: "crop", label: "① 평면도 영역(선택)" },
  { id: "ref1", label: "② 기준 구간 1" },
  { id: "ref2", label: "③ 기준 구간 2(다른 방향)" },
  { id: "envelope", label: "④ 외곽(실내 마감면)" },
];

/** 조명 품질 갱신까지 기다리는 시간(마지막 편집 후, ms) */
const QUALITY_DELAY = 1500;

export default function EditorScreen() {
  const [state, dispatch] = useReducer(editorReducer, null, () =>
    initEditor(createBlankDocument({ id: "new-plan", title: "새 도면", width: 6, depth: 4.5 })),
  );
  const doc = state.doc;
  /** 새 문서를 열 때마다 증가 → 3D 장면 키가 바뀌어 상태·리소스를 새로 준비 */
  const [session, setSession] = useState(1);
  const [stage, setStage] = useState<Stage>("edit");
  const [tool, setTool] = useState<EditorTool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [image, setImage] = useState<ImageState | null>(null);
  const [opacity, setOpacity] = useState(0.55);
  const [draft, setDraft] = useState<CalibrationDraft>(EMPTY_DRAFT);
  const [calTool, setCalTool] = useState<CalibrationTool>("ref1");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiOverlay, setAiOverlay] = useState<AiOverlay | null>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  const say = useCallback((text: string, tone: "info" | "error" = "info") => setMessage({ text, tone }), []);
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  // 이미지 URL 해제(다른 이미지로 바뀌거나 화면을 떠날 때)
  const imageUrl = image?.url;
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  const apply = useCallback((update: (d: FloorPlanDocument) => FloorPlanDocument, select?: Selection) => {
    dispatch({ type: "apply", update });
    if (select !== undefined) setSelection(select);
  }, []);

  const loadDocument = useCallback((next: FloorPlanDocument) => {
    dispatch({ type: "load", doc: next });
    setSession((s) => s + 1);
    setSelection(null);
    setAiOpen(false);
    setTool("select");
  }, []);

  const confirmDiscard = () => !state.dirty || window.confirm("저장하지 않은 편집이 있습니다. 현재 도면을 닫을까요?");

  /* ------------------------------ 검증·3D ------------------------------ */

  const validation = useMemo(() => validateFloorPlan(doc), [doc]);
  const liveScene = useMemo<SceneConfig | null>(
    () => (validation.ok && validation.document ? { ...floorPlanToScene(validation.document), revision: session } : null),
    [validation, session],
  );
  // 오류가 있는 동안에는 같은 문서의 마지막 통과 장면을 유지한다.
  const [lastScene, setLastScene] = useState<SceneConfig | null>(null);
  useEffect(() => {
    if (liveScene) setLastScene(liveScene);
  }, [liveScene]);
  const scene = liveScene ?? (lastScene?.revision === session ? lastScene : null);

  // 조명 품질 갱신: 편집이 멈추고 QUALITY_DELAY가 지나면(또는 버튼) 현재 장면으로 다시 굽는다.
  const [resourceScene, setResourceScene] = useState<SceneConfig | null>(null);
  useEffect(() => {
    if (!scene) return;
    const id = window.setTimeout(() => setResourceScene(scene), QUALITY_DELAY);
    return () => window.clearTimeout(id);
  }, [scene]);
  const effectiveResourceScene = scene && resourceScene && sceneKey(resourceScene) === sceneKey(scene) ? resourceScene : scene;
  const lightingStale = !!scene && effectiveResourceScene !== scene;

  const flagged = useMemo(() => {
    const map = new Map<string, "error" | "unconfirmed">();
    const keyOf = (path: string) => {
      const m = path.match(/^\/(walls|openings|furniture)\/(\d+)/);
      if (!m) return null;
      const i = Number(m[2]);
      const id = m[1] === "walls" ? doc.walls[i]?.id : m[1] === "openings" ? doc.openings[i]?.id : doc.furniture?.[i]?.id;
      return id ? `${m[1] === "walls" ? "wall" : m[1] === "openings" ? "opening" : "furniture"}:${id}` : null;
    };
    for (const p of doc.provenance ?? []) {
      const k = !p.confirmed && keyOf(p.path);
      if (k) map.set(k, "unconfirmed");
    }
    for (const i of validation.issues) {
      const k = i.severity === "error" && keyOf(i.path);
      if (k) map.set(k, "error");
    }
    return map;
  }, [doc, validation]);

  /* ------------------------------ 파일 ------------------------------ */

  const openJson = async (file: File) => {
    const result = parseFloorPlanJson(await file.text());
    if (!result.document) {
      const first = result.issues.slice(0, 3).map((i) => `${i.message} (${i.path || "/"})`).join(" · ");
      say(`${file.name}: 형식 오류 ${result.issues.length}개로 열지 않았습니다. ${first}`, "error");
      return;
    }
    if (!confirmDiscard()) return;
    loadDocument(result.document);
    setImage(null);
    setDraft(EMPTY_DRAFT);
    setStage("edit");
    const errors = result.issues.filter((i) => i.severity === "error").length;
    say(
      `${file.name}을 열었습니다.${errors ? ` 문서 오류 ${errors}개 — 고칠 때까지 3D를 만들지 않습니다.` : ""}${result.document.source?.kind === "image" ? " 원본 이미지는 '이미지 열기'로 다시 연결하세요." : ""}`,
      errors ? "error" : "info",
    );
  };

  const openImage = async (file: File) => {
    const fileError = checkImageFile(file);
    if (fileError) return say(fileError, "error");
    const url = URL.createObjectURL(file);
    const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
    if (!size) {
      URL.revokeObjectURL(url);
      return say("이미지를 읽지 못했습니다.", "error");
    }
    const pixelError = checkImageFile(file, size);
    if (pixelError) {
      URL.revokeObjectURL(url);
      return say(pixelError, "error");
    }
    const info: ImageInfo = { name: file.name, mimeType: file.type as ImageInfo["mimeType"], ...size };
    // 현재 문서가 같은 크기의 원본 이미지로 보정되어 있으면 다시 연결한다.
    if (doc.source?.kind === "image" && doc.calibration && imageMatchesSource(doc, size)) {
      setImage({ url, info, mode: "attached" });
      setDraft(draftFromDocument(doc));
      setStage("edit");
      say(`원본 이미지(${size.width}×${size.height})를 다시 연결했습니다.`);
      return;
    }
    if (doc.source?.kind === "image" && doc.source.image) {
      say(`문서 원본(${doc.source.image.width}×${doc.source.image.height})과 크기가 달라 새 이미지로 보정합니다.`, "error");
    }
    setImage({ url, info, mode: "new" });
    setDraft(EMPTY_DRAFT);
    setCalTool("crop");
    setStage("calibrate");
  };

  const exportJson = () => {
    const out = documentForExport(doc, state.dirty);
    const blob = new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportFileName(out);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    dispatch({ type: "saved", doc: out });
    say(`${a.download}로 저장했습니다${validation.ok ? "" : "(문서 오류 포함)"}.`);
  };

  /* ------------------------------ 보정 ------------------------------ */

  const calibrationInput = (): CalibrationInput | null => {
    if (!image) return null;
    const references = draft.refs.flatMap((r, i) => {
      const length = Number(draft.lengths[i]);
      return r && Number.isFinite(length) && length > 0 ? [{ label: `기준 ${i + 1}`, a: r.a, b: r.b, length }] : [];
    });
    return { image: image.info, crop: draft.crop, references, envelope: draft.envelope ?? { x: 0, y: 0, width: 0, height: 0 } };
  };
  const preview = (() => {
    const input = calibrationInput();
    return input ? computeCalibration(input) : null;
  })();

  const applyCal = () => {
    const input = calibrationInput();
    if (!input || !image) return;
    if (image.mode === "attached") {
      const res = applyCalibration(doc, input, doc.id);
      if ("error" in res) return say(res.error, "error");
      apply(() => res);
    } else {
      if (!confirmDiscard()) return;
      const res = applyCalibration(null, input, toDocumentId(image.info.name ?? "plan"));
      if ("error" in res) return say(res.error, "error");
      loadDocument(res);
      setImage({ ...image, mode: "attached" });
    }
    setStage("edit");
    setTool("wall-solid");
    say("보정을 적용했습니다. 원본 위에 벽을 그리세요(클릭 → 클릭, 더블클릭·Esc로 끝).");
  };

  /* ------------------------------ 키보드 ------------------------------ */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (t?.closest("canvas")) return; // 3D 보행 조작 키와 겹치지 않게
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (mod || stage !== "edit") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        const id = selection.id;
        if (selection.kind === "wall") apply((d) => deleteWall(d, id), null);
        else if (selection.kind === "opening") apply((d) => deleteOpening(d, id), null);
        else apply((d) => deleteFurniture(d, id), null);
        return;
      }
      const hit = TOOLS.find((x) => x.key === e.key.toUpperCase());
      if (hit) setTool(hit.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, stage, apply]);

  // 실행 취소 등으로 선택 항목이 사라지면 선택을 푼다.
  useEffect(() => {
    if (selection && !selectionPath(doc, selection)) setSelection(null);
  }, [doc, selection]);

  const underlay =
    image?.mode === "attached" && doc.calibration
      ? { url: image.url, width: image.info.width, height: image.info.height, matrix: doc.calibration.pixelToPlan, opacity }
      : undefined;
  const needsImage = doc.source?.kind === "image" && image?.mode !== "attached";
  const errorCount = validation.issues.filter((i) => i.severity === "error").length;

  return (
    <div className="flex min-h-dvh flex-col gap-2 bg-slate-100 p-2 text-slate-900 lg:h-dvh">
      {/* 머리글: 파일·기록 */}
      <header className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm">
        <h1 className="mr-2 text-base font-bold text-[#14305c]">도면 편집</h1>
        <span className="max-w-56 truncate text-xs text-slate-500" title={`${doc.title ?? doc.id} · ${doc.id} r${doc.revision}`}>
          {doc.title ?? doc.id} · r{doc.revision}
          {state.dirty ? " · 수정됨" : ""}
        </span>
        <div className="relative">
          <button type="button" className={BUTTON} onClick={() => setNewOpen((v) => !v)}>
            새 도면
          </button>
          {newOpen && (
            <NewDocumentForm
              onCancel={() => setNewOpen(false)}
              onCreate={(width, depth) => {
                setNewOpen(false);
                if (!confirmDiscard()) return;
                loadDocument(createBlankDocument({ id: `plan-${Date.now().toString(36)}`, title: "새 도면", width, depth }));
                setImage(null);
                setStage("edit");
                setTool("wall-solid");
              }}
            />
          )}
        </div>
        <select
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
          value=""
          aria-label="예제 열기"
          onChange={(e) => {
            const ex = EXAMPLES[Number(e.target.value)];
            const r = ex && validateFloorPlan(ex.data);
            if (r?.document && confirmDiscard()) {
              loadDocument(r.document);
              setImage(null);
              setStage("edit");
            }
          }}
        >
          <option value="">예제 열기…</option>
          {EXAMPLES.map((ex, i) => (
            <option key={ex.name} value={i}>
              {ex.name}
            </option>
          ))}
        </select>
        <button type="button" className={BUTTON} onClick={() => jsonRef.current?.click()}>
          JSON 열기
        </button>
        <button type="button" className={needsImage ? BUTTON_PRIMARY : BUTTON} onClick={() => imageRef.current?.click()}>
          {needsImage ? "원본 이미지 다시 연결" : "이미지 열기"}
        </button>
        <button type="button" className={BUTTON_PRIMARY} onClick={exportJson}>
          JSON 저장
        </button>
        <span className="mx-1 h-5 w-px bg-slate-200" />
        <button type="button" className={BUTTON} disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })} title="Ctrl+Z">
          실행 취소
        </button>
        <button type="button" className={BUTTON} disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })} title="Ctrl+Shift+Z / Ctrl+Y">
          다시 실행
        </button>
        <nav className="ml-auto flex gap-2">
          <Link href="/plans" className={BUTTON}>
            도면 문서
          </Link>
          <Link href="/office" className={BUTTON}>
            사무실
          </Link>
        </nav>
        <input ref={jsonRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => pick(e, openJson)} />
        <input ref={imageRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => pick(e, openImage)} />
      </header>

      {message && (
        <div role="status" className={`rounded-lg px-3 py-1.5 text-xs ${message.tone === "error" ? "bg-red-50 text-red-800" : "bg-sky-50 text-sky-900"}`}>
          {message.text}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1.35fr)_17rem_minmax(0,1fr)]">
        {/* 2D: 보정 / 구조 편집 */}
        <section className="relative flex min-h-[60vh] flex-col gap-2 rounded-xl border border-slate-300 bg-white p-2 shadow-sm lg:min-h-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="tablist" aria-label="단계" className="flex rounded-lg border border-slate-300 bg-slate-100 p-0.5">
              {(
                [
                  ["calibrate", "1 이미지 보정"],
                  ["edit", "2 구조 편집"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={stage === id}
                  disabled={id === "calibrate" && !image}
                  onClick={() => setStage(id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-40 ${stage === id ? "bg-[#14305c] text-white" : "text-slate-600"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {stage === "edit" ? (
              <>
                {TOOLS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTool(t.id)}
                    aria-pressed={tool === t.id}
                    title={`단축키 ${t.key}`}
                    className={`rounded-md border px-2 py-1 text-xs ${tool === t.id ? "border-[#14305c] bg-[#14305c] text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
                  >
                    {t.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setAiOpen((v) => !v)}
                  aria-pressed={aiOpen}
                  disabled={!underlay}
                  title={underlay ? "보정한 원본 이미지에서 벽·개구부·가구·치수 초안을 추출" : "이미지를 보정(또는 원본 이미지를 다시 연결)한 뒤 사용할 수 있습니다"}
                  className={`rounded-md border px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${aiOpen ? "border-violet-700 bg-violet-700 text-white" : "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100"}`}
                >
                  AI 초안
                </button>
                {underlay && (
                  <label className="ml-auto flex items-center gap-1 text-[11px] text-slate-500">
                    원본
                    <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-20" />
                  </label>
                )}
              </>
            ) : (
              CAL_TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCalTool(t.id)}
                  aria-pressed={calTool === t.id}
                  style={{ borderColor: CALIBRATION_COLORS[t.id], ...(calTool === t.id ? { background: CALIBRATION_COLORS[t.id], color: "#fff" } : { color: CALIBRATION_COLORS[t.id] }) }}
                  className="rounded-md border bg-white px-2 py-1 text-xs font-semibold"
                >
                  {t.label}
                </button>
              ))
            )}
          </div>

          {stage === "calibrate" && image ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="min-h-64 flex-1 overflow-hidden rounded-lg border border-slate-200">
                <CalibrationCanvas image={{ url: image.url, width: image.info.width, height: image.info.height }} draft={draft} tool={calTool} onChange={setDraft} />
              </div>
              <div className="flex flex-wrap items-end gap-3 text-xs">
                {[0, 1].map((i) => (
                  <label key={i} className="flex items-center gap-1" style={{ color: CALIBRATION_COLORS[i === 0 ? "ref1" : "ref2"] }}>
                    기준 {i + 1} 실제 길이
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={draft.lengths[i]}
                      disabled={!draft.refs[i]}
                      onChange={(e) => {
                        const lengths = [...draft.lengths] as CalibrationDraft["lengths"];
                        lengths[i] = e.target.value;
                        setDraft({ ...draft, lengths });
                      }}
                      className="w-20 rounded border border-slate-300 px-1.5 py-0.5 text-right text-slate-900 disabled:bg-slate-100"
                    />
                    m
                  </label>
                ))}
                <span className="text-slate-500">
                  {preview && !("error" in preview)
                    ? `배율 ${(1 / preview.scale).toFixed(1)} px/m → 외곽 ${preview.width} × ${preview.depth} m`
                    : preview && "error" in preview
                      ? preview.error
                      : ""}
                </span>
                <button type="button" className={`${BUTTON_PRIMARY} ml-auto`} disabled={!preview || "error" in preview} onClick={applyCal}>
                  {image.mode === "attached" ? "보정 다시 적용" : "보정 적용 → 새 도면"}
                </button>
              </div>
              <p className="text-[11px] leading-snug text-slate-500">
                실제 길이를 아는 치수선 양 끝을 끌어 기준 구간을 지정하고(Shift: 수평·수직 고정), 서로 다른 방향의 두 번째 구간으로 검산하세요. 외곽은 실내 마감면
                사각형입니다. 정면 스캔 이미지를 전제로 하며 원근·회전 보정은 하지 않습니다.
              </p>
            </div>
          ) : (
            <div className="min-h-64 flex-1 overflow-hidden rounded-lg border border-slate-200">
              <PlanEditorCanvas
                doc={doc}
                fitKey={`${session}:${doc.envelope.width}x${doc.envelope.depth}`}
                underlay={underlay}
                tool={tool}
                selection={selection}
                onSelect={setSelection}
                onApply={apply}
                flagged={flagged}
                onMessage={(m) => say(m, "error")}
                aiOverlay={aiOpen ? aiOverlay : null}
              />
            </div>
          )}
          {aiOpen && stage === "edit" && underlay && image && (
            <div className="absolute bottom-2 right-2 top-12 z-20 flex">
              <AiExtractPanel
                key={session}
                doc={doc}
                image={{ url: image.url, width: image.info.width, height: image.info.height }}
                onApply={(update) => apply(update, null)}
                onOverlay={setAiOverlay}
                onClose={() => setAiOpen(false)}
                onMessage={say}
              />
            </div>
          )}
        </section>

        {/* 속성·검증 */}
        <aside className="overflow-y-auto rounded-xl border border-slate-300 bg-white p-2.5 shadow-sm lg:min-h-0">
          <Inspector doc={doc} selection={selection} onSelect={setSelection} apply={apply} issues={validation.issues} />
        </aside>

        {/* 3D 미리보기 */}
        <section className="flex h-[60vh] flex-col gap-1.5 rounded-xl border border-slate-300 bg-white p-2 shadow-sm lg:h-auto lg:min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <h2 className="font-bold text-[#14305c]">3D 미리보기</h2>
            <span className={errorCount ? "text-red-700" : "text-slate-500"}>
              {errorCount ? `오류 ${errorCount}개 — 마지막 통과 도면 표시` : lightingStale ? "형상 반영됨 · 조명 갱신 대기" : "최신"}
            </span>
            <button type="button" className={BUTTON} disabled={!lightingStale} onClick={() => scene && setResourceScene(scene)}>
              조명 지금 갱신
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            {scene ? (
              <ViewerClient
                scene={scene}
                resourceScene={effectiveResourceScene ?? undefined}
                className="absolute inset-0 overflow-hidden rounded-lg bg-[#eef1f4] text-stone-100"
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-500">
                문서 오류를 고치면 3D를 만듭니다.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 파일 선택 후 같은 파일을 다시 고를 수 있게 값을 비운다. */
function pick(e: React.ChangeEvent<HTMLInputElement>, handle: (f: File) => void | Promise<void>) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) void handle(file);
}

/** 문서의 보정 정보로 보정 화면 초기값을 만든다(다시 연결한 이미지). */
function draftFromDocument(doc: FloorPlanDocument): CalibrationDraft {
  const cal = doc.calibration;
  if (!cal) return EMPTY_DRAFT;
  const [a, , , d, e, f] = cal.pixelToPlan;
  const refs = cal.references.slice(0, 2);
  return {
    crop: doc.source?.crop,
    refs: [refs[0] ? { a: refs[0].a, b: refs[0].b } : null, refs[1] ? { a: refs[1].a, b: refs[1].b } : null],
    lengths: [refs[0] ? String(refs[0].length) : "", refs[1] ? String(refs[1].length) : ""],
    envelope: { x: -e / a, y: -f / d, width: doc.envelope.width / a, height: doc.envelope.depth / d },
  };
}

function NewDocumentForm({ onCreate, onCancel }: { onCreate: (w: number, d: number) => void; onCancel: () => void }) {
  const [w, setW] = useState("6");
  const [d, setD] = useState("4.5");
  const valid = Number(w) >= 1 && Number(w) <= 60 && Number(d) >= 1 && Number(d) <= 60;
  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-56 space-y-2 rounded-lg border border-slate-300 bg-white p-3 text-xs shadow-lg">
      <p className="font-semibold">이미지 없이 새 도면</p>
      {(
        [
          ["실내 폭", w, setW],
          ["실내 깊이", d, setD],
        ] as const
      ).map(([label, value, set]) => (
        <label key={label} className="flex items-center justify-between gap-2">
          {label}
          <span>
            <input type="number" min={1} max={60} step={0.1} value={value} onChange={(e) => set(e.target.value)} className="w-20 rounded border border-slate-300 px-1.5 py-0.5 text-right" /> m
          </span>
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onCancel}>
          취소
        </button>
        <button type="button" className={BUTTON_PRIMARY} disabled={!valid} onClick={() => onCreate(Number(w), Number(d))}>
          만들기
        </button>
      </div>
    </div>
  );
}
