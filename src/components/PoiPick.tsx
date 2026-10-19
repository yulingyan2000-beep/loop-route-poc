// POI 吸附与搜索（前端组件）
// 1) PoiSearch：搜索框联想，选中即设为起点
// 2) PoiAroundSheet：点击地图后展示附近 POI，可吸附到最近 POI 或保留原坐标
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import type { LngLat, PoiItem } from "@contracts/loop";
import { Input } from "@/components/ui/input";

/** 搜索框：输入联想，点击结果设为起点 */
export function PoiSearch({
  center,
  onPick,
}: {
  center: LngLat;
  onPick: (poi: PoiItem) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖 350ms
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const query = trpc.loop.poiSearch.useQuery(
    { keywords: debounced, lng: center.lng, lat: center.lat },
    { enabled: debounced.length > 0, staleTime: 30_000 },
  );
  const items = query.data?.pois ?? [];
  const loading = query.isFetching && debounced.length > 0;

  // 点击外部收起
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <Input
        value={q}
        className="h-11"
        placeholder="搜索地点设为起点（如：人民广场）"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && q.trim() && (
        <div className="absolute z-[1002] mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover shadow-lg">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">搜索中…</div>}
          {!loading && debounced && items.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">无结果</div>
          )}
          {!loading &&
            items.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  onPick(p);
                  setQ(p.name);
                  setOpen(false);
                }}
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="line-clamp-1 text-xs text-muted-foreground">{p.address}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** 点图吸附面板：附近 POI 列表 + 保留原坐标（贴合地图底部，风格与卡片一致） */
export function PoiAroundSheet({
  pois,
  loading,
  onSnap,
  onKeepRaw,
  onClose,
}: {
  pois: PoiItem[];
  loading: boolean;
  onSnap: (poi: PoiItem) => void;
  onKeepRaw: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1002] flex justify-center p-3">
      <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">吸附到附近地点？</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="h-px bg-border" />

        {/* POI 列表 */}
        <div className="max-h-60 overflow-y-auto">
          {loading && (
            <div className="px-4 py-3 text-xs text-muted-foreground">查询附近地点…</div>
          )}
          {!loading && pois.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">附近没有可吸附的地点，已使用所选坐标</div>
          )}
          {!loading &&
            pois.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                onClick={() => onSnap(p)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{p.address}</span>
                </span>
                {typeof p.distanceM === "number" && (
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                    {p.distanceM < 1000 ? `${Math.round(p.distanceM)}m` : `${(p.distanceM / 1000).toFixed(1)}km`}
                  </span>
                )}
              </button>
            ))}
        </div>

        {/* 保留原坐标 */}
        <div className="h-px bg-border" />
        <button
          type="button"
          onClick={onKeepRaw}
          className="w-full px-4 py-3 text-left transition-colors hover:bg-muted"
        >
          <span className="block text-sm font-medium">使用地图所选位置</span>
          <span className="block text-xs text-muted-foreground">不吸附到任何地点</span>
        </button>
      </div>
    </div>
  );
}
