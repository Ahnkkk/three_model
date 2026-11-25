import type { Metadata } from "next";
import PlanDocumentsViewer from "@/components/plan/PlanDocumentsViewer";

export const metadata: Metadata = {
  title: "도면 문서 · Interior 3D Viewer",
  description: "FloorPlanDocument JSON을 검증해 같은 데이터로 2D 배치도와 3D 시안을 생성",
};

export default function PlansPage() {
  return (
    <main>
      <PlanDocumentsViewer />
    </main>
  );
}
