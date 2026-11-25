"use client";

import type { MaterialId } from "@/config/materials";
import type { FurnitureItem, PartitionSegment, PlanDimensionView, PlanView, RoomConfig, SceneConfig, Vec2, WallId } from "@/config/sceneTypes";
import { hDeskLayout } from "@/lib/three/layoutGeometry";
import { doorLeafSegment, planPoint, wallPlanFrame, type PlanFrame } from "@/lib/three/planGeometry";

/**
 * 2D 가구 배치도(SVG).
 * 3D와 같은 장면 데이터(가구·파티션·기둥·외벽 개구부)와 2D 표시 정보(scene.plan: 영역·치수·이름표)에서 생성한다.
 * 단위는 m이며 SVG 좌표 = 월드 (x, z). 회전은 three.js Y축 회전(θ)과 같은 방향이 되도록 SVG에서는 rotate(-θ)를 적용한다.
 */

const NAVY = "#14305c";
const WALL = "#f3f0ea";
const WALL_EDGE = "#9a9387";
const GLASS = "#7fd3c0";
const WINDOW = "#bfe6f2";
const WALL_IDS: WallId[] = ["north", "south", "west", "east"];

/** 바닥 마감별 평면 색(2D 배치도·미니맵 공용) */
export const FLOOR_COLORS: Partial<Record<MaterialId, string>> = {
  carpetDark: "#4a4b4e",
  loungeCarpet: "#5d534b",
  pantryTile: "#ece8e1",
  floorWood: "#b4885d",
  oakLight: "#c9a77c",
  marble: "#e4e1dc",
};

export const floorColor = (m?: MaterialId) => (m && FLOOR_COLORS[m]) || "#666666";

