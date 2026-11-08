# 91 video · 用 Workers KV 统计「被骗人数」的 Rickroll 整活页

> 单文件静态前端 + Cloudflare Workers KV 全局计数器。不用 localStorage，不做花哨特效，只做一件事：把人骗到 Rick Astley 面前，再告诉他排第几。

[![GitHub](https://img.shields.io/badge/GitHub-linyuanxuan%2F9191919191-181717?logo=github)](https://github.com/linyuanxuan/9191919191)
![License](https://img.shields.io/badge/license-MIT-blue)


---

## 这是什么

一个经典的 Rickroll 玩笑：落地页写着「本站永远免费」，两个通道按钮都把访客送到同一个被骗页。

被骗页不只是放视频，还会告诉访客「你是第 N 个被骗的」。这个 N 存在 Cloudflare Workers KV 里，由后端统一维护——页面不用 localStorage、不用 cookie，换设备、换浏览器看到的都是同一个全局数字。

实现上刻意保持克制：前端一个 HTML 文件，后端一个 JS 文件，零第三方依赖；CORS、OPTIONS 预检、IP 限流、脏数据容错、接口超时降级都在后端和前端各兜一层，网络出问题也不会把页面卡死。

## 特性

| | |
|---|---|
| 单文件前端 | 白底黑框，两个通道都指向同一个被骗页；hash 路由切换视图，不刷新页面。 |
| 后端全局计数 | Workers KV 保存全局计数，POST /api/hit 加一，GET /api/count 只读；页面不使用 localStorage。 |
| 自动播放兜底 | 先静音自动播放绕过浏览器限制，点击页面开启声音；接口超时与失败都有降级提示，不卡死页面。 |
| CORS 与预检 | OPTIONS 返回 204，所有响应含错误都带 CORS 头，并用 no-store 防止计数被缓存。 |
| 简单 IP 限流 | 单 IP 每 60 秒最多 5 次 hit，KV 里只存 IP 哈希，超限返回 429 与 Retry-After。 |
| 脏数据容错 | KV 内容非纯数字、负数或溢出一律按 0 处理；KV 读写异常返回 503 而不是让请求崩掉。 |

## 快速开始

### 1. 创建 KV 命名空间

```bash
npx wrangler login
npx wrangler kv namespace create COUNTER_KV
```

把输出的 id 填进 wrangler.toml 的 id 字段。本地 dev 可再加 --preview 生成 preview_id。

### 2. 部署 Worker

```bash
npx wrangler dev
npx wrangler deploy
```

部署成功后终端给出 https://rickroll-counter.<子域>.workers.dev，即 API 地址。

### 3. 配置前端 API 地址

编辑 `index.html` 顶部的 `<html>` 标签，把 `data-api` 换成你的 Worker 地址（完整示例见「使用说明」）。

临时测试可用查询参数覆盖：index.html?api=https://xxx.workers.dev。

### 4. 托管前端

```bash
git add -A
git commit -m "feat: 91 video Rickroll 计数器"
git push -u origin main
```

纯静态单文件，GitHub Pages 或 Cloudflare Pages 直接托管，无需构建。

## 使用说明

### 后端部署（Cloudflare Workers）

```bash
npx wrangler login
npx wrangler kv namespace create COUNTER_KV
```

把输出的 `id` 填进 `wrangler.toml` 的 `id = "..."`。需要本地 `wrangler dev` 时，再执行 `npx wrangler kv namespace create COUNTER_KV --preview`，把结果填到 `preview_id`。

```bash
npx wrangler dev       # 本地调试
npx wrangler deploy    # 上线
```

部署完成后终端会输出 `https://rickroll-counter.<子域>.workers.dev`，即前端要填的 API 地址。

### 前端配置

编辑 `index.html` 顶部的 `<html>` 标签，把 `data-api` 换成上一步的地址：

```html
<html lang="zh-CN" data-api="https://rickroll-counter.<子域>.workers.dev">
```

不想改文件时，可用查询参数临时覆盖：`index.html?api=https://xxx.workers.dev`。占位符未替换时页面会给出明确提示，不会发无效请求。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/hit` | 计数 +1，返回 `{"count": N}`；受 IP 限流约束 |
| GET | `/api/count` | 只读，返回 `{"count": N}`，不计数 |
| OPTIONS | 任意路径 | 返回 204 与 CORS 头 |

```bash
curl https://<worker>.workers.dev/api/count
curl -X POST https://<worker>.workers.dev/api/hit
```

错误统一为 `{"error": "..."}`：429 带 `Retry-After`，500 表示 KV 绑定缺失，503 表示 KV 读写失败。所有响应带 `Access-Control-Allow-Origin: *` 与 `Cache-Control: no-store`。

### Git 提交与推送

```bash
git init -b main
git add -A
git commit -m "feat: 91 video Rickroll 计数器"
git remote add origin https://github.com/linyuanxuan/9191919191.git
git push -u origin main
```

认证交给系统 Git（Credential Manager / SSH key），仓库里不放任何凭据。

## 规格

| 项 | 值 |
|---|---|
| 前端 | index.html 单文件，零构建、零框架 |
| 后端 | Cloudflare Workers，ES Module，src/index.js |
| 存储 | Workers KV，binding = COUNTER_KV |
| 第三方依赖 | 0 个（视频为 YouTube 官方嵌入播放器） |
| 限流 | 单 IP 60 秒最多 5 次 hit |
| 计数上限 | Number.MAX_SAFE_INTEGER - 1 |
| 许可 | MIT |

## 项目结构

```
91 video/
├── index.html        # 前端：落地页 + 被骗页（单文件双视图）
├── src/
│   └── index.js      # Cloudflare Workers 后端
├── wrangler.toml     # Worker 与 KV 绑定配置
├── showcase.html     # 项目介绍页（本仓库的说明页）
├── site.json         # 介绍页 / README 的生成配置
├── _headers          # Cloudflare Pages 响应头
├── README.md
└── LICENSE
```

## 已知限制

- **计数不是严格原子**：Workers KV 最终一致且没有原子自增，并发写入可能少量漏计。需要精确计数请换 Durable Objects。
- **限流不是安全边界**：同样受 KV 最终一致影响，属于尽力而为的防刷；要硬限流请用平台 Rate Limiting API 或 Durable Objects。
- **YouTube 可能被网络环境拦截**：页面会降级为普通 iframe 并给出跳转链接；降级模式下「点击开声音」靠重建播放器实现，成功率不是 100%。
- **两个占位符必须替换**：wrangler.toml 的 KV id 与 index.html 的 data-api 默认是占位值，不替换无法正常运行。

## 常见问题

<details>
<summary>计数为什么不用 localStorage？</summary>

localStorage 只在单个浏览器里累加，换设备就归零。本项目要的是全局数字，所以由 Workers KV 统一维护，前端每次进入被骗页只发一次 `POST /api/hit`。
</details>

<details>
<summary>视频没声音 / 没自动播放怎么办？</summary>

浏览器禁止无用户手势的有声自动播放，所以先静音播放；点击页面任意位置即可开启声音。若 YouTube 被网络拦截，页面会降级为普通 iframe 并给出直接打开链接。
</details>

<details>
<summary>静态托管会运行 Worker 吗？</summary>

不会。GitHub Pages / Cloudflare Pages 只托管 `index.html`，计数接口必须单独用 `npx wrangler deploy` 部署；两者是跨域调用，已由后端 CORS 头放行。
</details>

<details>
<summary>根目录的 showcase.html 是什么？</summary>

项目介绍页，用于说明设计与限制。真正对外服务的页面是根目录的 `index.html`（落地页 + 被骗页）。
</details>

## 部署前端页面

`index.html` 是纯静态单文件，无构建步骤，任何静态托管都能直接放。

### Cloudflare Pages（推荐，可用自定义域名）

| 项 | 值 |
|---|---|
| Framework preset | **None** |
| Build command | 留空 |
| Build output directory | `/` |
| 分支 | `main` |

Connect to Git 选中本仓库后保存即可，之后每次 push 自动重新部署。绑定域名：项目 → **Custom domains** → 输入子域，域名也在 Cloudflare 时 DNS 记录会自动创建。

根目录的 `_headers` 会被 Cloudflare Pages 识别，用于设置 `index.html` 的短缓存与安全响应头。

### GitHub Pages（备选）

Settings → Pages → Source 选 `main` + `/ (root)`，站点即 `https://linyuanxuan.github.io/9191919191/`。

> 两者都只托管静态前端页面，不会运行 Worker；接口需按上文单独部署。

## License

MIT · 详见 [LICENSE](LICENSE)。

---

<sub>整活归整活，代码是认真的。</sub>
