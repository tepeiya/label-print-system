# 38 · 部署与运维手册（客户现场版）

> 面向交付工程师。目标：一台干净的 Linux 服务器，按本文能在 30 分钟内起完整系统，并且知道上线后怎么备份、怎么升级、怎么回滚、怎么排故。
>
> 本文所有命令都在仓库根目录执行。脚本统一在 `deploy/`，客户数据导入工具在 `tools/data-migration/`。

## 1. 交付拓扑

一次 `docker compose up` 起 9 个服务，全部同机，不需要外网：

| 服务 | 作用 | 宿主端口（可用 .env 改） |
|---|---|---|
| postgres | PostgreSQL 16 + pgvector | 不对外（仅容器网络） |
| redis | 缓存 / 队列 | 不对外 |
| db-init | 一次性跑建表与种子 SQL，跑完即退 | — |
| api | NestJS 后端（REST + 队列消费入口） | `PORT_API`（默认 3200） |
| worker | 打印/派生任务队列消费者 | 不对外 |
| mcp | 供 AI 助手调用的 MCP 端点 | `PORT_MCP`（3300） |
| console | 租户管理后台（静态站 + nginx 反代 /api） | `PORT_CONSOLE`（5173） |
| platform | 平台运营后台（多租户） | `PORT_PLATFORM`（5181） |
| pda | 手持端页面（H5） | `PORT_PDA`（5185） |

外部依赖只有两个，且都在客户内网：

- **标签打印机**：走打印代理（Windows 小主机 + USB/网口打印机），见 §9。
- **手持终端 / 手机**：浏览器打开 `http://<服务器IP>:5185`。

## 2. 服务器要求

| 项目 | 最低 | 建议 |
|---|---|---|
| CPU | 4 核 | 8 核 |
| 内存 | 8 GB | 16 GB（含 PG + 5 个 Node 服务） |
| 磁盘 | 100 GB SSD | 256 GB，`/var/lib/docker` 单独分区更好 |
| 系统 | Ubuntu 22.04 / 24.04 LTS（或同代 Debian） | 同左 |
| Docker | Engine ≥ 24，含 compose 插件 | 官方 apt 源安装 |
| 时区 | Asia/Shanghai | 必须改，否则单据时间错 8 小时 |
| 网络 | 内网静态 IP | PDA 与打印机代理必须能访问该 IP |

```bash
# 时区
sudo timedatectl set-timezone Asia/Shanghai

# Docker（Ubuntu 官方脚本）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # 重新登录生效
docker compose version            # 应输出 v2.x
```

> 无外网的客户现场：先在能上网的机器 `docker save` 全部镜像成 tar，拷到现场 `docker load`，再用 `./deploy/init.sh --no-build`。镜像清单见 §10。

## 3. 首次部署

```bash
git clone <仓库地址> /opt/labelflow && cd /opt/labelflow

cp .env.example .env      # 也可以跳过，init.sh 会自动生成随机密钥
./deploy/init.sh          # 生产模式（.env 里 SEED_DEMO=0 时不灌演示数据）
```

`init.sh` 会依次做：依赖检查 → 生成 `.env`（随机 JWT/DB 口令/service token，权限 600）→ 端口占用检查 → 构建启动 → 轮询 `/api/v1/health` 直到通过 → 打印地址与账号。

演示/培训环境想带示例数据：

```bash
./deploy/init.sh --demo
```

起完访问：

```
租户后台  http://<IP>:5173      账号 admin / admin123  租户 default
平台后台  http://<IP>:5181
PDA       http://<IP>:5185
```

**第一件事是改密码。** `admin123` 只用于首次登录。

## 4. 端口与防火墙

只开四个端口给内网（不要暴露公网）：

```bash
sudo ufw allow from 192.168.0.0/16 to any port 3200,5173,5181,5185 proto tcp
```

`postgres` / `redis` 不映射到宿主，外部扫不到。若客户有多网段，按实际网段放行。

端口被占用时只改 `.env` 的 `PORT_*`，容器内部端口不动，前端 nginx 反代也用容器内地址，不需要跟着改。

## 5. 安全基线（production 下后端会拒绝启动的场景）

后端在 `NODE_ENV=production` 时强校验，以下任一不满足直接启动失败（这是故意的，防止把演示配置带到客户现场）：

