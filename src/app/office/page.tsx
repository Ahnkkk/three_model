import type { Metadata } from "next";
import OfficeViewer from "@/components/office/OfficeViewer";

export const metadata: Metadata = {
  title: "사무실 · Interior 3D Viewer",
  description: "H형 데스크 2세트 + 원형테이블 2개 사무실 배치의 2D 배치도와 3D 시안",
};

export default function OfficePage() {
  return (
    <main>
      <OfficeViewer />
    </main>
  );
}
