"use client";

import Link from "next/link";
import { useMemo } from "react";
import { OFFICE_ASSUMPTIONS } from "@/config/officePlan";
import { OFFICE_SCENE } from "@/config/officeScene";
import { summarizeOffice, validateOfficeLayout } from "@/lib/three/officeLayout";
import PlanViewer from "@/components/plan/PlanViewer";

const NAV_LINK = "rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50";

/** 사무실 비교 화면: 같은 장면 데이터로 만든 2D 가구 배치도와 3D 시안(공용 PlanViewer) + 사무실 배치 요약 */
export default function OfficeViewer() {
  return (
    <PlanViewer
      scene={OFFICE_SCENE}
      title="사무실"
      planTitle="2D 가구 배치도"
      aside={<OfficeSummary />}
      nav={
        <>
          <Link href="/editor" className={NAV_LINK}>
            도면 편집
          </Link>
          <Link href="/plans" className={NAV_LINK}>
            도면 문서
          </Link>
          <Link href="/" className={NAV_LINK}>
            ← 거실 프로토타입
          </Link>
        </>
      }
    />
  );
}

/** 배치 요약: 수량·검증 결과·가정 항목(패널 폭에 따라 수량 1~3열). */
function OfficeSummary() {
  const summary = useMemo(() => summarizeOffice(OFFICE_SCENE.furniture), []);
  const issues = useMemo(() => validateOfficeLayout(OFFICE_SCENE), []);

  const counts: [string, string][] = [
    ["대회의실", `${summary.largeMeetingSeats}석`],
    ["소회의실", `${summary.smallMeetingSeats}석`],
    ["H형 데스크", `${summary.hDeskSets}세트 · ${summary.workSeats}석*`],
    ["원형 테이블", `${summary.roundTables}개 · ${summary.openMeetingSeats}석*`],
    ["의자 합계", `${summary.totalChairs}개*`],
  ];

  return (
    <div className="@container flex shrink-0 flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs @sm:grid-cols-2 @2xl:grid-cols-3">
        {counts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-200 pb-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className="whitespace-nowrap font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] leading-snug text-slate-500">* 이미지에서 수량을 읽어 정한 가정값(설정에서 수정)</p>
      <div className={`rounded-md px-2 py-1 text-[11px] ${issues.length ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
        {issues.length ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : (
          "배치 검증 통과: 수량·겹침·파티션·문 열림·입구 동선"
        )}
      </div>
      <details className="text-[11px] leading-snug text-slate-600">
        <summary className="cursor-pointer font-semibold text-slate-700">가정·미확정 항목</summary>
        <ul className="mt-1 max-h-32 list-disc space-y-1 overflow-y-auto pl-4">
          {OFFICE_ASSUMPTIONS.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
