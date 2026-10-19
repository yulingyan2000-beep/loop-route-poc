// 模拟路网 Provider：在起点周边生成"扰动方格 + 干道 + 随机断路"的合成路网，
// 用 Dijkstra 最短路模拟驾车算路，用于无高德 Key 时验证算法全链路。
import { haversine, rng, type Pt } from "../geo";

export interface RouteResult {
  polyline: Pt[];
  distanceM: number;
  durationS: number;
}

export interface RouteProvider {
  name: "mock" | "amap";
  route(origin: Pt, waypoints: Pt[], strategy: number): Promise<RouteResult | null>;
  /** 可选：把途经点吸附到最近的可通车道路，并搬离小区/景点/公园/学校等内部区域。仅真实路网实现。 */
  snapToRoad?(pts: Pt[]): Promise<Pt[]>;
}

interface Node {
  id: number;
  p: Pt;
  arterial: boolean;
}
interface Edge {
  to: number;
  distM: number;
  speedKmh: number;
}

const METERS_PER_DEG_LAT = 111320;

function toXY(origin: Pt, p: Pt): { x: number; y: number } {
  const kx = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * METERS_PER_DEG_LAT };
}
function toPt(origin: Pt, x: number, y: number): Pt {
  const kx = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { lng: origin.lng + x / kx, lat: origin.lat + y / METERS_PER_DEG_LAT };
}

export class MockProvider implements RouteProvider {
  name = "mock" as const;
  private origin: Pt;
  private nodes: Node[] = [];
  private adj: Edge[][] = [];
  private spacing: number;

