// 高德 Web 服务 路径规划 2.0 驾车适配器。
// 需要在环境变量 AMAP_KEY 中配置 Web 服务 Key；QPS 通过令牌桶限制（配置项 AMAP_QPS，默认 3）。
// 未配置 Key 时 engine 自动回退到模拟路网，并在 warnings 中说明。
import type { Pt } from "../geo";
import { haversine } from "../geo";
import type { RouteProvider, RouteResult } from "./mock";
import { env } from "../../lib/env";

class TokenBucket {
  private tokens: number;
  private last: number = Date.now();
  private ratePerSec: number;
  private capacity: number;
  constructor(ratePerSec: number, capacity: number) {
    this.ratePerSec = ratePerSec;
    this.capacity = capacity;
    this.tokens = capacity;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }
}

export class AmapProvider implements RouteProvider {
  name = "amap" as const;
  private key: string;
  private bucket: TokenBucket;
  private timeoutMs: number;

  constructor(key: string) {
    this.key = key;
    this.bucket = new TokenBucket(env.amapQps, 3);
    this.timeoutMs = env.amapTimeoutMs;
  }

  static fromEnv(): AmapProvider | null {
    return env.amapKey ? new AmapProvider(env.amapKey) : null;
  }

  /**
   * 途经点吸附到可通车道路 + 搬离内部区域。
   * 批量逆地理（batch=true，≤20 点/次）拿最近道路 + 命中的 AOI；
   * 若途经点落在小区/景点/公园/学校等内部 AOI 里，先把点沿「远离 AOI 中心」方向搬到区域边缘，
   * 再吸附到最近道路，从源头避免路线钻进内部道路或步行区。失败/无结果时保留原点。
   */
  async snapToRoad(pts: Pt[]): Promise<Pt[]> {
    const out = pts.map((p) => ({ ...p }));
    const fmt = (p: Pt) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
    for (let i = 0; i < pts.length; i += 20) {
      const chunk = pts.slice(i, i + 20);
      const params = new URLSearchParams({
        key: this.key,
        location: chunk.map(fmt).join("|"),
        batch: "true",
        extensions: "all",
        radius: "2000",
      });
      const url = `${env.amapRestBase}/v3/geocode/regeo?${params.toString()}`;
      try {
        await this.bucket.take();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = (await resp.json()) as {
          status?: string;
          regeocodes?: {
            roads?: { location?: string }[];
            aois?: { type?: string; area?: string; location?: string }[];
          }[];
        };
        if (data.status !== "1" || !data.regeocodes) continue;
        data.regeocodes.forEach((rg, j) => {
          const orig = { ...pts[i + j] };
          let snapped: Pt = orig;
          const loc = rg.roads?.[0]?.location;
          if (loc) {
            const [lng, lat] = loc.split(",").map(Number);
            if (isFinite(lng) && isFinite(lat)) snapped = { lng, lat };
          }
          // 命中内部 AOI（小区/景点/公园/学校）：吸附点仍可能落在区域内部道路上，
          // 把点沿「远离 AOI 中心」搬到区域边缘外，后续由 engine 二次吸附到外部道路。
          const hit = (rg.aois ?? []).find((a) => a.type && AmapProvider.INTERNAL_AOI.test(a.type) && a.location && a.area);
          if (hit && hit.location) {
            const [clng, clat] = hit.location.split(",").map(Number);
            const areaM2 = Number(hit.area ?? 0);
            if (isFinite(clng) && isFinite(clat) && areaM2 > 0) {
              const center: Pt = { lng: clng, lat: clat };
              const edge = Math.sqrt(areaM2 / Math.PI); // 等效半径
              const distNow = haversine(snapped, center);
              if (distNow < edge + 30) {
                // 吸附点落在区域内（或贴边）：沿中心→点方向搬到边缘外 40m
                const target = edge + 40;
                if (distNow > 1) {
                  const ratio = target / distNow;
                  snapped = {
                    lng: center.lng + (snapped.lng - center.lng) * ratio,
                    lat: center.lat + (snapped.lat - center.lat) * ratio,
                  };
                } else {
                  // 几乎在 AOI 中心：朝东搬出
                  snapped = { lng: center.lng + target / (111320 * Math.cos((center.lat * Math.PI) / 180)), lat: center.lat };
                }
              }
            }
          }
          out[i + j] = snapped;
        });
      } catch {
        // 吸附失败保留原点，不影响后续算路
      }
    }
    return out;
  }

  // 需要规避的内部区域类别（高德 POI typecode 前缀）：
  // 1203xx 住宅区·住宅小区；1102xx 风景名胜·公园广场；110105 城市广场；1403xx 科教文化·学校
  private static readonly INTERNAL_AOI = /^(1203|1102|110105|1403)/;

  async route(origin: Pt, waypoints: Pt[], strategy: number): Promise<RouteResult | null> {
    const fmt = (p: Pt) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
    const params = new URLSearchParams({
      key: this.key,
      origin: fmt(origin),
      destination: fmt(origin), // 同起终点闭环
      strategy: String(strategy),
      show_fields: "cost,polyline", // polyline 不在默认响应中，必须显式请求；cost 提供 path 级时长
    });
    if (waypoints.length > 0) {
      // 高德驾车 2.0 途经点上限 16 个，产品侧自限 5 个
      params.set("waypoints", waypoints.slice(0, 16).map(fmt).join(";"));
    }
    const url = `${env.amapRestBase}/v5/direction/driving?${params.toString()}`;

    let attempt = 0;
    for (;;) {
      attempt++;
      await this.bucket.take();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = (await resp.json()) as {
          status?: string;
          info?: string;
          route?: {
            paths?: {
              distance?: string;
              duration?: string;
              cost?: { duration?: string }; // 时长在 path.cost.duration（需 show_fields=cost）
              steps?: { polyline?: string; cost?: { duration?: string } }[];
            }[];
          };
        };
        // 限流/异常：指数退避 + 随机抖动，最多 3 次
        if (data.status !== "1" || !data.route?.paths?.[0]) {
          if (attempt >= 3) return null;
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
          continue;
        }
        const path = data.route.paths[0];
        const polyline: Pt[] = [];
        for (const step of path.steps ?? []) {
          for (const pair of (step.polyline ?? "").split(";")) {
            if (!pair) continue;
            const [lng, lat] = pair.split(",").map(Number);
            if (isFinite(lng) && isFinite(lat)) polyline.push({ lng, lat });
          }
        }
        if (polyline.length < 2) return null;
        let durationS = Number(path.cost?.duration ?? path.duration ?? 0);
        if (!durationS) {
          // 回退：累加各 step 的 cost.duration
          durationS = (path.steps ?? []).reduce(
            (sum, s) => sum + Number(s.cost?.duration ?? 0),
            0,
          );
        }
        const distanceM = Number(path.distance ?? 0);
        if (!distanceM) return null;
        return { polyline, distanceM, durationS };
      } catch {
        if (attempt >= 3) return null;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
      }
    }
  }
}
