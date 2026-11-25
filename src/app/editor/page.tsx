import type { Metadata } from "next";
import EditorScreen from "@/components/editor/EditorScreen";

export const metadata: Metadata = {
  title: "도면 편집 · Interior 3D Viewer",
  description: "도면 이미지의 배율을 보정하고 벽·문·창을 입력해 3D로 확인한 뒤 도면 JSON으로 저장",
};

export default function EditorPage() {
  return (
    <main>
      <EditorScreen />
    </main>
  );
}
