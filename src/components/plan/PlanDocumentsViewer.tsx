"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import officeExample from "../../../examples/floor-plans/office.json";
import studioExample from "../../../examples/floor-plans/small-studio.json";
import { sceneKey } from "@/config/sceneTypes";
import { floorPlanToScene } from "@/lib/floorPlan/toScene";
import { parseFloorPlanJson, validateFloorPlan, type FloorPlanIssue, type FloorPlanValidationResult } from "@/lib/floorPlan/validate";
import { validateSceneLayout } from "@/lib/three/layoutValidation";
import PlanViewer from "./PlanViewer";

/**
 * 도면 문서(FloorPlanDocument JSON) → 2D·3D 화면.
 * 예제 문서를 고르거나 JSON 파일을 열어 코드 수정 없이 도면을 교체한다.
 * - 형식·문서 검증(validate.ts)을 통과한 문서만 장면으로 변환한다(floorPlanToScene). 오류가 있으면 목록만 보여 주고 현재 도면을 유지한다.
 * - 같은 id의 문서를 다시 열면 목록 항목을 바꾼다. revision이 다르면 리소스·시점을 새로 준비한다(sceneKey).
 */

interface LoadedDoc {
  /** 문서 id(같은 id를 다시 열면 교체) */
  id: string;
  name: string;
  origin: "예제" | "파일";
  result: FloorPlanValidationResult;
}

const EXAMPLES: { name: string; data: unknown }[] = [
  { name: "소형 원룸", data: studioExample },
  { name: "사무실", data: officeExample },
];

const NAV_LINK = "rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50";

export default function PlanDocumentsViewer() {
  const [docs, setDocs] = useState<LoadedDoc[]>(() =>
    EXAMPLES.flatMap(({ name, data }) => {
      const result = validateFloorPlan(data);
      return result.document ? [{ id: result.document.id, name, origin: "예제" as const, result }] : [];
    }),
  );
  const [selectedId, setSelectedId] = useState(() => docs[0]?.id ?? "");
  /** 마지막으로 연 파일이 장면으로 만들 수 없을 때의 결과 */
  const [rejected, setRejected] = useState<{ fileName: string; result: FloorPlanValidationResult } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = docs.find((d) => d.id === selectedId) ?? docs[0];
  const scene = useMemo(() => (selected?.result.ok && selected.result.document ? floorPlanToScene(selected.result.document) : null), [selected]);
  const layoutIssues = useMemo(() => (scene ? validateSceneLayout(scene) : []), [scene]);

  const openFile = async (file: File) => {
    const result = parseFloorPlanJson(await file.text());
    if (!result.ok || !result.document) {
      setRejected({ fileName: file.name, result });
      return;
    }
    const doc = result.document;
    setRejected(null);
    setDocs((list) => {
      const entry: LoadedDoc = { id: doc.id, name: doc.title ?? file.name, origin: "파일", result };
      return list.some((d) => d.id === doc.id) ? list.map((d) => (d.id === doc.id ? entry : d)) : [...list, entry];
    });
    setSelectedId(doc.id);
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5 text-slate-600">
        도면
        <select
          value={selected?.id ?? ""}
          onChange={(e) => setSelectedId(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900"
        >
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.origin} · {d.id} r{d.result.document?.revision})
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => fileRef.current?.click()} className="rounded-md bg-[#14305c] px-2.5 py-1 font-semibold text-white hover:bg-[#1d3f75]">
        JSON 열기
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // 같은 파일을 다시 고를 수 있게
          if (file) void openFile(file);
        }}
      />
    </div>
  );

  const nav = (
    <>
      <Link href="/editor" className={NAV_LINK}>
        도면 편집
      </Link>
      <Link href="/office" className={NAV_LINK}>
        사무실
      </Link>
      <Link href="/" className={NAV_LINK}>
        ← 거실 프로토타입
      </Link>
    </>
  );

  const aside = (
    <div className="flex shrink-0 flex-col gap-1.5">
      {rejected && <RejectedFile fileName={rejected.fileName} result={rejected.result} onClose={() => setRejected(null)} />}
      {selected && <DocumentSummary doc={selected} layoutIssues={layoutIssues} />}
    </div>
  );

  if (!scene || !selected) {
    return <div className="p-6 text-sm text-slate-700">표시할 수 있는 도면 문서가 없습니다.</div>;
  }
  return <PlanViewer key={sceneKey(scene)} scene={scene} title="도면 문서" toolbar={toolbar} nav={nav} aside={aside} />;
}

/** 현재 도면 요약: 항목 수·검증 경고·배치 검사 */
function DocumentSummary({ doc, layoutIssues }: { doc: LoadedDoc; layoutIssues: string[] }) {
  const d = doc.result.document!;
  const warnings = doc.result.issues.filter((i) => i.severity === "warning");
  const counts: [string, string][] = [
    ["외곽", `${d.envelope.width} × ${d.envelope.depth} m · 천장 ${d.ceilingHeight} m`],
    ["내부 벽", `${d.walls.length}개`],
    ["개구부", `${d.openings.length}개`],
    ["가구", `${d.furniture?.length ?? 0}개`],
  ];
  return (
    <div className="@container flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs @sm:grid-cols-2">
        {counts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-200 pb-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className="whitespace-nowrap font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className={`rounded-md px-2 py-1 text-[11px] ${layoutIssues.length ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
        {layoutIssues.length ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {layoutIssues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : (
          "배치 검사 통과: 경계·겹침·관통·문 열림·출입문 동선"
        )}
      </div>
      {warnings.length > 0 && (
        <details className="text-[11px] leading-snug text-slate-600">
          <summary className="cursor-pointer font-semibold text-slate-700">확인 필요 항목 {warnings.length}개(기본값·미확인값·미검토 목록)</summary>
          <IssueList issues={warnings} />
        </details>
      )}
    </div>
  );
}

function RejectedFile({ fileName, result, onClose }: { fileName: string; result: FloorPlanValidationResult; onClose: () => void }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-900">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">
          {fileName}: 오류 {errors.length}개로 3D를 생성하지 않았습니다. 현재 도면을 유지합니다.
        </p>
        <button type="button" onClick={onClose} className="shrink-0 rounded px-1.5 hover:bg-red-100" aria-label="닫기">
          ✕
        </button>
      </div>
      <IssueList issues={errors} />
    </div>
  );
}

function IssueList({ issues }: { issues: FloorPlanIssue[] }) {
  return (
    <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">
      {issues.map((i, n) => (
        <li key={`${i.code}${i.path}${n}`}>
          {i.message} <code className="text-[10px] opacity-70">{i.path || "/"}</code>
        </li>
      ))}
    </ul>
  );
}
