// 球面测地计算工具（V1.1 六二：撒点必须使用测地计算，不能按经纬度差值平移）
export interface Pt { lng: number; lat: number }

const R = 6371000; // 地球半径（米）
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** 两点球面距离（米） */
export function haversine(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 初始方位角（度，0=正北，顺时针） */
export function bearing(a: Pt, b: Pt): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** 从某点沿方位角走 dist 米后的目的地坐标 */
export function destination(origin: Pt, bearingDeg: number, distM: number): Pt {
  const d = distM / R;
  const brng = rad(bearingDeg);
  const lat1 = rad(origin.lat);
  const lng1 = rad(origin.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lng: deg(lng2), lat: deg(lat2) };
}

/** 折线总长度（米） */
export function polylineLength(line: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < line.length; i++) sum += haversine(line[i - 1], line[i]);
  return sum;
}

export interface SampledPoint extends Pt {
  along: number; // 距折线起点的沿线距离（米）
  heading: number; // 该点处行进方向（度）
}

/** 按约 interval 米间距重采样折线，附带沿线里程与航向（V1.1 六三） */
export function resample(line: Pt[], interval = 20): SampledPoint[] {
  if (line.length < 2) return [];
  const out: SampledPoint[] = [];
  let along = 0;
  let prev = line[0];
  out.push({ ...prev, along: 0, heading: bearing(line[0], line[1]) });
  let carry = interval;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const segLen = haversine(a, b);
    if (segLen < 1e-6) continue;
    const segBearing = bearing(a, b);
    let walked = 0;
    while (walked + carry <= segLen) {
      const d = walked + carry;
      const p = destination(a, segBearing, d);
      along += carry;
      out.push({ ...p, along, heading: segBearing });
      walked = d;
      carry = interval;
    }
    carry -= segLen - walked;
    along += segLen - walked;
    prev = b;
  }
  return out;
}

// 局部平面坐标（以 ref 为原点，米），用于空间网格索引
function toLocalMeters(ref: Pt, p: Pt): { x: number; y: number } {
  const kx = 111320 * Math.cos((ref.lat * Math.PI) / 180);
  return { x: (p.lng - ref.lng) * kx, y: (p.lat - ref.lat) * 111320 };
}

/** 空间网格索引：cell 边长取 gapM，查询时看 ±1 邻域即可覆盖 gapM 范围 */
class SpatialGrid<T extends { x: number; y: number }> {
  private map = new Map<string, T[]>();
  private cell: number;
  constructor(cell: number) {
    this.cell = cell;
  }
  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  add(item: T): void {
    const k = this.key(item.x, item.y);
    const arr = this.map.get(k);
    if (arr) arr.push(item);
    else this.map.set(k, [item]);
  }
  neighbors(x: number, y: number): T[] {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const out: T[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get(`${cx + dx},${cy + dy}`);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }
}

/**
 * 自重合率（V1.1 六三）：
 * 20 米重采样；仅比较沿线相距 ≥minApartM 的非相邻采样段；
 * 空间距离 ≤maxGapM 且方向近似相反（航向差 ≥150°）记为疑似去回程重合。
 * 空间网格索引避免 O(n²)。
 */
export function selfOverlapRatio(
  line: Pt[],
  { interval = 20, minApartM = 500, maxGapM = 30, oppositeDeg = 150 } = {},
): number {
  const pts = resample(line, interval);
  if (pts.length < 3) return 0;
  const ref = pts[0];
  interface GP extends SampledPoint { x: number; y: number; i: number }
  const gps: GP[] = pts.map((p, i) => ({ ...p, ...toLocalMeters(ref, p), i }));
  const grid = new SpatialGrid<GP>(maxGapM);
  let overlappedM = 0;
  const counted = new Set<number>();
  for (const p of gps) {
    if (counted.has(p.i)) {
      grid.add(p);
      continue;
    }
    for (const q of grid.neighbors(p.x, p.y)) {
      if (counted.has(q.i)) continue;
      if (Math.abs(q.along - p.along) < minApartM) continue;
      const gap = Math.hypot(q.x - p.x, q.y - p.y);
      if (gap > maxGapM) continue;
      let dHeading = Math.abs(q.heading - p.heading) % 360;
      if (dHeading > 180) dHeading = 360 - dHeading;
      if (dHeading >= oppositeDeg) {
        counted.add(p.i);
        counted.add(q.i);
        overlappedM += interval * 2;
        break;
      }
    }
    grid.add(p);
  }
  const total = polylineLength(line);
  return total > 0 ? Math.min(1, overlappedM / total) : 0;
}

/** 转弯检测：相邻段航向变化超过阈值记为一次转弯；>150° 记为 U 型掉头 */
export function countTurns(line: Pt[], minAngleDeg = 45): { turns: number; uTurns: number } {
  const pts = resample(line, 40);
  let turns = 0;
  let uTurns = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.abs(pts[i].heading - pts[i - 1].heading) % 360;
    if (d > 180) d = 360 - d;
    if (d >= 150) uTurns++;
    else if (d >= minAngleDeg) turns++;
  }
  return { turns, uTurns };
}