/** 가구 평면 기호(2D 배치도·미니맵 공용). 크기는 m 단위, 가구 로컬 좌표(중심 원점). */
export function FurnitureSymbol({ item }: { item: FurnitureItem }) {
  const [w, , d] = item.size;
  const color = item.variant?.color;
  switch (item.kind) {
    case "meetingChair":
    case "officeChair":
      return (
        <g>
          <rect x={-0.23} y={-0.2} width={0.46} height={0.44} rx={0.09} fill={color ?? "#6b635b"} stroke="#2a2724" strokeWidth={0.015} />
          <rect x={-0.23} y={-0.3} width={0.46} height={0.09} rx={0.035} fill="#2a2724" opacity={0.75} />
        </g>
      );
    case "conferenceTable": {
      const ports = item.variant?.ports ?? 0;
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={Math.min(w, d) * 0.22} fill="#eaa957" stroke="#c4862f" strokeWidth={0.03} />
          {Array.from({ length: ports }, (_, i) => {
            const z = -d / 2 + ((i + 1) / (ports + 1)) * d;
            return <rect key={i} x={-0.07} y={z - 0.12} width={0.14} height={0.24} fill="#fff" stroke="#3d3d3d" strokeWidth={0.02} />;
          })}
        </g>
      );
    }
    case "roundMeetingTable":
      return <circle r={w / 2} fill="#fbfbfa" stroke="#bdbdbd" strokeWidth={0.025} />;
    case "hDesk": {
      const L = hDeskLayout(item.size);
      return (
        <g>
          {L.desks.map((dk, i) => (
            <rect key={i} x={dk.x - L.deskWidth / 2} y={-d / 2} width={L.deskWidth} height={d} fill="#f7f7f5" stroke="#c9c9c6" strokeWidth={0.02} />
          ))}
          <rect x={-L.spine.width / 2} y={-L.spine.depth / 2} width={L.spine.width} height={L.spine.depth} fill="#efe9dd" stroke="#c9c2b4" strokeWidth={0.02} />
          {[-0.5, -0.15, 0.25, 0.55].map((x) => (
            <rect key={x} x={x * L.spine.width * 0.8} y={-0.12} width={0.18} height={0.24} fill="#c9a26b" opacity={0.75} />
          ))}
          {L.monitors.map((m, i) => (
            <rect key={i} x={m.x - 0.03} y={m.z - 0.28} width={0.06} height={0.56} rx={0.02} fill="#1d1d1f" />
          ))}
        </g>
      );
    }
    case "bench":
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.06} fill="#aaa59d" stroke="#8a847b" strokeWidth={0.02} />
          <rect x={-w / 2} y={-d / 2} width={w} height={0.14} rx={0.05} fill="#938d84" />
        </g>
      );
    case "lowCabinet":
      return <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#f7f7f5" stroke="#c8c8c5" strokeWidth={0.02} />;
    case "sofa":
    case "armchair": {
      const arm = item.kind === "sofa" ? 0.17 : 0.13;
      const fill = color ?? "#bdb5aa";
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.08} fill={fill} stroke="#857d72" strokeWidth={0.02} />
          <rect x={-w / 2} y={-d / 2} width={w} height={0.2} rx={0.06} fill="#000" opacity={0.12} />
          <rect x={-w / 2} y={-d / 2} width={arm} height={d} rx={0.06} fill="#000" opacity={0.1} />
          <rect x={w / 2 - arm} y={-d / 2} width={arm} height={d} rx={0.06} fill="#000" opacity={0.1} />
        </g>
      );
    }
    case "sideTable":
      return <circle r={w / 2} fill={color ?? "#d39a52"} stroke="#a8743a" strokeWidth={0.02} />;
    case "pantryCounter":
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#f8f8f6" stroke="#bdbdba" strokeWidth={0.02} />
          <rect x={-w / 2} y={-d / 2 - 0.02} width={w} height={0.04} fill="#d9d6d0" />
          <rect x={-0.25} y={-0.15} width={0.5} height={0.36} rx={0.04} fill="#cfd3d6" stroke="#9aa0a5" strokeWidth={0.015} />
          <rect x={-w / 2 + 0.25} y={-0.22} width={0.26} height={0.34} rx={0.03} fill="#1c1c1e" />
          <rect x={w / 2 - 0.66} y={-0.23} width={0.48} height={0.36} rx={0.03} fill="#1c1c1e" />
        </g>
      );
    // 거실(미니맵)
    case "rug":
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#e9dfcf" stroke="#5d6f80" strokeWidth={0.09} />
          <rect x={-w / 2 + 0.18} y={-d / 2 + 0.18} width={w - 0.36} height={d - 0.36} fill="none" stroke="#c0603f" strokeWidth={0.03} />
        </g>
      );
    case "coffeeTable":
      return <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.03} fill="#eeebe5" stroke="#6e4630" strokeWidth={0.03} />;
    case "tvConsole":
      return <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#6b4a34" stroke="#45301f" strokeWidth={0.02} />;
    case "tv":
      return <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.02} fill="#1c1c1e" />;
    case "bookshelf":
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#8b6a4a" stroke="#5e4630" strokeWidth={0.02} />
          {[-0.25, 0, 0.25].map((t) => (
            <line key={t} x1={t * w} y1={-d / 2} x2={t * w} y2={d / 2} stroke="#5e4630" strokeWidth={0.015} />
          ))}
        </g>
      );
    case "floorLamp":
      return <circle r={w / 2} fill="#f4efe6" stroke="#2a2a2a" strokeWidth={0.03} />;
    case "plant":
      return <circle r={w / 2} fill="#5f8a4f" stroke="#3e5f33" strokeWidth={0.02} />;
    case "door":
      return <rect x={-w / 2} y={-d / 2} width={w} height={Math.max(d, 0.06)} fill="#f2efe9" stroke="#9a9387" strokeWidth={0.015} />;
    case "pendantLamp": // 천장에 매달려 있어 평면에서는 생략
    case "wallArt":
      return null;
    case "unknown": // 미분류 가구: 빗금 박스 + "?"
      return (
        <g>
          <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#e7e2da" stroke="#8d857a" strokeWidth={0.02} strokeDasharray="0.06 0.04" />
          <line x1={-w / 2} y1={-d / 2} x2={w / 2} y2={d / 2} stroke="#8d857a" strokeWidth={0.015} />
          <line x1={-w / 2} y1={d / 2} x2={w / 2} y2={-d / 2} stroke="#8d857a" strokeWidth={0.015} />
        </g>
      );
    default:
      return <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#ddd" stroke="#999" strokeWidth={0.02} />;
  }
}

