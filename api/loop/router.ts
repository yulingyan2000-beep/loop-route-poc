// tRPC 路由：闭环生成 + PoC 验收测试（V1.1 第七/十章）
// 验收测试为「逐用例」模式：一次 HTTP 请求只跑一个用例，前端循环调用并实时汇总。
// 原因：接入真实高德后整个矩阵（27+ 用例 × 每例十余次 API 调用，QPS 3 限流）
// 需要数分钟，单次请求会被网关超时掐断（前端表现为 Unexpected end of JSON input）。
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import {
  GenerateInputSchema,
  buildPocCases,
  type PocCaseResult,
  type PoiItem,
} from "../../contracts/loop";
import { generateLoop } from "./engine";
import { env } from "../lib/env";

// ---------- POI（高德 Web 服务：周边搜索 + 输入提示）----------
// Key 仅在后端使用，前端不接触。

const AMAP_V3 = `${env.amapRestBase}/v3`;

async function amapGet<T>(url: string): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), env.amapTimeoutMs);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** 周边搜索：点击地图选点后的 POI 吸附候选（半径 300m，由近到远） */
async function aroundPois(key: string, lng: number, lat: number): Promise<PoiItem[]> {
  const params = new URLSearchParams({
    key,
    location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
    radius: "300",
    sortrule: "distance",
    offset: "6",
    page: "1",
    extensions: "base",
  });
  const data = await amapGet<{
    status?: string;
    pois?: { id?: string; name?: string; address?: string | string[]; location?: string; distance?: string }[];
  }>(`${AMAP_V3}/place/around?${params.toString()}`);
  if (data?.status !== "1" || !Array.isArray(data.pois)) return [];
  return data.pois
    .map((p, i): PoiItem | null => {
      const [plng, plat] = String(p.location ?? "").split(",").map(Number);
      const name = String(p.name ?? "").trim();
      if (!isFinite(plng) || !isFinite(plat) || !name) return null;
      return {
        id: p.id || `around_${i}`,
        name,
        address: Array.isArray(p.address) ? p.address.join("") : String(p.address ?? ""),
        lng: plng,
        lat: plat,
        distanceM: Number(p.distance ?? 0) || undefined,
      };
    })
    .filter((p): p is PoiItem => p !== null)
    .slice(0, 6);
}

/** 输入提示：搜索框联想（按输入中心点排序） */
async function tipPois(key: string, keywords: string, center?: { lng: number; lat: number }): Promise<PoiItem[]> {
  const params = new URLSearchParams({ key, keywords, datatype: "all" });
  if (center) params.set("location", `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`);
  const data = await amapGet<{
    status?: string;
    tips?: { id?: string | string[]; name?: string; address?: string | string[]; district?: string; location?: string | string[] }[];
  }>(`${AMAP_V3}/assistant/inputtips?${params.toString()}`);
  if (data?.status !== "1" || !Array.isArray(data.tips)) return [];
  return data.tips
    .map((t, i): PoiItem | null => {
      const loc = String(t.location ?? "");
      const [plng, plat] = loc.split(",").map(Number);
      const name = String(t.name ?? "").trim();
      // 公交站等无坐标/无 id 的提示项跳过
      if (!isFinite(plng) || !isFinite(plat) || !name) return null;
      const addr = Array.isArray(t.address) ? t.address.join("") : String(t.address ?? "");
      const district = String(t.district ?? "");
      return {
        id: typeof t.id === "string" && t.id ? t.id : `tip_${i}`,
        name,
        address: addr || district,
        lng: plng,
        lat: plat,
      };
    })
    .filter((p): p is PoiItem => p !== null)
    .slice(0, 8);
}

export const loopRouter = createRouter({
  generate: publicQuery
    .input(GenerateInputSchema)
    .mutation(({ input }) => generateLoop(input)),

  /** POI 吸附：返回点击位置附近的 POI（由近到远），供用户确认吸附 */
  poiAround: publicQuery
    .input(z.object({ lng: z.number(), lat: z.number() }))
    .query(async ({ input }): Promise<{ pois: PoiItem[] }> => {
      const key = env.amapKey;
      if (!key) return { pois: [] };
      return { pois: await aroundPois(key, input.lng, input.lat) };
    }),

  /** POI 搜索：输入提示联想 */
  poiSearch: publicQuery
    .input(z.object({ keywords: z.string().min(1).max(50), lng: z.number().optional(), lat: z.number().optional() }))
    .query(async ({ input }): Promise<{ pois: PoiItem[] }> => {
      const key = env.amapKey;
      if (!key || !input.keywords.trim()) return { pois: [] };
      const center = input.lng != null && input.lat != null ? { lng: input.lng, lat: input.lat } : undefined;
      return { pois: await tipPois(key, input.keywords.trim(), center) };
    }),

  /** 跑测试矩阵中的单个用例；用例定义见 contracts/loop.ts buildPocCases */
  pocCase: publicQuery
    .input(
      z.object({
        origin: z.object({ lng: z.number(), lat: z.number() }),
        caseNo: z.number().int().min(1),
        scenarioCount: z.number().int().min(1).max(5).default(3),
        seedBase: z.number().int().default(20261012),
      }),
    )
    .mutation(async ({ input }): Promise<PocCaseResult> => {
      const spec = buildPocCases(input.scenarioCount, input.seedBase)[input.caseNo - 1];
      if (!spec) throw new Error(`无用例 #${input.caseNo}`);
      const t0 = Date.now();
      const base = {
        caseId: spec.caseId,
        scenario: spec.scenario,
        targetKm: spec.targetKm,
        strategyLabel: spec.strategyLabel,
      };
      try {
        const res = await generateLoop({
          origin: input.origin,
          target: { type: "distance", value: spec.targetKm },
          avgSpeedKmh: 40,
          preferences: { ...spec.preferences },
          candidateCount: 3,
          seed: spec.seed,
        });
        const best = res.routes[0];
        return {
          ...base,
          ok: res.routes.length > 0,
          candidateCount: res.routes.length,
          bestDeviationPct: best
            ? Math.round((Math.abs(best.distanceKm - spec.targetKm) / spec.targetKm) * 1000) / 10
            : null,
          bestSelfOverlapPct: best ? Math.round(best.selfOverlapRatio * 1000) / 10 : null,
          elapsedMs: res.meta.elapsedMs,
          failReason: res.routes.length === 0 ? res.warnings.join("；") || "无候选" : undefined,
        };
      } catch (err) {
        return {
          ...base,
          ok: false,
          candidateCount: 0,
          bestDeviationPct: null,
          bestSelfOverlapPct: null,
          elapsedMs: Date.now() - t0,
          failReason: err instanceof Error ? err.message : "未知错误",
        };
      }
    }),
});
