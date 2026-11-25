/** JSON Pointer(RFC 6901) 보조 함수. 검증 결과의 위치 표시와 provenance 경로 확인에 쓴다. */

const escape = (seg: string) => seg.replace(/~/g, "~0").replace(/\//g, "~1");
const unescape = (seg: string) => seg.replace(/~1/g, "/").replace(/~0/g, "~");

/** 경로 배열(Zod issue.path 등) → JSON Pointer. 빈 배열은 문서 전체("") */
export function toPointer(path: readonly PropertyKey[]): string {
  return path.map((seg) => `/${escape(String(seg))}`).join("");
}

/** JSON Pointer가 가리키는 값을 찾는다. */
export function resolvePointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: root };
  if (!pointer.startsWith("/")) return { found: false };
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const seg = unescape(raw);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= cur.length) return { found: false };
      cur = cur[Number(seg)];
    } else if (cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}
