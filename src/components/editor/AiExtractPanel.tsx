"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AI_LIMITS,
  type AiProviderId,
  type ExtractFailure,
  type ExtractRequest,
  type ExtractResponse,
  type ExtractStatus,
  type ExtractSuccess,
} from "@/lib/floorPlan/ai/protocol";
import { applyProposal, defaultSelection, planChanges, type ProposalCategory, type ProposalChange } from "@/lib/floorPlan/ai/proposal";
import type { FloorPlanDocument } from "@/lib/floorPlan/schema";
import { BUTTON, BUTTON_PRIMARY } from "./common";

/**
 * AI 초안 추출 패널(단기 계획 S4).
 *  1) 공급자 선택·전송 안내 → 평면도 영역 이미지를 잘라(긴 변 ≤ 2576px) 서버 경계로 보낸다(키는 서버에만 있다).
 *  2) 진행 시간·취소. 실패하면 이유와 다시 시도·수동 입력 계속을 보여 준다(문서는 바뀌지 않는다).
 *  3) 성공하면 현재 문서와의 차이를 보여 주고, 고른 항목만 실행 취소 가능한 한 번의 편집으로 적용한다.
 *     사용자가 입력·확인한 값의 변경은 기본으로 고르지 않는다.
 */

export interface AiOverlay {
  result: ExtractSuccess;
  changes: ProposalChange[];
  selected: ReadonlySet<string>;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; started: number; controller: AbortController }
  | { kind: "error"; failure: ExtractFailure }
  | { kind: "done"; result: ExtractSuccess };

const CATEGORY_LABELS: Record<ProposalCategory, string> = { wall: "벽", opening: "문·창·통로", furniture: "가구", ceiling: "천장 높이", issue: "확인 항목" };

