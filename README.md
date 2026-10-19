# 闭环路线生成 · Loop Route PoC

输入一个目标**距离**或**时长**，生成「起点 = 终点」的驾车闭环候选路线，可一键接力到高德 App 导航。适合遛弯、夜跑陪驾、试驾兜风等「想开一段再回到原点」的场景。

- 前端：React 19 + TypeScript + Vite + Tailwind / shadcn，高德 JS API 2.0 矢量地图
- 后端：Hono + tRPC 11，高德 Web 服务（路径规划 2.0 / POI / 逆地理）
- 算法：撒点（圆形 / 方形 / 长条）→ 途经点吸附与搬离小区·景点内部区域 → 高德真实算路 → 偏差/自重合/折返评分 → 返回前 3 候选

## 功能

- 按距离（km）或时长（分钟，配合预估均速换算）生成闭环
- 偏好：高速、道路规模（大路优先/均衡）、收费、环绕方向、闭环形状（圆/方/长条）
- 起点：自动定位 / 搜索 POI / 点击地图选点（带附近 POI 吸附）
- 候选卡片：实际里程、预计时长、自重合率、折返率、转弯数、评分
- 一键唤起高德 App 接管导航（含全部途经点），或复制 H5 链接
- `/poc` 验收测试页：按矩阵逐用例跑真实算路并汇总放行门槛

## 快速开始

```bash
npm install
cp .env.example .env   # 填入你的高德 Key
npm run dev            # 开发（前后端一体，Vite + Hono）
```

生产构建与启动：

```bash
npm run build
npm start              # NODE_ENV=production，默认 3000 端口
```

## 配置（环境变量）

所有 Key 与接口地址均通过环境变量注入，**仓库不含任何真实密钥**。见 [.env.example](./.env.example)。

| 变量 | 说明 | 必填 |
|---|---|---|
| `AMAP_KEY` | 高德「**Web 服务**」Key：后端算路/POI/逆地理 | 真实路网必填；留空则用内置模拟路网演示 |
| `AMAP_QPS` | Web 服务限流（默认 3） | 否 |
| `AMAP_TIMEOUT_MS` | 高德接口超时（默认 8000） | 否 |
| `AMAP_REST_BASE` | Web 服务 base（默认 `https://restapi.amap.com`，代理/网关时覆盖） | 否 |
| `VITE_AMAP_JS_KEY` | 高德「**Web端(JS API)**」Key：前端地图渲染+定位 | 否（不配则仅浏览器定位） |
| `VITE_AMAP_JS_CODE` | JS API 对应的安全密钥 | 否 |
| `VITE_AMAP_JS_BASE` | JS API 加载地址（默认 `https://webapi.amap.com/maps`） | 否 |
| `PORT` | 生产端口（默认 3000） | 否 |
| `LOOP_K` | 闭环算法标定系数（默认 0.85，一般无需改） | 否 |

> ⚠️ `AMAP_KEY` 为后端专用，切勿以前缀 `VITE_` 暴露到前端。
> `VITE_AMAP_JS_KEY` 按高德设计会随前端打包暴露，请在高德控制台为它配置**域名白名单**（只填域名，不带协议/端口/路径，不支持通配符）。

## 安全

- 后端 Web 服务 Key 只在服务端使用，前端不接触。
- `.env` 已在 `.gitignore` 中排除；开源前请确认不要把本地 `.env` 提交进仓库。
- 如果你在历史版本中误提交过密钥，请到高德控制台**重置 Key** 后再公开仓库。

## License

[MIT](./LICENSE)
