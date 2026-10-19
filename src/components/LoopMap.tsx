// 高德 JS API 2.0 地图：矢量底图 + AMap.Polyline 的 showDir 官方方向箭头
// 与 Leaflet 方案相比：底图/路线/箭头同为高德原生渲染，风格统一，方向箭头用官方白色箭头
import { useEffect, useRef } from "react";
import { ensureAmapJs } from "@/lib/locate";
import type { CandidateRoute, LngLat } from "@contracts/loop";

export const ROUTE_COLORS = ["#3E6B89", "#B08A3E", "#A4594E"];

interface Props {
  origin: LngLat;
  onPickOrigin: (p: LngLat) => void;
  routes: CandidateRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 递增加 1 时地图飞回 origin（用于「我的位置」按钮） */
  recenterSignal?: number;
}

export default function LoopMap({
  origin,
  onPickOrigin,
  routes,
  selectedId,
  onSelect,
  recenterSignal = 0,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const originMarkerRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const readyRef = useRef(false);
  const onPickRef = useRef(onPickOrigin);
  const onSelectRef = useRef(onSelect);
  onPickRef.current = onPickOrigin;
  onSelectRef.current = onSelect;

  // 初始化地图（只一次）
  useEffect(() => {
    let disposed = false;
    ensureAmapJs()
      .then((AMap) => {
        if (disposed || !boxRef.current) return;
        const map = new AMap.Map(boxRef.current, {
          center: [origin.lng, origin.lat],
          zoom: 12,
          viewMode: "2D",
          mapStyle: "amap://styles/normal",
        });
        map.on("click", (e: any) => {
          onPickRef.current({ lng: e.lnglat.lng, lat: e.lnglat.lat });
        });
        mapRef.current = map;
        readyRef.current = true;
        // 起点标记
        const marker = new AMap.Marker({
          position: [origin.lng, origin.lat],
          anchor: "center",
          content:
            '<div style="width:18px;height:18px;border-radius:50%;background:#263238;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
          zIndex: 120,
        });
        marker.setMap(map);
        originMarkerRef.current = marker;
      })
      .catch(() => {
        // JS API 加载失败：保持空白，由上层提示
      });
    return () => {
      disposed = true;
      readyRef.current = false;
      try {
        mapRef.current?.destroy();
      } catch { /* ignore */ }
      mapRef.current = null;
      originMarkerRef.current = null;
      overlaysRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 起点标记跟随 origin（不缩放地图）
  useEffect(() => {
    if (!readyRef.current) return;
    originMarkerRef.current?.setPosition([origin.lng, origin.lat]);
  }, [origin]);

  // 定位按钮/自动定位：飞回起点
  useEffect(() => {
    if (!readyRef.current || !mapRef.current) return;
    if (recenterSignal > 0) {
      const z = mapRef.current.getZoom();
      mapRef.current.setZoomAndCenter(Math.max(z, 14), [origin.lng, origin.lat], false, 600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterSignal]);

  // 路线渲染：重画所有候选折线 + 途经点 + 官方方向箭头（仅选中路线）
  useEffect(() => {
    if (!readyRef.current || !mapRef.current) return;
    const AMap = (window as any).AMap;
    const map = mapRef.current;
    // 清旧覆盖物
    for (const ov of overlaysRef.current) {
      try { map.remove(ov); } catch { /* ignore */ }
    }
    overlaysRef.current = [];

    for (let idx = 0; idx < routes.length; idx++) {
      const r = routes[idx];
      const active = r.routeId === selectedId;
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
      const path = r.polyline.map(([lng, lat]) => [lng, lat]);
      const line = new AMap.Polyline({
        path,
        strokeColor: color,
        strokeWeight: active ? 6 : 4,
        strokeOpacity: selectedId === null || active ? 0.9 : 0.25,
        lineJoin: "round",
        lineCap: "round",
        zIndex: active ? 60 : 50,
        // 官方方向箭头：仅选中路线，白色箭头
        showDir: active,
        dirColor: "#ffffff",
        cursor: "pointer",
        extData: r.routeId,
      });
      line.on("click", () => onSelectRef.current(r.routeId));
      line.setMap(map);
      overlaysRef.current.push(line);
      // 途经点
      for (const wp of r.waypoints) {
        const dot = new AMap.CircleMarker({
          center: [wp.lng, wp.lat],
          radius: 4,
          strokeColor: color,
          strokeWeight: 2,
          strokeOpacity: 0.9,
          fillColor: "#ffffff",
          fillOpacity: 0.9,
          zIndex: 55,
        });
        dot.setMap(map);
        overlaysRef.current.push(dot);
      }
    }

    // 仅在生成新路线时自适应视野（手动选点不缩放）
    if (routes.length > 0) {
      const pts: [number, number][] = [[origin.lng, origin.lat]];
      for (const r of routes) for (const [lng, lat] of r.polyline) pts.push([lng, lat]);
      const bounds = new AMap.Bounds(
        [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
        [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
      );
      map.setBounds(bounds, false, [40, 40, 40, 40]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, selectedId]);

  return <div ref={boxRef} className="h-full w-full" />;
}
