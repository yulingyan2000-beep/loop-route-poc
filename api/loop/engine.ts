// 闭环路线生成引擎 —— 按技术方案 V1.1 第六章实现
import type {
  CandidateRoute, GenerateInput, GenerateResponse, LoopShape, LngLat,
} from "../../contracts/loop";
import {
  backtrackRatio, bearing, countTurns, destination, haversine, pairwiseOverlap, rng, selfOverlapRatio, type Pt,
} from "./geo";
import { MockProvider, type RouteProvider, type RouteResult } from "./providers/mock";
import { AmapProvider } from "./providers/amap";
import { env } from "../lib/env";

// ---- 参数（V1.1：全部配置化，不写死为永久事实）----
const CFG = {
  kSeed: env.loopK, // 实测标定（真实路网 D实际/D ≈ 1.8；k=2/π×1.8≈1.15 初值迭代，0.85 实测收敛最快）
  radiiFactors: [0.85, 1.0, 1.15],
  radiusJitter: 0.15, // ±15% 抖动
  groupsPerRound: 12, // 主轮撒点组数（V1.1 五三：单次生成主轮 8~12 次调用）
  maxWaypoints: 5, // 产品侧自限（接口上限 16）
  globalTimeoutMs: 12000,
  minTargetKm: 3,
  maxTargetKm: 200,
  clampRatio: [0.5, 1.5] as const, // 自适应半径调整幅度（放宽以覆盖形状受限时的大幅偏差）
  hardDeviation: 0.25,
  hardOverlap: 0.6,
  hardBacktrack: 0.25, // 折返率硬剔除：同段路来回跑占比 >25% 直接淘汰
  dedupOverlap: 0.85, // 候选间重合去重阈值（原 0.7 偏严，真实路网同向候选易被合并，放宽到 0.85）
};

/** 用户偏好 → 高德 strategy 枚举（V1.1 五一映射表；35=不走高速，36=少收费） */
export function mapStrategy(p: GenerateInput["preferences"]): number {
  if (p.highway === "prefer") return 34;
  if (p.highway === "avoid") return 35;
  if (p.roadScale === "major") return 37;
  if (p.toll === "avoid") return 36;
  return 32; // 高德默认推荐
}

interface WaypointGroup {
  shape: LoopShape;
  waypoints: Pt[];
  clockwise: boolean;
}

/** 撒点：圆形(多边形) / 方形 / 长条(椭圆) /（默认关闭的）棒棒糖，测地计算生成 */
function scatter(origin: Pt, radiusM: number, rand: () => number, allowLollipop: boolean): WaypointGroup[] {
  const groups: WaypointGroup[] = [];
  for (const rf of CFG.radiiFactors) {
    const r = radiusM * rf * (1 + (rand() * 2 - 1) * CFG.radiusJitter);
    // 圆形：5~6 等角点近似圆 + 随机旋转
    const corners = 5 + Math.floor(rand() * 2);
    const rot = rand() * 360;
    for (const cw of [true, false]) {
      const pts: Pt[] = [];
      for (let i = 0; i < corners; i++) {
        const ang = rot + (cw ? 1 : -1) * (i * 360) / corners;
        pts.push(destination(origin, ang, r));
      }
      groups.push({ shape: "polygon", waypoints: pts, clockwise: cw });
    }
    // 方形：4 等角点（正方形顶点），近似方形闭环
    const sqRot = rand() * 360;
    for (const cw of [true, false]) {
      const pts: Pt[] = [];
      for (let i = 0; i < 4; i++) {
        const ang = sqRot + 45 + (cw ? 1 : -1) * i * 90; // 顶点偏移 45° 让边过轴
        pts.push(destination(origin, ang, r));
      }
      groups.push({ shape: "square", waypoints: pts, clockwise: cw });
    }
    // 长条(椭圆)：随机主轴拉伸 1.5~2.2，取 4 点
    const stretch = 1.5 + rand() * 0.7;
    const axisAng = rand() * 360;
    for (const cw of [true, false]) {
      const pts: Pt[] = [];
      for (let i = 0; i < 4; i++) {
        const base = (cw ? 1 : -1) * i * 90;
        const along = Math.cos((base * Math.PI) / 180) * stretch;
        const across = Math.sin((base * Math.PI) / 180) / stretch;
        const d = r * Math.sqrt(along * along + across * across);
        const ang = axisAng + (Math.atan2(across, along) * 180) / Math.PI + 90;
        pts.push(destination(origin, cw ? ang : -ang, Math.min(d, r * stretch)));
      }
      groups.push({ shape: "ellipse", waypoints: pts, clockwise: cw });
    }
    // 棒棒糖（默认关闭，V1.1：MVP 默认不启用）
    if (allowLollipop) {
      const ang = rand() * 360;
      groups.push({
        shape: "lollipop",
        waypoints: [destination(origin, ang, r * 1.5)],
        clockwise: true,
      });
    }
  }
  // 途经点数量自限
  for (const g of groups) g.waypoints = g.waypoints.slice(0, CFG.maxWaypoints);
  return groups;
}

