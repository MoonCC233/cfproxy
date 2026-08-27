# cfproxy — Cloudflare VLESS 节点

基于 Cloudflare Workers / Pages Functions 的 VLESS + WebSocket + TLS 节点服务，用于访问境外服务。
协议兼容 **v2rayN / NekoBox / Clash.Meta / Sing-Box / Shadowrocket**。

> ⚠️ 请遵守所在地区法律法规，仅用于合法合规的用途。

---

## 目录结构

```
cfproxy/
├── worker.js            # Cloudflare Workers 版（推荐）
├── wrangler.toml        # Workers 部署配置
├── functions/[[path]].js # Cloudflare Pages Functions 版
├── functions/_routes.json
├── package.json
└── README.md
```

---

## 一、准备 UUID

生成你自己的 UUID（随便一个都行，记住它）：

```bash
# 方式1：在线 https://www.uuidgenerator.net
# 方式2：命令行
python -c "import uuid; print(uuid.uuid4())"
```

---

## 二、方式 A：部署到 Cloudflare Workers（推荐）

### 1. 安装 wrangler

```bash
npm install -g wrangler
# 或项目内
npm install
```

### 2. 登录

```bash
npx wrangler login
```

### 3. 配置 UUID（二选一）

- **简单**：直接编辑 `wrangler.toml` 里的 `UUID`（已填占位值，请替换）。
- **安全**：用 secret（不进代码仓库）

```bash
npx wrangler secret put UUID
# 提示输入时粘贴你的 UUID
```

> 若用 secret，请把 `wrangler.toml` 中的 `UUID = "..."` 那行删掉，避免冲突。

### 4. 部署

```bash
npx wrangler deploy
```

部署成功后会得到类似 `https://cf-vless.<你的子域>.workers.dev` 的地址。

---

## 三、方式 B：部署到 Cloudflare Pages

### 1. 推送到 GitHub

把整个 `cfproxy` 目录推到你的 GitHub 仓库。

### 2. 在 Cloudflare Pages 创建项目

- Build command：**留空**
- Build output directory：**留空**（或 `.`）
- 框架预设：None

### 3. 设置环境变量 / 密钥

Pages 项目 → **Settings → Environment variables**：

| 变量名 | 值         | 类型           |
| ------ | ---------- | -------------- |
| `UUID` | 你的 UUID  | Secret（推荐） |
| `PATH` | `/vless`   | 普通变量       |
| `NAME` | 节点显示名 | 普通变量       |

> 注意：Pages Functions 读取的是 `context.env`，所以变量名必须与代码一致（`UUID` / `PATH` / `NAME`）。

### 4. 部署

连接仓库后自动部署，或手动 **Deploy**。

---

## 四、客户端配置

部署完成后，你的节点信息：

- **地址 (Host)**：`你的域名`（Workers: `xxx.workers.dev`；Pages: `xxx.pages.dev`）
- **端口**：`443`
- **UUID**：你设置的 UUID
- **传输方式**：WebSocket
- **路径 (Path)**：`/vless`（即 `PATH` 变量）
- **TLS**：开启
- **SNI / host**：填你的域名
- **Fingerprint**：`chrome`

### 方式 1：直接导入订阅（最简单）

在客户端订阅里填入：

```
https://你的域名/sub
```

- 用 **v2rayN** 打开：自动得到 v2rayN 格式订阅。
- 用 **Clash.Meta / Sing-Box** 打开（UA 含 clash/singbox，或加 `?clash` / `?sb`）：自动跳转到订阅转换服务生成对应配置。

### 方式 2：手动填写

以 v2rayN 为例，新建 VLESS 节点：

```
地址: 你的域名
端口: 443
UUID: 你的UUID
传输: ws
路径: /vless
TLS: 开启
SNI: 你的域名
Fingerprint: chrome
```

### 手动构造的分享链接

```
vless://<UUID>@<你的域名>:443?type=ws&security=tls&path=%2Fvless&host=<你的域名>&sni=<你的域名>&fp=chrome&alpn=h2%2Chttp%2F1.1#CF-Node
```

---

## 五、常见问题

**Q：连不上？**

- 确认 `PATH` 与客户端路径一致（默认 `/vless`）。
- 确认 UUID 一致。
- Workers 免费版每日请求额度 10 万次，超出会限流。

**Q：想换路径？**

- 改 `wrangler.toml` 的 `PATH` 或 Pages 环境变量 `PATH`，重新部署。

**Q：想支持更多协议（Trojan / gRPC / 优选 IP）？**

- 本实现为精简稳定版，仅 VLESS+WS+TLS。如需完整功能（含优选订阅、SOCKS5 反代、gRPC、ECH 等），可参考社区项目 `cmliu/edgetunnel`。

**Q：Pages 与 Workers 区别？**

- Workers 更简单、延迟略低；Pages 适合已有静态站点托管需求。功能一致。

---

## 六、本地调试

```bash
npx wrangler dev
# 访问 http://127.0.0.1:8787/sub 查看订阅
```
