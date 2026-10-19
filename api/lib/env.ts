// 服务端运行配置：集中读取环境变量，给默认值，便于开源后按需覆盖。
// 注意：本文件不含任何真实密钥；密钥一律从环境变量注入（见 .env.example）。
import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  isProduction: process.env.NODE_ENV === "production",
  port: num("PORT", 3000),

  /** 高德 Web 服务 Key（后端算路/POI/逆地理用）。留空则自动回退到内置模拟路网。 */
  amapKey: process.env.AMAP_KEY ?? "",
  /** 高德 Web 服务 QPS 限流（令牌桶） */
  amapQps: num("AMAP_QPS", 3),
  /** 高德接口超时（毫秒） */
  amapTimeoutMs: num("AMAP_TIMEOUT_MS", 8000),
  /** 高德 Web 服务 base（默认官方；如需代理/网关可覆盖） */
  amapRestBase: process.env.AMAP_REST_BASE ?? "https://restapi.amap.com",

  /** 闭环算法标定系数 k（真实路网里程 / 理论圆周），开源用户一般无需改 */
  loopK: num("LOOP_K", 0.85),
} as const;