export default function AiExtractPanel({
  doc,
  image,
  onApply,
  onOverlay,
  onClose,
  onMessage,
}: {
  doc: FloorPlanDocument;
  image: { url: string; width: number; height: number };
  onApply: (update: (d: FloorPlanDocument) => FloorPlanDocument) => void;
  onOverlay: (overlay: AiOverlay | null) => void;
  onClose: () => void;
  onMessage: (text: string, tone?: "info" | "error") => void;
}) {
  const [status, setStatus] = useState<ExtractStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProviderId>("claude");
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    fetch("/api/floor-plan/extract", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ExtractStatus>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        const first = s.providers.find((p) => p.configured);
        if (first) setProvider(first.id);
      })
      .catch((e: unknown) => alive && setStatusError(`AI 추출 서버 상태를 읽지 못했습니다(${e instanceof Error ? e.message : String(e)}).`));
    return () => {
      alive = false;
    };
  }, []);

  // 진행 시간 표시
  useEffect(() => {
    if (run.kind !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [run.kind]);

  // 패널을 닫거나 화면을 떠나면 진행 중 요청을 취소한다.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(
    () => () => {
      if (runRef.current.kind === "running") runRef.current.controller.abort();
    },
    [],
  );

  const result = run.kind === "done" ? run.result : null;
  // 문서가 바뀌면(사용자 편집·적용) 차이를 다시 계산한다.
  const changes = useMemo(() => (result ? planChanges(doc, result.proposal) : []), [doc, result]);
  const visible = changes.filter((c) => c.action !== "same");
  const sameCount = changes.length - visible.length;
  const selectable = visible.filter((c) => !c.blocked);
  const chosen = selectable.filter((c) => selected.has(c.key));

  useEffect(() => {
    onOverlay(result ? { result, changes, selected } : null);
  }, [result, changes, selected, onOverlay]);
  useEffect(() => () => onOverlay(null), [onOverlay]);

  const start = async () => {
    const controller = new AbortController();
    setRun({ kind: "running", started: Date.now(), controller });
    setNow(Date.now());
    try {
      const prepared = await prepareImage(image, doc.source?.crop);
      const body: ExtractRequest = { provider, image: prepared.image, frame: { crop: prepared.crop }, document: doc };
      const res = await fetch("/api/floor-plan/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data: ExtractResponse;
      try {
        data = (await res.json()) as ExtractResponse;
      } catch {
        data = { ok: false, code: "provider.error", message: `서버 응답을 읽지 못했습니다(HTTP ${res.status}).`, retryable: true };
      }
      if (data.ok) {
        setSelected(defaultSelection(planChanges(doc, data.proposal)));
        setRun({ kind: "done", result: data });
      } else {
        setRun({ kind: "error", failure: data });
      }
    } catch (e) {
      const cancelled = controller.signal.aborted;
      setRun({
        kind: "error",
        failure: {
          ok: false,
          code: cancelled ? "cancelled" : "provider.error",
          message: cancelled ? "추출을 취소했습니다." : `요청 실패: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        },
      });
    }
  };

  const applySelected = () => {
    if (!result) return;
    const keys = new Set(chosen.map((c) => c.key));
    // 결과 안내를 위해 현재 문서로 먼저 계산한다. 그사이 문서가 바뀌었으면 갱신 시점의 문서로 다시 계산한다.
    const r = applyProposal(doc, result.proposal, keys);
    if (r.applied.length) onApply((d) => (d === doc ? r.doc : applyProposal(d, result.proposal, keys).doc));
    setSelected(new Set());
    onMessage(
      r.applied.length
        ? `AI 초안 ${r.applied.length}개 항목을 적용했습니다(미확인 표시). 2D에서 확인·수정하고 '값 확인'을 누르세요. 실행 취소(Ctrl+Z)로 한 번에 되돌릴 수 있습니다.${r.skipped.length ? ` 건너뜀 ${r.skipped.length}개: ${r.skipped[0]}` : ""}`
        : `적용한 항목이 없습니다.${r.skipped.length ? ` ${r.skipped[0]}` : ""}`,
      r.applied.length ? "info" : "error",
    );
  };

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const setCategory = (category: ProposalCategory, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const c of selectable) if (c.category === category) (on ? n.add(c.key) : n.delete(c.key));
      return n;
    });

  const providerInfo = status?.providers.find((p) => p.id === provider);
  const anyConfigured = !!status?.providers.some((p) => p.configured);

  return (
    <div className="flex max-h-full w-92 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-violet-300 bg-white text-xs shadow-xl" role="dialog" aria-label="AI 초안 추출">
      <div className="flex items-center justify-between border-b border-violet-100 bg-violet-50 px-3 py-2">
        <h2 className="font-bold text-violet-900">AI 초안 추출</h2>
        <button type="button" className={BUTTON} onClick={onClose}>
          닫기
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {(run.kind === "idle" || run.kind === "error") && (
          <>
            {statusError && <p className="rounded bg-red-50 px-2 py-1.5 text-red-800">{statusError}</p>}
            {status && !anyConfigured && (
              <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-900">
                서버에 모델 API 키가 없습니다(ANTHROPIC_API_KEY·OPENAI_API_KEY). 벽·개구부는 2D에서 직접 입력할 수 있습니다.
              </p>
            )}
            <fieldset className="space-y-1">
              <legend className="mb-1 font-semibold text-slate-700">모델 공급자</legend>
              {(status?.providers ?? []).map((p) => (
                <label key={p.id} className={`flex items-center gap-2 rounded border px-2 py-1 ${provider === p.id ? "border-violet-400 bg-violet-50" : "border-slate-200"} ${p.configured ? "" : "opacity-50"}`}>
                  <input type="radio" name="ai-provider" value={p.id} checked={provider === p.id} disabled={!p.configured} onChange={() => setProvider(p.id)} />
                  <span className="font-semibold">{p.label}</span>
                  <span className="truncate text-slate-500">{p.configured ? p.model : "키 없음"}</span>
                </label>
              ))}
            </fieldset>
            <p className="leading-snug text-slate-600">{status?.policy ?? "전송 정책을 불러오는 중…"}</p>
            {status && (
              <p className="text-slate-500">
                한도: 시도 {status.limits.maxAttempts}회 · {status.limits.timeoutSeconds}초 · 응답 {status.limits.maxOutputTokens.toLocaleString()} 토큰 · 시간당 {status.limits.requestsPerHour}회
              </p>
            )}
            <p className="text-slate-500">
              보낼 영역: {doc.source?.crop ? `평면도 영역 ${Math.round(doc.source.crop.width)}×${Math.round(doc.source.crop.height)}px` : `이미지 전체 ${image.width}×${image.height}px`}
              {!doc.source?.crop && " — 제목·범례·3D 시안이 있으면 보정 단계에서 평면도 영역을 지정하세요."}
            </p>
            {run.kind === "error" && (
              <div className="space-y-1.5 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-red-900" role="alert">
                <p>
                  {run.failure.message}
                  {run.failure.attempts ? ` (시도 ${run.failure.attempts}회)` : ""}
                </p>
                <p className="text-red-700">문서는 바뀌지 않았습니다. 2D 편집 도구로 직접 입력을 계속할 수 있습니다.</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {run.kind === "error" && (
                <button type="button" className={BUTTON} onClick={onClose}>
                  수동으로 계속
                </button>
              )}
              <button type="button" className={BUTTON_PRIMARY} disabled={!providerInfo?.configured} onClick={() => void start()}>
                {run.kind === "error" ? (run.failure.retryable ? "다시 시도" : "다시 보내기") : "이미지 보내고 추출"}
              </button>
            </div>
          </>
        )}

        {run.kind === "running" && (
          <div className="space-y-2" aria-live="polite">
            <p className="flex items-center gap-2 font-semibold text-violet-900">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
              {providerInfo?.label ?? provider} 추출 중… {Math.max(0, Math.round((now - run.started) / 1000))}초
              {status ? ` / 한도 ${status.limits.timeoutSeconds}초` : ""}
            </p>
            <p className="text-slate-500">편집은 계속할 수 있습니다. 결과는 적용 전에 차이로 보여 줍니다.</p>
            <button type="button" className={BUTTON} onClick={() => run.controller.abort()}>
              취소
            </button>
          </div>
        )}

        {result && (
          <>
            <div className="space-y-0.5 rounded bg-slate-50 px-2 py-1.5 text-slate-600">
              <p>
                <span className="font-semibold text-slate-800">{result.model}</span> · 시도 {result.attempts}회 · {(result.durationMs / 1000).toFixed(1)}초
              </p>
              <p>
                토큰 입력 {result.usage.inputTokens.toLocaleString()} · 출력 {result.usage.outputTokens.toLocaleString()}
                {result.usage.estimatedCostUsd !== null ? ` · 추정 $${result.usage.estimatedCostUsd.toFixed(3)}` : ""}
              </p>
              <p className={result.draftValidation.errors ? "text-red-700" : ""}>
                전체 적용 시 문서 검증: 오류 {result.draftValidation.errors} · 경고 {result.draftValidation.warnings}
              </p>
            </div>
            {result.proposal.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-slate-600">
                {result.proposal.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}

            {visible.length === 0 ? (
              <p className="rounded bg-emerald-50 px-2 py-1.5 text-emerald-900">현재 문서와 다른 항목이 없습니다{sameCount ? `(일치 ${sameCount}개)` : ""}.</p>
            ) : (
              (Object.keys(CATEGORY_LABELS) as ProposalCategory[]).map((cat) => {
                const list = visible.filter((c) => c.category === cat);
                if (!list.length) return null;
                const pickable = list.filter((c) => !c.blocked);
                return (
                  <section key={cat} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-700">
                        {CATEGORY_LABELS[cat]} {list.length}
                      </h3>
                      {pickable.length > 1 && (
                        <span className="flex gap-1">
                          <button type="button" className="text-violet-700 underline" onClick={() => setCategory(cat, true)}>
                            모두
                          </button>
                          <button type="button" className="text-violet-700 underline" onClick={() => setCategory(cat, false)}>
                            없음
                          </button>
                        </span>
                      )}
                    </div>
                    <ul className="space-y-1">
                      {list.map((c) => (
                        <li key={c.key}>
                          <label className={`flex items-start gap-2 rounded border px-2 py-1 ${c.blocked ? "border-slate-200 bg-slate-50 text-slate-400" : c.protectedValue ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
                            <input type="checkbox" className="mt-0.5" checked={selected.has(c.key)} disabled={!!c.blocked} onChange={() => toggle(c.key)} data-change={c.key} />
                            <span className="min-w-0">
                              <span className="font-semibold">{c.title}</span>
                              {c.protectedValue && c.action === "update" && <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] text-amber-900">확정값 변경</span>}
                              {c.detail && <span className="block wrap-break-word text-slate-500">{c.detail}</span>}
                              {c.blocked && <span className="block text-red-700">적용 불가: {c.blocked}</span>}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
            {sameCount > 0 && visible.length > 0 && <p className="text-slate-500">현재 문서와 일치하는 항목 {sameCount}개는 목록에서 뺐습니다.</p>}
            <p className="text-slate-500">AI가 찾지 못한 기존 항목은 지우지 않습니다. 높이 등 평면도에 없는 값은 기본값으로 기록합니다.</p>

            {result.proposal.dimensions.length > 0 && (
              <details>
                <summary className="cursor-pointer font-semibold text-slate-700">읽은 치수 {result.proposal.dimensions.length}개</summary>
                <table className="mt-1 w-full text-left tabular-nums">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="font-normal">표기</th>
                      <th className="font-normal">값(m)</th>
                      <th className="font-normal">잰 길이(m)</th>
                      <th className="font-normal">판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.proposal.dimensions.map((d, i) => (
                      <tr key={i} className={d.status === "conflict" ? "text-red-700" : ""}>
                        <td>{d.text}</td>
                        <td>
                          {d.stated ?? "—"}
                          {d.unitAssumed ? "*" : ""}
                        </td>
                        <td>{d.measured}</td>
                        <td>{d.status === "ok" ? "일치" : d.status === "conflict" ? "충돌" : "읽지 못함"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.proposal.dimensions.some((d) => d.unitAssumed) && <p className="text-slate-500">* 단위 표기가 없어 잰 길이에 가까운 단위로 해석</p>}
              </details>
            )}
            {result.proposal.dropped.length > 0 && (
              <details>
                <summary className="cursor-pointer font-semibold text-slate-700">버린 항목 {result.proposal.dropped.length}개</summary>
                <ul className="mt-1 list-disc pl-4 text-slate-500">
                  {result.proposal.dropped.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>

      {result && (
        <div className="flex items-center justify-between gap-2 border-t border-violet-100 px-3 py-2">
          <button type="button" className={BUTTON} onClick={() => setRun({ kind: "idle" })}>
            다시 추출
          </button>
          <button type="button" className={BUTTON_PRIMARY} disabled={!chosen.length} onClick={applySelected}>
            선택 항목 적용 ({chosen.length})
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 원본 이미지에서 평면도 영역을 잘라 긴 변 2576px 이하로 줄이고 base64로 만든다.
 * 가로·세로를 같은 비율로 줄여야 서버가 보낸 이미지 좌표를 원본 좌표로 되돌릴 수 있다.
 */
async function prepareImage(
  image: { url: string; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number } | undefined,
): Promise<{ image: ExtractRequest["image"]; crop: { x: number; y: number; width: number; height: number } }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("원본 이미지를 읽지 못했습니다."));
    el.src = image.url;
  });
  const x = Math.max(0, Math.floor(crop?.x ?? 0));
  const y = Math.max(0, Math.floor(crop?.y ?? 0));
  const cw = Math.min(img.naturalWidth - x, Math.round(crop?.width ?? img.naturalWidth));
  const ch = Math.min(img.naturalHeight - y, Math.round(crop?.height ?? img.naturalHeight));
  const scale = Math.min(1, AI_LIMITS.maxImageEdge / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * scale));
  const h = Math.max(1, Math.round(ch * scale));
  // 서버는 x·y 축을 각각 crop/보낸 크기 비율로 되돌리므로 실제로 잘라낸 픽셀 영역을 그대로 보낸다.
  const sentCrop = { x, y, width: cw, height: ch };
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이미지를 처리할 수 없습니다(canvas).");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, cw, ch, 0, 0, w, h);
  const encode = (type: "image/png" | "image/jpeg", quality?: number) =>
    new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 인코딩 실패"))), type, quality));
  let blob = await encode("image/png");
  let mimeType: "image/png" | "image/jpeg" = "image/png";
  for (const q of [0.92, 0.85, 0.75]) {
    if (blob.size <= AI_LIMITS.maxImageBytes) break;
    blob = await encode("image/jpeg", q);
    mimeType = "image/jpeg";
  }
  if (blob.size > AI_LIMITS.maxImageBytes) throw new Error("보낼 이미지가 너무 큽니다. 평면도 영역을 더 작게 지정하세요.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ""));
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
  return { image: { mimeType, data, width: w, height: h }, crop: sentCrop };
}
