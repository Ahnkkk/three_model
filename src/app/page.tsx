import Link from "next/link";
import ViewerClient from "@/components/viewer/ViewerClient";

export default function Page() {
  return (
    <main className="relative">
      <ViewerClient />
      <Link
        href="/office"
        className="absolute bottom-4 right-4 z-10 rounded-lg border border-white/10 bg-stone-900/80 px-3 py-1.5 text-sm text-stone-100 shadow-lg backdrop-blur hover:bg-stone-800/90"
      >
        사무실 →
      </Link>
    </main>
  );
}