- `JWT_SECRET` 长度 < 32 或仍是示例值
- `DB_PASS` 长度 < 16，或等于 `labelflow` / `postgres`
- `WMS_SERVICE_TOKEN` 为空

先用 `./deploy/preflight.sh` 自查，比看容器日志快。

其他要求：

- `.env` 权限 600，**不进版本库、不进备份包的外部传输渠道**（备份目录里的 `.env` 同样含密钥）。
- 数据库口令一旦在客户现场泄露，改 `.env` 后需同时改库内角色口令，否则连不上：
  ```bash
  docker compose exec postgres psql -U labelflow -d labelflow -c "ALTER ROLE labelflow PASSWORD '新口令';"
  ```
- 每个客户一个独立实例（独立库、独立 `.env`），不要多客户共用一个库。

## 6. 备份与恢复

### 6.1 日常备份

```bash
./deploy/backup.sh --out=/data/labelflow-backups --keep=30
```

产物：`labelflow-YYYYmmdd-HHMMSS/db.dump`（pg_dump 自定义格式）+ `.env` 快照 + `manifest.txt`（含 sha256 与代码版本）。脚本自带两道自检：文件非空、`pg_restore --list` 能解析。解析不了就报失败——**不做"看起来有文件就算备份成功"的事**。

定时任务（每天 02:30，保留 30 天）：

```bash
sudo crontab -e
30 2 * * * cd /opt/labelflow && ./deploy/backup.sh --out=/data/labelflow-backups --keep=30 >> /var/log/labelflow-backup.log 2>&1
```

备份要落到另一块盘或 NAS，跟数据库同盘等于没备份。

### 6.2 恢复

```bash
./deploy/restore.sh /data/labelflow-backups/labelflow-20261126-023000/db.dump
# 上面只做检查（sha256、文件、当前库预备份）不执行
./deploy/restore.sh .../db.dump --confirm    # 真正执行
```

不加 `--confirm` 不会动数据。执行时会先自动备份"当前库"到 `backups/pre-restore-<时间>/`，恢复后如果发现数据不对，可以用它退回恢复前的状态。恢复完自动做健康检查。

### 6.3 备份有效性演练（交付必做）

交付时至少做一次，并让客户 IT 在场：

1. `backup.sh` 出一份备份
2. 在测试实例上 `restore.sh --confirm`
3. 登录抽查 3 条数据：某物料的多档 GTIN、某张收货单的状态、某条库存余额

只做备份不演练，等于把风险留给半年后的自己。

## 7. 升级与回滚

```bash
./deploy/upgrade.sh            # 备份 → 构建 → 重启 → 健康检查
./deploy/upgrade.sh --pull     # 部署机是 git 仓库时，先 git pull
```

设计约束：

- **先备份再升级**，备份失败直接中止（`--no-backup` 只在已手动备份时用）。
- 升级后 300s 内健康检查不通过，脚本退出码 2，并打印回滚两条命令（数据回滚 + 代码回滚）。
- `db-init` 每次 `up` 都会重跑全部 SQL，因此**所有迁移脚本必须幂等**（`CREATE TABLE IF NOT EXISTS`、`ON CONFLICT DO NOTHING`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）。新增结构变更只能加新脚本，不能改已上线的历史脚本。

回滚：

```bash
./deploy/restore.sh backups/labelflow-<升级前时间>/db.dump --confirm
git checkout <升级前版本> && ./deploy/upgrade.sh --no-backup
```

## 8. 上线验收清单（每条都要有结果，不接受"应该没问题"）

| # | 项目 | 判定标准 |
|---|---|---|
| 1 | 服务健康 | `curl /api/v1/health` 200；`docker compose ps` 全部 running/healthy |
| 2 | 登录 | 租户后台 admin 能登，改密后能登 |
| 3 | 物料主数据 | 新建物料 + 填 UNIT/CARTON 两档 GTIN，保存后列表可见 |
| 4 | 标签打印 | 从 console 触发打印，**真打印机出纸**，扫码枪能读出 GS1 DataMatrix |
| 5 | 扫码收货 | PDA 扫 UDI 建收货单，数量与实物一致 |
| 6 | 装箱 | PDA 三步向导走完，生成箱码（SSCC）且箱标能扫 |
| 7 | 库存 | 期初导入后余额与客户台账对得上（抽样 ≥3 条） |
| 8 | 出库/发运 | 走一遍完整单据，状态流转正确 |
| 9 | 备份恢复 | 按 §6.3 演练通过 |
| 10 | 打印代理 | 代理断开时前端有明确提示；恢复后任务能重发 |