/**
 * 折返率（同一段路来回跑）：
 * 识别"去程"与"返程"在空间上紧贴（≤maxGapM）、方向相反（航向差≥150°）、
 * 且沿线里程间隔较小（minApartM~maxApartM）的采样段——即开车出去又沿同一条路折回来的情况。
 * 与 selfOverlapRatio 的差别：selfOverlap 要求沿线相距 ≥500m（长距离去回程），
 * 这里捕捉间隔较小的紧贴折返，用于惩罚"折返过多"的候选。
 * 返回折返里程占比 0~1。
 */
export function backtrackRatio(
  line: Pt[],
  { interval = 20, minApartM = 60, maxApartM = 800, maxGapM = 30, oppositeDeg = 150 } = {},
): number {
  const pts = resample(line, interval);
  if (pts.length < 3) return 0;
  const ref = pts[0];
  interface GP extends SampledPoint { x: number; y: number; i: number }
  const gps: GP[] = pts.map((p, i) => ({ ...p, ...toLocalMeters(ref, p), i }));
  const grid = new SpatialGrid<GP>(maxGapM);
  let backtrackM = 0;
  const counted = new Set<number>();
  for (const p of gps) {
    for (const q of grid.neighbors(p.x, p.y)) {
      if (counted.has(q.i) || counted.has(p.i)) continue;
      const apart = Math.abs(q.along - p.along);
      if (apart < minApartM || apart > maxApartM) continue;
      const gap = Math.hypot(q.x - p.x, q.y - p.y);
      if (gap > maxGapM) continue;
      let dHeading = Math.abs(q.heading - p.heading) % 360;
      if (dHeading > 180) dHeading = 360 - dHeading;
      if (dHeading >= oppositeDeg) {
        counted.add(p.i);
        counted.add(q.i);
        backtrackM += interval * 2;
        break;
      }
    }
    grid.add(p);
  }
  const total = polylineLength(line);
  return total > 0 ? Math.min(1, backtrackM / total) : 0;
}

/** 两条候选路线的空间重合度（用于候选间去重）：互为近邻的采样点占比取较大值 */
export function pairwiseOverlap(a: Pt[], b: Pt[], maxGapM = 80): number {
  const pa = resample(a, 40);
  const pb = resample(b, 40);
  if (pa.length === 0 || pb.length === 0) return 0;
  const ref = pa[0];
  interface GP { x: number; y: number }
  const gb = new SpatialGrid<GP>(maxGapM);
  for (const q of pb) gb.add(toLocalMeters(ref, q));
  const nearB = (p: SampledPoint): boolean => {
    const lp = toLocalMeters(ref, p);
    return gb.neighbors(lp.x, lp.y).some((q) => Math.hypot(q.x - lp.x, q.y - lp.y) <= maxGapM);
  };
  const ga = new SpatialGrid<GP>(maxGapM);
  for (const p of pa) ga.add(toLocalMeters(ref, p));
  const nearA = (q: SampledPoint): boolean => {
    const lq = toLocalMeters(ref, q);
    return ga.neighbors(lq.x, lq.y).some((p) => Math.hypot(p.x - lq.x, p.y - lq.y) <= maxGapM);
  };
  const ra = pa.filter(nearB).length / pa.length;
  const rb = pb.filter(nearA).length / pb.length;
  return Math.max(ra, rb);
}

/** 简易可复现随机数（mulberry32），保证同一 seed 可复现测试 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
