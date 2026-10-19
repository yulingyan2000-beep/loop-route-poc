import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import type { CandidateRoute, GenerateInput, LngLat } from "@contracts/loop";
import { wgs84ToGcj02 } from "@/lib/gcj02";
import { locate } from "@/lib/locate";
import LoopMap, { ROUTE_COLORS } from "@/components/LoopMap";
import { PoiSearch, PoiAroundSheet } from "@/components/PoiPick";
import type { PoiItem } from "@contracts/loop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// 底图为高德瓦片（GCJ-02），默认起点同样转 GCJ-02
const DEFAULT_ORIGIN: LngLat = (() => {
  const [lng, lat] = wgs84ToGcj02(121.4737, 31.2304); // 上海人民广场（WGS-84）
  return { lng, lat };
})();

type TargetType = "distance" | "duration";

interface FormState {
  targetType: TargetType;
  /** 数字输入保持字符串，清空后不再被填回 0；提交时才转 number */
  value: string;
  avgSpeedKmh: string;
  highway: "prefer" | "neutral" | "avoid";
  roadScale: "major" | "balanced";
  toll: "neutral" | "avoid";
  direction: "clockwise" | "counterclockwise" | "any";
  shape: "any" | "circle" | "square" | "elongated";
}

const DEFAULT_FORM: FormState = {
  targetType: "distance",
  value: "30",
  avgSpeedKmh: "40",
  highway: "neutral",
  roadScale: "major", // 默认大路优先：尽量避开小区/园区等内部道路
  toll: "neutral",
  direction: "any",
  shape: "any",
};

const SHAPE_LABEL: Record<string, string> = {
  polygon: "圆形",
  ellipse: "长条",
  square: "方形",
  lollipop: "往返",
};

// 全链路统一 GCJ-02 坐标（底图、路线、接力 URI 同系，免纠偏；dev=0 表示传入坐标已是高德系）
// App 接力用官方 amapuri:// scheme，途经点必须 vian/vialons/vialats/vianames 四个参数配齐、
// 且用 "|" 分隔——之前用逗号分隔且缺 vian，App 静默丢弃途经点，把闭环退化成短路线。
// H5 兜底用 ditu.amap.com/dir 的 via[i][lnglat] 索引格式（实测稳定，最多 5 个途经点）。
function buildAmapLinks(route: CandidateRoute, origin: LngLat): { app: string; h5: string } {
  const f = (n: number) => n.toFixed(6);
  const wps = route.waypoints.slice(0, 5);
  const viaName = (i: number) => encodeURIComponent(`途经点${i + 1}`);
  const app =
    `amapuri://route/plan/?sourceApplication=loop_poc` +
    `&slat=${f(origin.lat)}&slon=${f(origin.lng)}&sname=${encodeURIComponent("起点")}` +
    `&dlat=${f(origin.lat)}&dlon=${f(origin.lng)}&dname=${encodeURIComponent("起点（闭环）")}` +
    `&dev=0&t=0&vian=${wps.length}` +
    `&vialons=${wps.map((w) => f(w.lng)).join("|")}` +
    `&vialats=${wps.map((w) => f(w.lat)).join("|")}` +
    `&vianames=${wps.map((_, i) => viaName(i)).join("|")}`;
  const viaQuery = wps
    .map((w, i) => `&via[${i}][lnglat]=${f(w.lng)},${f(w.lat)}&via[${i}][name]=${viaName(i)}`)
    .join("");
  const h5 =
    `https://ditu.amap.com/dir?type=car&policy=1` +
    `&from[lnglat]=${f(origin.lng)},${f(origin.lat)}&from[name]=${encodeURIComponent("起点")}` +
    `&to[lnglat]=${f(origin.lng)},${f(origin.lat)}&to[name]=${encodeURIComponent("起点（闭环）")}` +
    `${viaQuery}&src=loop_poc`;
  return { app, h5 };
}