第 4、5、6 条是只有真机能验证的项：**没在客户硬件上跑过，就不能说这单交付完成**。

## 9. 客户机配置

### 9.1 标签打印机（Windows 打印代理）

打印代理是独立的小程序（`apps/print-agent`），装在连着打印机的那台 Windows 机器上：

1. 装 .NET 6 运行时（或直接用发布包，见 `apps/print-agent/README.md`）
2. 打印机驱动装好，在 Windows「设备和打印机」里能正常打印测试页
3. 配置 `appsettings.json`：服务器地址（`http://<服务器IP>:3200`）、`WMS_SERVICE_TOKEN`（与 `.env` 一致）、打印机名称（必须是系统里的**精确名称**）
4. 以服务方式常驻（`sc create` 或用 NSSM），开机自启
5. 在 console「硬件 → 打印代理」看到该代理在线

代理支持的下发格式：`zpl / tspl / epl / png-base64 / pdf-base64`。其中 `pdf-base64` 当前代理侧不支持，会回 failed——客户若用 PDF 模板，需要在模板里换成位图或原生指令，见 `docs/18`。

### 9.2 中文字体

后端渲染位图标签依赖系统字体，容器里已装中文字体（Noto Sans CJK）。若客户改用自定义字体，把 TTF 放进 `deploy/fonts/` 并重建 api 镜像；否则中文会渲染成方框。

### 9.3 PDA / 手持终端

- 浏览器直接开 `http://<服务器IP>:5185`，无需装 App
- 建议加桌面书签/全屏，横竖屏均可
- 扫码枪用键盘模拟模式（HID），扫码后回车；PDA 自带扫描头同理
- 与服务器必须同网段，跨网段要走 VPN

## 10. 离线交付镜像清单

```bash
docker compose build
docker save -o labelflow-images.tar \
  labelflow/api:dev $(docker compose images -q | sort -u)
```

现场：`docker load -i labelflow-images.tar && ./deploy/init.sh --no-build`

## 11. 故障排查速查

| 现象 | 先看什么 | 常见原因 |
|---|---|---|
| 容器起来就退出 | `docker compose logs db-init` | SQL 脚本报错 / 库已存在但结构不符 |
| api 反复重启 | `docker compose logs api --tail 100` | 生产模式下密钥强度不达标；DB 口令与库不一致 |
| 前端 502 | `docker compose logs console` | api 未就绪；nginx 反代地址写错 |
| 登录 401 | api 日志 | JWT_SECRET 改过但旧 token 还在（重新登录即可） |
| 打印一直 pending | `docker compose logs worker` | worker 没起 / 队列 consumer 未注册 / 代理离线 |
| 打印 failed | 代理日志 + `hardware_agent_jobs` 表 | 打印机名不对；驱动异常；pdf-base64 |
| 扫码识别不出 | 标签实物 + 手机相机 | 打印分辨率不足、静区被裁、标签尺寸与模板不匹配 |
| 单据时间为 UTC | `timedatectl` | 服务器时区未改 |

排查原则：先看健康检查，再看单服务日志，最后看库里的任务记录表（`hardware_agent_jobs` / 队列表），不要一上来改代码。

## 12. 本套件交付物与验证状态

| 交付物 | 状态 |
|---|---|
| `docker-compose.yml`（端口/SEED_DEMO/业务 env 可配） | 已改，YAML 解析通过；**未在本机实跑**（本机无 docker daemon） |
| `.env.example` | 完成 |
| `deploy/init.sh` | 完成，`bash -n` 通过；未实跑 |
| `deploy/preflight.sh` | 完成，`bash -n` 通过；未实跑 |
| `deploy/backup.sh` / `restore.sh` | 完成，`bash -n` 通过；**pg_dump/pg_restore 参数未在容器内实跑** |
| `deploy/upgrade.sh` | 完成，`bash -n` 通过；未实跑 |
| 本文 | 完成 |

> 诚实说明：本机没有 Docker 守护进程，上述 compose 与备份/恢复脚本只做了静态检查（YAML 解析、`bash -n`），**没有在真实 Docker 环境跑过一遍**。第一次在客户/测试服务器上执行时按 §8 逐条验收，遇到问题按 §11 定位；正式对外承诺"SOP 已跑通"之前必须补一次完整实跑记录。