interface Evaluated {
  group: WaypointGroup;
  result: RouteResult;
  deviation: number;
  overlap: number;
  backtrack: number;
  turns: number;
  uTurns: number;
  eliminated?: string;
  baseScore: number;
}

export async function generateLoop(input: GenerateInput): Promise<GenerateResponse> {
  const started = Date.now();
  const warnings: string[] = [];
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = rng(seed);

  // 目标距离换算与上下限（V1.1 六一 step 1）
  let targetKm =
    input.target.type === "distance"
      ? input.target.value
      : (input.target.value / 60) * input.avgSpeedKmh;
  targetKm = Math.min(CFG.maxTargetKm, Math.max(CFG.minTargetKm, targetKm));

  const strategy = mapStrategy(input.preferences);

  // Provider 选择：有高德 Key 用高德，否则模拟路网（PoC 默认）
  const amap = AmapProvider.fromEnv();
  let provider: RouteProvider;
  if (amap) {
    provider = amap;
  } else {
    const r0m = (targetKm * 1000) / (2 * Math.PI * CFG.kSeed);
    provider = new MockProvider(input.origin, r0m * 3.2, seed);
    warnings.push("当前为模拟路网模式：配置 AMAP_KEY 环境变量后自动切换为高德真实算路");
  }

  const direction = input.preferences.direction;
  const eliminated: Record<string, number> = {};
  let callsUsed = 0;
  const allowLollipop = false; // V1.1：棒棒糖默认关闭

  // 途经点吸附：跑两遍——第一遍把落在小区/景点/公园/学校内部的点搬离该区域，
  // 第二遍把搬离后的点吸附到区域外的道路上（避免吸附点仍卡在内部路）
  const snapWaypoints = async (wps: Pt[]): Promise<Pt[]> => {
    if (!provider.snapToRoad || wps.length === 0) return wps;
    const once = await provider.snapToRoad(wps);
    return provider.snapToRoad(once);
  };

  const shapePref = input.preferences.shape ?? "any";
  const runRound = async (radiusM: number, maxGroups = CFG.groupsPerRound): Promise<Evaluated[]> => {
    let groups = scatter(input.origin, radiusM, rand, allowLollipop);
    if (direction === "clockwise") groups = groups.filter((g) => g.clockwise);
    else if (direction === "counterclockwise") groups = groups.filter((g) => !g.clockwise);
    // 形状偏好过滤：circle→polygon(近似圆)、square→square、elongated→ellipse
    if (shapePref === "circle") groups = groups.filter((g) => g.shape === "polygon");
    else if (shapePref === "square") groups = groups.filter((g) => g.shape === "square");
    else if (shapePref === "elongated") groups = groups.filter((g) => g.shape === "ellipse");
    groups = groups.slice(0, maxGroups);

    // 途经点吸附到可通车道路并搬离内部区域，从源头避免路线钻进小区/景区内部路
    if (groups.length > 0) {
      const allWps = groups.flatMap((g) => g.waypoints);
      const snapped = await snapWaypoints(allWps);
      let k = 0;
      for (const g of groups) g.waypoints = g.waypoints.map(() => snapped[k++]);
    }

    const out: Evaluated[] = [];
    // 串行（高德 QPS 3 已由 provider 内令牌桶限制；模拟路网无开销）
    for (const group of groups) {
      if (Date.now() - started > CFG.globalTimeoutMs) {
        warnings.push("触发全局超时，返回已完成候选（结果不完整）");
        break;
      }
      callsUsed++;
      const result = await provider.route(input.origin, group.waypoints, strategy);
      if (!result) {
        eliminated["算路失败"] = (eliminated["算路失败"] ?? 0) + 1;
        continue;
      }
      const distanceKm = result.distanceM / 1000;
      const deviation = Math.abs(distanceKm - targetKm) / targetKm;
      if (deviation > CFG.hardDeviation) {
        eliminated["里程偏差>25%"] = (eliminated["里程偏差>25%"] ?? 0) + 1;
        out.push({ group, result, deviation, overlap: 0, backtrack: 0, turns: 0, uTurns: 0, eliminated: "deviation", baseScore: 0 });
        continue;
      }
      const overlap = selfOverlapRatio(result.polyline);
      if (overlap > CFG.hardOverlap) {
        eliminated["自重合率>60%"] = (eliminated["自重合率>60%"] ?? 0) + 1;
        out.push({ group, result, deviation, overlap, backtrack: 0, turns: 0, uTurns: 0, eliminated: "overlap", baseScore: 0 });
        continue;
      }
      // 折返检测：同一段路来回跑占比过高则硬剔除（折返路线体验差）
      const backtrack = backtrackRatio(result.polyline);
      if (backtrack > CFG.hardBacktrack) {
        eliminated["折返率>25%"] = (eliminated["折返率>25%"] ?? 0) + 1;
        out.push({ group, result, deviation, overlap, backtrack, turns: 0, uTurns: 0, eliminated: "backtrack", baseScore: 0 });
        continue;
      }
      const { turns, uTurns } = countTurns(result.polyline);
      if (uTurns >= 3) {
        eliminated["异常掉头"] = (eliminated["异常掉头"] ?? 0) + 1;
        out.push({ group, result, deviation, overlap, backtrack, turns, uTurns, eliminated: "uturn", baseScore: 0 });
        continue;
      }
      // 基础分：距离偏差 45 + 自重合 25 + 行驶复杂度 10 + 折返 10（候选差异 20 在选样阶段计算，超出 100 分上限可接受）
      const devScore = Math.max(0, 1 - deviation / CFG.hardDeviation) * 45;
      const ovlScore = Math.max(0, 1 - overlap / CFG.hardOverlap) * 25;
      const turnsPerKm = turns / Math.max(distanceKm, 0.1);
      const cplxScore = Math.max(0, 1 - Math.max(0, turnsPerKm - 1.2) / 3) * 10;
      const btScore = Math.max(0, 1 - backtrack / CFG.hardBacktrack) * 10;
      out.push({ group, result, deviation, overlap, backtrack, turns, uTurns, baseScore: devScore + ovlScore + cplxScore + btScore });
    }
    return out;
  };

  // 主轮（V1.1 六二：k=0.85 为 PoC 种子，r0 = D/(2πk)）
  // 形状系数：长条(椭圆)周长是同半径圆 ~1.35 倍；圆形多边形顶点在高密路网绕行多，也略降半径
  const kShape =
    shapePref === "elongated" ? CFG.kSeed * 1.35 :
    shapePref === "circle" ? CFG.kSeed * 1.12 :
    CFG.kSeed;
  const r0m = (targetKm * 1000) / (2 * Math.PI * kShape);
  let evaluated = await runRound(r0m);

  // 自适应半径校准轮（V1.1 六二/六五：r1 = r0 × D/D实际，比例限制 0.5~1.5，最多追加一轮）
  // 逐组校准：对每组按自身实际里程比例缩放其途经点半径，避免不同撒点形态互相污染反馈
  let usable = evaluated.filter((e) => !e.eliminated);
  const bestDeviation = evaluated.reduce(
    (m, e) => (e.result.distanceM > 0 ? Math.min(m, e.deviation) : m),
    Infinity,
  );
  if (
    (usable.length < input.candidateCount || bestDeviation > 0.1) &&
    Date.now() - started < CFG.globalTimeoutMs
  ) {
    const withDist = evaluated
      .filter((e) => e.result.distanceM > 0)
      .sort((a, b) => a.deviation - b.deviation);
    if (withDist.length > 0) {
      // 偏差最小的 8 组（自适应重试）
      const picked = withDist.slice(0, 8);
      warnings.push(
        usable.length === 0
          ? "主轮无可用候选，按各组实际里程反馈缩放半径重试"
          : "追加逐组半径校准轮以收敛里程偏差",
      );
      // 每组最多迭代 2 次缩放，校准调用预算（形状受限时收敛更难，放宽到 10）
      let calibBudget = 10;
      for (const seedGroup of picked) {
        if (calibBudget <= 0) break;
        let current: Evaluated = seedGroup;
        for (let iter = 0; iter < 2 && calibBudget > 0; iter++) {
          if (Date.now() - started > CFG.globalTimeoutMs) {
            warnings.push("校准轮触发全局超时，返回已完成候选（结果不完整）");
            calibBudget = 0;
            break;
          }
          const ratio = Math.min(
            CFG.clampRatio[1],
            Math.max(CFG.clampRatio[0], (targetKm * 1000) / current.result.distanceM),
          );
          if (Math.abs(ratio - 1) <= 0.02) break;
          const origin = input.origin;
          let scaled: Pt[] = current.group.waypoints.map((wp) =>
            destination(origin, bearing(origin, wp), haversine(origin, wp) * ratio),
          );
          // 缩放后的途经点同样吸附并搬离内部区域，防止缩回小区/景点内部
          scaled = await snapWaypoints(scaled);
          callsUsed++;
          calibBudget--;
          const result = await provider.route(origin, scaled, strategy);
          if (!result) {
            eliminated["校准轮算路失败"] = (eliminated["校准轮算路失败"] ?? 0) + 1;
            break;
          }
          const distanceKm = result.distanceM / 1000;
          const deviation = Math.abs(distanceKm - targetKm) / targetKm;
          if (deviation > CFG.hardDeviation) {
            eliminated["里程偏差>25%"] = (eliminated["里程偏差>25%"] ?? 0) + 1;
            break;
          }
          const overlap = selfOverlapRatio(result.polyline);
          if (overlap > CFG.hardOverlap) {
            eliminated["自重合率>60%"] = (eliminated["自重合率>60%"] ?? 0) + 1;
            break;
          }
          const backtrack = backtrackRatio(result.polyline);
          if (backtrack > CFG.hardBacktrack) {
            eliminated["折返率>25%"] = (eliminated["折返率>25%"] ?? 0) + 1;
            break;
          }
          const { turns, uTurns } = countTurns(result.polyline);
          if (uTurns >= 3) {
            eliminated["异常掉头"] = (eliminated["异常掉头"] ?? 0) + 1;
            break;
          }
          const devScore = Math.max(0, 1 - deviation / CFG.hardDeviation) * 45;
          const ovlScore = Math.max(0, 1 - overlap / CFG.hardOverlap) * 25;
          const turnsPerKm = turns / Math.max(distanceKm, 0.1);
          const cplxScore = Math.max(0, 1 - Math.max(0, turnsPerKm - 1.2) / 3) * 10;
          const btScore = Math.max(0, 1 - backtrack / CFG.hardBacktrack) * 10;
          const next: Evaluated = {
            group: { ...current.group, waypoints: scaled },
            result, deviation, overlap, backtrack, turns, uTurns,
            baseScore: devScore + ovlScore + cplxScore + btScore,
          };
          evaluated.push(next);
          current = next;
          if (next.deviation <= 0.12) break; // 已收敛
        }
      }
      usable = evaluated.filter((e) => !e.eliminated);
    } else if (usable.length === 0) {
      warnings.push("主轮全部算路失败且无法估计调整比例，未重试");
    }
  }

  // 选样：按基础分排序，逐个加入并计算候选差异分（权重 20），重合 >85% 去重
  usable.sort((a, b) => b.baseScore - a.baseScore);
  const selected: { e: Evaluated; score: number }[] = [];
  for (const e of usable) {
    if (selected.length >= input.candidateCount) break;
    let maxPair = 0;
    for (const s of selected) {
      const o = pairwiseOverlap(e.result.polyline, s.e.result.polyline);
      maxPair = Math.max(maxPair, o);
    }
    if (maxPair > CFG.dedupOverlap) {
      eliminated["候选重合去重"] = (eliminated["候选重合去重"] ?? 0) + 1;
      continue;
    }
    const diffScore = (1 - maxPair) * 20;
    selected.push({ e, score: Math.round((e.baseScore + diffScore) * 10) / 10 });
  }

  if (selected.length === 0) {
    warnings.push("无可用候选：建议调整目标距离、更换起点或放宽偏好");
  }

  const routes: CandidateRoute[] = selected.map(({ e, score }, i) => {
    // 闭环 polyline：确保首尾点一致（高德同起终点有时末点不严格等于起点）
    const pts = e.result.polyline.map((p) => [p.lng, p.lat] as [number, number]);
    if (pts.length >= 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) pts.push([f[0], f[1]]);
    }
    return {
      routeId: `c_${String(i + 1).padStart(2, "0")}`,
      shape: e.group.shape,
      distanceKm: Math.round((e.result.distanceM / 1000) * 100) / 100,
      durationMin: Math.round(e.result.durationS / 60),
      selfOverlapRatio: Math.round(e.overlap * 1000) / 1000,
      backtrackRatio: Math.round(e.backtrack * 1000) / 1000,
      turnCount: e.turns,
      score,
      strategy,
      clockwise: e.group.clockwise,
      waypoints: e.group.waypoints.map((p) => ({ lng: p.lng, lat: p.lat })) as LngLat[],
      polyline: pts,
      previewMayDiffer: true as const,
    };
  });

  return {
    requestId: `r_${Date.now().toString(36)}_${(seed % 65536).toString(36)}`,
    targetDistanceKm: Math.round(targetKm * 100) / 100,
    routes,
    warnings,
    meta: {
      provider: provider.name,
      kUsed: CFG.kSeed,
      callsUsed,
      evaluated: evaluated.length,
      eliminated,
      elapsedMs: Date.now() - started,
      partial: Date.now() - started > CFG.globalTimeoutMs,
    },
  };
}
