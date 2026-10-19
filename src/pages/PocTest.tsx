import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import {
  buildPocCases,
  summarizePoc,
  type PocCaseResult,
  type PocGate,
  type PocMetrics,
} from "@contracts/loop";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const SCENARIO_COUNT = 3;
const SEED_BASE = 20261012;
const ORIGIN = { lng: 121.4797, lat: 31.2337 }; // 上海人民广场（GCJ-02）

export default function PocTest() {
  const specs = useMemo(() => buildPocCases(SCENARIO_COUNT, SEED_BASE), []);
  const [cases, setCases] = useState<PocCaseResult[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const stopRef = useRef(false);
  const pocCase = trpc.loop.pocCase.useMutation();

  const summary: { metrics: PocMetrics; gates: PocGate[] } | null =
    cases.length > 0 ? summarizePoc(cases) : null;

  const runAll = async () => {
    stopRef.current = false;
    setRunning(true);
    setDone(false);
    setCases([]);
    setStartedAt(Date.now());
    for (const spec of specs) {
      if (stopRef.current) break;
      try {
        const r = await pocCase.mutateAsync({
          origin: ORIGIN,
          caseNo: spec.caseNo,
          scenarioCount: SCENARIO_COUNT,
          seedBase: SEED_BASE,
        });
        if (stopRef.current) break;
        setCases((prev) => [...prev, r]);
      } catch (err) {
        setCases((prev) => [
          ...prev,
          {
            caseId: spec.caseId,
            scenario: spec.scenario,
            targetKm: spec.targetKm,
            strategyLabel: spec.strategyLabel,
            ok: false,
            candidateCount: 0,
            bestDeviationPct: null,
            bestSelfOverlapPct: null,
            elapsedMs: 0,
            failReason: err instanceof Error ? err.message : "请求失败",
          },
        ]);
      }
    }
    setRunning(false);
    setDone(true);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-bold">PoC 验收测试</h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            测试矩阵：场景 × 目标距离（10/30/60km）× 偏好策略（默认/不走高速/大路优先）。
            放行标准见技术方案 V1.1 第十章。模拟路网模式下结果仅验证算法链路；App 接管两项需真机验证。
          </p>
        </div>
        <Link
          to="/"
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground underline underline-offset-4"
        >
          返回生成器
        </Link>
      </div>

      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-3">
          <Button className="h-11" disabled={running} onClick={runAll}>
            {running ? "运行中…" : "运行测试矩阵"}
          </Button>
          {running && (
            <Button variant="outline" className="h-11" onClick={() => (stopRef.current = true)}>
              停止
            </Button>
          )}
          {(running || done) && (
            <span className="text-xs text-muted-foreground">
              {cases.length}/{specs.length} 用例
              {done && startedAt > 0 && ` · 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`}
            </span>
          )}
        </div>
        {(running || (done && cases.length > 0)) && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all duration-300"
              style={{ width: `${(cases.length / specs.length) * 100}%` }}
            />
          </div>
        )}
        {running && (
          <p className="text-[11px] text-muted-foreground">
            逐用例执行（真实高德算路受 QPS 限流，每用例约 5~10 秒），可中途停止，已跑完的用例会正常汇总。
          </p>
        )}
      </div>

      {summary && (
        <>
          {/* 放行门槛 */}
          <Card className="mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                放行门槛（V1.1 十一）{running && <span className="ml-2 text-xs font-normal text-muted-foreground">实时汇总中</span>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {summary.gates.map((g) => (
                  <div key={g.label} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs text-muted-foreground">{g.label}</span>
                      <Badge variant={g.pass ? "default" : "destructive"} className="shrink-0">
                        {g.pass ? "达标" : "未达标"}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xl font-semibold">{g.actual}</div>
                    <div className="text-[10px] text-muted-foreground">门槛 {g.threshold}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                未纳入自动测试的门槛：App 接管成功率（Android/iOS 各 ≥95%）、接管后里程变化（中位数 ≤15%）——需真机验证。
              </p>
            </CardContent>
          </Card>

          {/* 明细 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">用例明细</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>用例</TableHead>
                    <TableHead>场景</TableHead>
                    <TableHead className="text-right">目标 km</TableHead>
                    <TableHead>策略</TableHead>
                    <TableHead className="text-right">候选数</TableHead>
                    <TableHead className="text-right">偏差 %</TableHead>
                    <TableHead className="text-right">自重合 %</TableHead>
                    <TableHead className="text-right">耗时 ms</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => (
                    <TableRow key={c.caseId}>
                      <TableCell className="font-mono text-xs">{c.caseId}</TableCell>
                      <TableCell className="whitespace-nowrap">{c.scenario}</TableCell>
                      <TableCell className="text-right">{c.targetKm}</TableCell>
                      <TableCell className="whitespace-nowrap">{c.strategyLabel}</TableCell>
                      <TableCell className="text-right">{c.candidateCount}</TableCell>
                      <TableCell className="text-right">{c.bestDeviationPct ?? "—"}</TableCell>
                      <TableCell className="text-right">{c.bestSelfOverlapPct ?? "—"}</TableCell>
                      <TableCell className="text-right">{c.elapsedMs}</TableCell>
                      <TableCell>
                        {c.ok ? (
                          <Badge variant="default">通过</Badge>
                        ) : (
                          <span className="text-xs text-destructive" title={c.failReason}>
                            失败
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {running && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-xs text-muted-foreground">
                        正在运行下一个用例…
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
