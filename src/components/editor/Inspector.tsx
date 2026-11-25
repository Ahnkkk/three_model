"use client";

import {
  confirmPath,
  deleteFurniture,
  deleteOpening,
  deleteWall,
  findWall,
  setCeilingHeight,
  setCompleteness,
  setEnvelope,
  updateOpening,
  updateWall,
  wallLength,
} from "@/lib/floorPlan/editor";
import type { FloorPlanDocument, FloorPlanOpening } from "@/lib/floorPlan/schema";
import type { FloorPlanIssue } from "@/lib/floorPlan/validate";
import { BUTTON, NumberField, SelectField } from "./common";
import type { Selection } from "./PlanEditorCanvas";

type Apply = (update: (d: FloorPlanDocument) => FloorPlanDocument, select?: Selection) => void;

/** 선택 항목의 문서 경로(JSON Pointer) */
export function selectionPath(doc: FloorPlanDocument, sel: Selection): string | null {
  if (!sel) return null;
  const list = sel.kind === "wall" ? doc.walls : sel.kind === "opening" ? doc.openings : (doc.furniture ?? []);
  const i = list.findIndex((x) => x.id === sel.id);
  return i < 0 ? null : `/${sel.kind === "wall" ? "walls" : sel.kind === "opening" ? "openings" : "furniture"}/${i}`;
}

/** 문서 경로 → 선택 항목(벽·개구부·가구 하위 경로 포함) */
export function pathToSelection(doc: FloorPlanDocument, path: string): Selection {
  const m = path.match(/^\/(walls|openings|furniture)\/(\d+)/);
  if (!m) return null;
  const i = Number(m[2]);
  if (m[1] === "walls") return doc.walls[i] ? { kind: "wall", id: doc.walls[i].id } : null;
  if (m[1] === "openings") return doc.openings[i] ? { kind: "opening", id: doc.openings[i].id } : null;
  const f = doc.furniture?.[i];
  return f ? { kind: "furniture", id: f.id } : null;
}

const ORIGIN_LABEL = { source: "원본 추출", user: "사용자 입력", default: "기본값", derived: "계산값" } as const;

