// 定位模块：优先高德 JS API 定位（返回 GCJ-02，与底图同系；浏览器定位被拒时
// 插件自动降级 IP 定位，至少能定到城市级），未配置 JS Key 时回退浏览器定位
// （WGS-84，转 GCJ-02 后使用）。
import { wgs84ToGcj02 } from "./gcj02";
import type { LngLat } from "@contracts/loop";

declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

const JS_KEY = (import.meta.env.VITE_AMAP_JS_KEY as string | undefined) || "";
const JS_CODE = (import.meta.env.VITE_AMAP_JS_CODE as string | undefined) || "";
// 高德 JS API 加载地址（默认官方；如需代理/网关可用 VITE_AMAP_JS_BASE 覆盖）
const JS_BASE = (import.meta.env.VITE_AMAP_JS_BASE as string | undefined) || "https://webapi.amap.com/maps";

export const AMAP_JS_LOCATE_ENABLED = Boolean(JS_KEY);

let amapLoading: Promise<any> | null = null;

function loadAmapJs(): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (amapLoading) return amapLoading;
  amapLoading = new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { securityJsCode: JS_CODE };
    const s = document.createElement("script");
    s.src = `${JS_BASE}?v=2.0&key=${JS_KEY}&plugin=AMap.Geolocation`;
    s.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error("AMap missing")));
    s.onerror = () => reject(new Error("amap js load failed"));
    document.head.appendChild(s);
  });
  // 加载失败后允许重试（清缓存 promise）
  amapLoading.catch(() => {
    amapLoading = null;
  });
  return amapLoading;
}

/** 供地图组件复用：加载并返回 AMap 全局对象 */
export function ensureAmapJs(): Promise<any> {
  return loadAmapJs();
}

function browserLocate(): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("浏览器不支持定位"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
        resolve({ lng, lat });
      },
      (err) => reject(err),
      { timeout: 8000, enableHighAccuracy: true, maximumAge: 60_000 },
    );
  });
}

function amapLocate(): Promise<{ pos: LngLat; rough: boolean }> {
  return loadAmapJs().then(
    (AMap) =>
      new Promise((resolve, reject) => {
        // convert 默认 true：插件内部把浏览器 WGS-84 结果转成 GCJ-02，与底图同系
        const geo = new AMap.Geolocation({
          enableHighAccuracy: true,
          timeout: 8000,
          needAddress: false,
        });
        geo.getCurrentPosition((status: string, result: any) => {
          if (status === "complete" && result?.position) {
            // IP 降级定位的精度为城市级（accuracy 缺失或特别大），标记为粗略
            const accuracy = Number(result?.accuracy ?? 0);
            const rough = !accuracy || accuracy > 1000;
            resolve({ pos: { lng: result.position.lng, lat: result.position.lat }, rough });
          } else {
            reject(new Error(result?.message || "高德定位失败"));
          }
        });
      }),
  );
}

export type LocateResult = {
  pos: LngLat;
  via: "amap" | "browser";
  /** true 表示 IP 城市级粗定位 */
  rough: boolean;
};

/** 定位：高德 JS API 优先（含 IP 兜底），失败后回退浏览器定位 */
export async function locate(): Promise<LocateResult> {
  if (AMAP_JS_LOCATE_ENABLED) {
    try {
      const r = await amapLocate();
      return { ...r, via: "amap" };
    } catch {
      // 继续走浏览器定位兜底
    }
  }
  return { pos: await browserLocate(), via: "browser", rough: false };
}