  /** 以 origin 为中心、覆盖 ±extentM 的合成路网 */
  constructor(origin: Pt, extentM: number, seed: number, opts?: { spacingM?: number; dropRate?: number }) {
    this.origin = origin;
    this.spacing = opts?.spacingM ?? 330;
    const rand = rng(seed);
    let n = Math.max(6, Math.ceil((extentM * 2) / this.spacing));
    if (n > 90) {
      this.spacing = (extentM * 2) / 90; // 大范围目标时自适应加宽网格，限制节点规模
      n = 90;
    }
    const drop = opts?.dropRate ?? 0.12;

    // 节点：带扰动的方格网
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const x = -extentM + i * this.spacing + (rand() - 0.5) * this.spacing * 0.7;
        const y = -extentM + j * this.spacing + (rand() - 0.5) * this.spacing * 0.7;
        const arterial = i % 3 === 0 || j % 3 === 0; // 每 3 行/列一条干道
        this.nodes.push({ id: this.nodes.length, p: toPt(origin, x, y), arterial });
      }
    }
    this.adj = this.nodes.map(() => []);
    const idx = (i: number, j: number) => i * (n + 1) + j;
    const addEdge = (a: number, b: number) => {
      const na = this.nodes[a];
      const nb = this.nodes[b];
      const distM = haversine(na.p, nb.p);
      const arterial = na.arterial && nb.arterial;
      const speedKmh = arterial ? 55 : 30;
      this.adj[a].push({ to: b, distM, speedKmh });
      this.adj[b].push({ to: a, distM, speedKmh });
    };
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        if (i < n && rand() > drop) addEdge(idx(i, j), idx(i + 1, j));
        if (j < n && rand() > drop) addEdge(idx(i, j), idx(i, j + 1));
        // 极少量对角，主体为方格路网，接近真实城区绕行特征
        if (i < n && j < n && rand() < 0.02) addEdge(idx(i, j), idx(i + 1, j + 1));
      }
    }
    // 连通性修复：断路可能产生孤立节点/孤岛，把度为 0 的节点连到最近邻，
    // 再对剩余不连通分量做一次合并，保证任意吸附点之间可达
    const xy = (id: number) => toXY(this.origin, this.nodes[id].p);
    for (const node of this.nodes) {
      if (this.adj[node.id].length > 0) continue;
      let best = -1;
      let bestD = Infinity;
      for (const other of this.nodes) {
        if (other.id === node.id || this.adj[other.id].length === 0) continue;
        const a = xy(node.id);
        const b = xy(other.id);
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = other.id;
        }
      }
      if (best >= 0) addEdge(node.id, best);
    }
    // 合并不连通分量（BFS 找主分量，其余分量接到最近的主分量节点）
    const comp = new Array<number>(this.nodes.length).fill(-1);
    let compCount = 0;
    for (const node of this.nodes) {
      if (comp[node.id] >= 0 || this.adj[node.id].length === 0) continue;
      const queue = [node.id];
      comp[node.id] = compCount;
      while (queue.length) {
        const u = queue.pop()!;
        for (const e of this.adj[u]) {
          if (comp[e.to] < 0) {
            comp[e.to] = compCount;
            queue.push(e.to);
          }
        }
      }
      compCount++;
    }
    if (compCount > 1) {
      const sizes = new Array<number>(compCount).fill(0);
      for (const c of comp) if (c >= 0) sizes[c]++;
      const main = sizes.indexOf(Math.max(...sizes));
      for (let c = 0; c < compCount; c++) {
        if (c === main) continue;
        let ba = -1;
        let bb = -1;
        let bestD = Infinity;
        for (const na of this.nodes) {
          if (comp[na.id] !== c) continue;
          for (const nb of this.nodes) {
            if (comp[nb.id] !== main) continue;
            const a = xy(na.id);
            const b = xy(nb.id);
            const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
            if (d < bestD) {
              bestD = d;
              ba = na.id;
              bb = nb.id;
            }
          }
        }
        if (ba >= 0 && bb >= 0) addEdge(ba, bb);
      }
    }
  }

  private nearestNode(p: Pt): number {
    const { x, y } = toXY(this.origin, p);
    let best = 0;
    let bestD = Infinity;
    for (const node of this.nodes) {
      const np = toXY(this.origin, node.p);
      const d = (np.x - x) ** 2 + (np.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = node.id;
      }
    }
    return best;
  }

  /** 二叉堆 Dijkstra：weight 依据 strategy 折算（模拟高德策略效果） */
  private dijkstra(from: number, to: number, strategy: number): Node[] | null {
    const N = this.nodes.length;
    const dist = new Array<number>(N).fill(Infinity);
    const prev = new Array<number>(N).fill(-1);
    dist[from] = 0;

    const w = (e: Edge): number => {
      const node = this.nodes[e.to];
      let base = e.distM / e.speedKmh;
      if (strategy === 34) base *= node.arterial ? 0.6 : 1.6;
      else if (strategy === 35) base *= node.arterial ? 2.2 : 0.9;
      else if (strategy === 37) base *= node.arterial ? 0.85 : 1.25;
      else if (strategy === 36) base *= node.arterial ? 1.1 : 1.0;
      return base;
    };

    // 简易二叉堆 [weight, nodeId]
    const heap: [number, number][] = [[0, from]];
    const push = (item: [number, number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent][0] <= heap[i][0]) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = (): [number, number] | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };

    const done = new Array<boolean>(N).fill(false);
    for (;;) {
      const item = pop();
      if (!item) break;
      const [d, u] = item;
      if (done[u]) continue;
      done[u] = true;
      if (u === to) break;
      for (const e of this.adj[u]) {
        const nd = d + w(e);
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
          push([nd, e.to]);
        }
      }
    }
    if (!isFinite(dist[to])) return null;
    const path: Node[] = [];
    for (let cur = to; cur !== -1; cur = prev[cur]) path.unshift(this.nodes[cur]);
    return path;
  }

  async route(origin: Pt, waypoints: Pt[], strategy: number): Promise<RouteResult | null> {
    const seq = [origin, ...waypoints, origin]; // 闭环：起点=终点
    const polyline: Pt[] = [];
    let distanceM = 0;
    let durationS = 0;
    for (let s = 0; s < seq.length - 1; s++) {
      const a = this.nearestNode(seq[s]);
      const b = this.nearestNode(seq[s + 1]);
      const path = this.dijkstra(a, b, strategy);
      if (!path || path.length < 1) return null;
      const pts = path.map((nd) => nd.p);
      if (polyline.length > 0) pts.shift();
      polyline.push(...pts);
      for (let i = 1; i < path.length; i++) {
        const d = haversine(path[i - 1].p, path[i].p);
        distanceM += d;
        const speed = path[i].arterial && path[i - 1].arterial ? 55 : 30;
        durationS += (d / 1000 / speed) * 3600;
      }
    }
    if (distanceM < 100) return null;
    return { polyline, distanceM, durationS };
  }
}