/** 경로(와 하위 경로)의 정보 출처·확인 상태 */
function Provenance({ doc, paths, apply }: { doc: FloorPlanDocument; paths: string[]; apply: Apply }) {
  const entries = (doc.provenance ?? []).filter((p) => paths.some((path) => p.path === path || p.path.startsWith(`${path}/`)));
  if (!entries.length) return <p className="text-[11px] text-slate-400">출처 기록 없음</p>;
  const pending = entries.filter((p) => !p.confirmed);
  return (
    <div className="space-y-1 text-[11px]">
      <ul className="space-y-0.5">
        {entries.map((p) => (
          <li key={p.path} className="flex flex-wrap items-baseline gap-1">
            <code className="text-[10px] text-slate-400">{p.path}</code>
            <span className={`rounded px-1 ${p.confirmed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {ORIGIN_LABEL[p.origin]} · {p.confirmed ? "확인됨" : "미확인"}
            </span>
            {p.note && <span className="text-slate-500">{p.note}</span>}
            {p.region && <span className="text-slate-400">(원본 {Math.round(p.region.x)}, {Math.round(p.region.y)} px)</span>}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <button type="button" className={BUTTON} onClick={() => apply((d) => paths.reduce((acc, path) => confirmPath(acc, path), d))}>
          값 확인({pending.length})
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-b border-slate-200 pb-2.5">
      <h3 className="text-xs font-bold text-[#14305c]">{title}</h3>
      {children}
    </section>
  );
}

export default function Inspector({
  doc,
  selection,
  onSelect,
  apply,
  issues,
}: {
  doc: FloorPlanDocument;
  selection: Selection;
  onSelect: (s: Selection) => void;
  apply: Apply;
  issues: FloorPlanIssue[];
}) {
  const path = selectionPath(doc, selection);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return (
    <div className="flex flex-col gap-2.5 text-xs">
      <SelectionPanel doc={doc} selection={selection} path={path} apply={apply} onSelect={onSelect} />

      <Section title="외곽·높이">
        <NumberField label="실내 폭" value={doc.envelope.width} min={1} max={60} onCommit={(v) => apply((d) => setEnvelope(d, { width: v }))} />
        <NumberField label="실내 깊이" value={doc.envelope.depth} min={1} max={60} onCommit={(v) => apply((d) => setEnvelope(d, { depth: v }))} />
        <NumberField label="외벽 두께" value={doc.envelope.wallThickness} min={0.05} max={1} onCommit={(v) => apply((d) => setEnvelope(d, { wallThickness: v }))} />
        <NumberField label="천장 높이" value={doc.ceilingHeight} min={2} max={6} onCommit={(v) => apply((d) => setCeilingHeight(d, v))} />
        <Provenance doc={doc} paths={["/envelope", "/ceilingHeight"]} apply={apply} />
      </Section>

      <Section title="검토 상태">
        <p className="text-[11px] text-slate-500">목록을 모두 확인했으면 표시하세요. 빈 목록이 확인된 &apos;없음&apos;인지 미인식인지 구분합니다.</p>
        {(
          [
            ["walls", "내부 벽"],
            ["openings", "개구부"],
            ["furniture", "가구"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={doc.completeness?.[key] === "reviewed"}
              onChange={(e) => apply((d) => setCompleteness(d, key, e.target.checked ? "reviewed" : "unreviewed"))}
            />
            {label} 검토 완료
          </label>
        ))}
      </Section>

      <Section title={`검증 결과 · 오류 ${errors.length} · 확인 필요 ${warnings.length}`}>
        {errors.length === 0 && <p className="rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">오류 없음 — 3D에 반영됩니다.</p>}
        {errors.length > 0 && <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">오류를 고칠 때까지 3D는 마지막으로 통과한 도면을 표시합니다.</p>}
        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
          {[...errors, ...warnings].map((i, n) => {
            const target = pathToSelection(doc, i.path);
            return (
              <li key={`${i.code}${i.path}${n}`}>
                <button
                  type="button"
                  disabled={!target}
                  onClick={() => target && onSelect(target)}
                  className={`w-full rounded px-1.5 py-0.5 text-left text-[11px] ${i.severity === "error" ? "text-red-700" : "text-amber-800"} enabled:hover:bg-slate-100`}
                >
                  {i.severity === "error" ? "✕" : "!"} {i.message} <code className="text-[10px] opacity-60">{i.path || "/"}</code>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function SelectionPanel({ doc, selection, path, apply, onSelect }: { doc: FloorPlanDocument; selection: Selection; path: string | null; apply: Apply; onSelect: (s: Selection) => void }) {
  if (!selection || !path) {
    return (
      <Section title="선택 항목">
        <p className="text-[11px] text-slate-500">벽·개구부·가구를 선택하면 치수를 고칠 수 있습니다. Delete로 지우고 Ctrl+Z로 되돌립니다.</p>
      </Section>
    );
  }

  if (selection.kind === "wall") {
    const w = doc.walls.find((x) => x.id === selection.id)!;
    const set = (patch: Parameters<typeof updateWall>[2]) => apply((d) => updateWall(d, w.id, patch));
    return (
      <Section title={`벽 · ${w.id}`}>
        <SelectField
          label="종류"
          value={w.kind}
          options={[
            ["solid", "불투명 벽"],
            ["glass", "유리 파티션"],
          ]}
          onChange={(kind) => set({ kind })}
        />
        <NumberField label="시작점 u(오른쪽)" value={w.start[0]} min={0} max={doc.envelope.width} onCommit={(v) => set({ start: [v, w.start[1]] })} />
        <NumberField label="시작점 v(아래쪽)" value={w.start[1]} min={0} max={doc.envelope.depth} onCommit={(v) => set({ start: [w.start[0], v] })} />
        <NumberField label="끝점 u" value={w.end[0]} min={0} max={doc.envelope.width} onCommit={(v) => set({ end: [v, w.end[1]] })} />
        <NumberField label="끝점 v" value={w.end[1]} min={0} max={doc.envelope.depth} onCommit={(v) => set({ end: [w.end[0], v] })} />
        <p className="text-[11px] text-slate-500">길이 {wallLength(w).toFixed(3)} m · 개구부 {doc.openings.filter((o) => o.wallId === w.id).length}개(벽과 함께 이동·삭제)</p>
        <NumberField label="두께" value={w.thickness} min={0.02} max={0.6} onCommit={(v) => set({ thickness: v })} />
        <NumberField label="높이(비우면 천장)" value={w.height ?? doc.ceilingHeight} min={0.3} max={doc.ceilingHeight} onCommit={(v) => set({ height: v === doc.ceilingHeight ? undefined : v })} />
        <Provenance doc={doc} paths={[path]} apply={apply} />
        <DeleteButton onClick={() => apply((d) => deleteWall(d, w.id), null)} />
      </Section>
    );
  }

  if (selection.kind === "opening") {
    const o = doc.openings.find((x) => x.id === selection.id)!;
    const wall = findWall(doc, o.wallId);
    const set = (patch: Partial<Omit<FloorPlanOpening, "id">>) => apply((d) => updateOpening(d, o.id, patch));
    const kinds: [FloorPlanOpening["kind"], string][] = wall?.exterior
      ? [
          ["door", "문"],
          ["window", "창"],
          ["passage", "통로(문짝 없음)"],
        ]
      : [
          ["door", "문"],
          ["passage", "통로(문짝 없음)"],
        ];
    return (
      <Section title={`개구부 · ${o.id}`}>
        <p className="text-[11px] text-slate-500">
          소속 벽 <button className="underline" onClick={() => wall && !wall.exterior && onSelect({ kind: "wall", id: wall.id })}>{o.wallId}</button>
          {wall ? ` · 벽 길이 ${wallLength(wall).toFixed(2)} m` : ""}
        </p>
        <SelectField label="종류" value={o.kind} options={kinds} onChange={(kind) => set({ kind })} />
        <NumberField label="벽 시작점 → 중심" value={o.offset} min={0} onCommit={(v) => set({ offset: v })} />
        <NumberField label="폭" value={o.width} min={0.3} max={6} onCommit={(v) => set({ width: v })} />
        <NumberField label="높이" value={o.height} min={0.3} max={doc.ceilingHeight} onCommit={(v) => set({ height: v })} />
        <NumberField label="하단 높이" value={o.bottom} min={0} max={doc.ceilingHeight} disabled={o.kind !== "window"} onCommit={(v) => set({ bottom: v })} />
        {o.kind === "door" && o.door && (
          <>
            <SelectField
              label="문짝"
              value={o.door.leaf}
              options={[
                ["paint", "도장"],
                ["wood", "목재"],
                ["glass", "유리"],
                ["none", "없음(문틀만)"],
              ]}
              onChange={(leaf) => set({ door: { ...o.door!, leaf } })}
            />
            <SelectField
              label="경첩"
              value={o.door.hinge}
              options={[
                ["start", "벽 시작점 쪽"],
                ["end", "벽 끝점 쪽"],
              ]}
              onChange={(hinge) => set({ door: { ...o.door!, hinge } })}
            />
            <SelectField
              label="열림"
              value={o.door.swing}
              options={[
                ["pos", wall?.exterior ? "실내 쪽" : "왼쪽(진행 방향 기준)"],
                ["neg", wall?.exterior ? "실외 쪽" : "오른쪽(진행 방향 기준)"],
              ]}
              onChange={(swing) => set({ door: { ...o.door!, swing } })}
            />
            <NumberField label="열린 각도" value={o.door.angle} min={0} max={180} step={5} unit="°" onCommit={(angle) => set({ door: { ...o.door!, angle } })} />
          </>
        )}
        <Provenance doc={doc} paths={[path]} apply={apply} />
        <DeleteButton onClick={() => apply((d) => deleteOpening(d, o.id), null)} />
      </Section>
    );
  }

  const f = (doc.furniture ?? []).find((x) => x.id === selection.id)!;
  return (
    <Section title={`가구 · ${f.label ?? f.id}`}>
      <p className="text-[11px] text-slate-500">
        종류 {f.kind === "unknown" ? "미분류(단순 박스)" : f.kind} · 위치 ({f.position[0]}, {f.position[2]}) m · 크기 {f.size.join(" × ")} m
      </p>
      <p className="text-[11px] text-slate-400">가구 배치 편집은 장기 계획(L4) 범위입니다. 여기서는 삭제만 합니다.</p>
      <Provenance doc={doc} paths={[path]} apply={apply} />
      <DeleteButton onClick={() => apply((d) => deleteFurniture(d, f.id), null)} />
    </Section>
  );
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50">
      삭제(Delete)
    </button>
  );
}