export default function Home() {
  const [origin, setOrigin] = useState<LngLat>(DEFAULT_ORIGIN);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [routes, setRoutes] = useState<CandidateRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ provider: string; elapsedMs: number; callsUsed: number } | null>(null);
  const [targetKm, setTargetKm] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  // 点图吸附：点击的原始坐标（附近 POI 由 useQuery 派生）
  const [tapRaw, setTapRaw] = useState<LngLat | null>(null);

  // 定位：进入页面自动请求一次；失败时保留默认起点，仍可点击地图选点（V1.1）
  const doLocate = useCallback(async (auto: boolean) => {
    setLocating(true);
    try {
      const r = await locate();
      setOrigin(r.pos);
      setRecenterSignal((s) => s + 1);
      setLocateMsg(r.rough ? "已定位（IP 粗定位，建议点击地图微调起点）" : "已定位到当前位置");
    } catch {
      setLocateMsg(auto ? "定位未授权，可点击地图选起点" : "定位失败，请检查浏览器定位权限");
    } finally {
      setLocating(false);
      window.setTimeout(() => setLocateMsg(null), 4000);
    }
  }, []);

  useEffect(() => {
    doLocate(true);
  }, [doLocate]);

  // POI 吸附：点击地图后查询附近 POI，弹吸附面板
  const aroundQuery = trpc.loop.poiAround.useQuery(
    { lng: tapRaw?.lng ?? 0, lat: tapRaw?.lat ?? 0 },
    { enabled: tapRaw !== null, staleTime: 60_000 },
  );
  const aroundPois = aroundQuery.data?.pois ?? [];
  const aroundLoading = tapRaw !== null && aroundQuery.isFetching;

  const onPickOrigin = useCallback((p: LngLat) => {
    // 先立即用原坐标作起点（保证可用），再查询附近 POI 供吸附
    setOrigin(p);
    setOriginLabel(null);
    setTapRaw(p);
  }, []);

  const snapToPoi = useCallback((poi: PoiItem) => {
    setOrigin({ lng: poi.lng, lat: poi.lat });
    setOriginLabel(poi.name);
    setTapRaw(null);
  }, []);

  const keepRaw = useCallback(() => {
    if (tapRaw) setOrigin(tapRaw);
    setOriginLabel(null);
    setTapRaw(null);
  }, [tapRaw]);

  // 最近输入（localStorage，V1.1 F7：仅存偏好与输入摘要）
  useEffect(() => {
    try {
      const saved = localStorage.getItem("loop_poc_form");
      if (saved) setForm({ ...DEFAULT_FORM, ...JSON.parse(saved) });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    localStorage.setItem("loop_poc_form", JSON.stringify(form));
  }, [form]);

  const generate = trpc.loop.generate.useMutation({
    onSuccess: (res) => {
      // 底图已是高德瓦片（GCJ-02），路线坐标原样渲染，无需纠偏
      const routes = res.routes;
      setRoutes(routes);
      setSelectedId(routes[0]?.routeId ?? null);
      setWarnings(res.warnings);
      setTargetKm(res.targetDistanceKm);
      setMeta({ provider: res.meta.provider, elapsedMs: res.meta.elapsedMs, callsUsed: res.meta.callsUsed });
    },
  });

  const onGenerate = () => {
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) return;
    const input: GenerateInput = {
      origin,
      target:
        form.targetType === "distance"
          ? { type: "distance", value }
          : { type: "duration", value },
      avgSpeedKmh: Number(form.avgSpeedKmh) || 40,
      preferences: {
        highway: form.highway,
        roadScale: form.roadScale,
        toll: form.toll,
        direction: form.direction,
        shape: form.shape,
      },
      candidateCount: 3,
    };
    generate.mutate(input);
  };

  const selected = useMemo(() => routes.find((r) => r.routeId === selectedId) ?? null, [routes, selectedId]);

  const takeover = (r: CandidateRoute) => {
    const { app } = buildAmapLinks(r, origin);
    window.location.href = app;
  };

  const copyUri = (r: CandidateRoute) => {
    const { h5 } = buildAmapLinks(r, origin);
    navigator.clipboard?.writeText(h5).then(() => {
      setCopied(r.routeId);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      {/* 地图：移动端在上，桌面端在右 */}
      <div className="relative order-first h-[42dvh] w-full lg:order-last lg:h-full lg:flex-1">
        <LoopMap
          origin={origin}
          onPickOrigin={onPickOrigin}
          routes={routes}
          selectedId={selectedId}
          onSelect={setSelectedId}
          recenterSignal={recenterSignal}
        />
        {tapRaw && (
          <PoiAroundSheet
            pois={aroundPois}
            loading={aroundLoading}
            onSnap={snapToPoi}
            onKeepRaw={keepRaw}
            onClose={() => setTapRaw(null)}
          />
        )}
        {/* 我的位置：重新定位并飞回（z-index 需高于 Leaflet 控件的 1000） */}
        <button
          type="button"
          onClick={() => doLocate(false)}
          disabled={locating}
          title="我的位置"
          aria-label="我的位置"
          className={`absolute bottom-5 right-3 z-[1001] flex h-11 w-11 items-center justify-center rounded-full border bg-background/95 shadow-md backdrop-blur transition-colors hover:bg-muted disabled:opacity-60 ${locating ? "animate-pulse" : ""}`}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="7" />
          </svg>
        </button>
        {locateMsg && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-[1001] -translate-x-1/2 rounded-full border bg-background/95 px-4 py-1.5 text-xs shadow backdrop-blur">
            {locateMsg}
          </div>
        )}
      </div>

      {/* 控制面板 */}
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-t bg-background lg:order-first lg:w-[400px] lg:flex-none lg:border-r lg:border-t-0">
        <div className="border-b px-5 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-foreground">闭环路线生成 · PoC</h1>
            <Link to="/poc" className="text-xs text-muted-foreground underline underline-offset-4">
              验收测试
            </Link>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            输入目标距离或时长，生成回到起点的驾车闭环候选。点击地图可更换起点。
          </p>
          {meta && (
            <Badge variant={meta.provider === "amap" ? "default" : "secondary"} className="mt-2">
              {meta.provider === "amap" ? "高德真实算路" : "模拟路网"} · 调用 {meta.callsUsed} 次 ·{" "}
              {(meta.elapsedMs / 1000).toFixed(1)}s
            </Badge>
          )}
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 起点：搜索地点 + 当前起点 */}
          <div className="space-y-1.5">
            <Label>起点</Label>
            <PoiSearch
              center={origin}
              onPick={(poi) => {
                setOrigin({ lng: poi.lng, lat: poi.lat });
                setOriginLabel(poi.name);
                setRecenterSignal((s) => s + 1);
              }}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              当前起点：{originLabel ?? "地图所选位置"}（可点击地图重新选择）
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>目标类型</Label>
              <Select
                value={form.targetType}
                onValueChange={(v) => setForm({ ...form, targetType: v as TargetType })}
              >
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="distance">按距离</SelectItem>
                  <SelectItem value="duration">按时长</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{form.targetType === "distance" ? "距离（公里）" : "时长（分钟）"}</Label>
              <Input
                type="number"
                className="h-11"
                value={form.value}
                min={form.targetType === "distance" ? 3 : 10}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </div>
          </div>

          {form.targetType === "duration" && (
            <div className="space-y-1.5">
              <Label>预估均速（km/h，用于时长换算距离）</Label>
              <Input
                type="number"
                className="h-11"
                value={form.avgSpeedKmh}
                min={10}
                max={120}
                onChange={(e) => setForm({ ...form, avgSpeedKmh: e.target.value })}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>高架/高速</Label>
              <Select value={form.highway} onValueChange={(v) => setForm({ ...form, highway: v as FormState["highway"] })}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="neutral">无所谓</SelectItem>
                  <SelectItem value="prefer">优先</SelectItem>
                  <SelectItem value="avoid">避开</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>道路规模</Label>
              <Select value={form.roadScale} onValueChange={(v) => setForm({ ...form, roadScale: v as FormState["roadScale"] })}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="major">大路优先（推荐）</SelectItem>
                  <SelectItem value="balanced">均衡</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">大路优先可减少穿小区/园区等内部道路</p>
            </div>
            <div className="space-y-1.5">
              <Label>收费</Label>
              <Select value={form.toll} onValueChange={(v) => setForm({ ...form, toll: v as FormState["toll"] })}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="neutral">无所谓</SelectItem>
                  <SelectItem value="avoid">少收费</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>环绕方向</Label>
              <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v as FormState["direction"] })}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">无偏好</SelectItem>
                  <SelectItem value="clockwise">顺时针</SelectItem>
                  <SelectItem value="counterclockwise">逆时针</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>闭环形状</Label>
              <Select value={form.shape} onValueChange={(v) => setForm({ ...form, shape: v as FormState["shape"] })}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">无偏好</SelectItem>
                  <SelectItem value="circle">圆形</SelectItem>
                  <SelectItem value="square">方形</SelectItem>
                  <SelectItem value="elongated">长条</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button className="h-12 w-full text-base" onClick={onGenerate} disabled={generate.isPending}>
            {generate.isPending ? "生成中…" : "生成闭环路线"}
          </Button>

          {generate.isError && (
            <Alert variant="destructive">
              <AlertTitle>生成失败</AlertTitle>
              <AlertDescription>{generate.error.message}</AlertDescription>
            </Alert>
          )}
          {warnings.length > 0 && (
            <Alert>
              <AlertTitle>提示</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* 候选路线卡片 */}
        {routes.length > 0 && (
          <div className="space-y-3 border-t px-5 py-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">候选路线（{routes.length}）</h2>
              {targetKm !== null && (
                <span className="text-xs text-muted-foreground">目标 {targetKm} km</span>
              )}
            </div>
            {routes.map((r, idx) => (
              <button
                key={r.routeId}
                type="button"
                onClick={() => setSelectedId(r.routeId)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selectedId === r.routeId ? "border-foreground bg-muted/50" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ background: ROUTE_COLORS[idx % ROUTE_COLORS.length] }}
                    />
                    <span className="text-sm font-medium">
                      {SHAPE_LABEL[r.shape]} · {r.clockwise ? "顺时针" : "逆时针"}
                    </span>
                  </div>
                  <Badge variant="outline">评分 {r.score}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1 text-center">
                  <div>
                    <div className="text-base font-semibold">{r.distanceKm}</div>
                    <div className="text-[10px] text-muted-foreground">实际 km</div>
                  </div>
                  <div>
                    <div className="text-base font-semibold">{r.durationMin}</div>
                    <div className="text-[10px] text-muted-foreground">预计分钟</div>
                  </div>
                  <div>
                    <div className="text-base font-semibold">{Math.round(r.selfOverlapRatio * 100)}%</div>
                    <div className="text-[10px] text-muted-foreground">自重合</div>
                  </div>
                  <div>
                    <div className="text-base font-semibold">{Math.round((r.backtrackRatio ?? 0) * 100)}%</div>
                    <div className="text-[10px] text-muted-foreground">折返率</div>
                  </div>
                  <div>
                    <div className="text-base font-semibold">{r.turnCount}</div>
                    <div className="text-[10px] text-muted-foreground">转弯数</div>
                  </div>
                </div>
                {selectedId === r.routeId && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <p className="text-xs text-amber-700">
                      高德地图将根据实时路况和本地偏好重新规划，最终线路可能与预览不同。
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" className="h-10 flex-1" onClick={(e) => { e.stopPropagation(); takeover(r); }}>
                        高德 App 接管导航
                      </Button>
                      <Button
                        size="sm" variant="outline" className="h-10"
                        onClick={(e) => { e.stopPropagation(); copyUri(r); }}
                      >
                        {copied === r.routeId ? "已复制" : "复制链接"}
                      </Button>
                    </div>
                  </div>
                )}
              </button>
            ))}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              候选卡片同时展示实际里程、预计时长与自重合率（V1.1 四一）。「接管导航」优先唤起高德 App（含全部途经点），未安装时自动降级到高德 H5 路线页；「复制链接」复制 H5 链接，可发到任意设备打开。微信等受限 WebView 请在系统浏览器中打开。
            </p>
          </div>
        )}
        {selected === null && routes.length === 0 && !generate.isPending && (
          <div className="px-5 pb-6 text-xs leading-relaxed text-muted-foreground">
            PoC 范围：仅驾车闭环；导航执行由高德 App 完成，本应用输出路线建议。
          </div>
        )}
      </div>
    </div>
  );
}
