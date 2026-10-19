// 闭环路线生成 PoC —— 前后端共享类型（对应技术方案 V1.1 第七章）
import { z } from "zod";

export const LngLatSchema = z.object({ lng: z.number(), lat: z.number() });
export type LngLat = z.infer<typeof LngLatSchema>;

export const PreferencesSchema = z.object({
  highway: z.enum(["prefer", "neutral", "avoid"]).default("neutral"),
  roadScale: z.enum(["major", "balanced"]).default("balanced"),
  toll: z.enum(["neutral", "avoid"]).default("neutral"),
  direction: z.enum(["clockwise", "counterclockwise", "any"]).default("any"),
  shape: z.enum(["any", "circle", "square", "elongated"]).default("any"),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const GenerateInputSchema = z.object({
  origin: LngLatSchema,
  target: z.union([
    z.object({ type: z.literal("distance"), value: z.number().min(1).max(300) }),
    z.object({ type: z.literal("duration"), value: z.number().min(5).max(600) }),
  ]),
  avgSpeedKmh: z.number().min(10).max(120).default(40),
  preferences: PreferencesSchema.default({
    highway: "neutral", roadScale: "balanced", toll: "neutral", direction: "any", shape: "any",
  }),
  candidateCount: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  seed: z.number().int().optional(),
});
export type GenerateInput = z.infer<typeof GenerateInputSchema>;

export type LoopShape = "polygon" | "ellipse" | "square" | "lollipop";

export interface CandidateRoute {
  routeId: string;
  shape: LoopShape;
  distanceKm: number;
  durationMin: number;
  selfOverlapRatio: number; // 按 V1.1 六三算法计算
  backtrackRatio: number; // 折返率：同段路来回跑占比
  turnCount: number;
  score: number;
  strategy: number; // 高德 strategy 枚举（模拟模式下为等效值）
  clockwise: boolean;
  waypoints: LngLat[]; // 有序途经点，用于 App 接管
  polyline: [number, number][]; // [lng, lat]，仅用于预览
  previewMayDiffer: true;
}

export interface GenerateResponse {
  requestId: string;
  targetDistanceKm: number;
  routes: CandidateRoute[];
  warnings: string[];
  meta: {
    provider: "mock" | "amap";
    kUsed: number;
    callsUsed: number;
    evaluated: number;
    eliminated: Record<string, number>;
    elapsedMs: number;
    partial: boolean;
  };
}

// ---------- PoC 批量验收测试 ----------
// 测试矩阵与汇总逻辑放在 contracts：后端按用例执行，前端逐用例调用并汇总
// （矩阵全量跑需数分钟，单次 HTTP 会被网关超时掐断，故必须逐用例请求）。

export const POC_SCENARIOS = [
  { id: "dense-urban", label: "高密城区" },
  { id: "suburb", label: "郊区" },
  { id: "coastal", label: "跨江/沿海" },
  { id: "mountain", label: "山地边缘" },
  { id: "border", label: "行政边界" },
] as const;

export const POC_DISTANCES = [10, 30, 60] as const;

export const POC_STRATEGIES = [
  { label: "默认", preferences: { highway: "neutral", roadScale: "balanced", toll: "neutral", direction: "any" } },
  { label: "不走高速", preferences: { highway: "avoid", roadScale: "balanced", toll: "neutral", direction: "any" } },
  { label: "大路优先", preferences: { highway: "neutral", roadScale: "major", toll: "neutral", direction: "any" } },
] as const;

export interface PocCaseSpec {
  caseNo: number; // 1-based
  caseId: string;
  scenario: string;
  targetKm: number;
  strategyLabel: string;
  preferences: Preferences;
  seed: number;
}

export function buildPocCases(scenarioCount: number, seedBase: number): PocCaseSpec[] {
  const list: PocCaseSpec[] = [];
  let caseNo = 0;
  for (const sc of POC_SCENARIOS.slice(0, scenarioCount)) {
    for (const km of POC_DISTANCES) {
      for (const sp of POC_STRATEGIES) {
        caseNo++;
        list.push({
          caseNo,
          caseId: `case_${String(caseNo).padStart(2, "0")}`,
          scenario: sc.label,
          targetKm: km,
          strategyLabel: sp.label,
          preferences: { ...sp.preferences } as Preferences,
          seed: seedBase + caseNo * 7919 + sc.id.length * 131 + km,
        });
      }
    }
  }
  return list;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** 由已完成用例汇总指标与放行门槛（V1.1 十一） */
export function summarizePoc(cases: PocCaseResult[]): { metrics: PocMetrics; gates: PocGate[] } {
  const total = cases.length;
  const success = cases.filter((c) => c.ok);
  const three = cases.filter((c) => c.candidateCount >= 3);
  const devs = success.map((c) => c.bestDeviationPct!).sort((a, b) => a - b);
  const ovls = success.map((c) => c.bestSelfOverlapPct!).sort((a, b) => a - b);
  const lats = cases.map((c) => c.elapsedMs).sort((a, b) => a - b);

  const metrics: PocMetrics = {
    total,
    successRatePct: total ? Math.round((success.length / total) * 1000) / 10 : 0,
    threeCandidateRatePct: total ? Math.round((three.length / total) * 1000) / 10 : 0,
    deviationMedianPct: Math.round(percentile(devs, 50) * 10) / 10,
    deviationP90Pct: Math.round(percentile(devs, 90) * 10) / 10,
    selfOverlapMedianPct: Math.round(percentile(ovls, 50) * 10) / 10,
    latencyP95Ms: Math.round(percentile(lats, 95)),
  };

  const gates: PocGate[] = [
    { label: "至少 1 条候选成功率", threshold: "≥90%", actual: `${metrics.successRatePct}%`, pass: metrics.successRatePct >= 90 },
    { label: "3 条差异候选成功率", threshold: "≥70%", actual: `${metrics.threeCandidateRatePct}%`, pass: metrics.threeCandidateRatePct >= 70 },
    { label: "距离偏差中位数", threshold: "≤15%", actual: `${metrics.deviationMedianPct}%`, pass: metrics.deviationMedianPct <= 15 },
    { label: "P90 距离偏差", threshold: "≤25%", actual: `${metrics.deviationP90Pct}%`, pass: metrics.deviationP90Pct <= 25 },
    { label: "候选自重合率中位数", threshold: "≤60%", actual: `${metrics.selfOverlapMedianPct}%`, pass: metrics.selfOverlapMedianPct <= 60 },
    { label: "生成耗时 P95", threshold: "≤15s", actual: `${(metrics.latencyP95Ms / 1000).toFixed(1)}s`, pass: metrics.latencyP95Ms <= 15000 },
  ];

  return { metrics, gates };
}

export interface PocGate {
  label: string;
  threshold: string;
  actual: string;
  pass: boolean;
}

export interface PocCaseResult {
  caseId: string;
  scenario: string;
  targetKm: number;
  strategyLabel: string;
  ok: boolean; // ≥1 条候选
  candidateCount: number;
  bestDeviationPct: number | null;
  bestSelfOverlapPct: number | null;
  elapsedMs: number;
  failReason?: string;
}

export interface PocMetrics {
  total: number;
  successRatePct: number; // 至少 1 条候选
  threeCandidateRatePct: number; // 3 条差异候选
  deviationMedianPct: number;
  deviationP90Pct: number;
  selfOverlapMedianPct: number;
  latencyP95Ms: number;
}

// ---------- POI 吸附与搜索 ----------
export interface PoiItem {
  id: string;
  name: string;
  address: string;
  /** GCJ-02 */
  lng: number;
  lat: number;
  /** 距查询点/中心的距离（米），可选 */
  distanceM?: number;
}