/** 파티션 평면(벽 구간·유리·문 열림 호). 2D 배치도·미니맵 공용 */
export function PartitionPlan({ p }: { p: PartitionSegment }) {
  const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
  const angle = (Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) * 180) / Math.PI;
  const openings = [...p.openings].sort((a, b) => a.offset - b.offset);
  const spans: [number, number][] = [];
  let s = 0;
  for (const o of openings) {
    if (o.offset - o.width / 2 > s) spans.push([s, o.offset - o.width / 2]);
    s = Math.max(s, o.offset + o.width / 2);
  }
  if (s < len) spans.push([s, len]);
  const t = Math.max(p.thickness, 0.07);
  return (
    // 로컬: x = a→b 방향, y = 왼쪽 법선(3D 로컬 +z와 같은 쪽)
    <g transform={`translate(${p.a[0]} ${p.a[1]}) rotate(${angle})`}>
      {spans.map(([x0, x1], i) =>
        p.kind === "glass" ? (
          <g key={i}>
            <rect x={x0} y={-t / 2} width={x1 - x0} height={t} fill={GLASS} />
            <line x1={x0} y1={0} x2={x1} y2={0} stroke="#eafaf6" strokeWidth={0.015} />
          </g>
        ) : (
          <rect key={i} x={x0} y={-t / 2} width={x1 - x0} height={t} fill={WALL} stroke={WALL_EDGE} strokeWidth={0.015} />
        ),
      )}
      {openings.map((o) => {
        if (!o.door || o.door.leaf === "none") return null;
        const x0 = o.offset - o.width / 2;
        const hingeX = o.door.hinge === "start" ? x0 : x0 + o.width;
        const dir = o.door.hinge === "start" ? 1 : -1;
        const a = (o.door.angle * Math.PI) / 180;
        // SVG 로컬 +y = (-dz, dx) = 3D 파티션 로컬 +z(PartitionSystem의 swing "pos" 방향)
        const side = o.door.swing === "pos" ? 1 : -1;
        const tipX = hingeX + dir * o.width * Math.cos(a);
        const tipY = side * o.width * Math.sin(a);
        const closedX = hingeX + dir * o.width;
        const sweep = (dir > 0) === (side > 0) ? 1 : 0;
        return (
          <g key={o.id}>
            <path d={`M ${closedX} 0 A ${o.width} ${o.width} 0 0 ${sweep} ${tipX} ${tipY}`} fill="none" stroke="#e8e4dc" strokeWidth={0.02} strokeDasharray="0.06 0.05" />
            <line
              x1={hingeX}
              y1={0}
              x2={tipX}
              y2={tipY}
              stroke={o.door.leaf === "glass" ? GLASS : o.door.leaf === "wood" ? "#d8954c" : "#f2efe9"}
              strokeWidth={0.05}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </g>
  );
}

/** 외벽 표시(실내 면에서 바깥으로 벽 두께만큼): 문·통로는 비우고 창은 하늘색, 문짝은 선(swings면 열림 호 포함). 2D 배치도·미니맵 공용 */
export function ExteriorWallsPlan({ room, swings = false }: { room: RoomConfig; swings?: boolean }) {
  const t = room.wallThickness;
  const quad = (f: PlanFrame, s0: number, s1: number, n0: number, n1: number) =>
    [planPoint(f, s0, n0), planPoint(f, s1, n0), planPoint(f, s1, n1), planPoint(f, s0, n1)].map((p) => p.join(",")).join(" ");
  return (
    <g>
      {WALL_IDS.map((wall) => {
        const f = wallPlanFrame(wall, room);
        const length = wall === "north" || wall === "south" ? room.width : room.depth;
        const openings = room.openings.filter((o) => o.wall === wall);
        const doors = openings.filter((o) => o.kind === "door").sort((a, b) => a.center - b.center);
        const spans: Vec2[] = [];
        let s = -t;
        for (const d of doors) {
          spans.push([s, d.center - d.width / 2]);
          s = d.center + d.width / 2;
        }
        spans.push([s, length + t]);
        return (
          <g key={wall}>
            {spans.map(([s0, s1]) => (
              <polygon key={s0} points={quad(f, s0, s1, -t, 0)} fill={WALL} stroke={WALL_EDGE} strokeWidth={0.02} />
            ))}
            {openings
              .filter((o) => o.kind === "window")
              .map((o) => (
                <polygon key={o.id} points={quad(f, o.center - o.width / 2, o.center + o.width / 2, -t + 0.04, -0.04)} fill={WINDOW} stroke="#2f3033" strokeWidth={0.02} />
              ))}
            {doors
              .filter((o) => o.door && o.door.leaf !== "none")
              .map((o) => {
                const x0 = o.center - o.width / 2;
                // 3D 문짝·충돌과 같은 위치(벽 두께 가운데 경첩)
                const [hinge, tip] = doorLeafSegment(f, x0, o.width, o.door!, -t / 2);
                const closed = planPoint(f, o.door!.hinge === "start" ? x0 + o.width : x0, -t / 2);
                const cross = (closed[0] - hinge[0]) * (tip[1] - hinge[1]) - (closed[1] - hinge[1]) * (tip[0] - hinge[0]);
                return (
                  <g key={o.id}>
                    {swings && (
                      <path
                        d={`M ${closed[0]} ${closed[1]} A ${o.width} ${o.width} 0 0 ${cross > 0 ? 1 : 0} ${tip[0]} ${tip[1]}`}
                        fill="none"
                        stroke="#e8e4dc"
                        strokeWidth={0.02}
                        strokeDasharray="0.06 0.05"
                      />
                    )}
                    <line x1={hinge[0]} y1={hinge[1]} x2={tip[0]} y2={tip[1]} stroke="#f2efe9" strokeWidth={swings ? 0.05 : 0.06} strokeLinecap="round" />
                  </g>
                );
              })}
          </g>
        );
      })}
    </g>
  );
}

function Pill({ x, y, label }: { x: number; y: number; label: string }) {
  const w = 0.36 * label.length * 0.72 + 0.6;
  return (
    <g>
      <rect x={x - w / 2} y={y - 0.29} width={w} height={0.58} rx={0.29} fill={NAVY} stroke="#fff" strokeWidth={0.05} />
      <text x={x} y={y + 0.02} fontSize={0.36} fontWeight={700} fill="#fff" textAnchor="middle" dominantBaseline="middle">
        {label}
      </text>
    </g>
  );
}

function ArrowLine({ x, y0, y1 }: { x: number; y0: number; y1: number }) {
  const dir = Math.sign(y1 - y0);
  return (
    <g>
      <line x1={x} y1={y0} x2={x} y2={y1 - dir * 0.2} stroke={NAVY} strokeWidth={0.09} />
      <path d={`M ${x - 0.17} ${y1 - dir * 0.26} L ${x} ${y1} L ${x + 0.17} ${y1 - dir * 0.26} Z`} fill={NAVY} />
    </g>
  );
}

function Dimension({ d, room }: { d: PlanDimensionView; room: RoomConfig }) {
  const { side, from, to, label, assumption } = d;
  const W = room.width;
  const D = room.depth;
  const off = 0.85 + room.wallThickness;
  const color = assumption ? "#8a8f98" : "#1f2937";
  if (side === "top" || side === "bottom") {
    const y = side === "top" ? -D / 2 - off : D / 2 + off;
    const ty = side === "top" ? y - 0.18 : y + 0.45;
    return (
      <g stroke={color} strokeWidth={0.025}>
        <line x1={from} y1={y} x2={to} y2={y} markerStart="url(#dim)" markerEnd="url(#dim)" strokeDasharray={assumption ? "0.08 0.06" : undefined} />
        <line x1={from} y1={y - 0.15} x2={from} y2={y + 0.15} />
        <line x1={to} y1={y - 0.15} x2={to} y2={y + 0.15} />
        <text x={(from + to) / 2} y={ty} fontSize={0.4} fontWeight={700} fill={color} stroke="none" textAnchor="middle">
          {label}
        </text>
      </g>
    );
  }
  const x = side === "left" ? -W / 2 - off : W / 2 + off;
  const tx = side === "left" ? x - 0.22 : x + 0.22;
  return (
    <g stroke={color} strokeWidth={0.025}>
      <line x1={x} y1={from} x2={x} y2={to} markerStart="url(#dim)" markerEnd="url(#dim)" strokeDasharray={assumption ? "0.08 0.06" : undefined} />
      <line x1={x - 0.15} y1={from} x2={x + 0.15} y2={from} />
      <line x1={x - 0.15} y1={to} x2={x + 0.15} y2={to} />
      <text
        x={tx}
        y={(from + to) / 2}
        fontSize={assumption ? 0.28 : 0.4}
        fontWeight={700}
        fill={color}
        stroke="none"
        textAnchor="middle"
        transform={`rotate(-90 ${tx} ${(from + to) / 2})`}
      >
        {label}
      </text>
    </g>
  );
}

/** 밝은 바닥 위의 글자는 어둡게 */
function isLight(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

const EMPTY_PLAN: PlanView = { zones: [], dimensions: [], callouts: [] };

export default function FloorPlanSvg({ scene }: { scene: SceneConfig }) {
  const { room } = scene;
  const W = room.width;
  const D = room.depth;
  const plan = scene.plan ?? EMPTY_PLAN;
  const vb = [-W / 2 - 2.0, -D / 2 - 1.8, W + 4.0, D + 3.65];

  return (
    <svg viewBox={vb.join(" ")} className="h-full w-full" role="img" aria-label={`${scene.title} 2D 배치도`}>
      <defs>
        <marker id="dim" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#1f2937" />
        </marker>
      </defs>

      {/* 바닥·영역 */}
      <rect x={-W / 2} y={-D / 2} width={W} height={D} fill={floorColor(scene.surfaceMaterials.floor)} />
      {plan.zones
        .filter((z) => z.material)
        .map((z) => (
          <rect key={z.id} x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} fill={floorColor(z.material)} />
        ))}
      {plan.zones
        .filter((z) => z.assumption)
        .map((z) => (
          <rect
            key={z.id}
            x={z.rect[0] + 0.08}
            y={z.rect[1] + 0.08}
            width={z.rect[2] - z.rect[0] - 0.16}
            height={z.rect[3] - z.rect[1] - 0.16}
            fill="none"
            stroke="#c9cbd1"
            strokeWidth={0.025}
            strokeDasharray="0.12 0.1"
            opacity={0.55}
          />
        ))}

      {/* 가구(3D와 같은 목록) */}
      {scene.furniture.map((it) => (
        <g key={it.id} transform={`translate(${it.position[0]} ${it.position[2]}) rotate(${-(it.rotationY ?? 0)})`}>
          <title>{it.label}</title>
          <FurnitureSymbol item={it} />
        </g>
      ))}

      {/* 내부 벽·문 */}
      {scene.partitions.map((p) => (
        <PartitionPlan key={p.id} p={p} />
      ))}

      {/* 외벽·창·출입문·기둥 */}
      <ExteriorWallsPlan room={room} swings />
      {scene.columns?.map((c) => (
        <rect key={c.id} x={c.center[0] - c.size[0] / 2} y={c.center[1] - c.size[1] / 2} width={c.size[0]} height={c.size[1]} fill="#55565a" />
      ))}

      {/* 공간명 */}
      {plan.zones
        .filter((z) => z.labelAt)
        .map((z) => {
          const dark = !isLight(floorColor(z.material ?? scene.surfaceMaterials.floor));
          return (
            <g key={z.id} fill={dark ? "#ffffff" : "#1f2937"} textAnchor="middle" style={{ paintOrder: "stroke" }} stroke={dark ? "#00000055" : "none"} strokeWidth={0.05}>
              <text x={z.labelAt![0]} y={z.labelAt![1] - 0.14} fontSize={z.assumption ? 0.24 : 0.34} fontWeight={700} opacity={z.assumption ? 0.75 : 1}>
                {z.label}
              </text>
              {z.sub && (
                <text x={z.labelAt![0]} y={z.labelAt![1] + 0.27} fontSize={z.assumption ? 0.22 : 0.28} fontWeight={600} opacity={z.assumption ? 0.75 : 1}>
                  {z.sub}
                </text>
              )}
            </g>
          );
        })}

      {/* 치수 */}
      {plan.dimensions.map((d, i) => (
        <Dimension key={i} d={d} room={room} />
      ))}

      {/* 이름표(예: H형 ①·② / 입구) */}
      {plan.callouts.map((c) =>
        c.side === "top" ? (
          <g key={c.id}>
            <ArrowLine x={c.x} y0={-D / 2 - 0.3} y1={c.tipZ} />
            <Pill x={c.x} y={-D / 2 - 0.5} label={c.label} />
          </g>
        ) : (
          <g key={c.id}>
            <ArrowLine x={c.x} y0={D / 2 + 1.0} y1={c.tipZ} />
            <Pill x={c.x} y={D / 2 + 1.25} label={c.label} />
          </g>
        ),
      )}
    </svg>
  );
}
