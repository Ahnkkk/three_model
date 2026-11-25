import Link from "next/link";
import ViewerClient from "@/components/viewer/ViewerClient";

export default function Page() {
  return (
    <main className="relative">
      <ViewerClient />
      <Link
        href="/office"
        // 좁은 화면에서는 아래 가운데의 시점 버튼 줄·1인칭 안내와 겹치지 않도록 그 위에 둔다.
        className="absolute bottom-4 right-4 z-10 max-sm:bottom-28 rounded-lg border border-white/10 bg-stone-900/80 px-3 py-1.5 text-sm text-stone-100 shadow-lg backdrop-blur hover:bg-stone-800/90"
      >
        사무실 →
      </Link>
    </main>
  );
}
