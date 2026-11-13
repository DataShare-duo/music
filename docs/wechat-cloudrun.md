# 微信云托管部署

## 当前项目配置

| 项目         | 配置                                                       |
| ------------ | ---------------------------------------------------------- |
| 构建目录     | 仓库根目录 `.`                                             |
| Dockerfile   | 根目录 `Dockerfile`                                        |
| 默认监听     | `0.0.0.0:80`                                               |
| 运行环境变量 | `PORT=80`                                                  |
| 运行用户     | `app`，UID 10001，非 root                                  |
| 健康接口     | `GET /api/health`，成功返回 HTTP 200                       |
| 模板资源     | 1 核、1GiB，最小实例 0、最大实例 1，可按控制台支持规格调整 |
| 数据库       | 容器内 SQLite，仅用于本次不要求持久化的测试                |

`container.config.json` 沿用微信官方示例仓库的快速部署配置格式，包含运行参数和轻量内测配置，不含 AppID 或环境 ID，MUSIC_KEYWORDS 默认从随镜像打包的 .env.example 读取

**该文件是快速部署模板，不会自动修改控制台中已经存在的 music 服务，现有服务必须在发布新版本时手动核对端口和环境变量**

## 已有服务重新部署

1. 选择 GitHub 仓库 `DataShare-duo/music` 的最新 `master`，重新构建镜像，不继续使用旧版本镜像
2. 构建上下文选择根目录 `.`，Dockerfile 路径使用 `Dockerfile`
3. 新版本的监听端口设为 `80`，运行环境变量同时设为 `PORT=80`
4. 启动命令留空，使用 Dockerfile 的 CMD，如果以前手填了带 `--port 10000` 的启动命令，清除该覆盖配置
5. 页面公开访问，无需设置账号密码，旧版本配置迁移见 [安全说明](security.md)，如果以前配置了 `MUSIC_KEYWORDS`，删除旧覆盖项以跟随 `.env.example`
6. 同步下面的内测资源参数，最大实例数保持 1，发布新版本
7. 如果控制台支持 HTTP 健康检查，使用端口 80、路径 `/api/health`，优先使用轻量的健康接口，不以首页代替健康检查；如果使用 TCP 检查，检查端口同样为 80

当前版本默认公开访问，页面、搜索和播放均无需输入密码，资源限制仍生效，超过频率或容量时可能返回 `429` 或 `503`，后台搜索可能展示旧缓存或失败冷却信息

### 运行环境变量

完整值见根目录 `container.config.json` 的 `envParams`，不要只修改 Docker 的 EXPOSE 而忘记同步控制台监听端口

| 变量                                | 微信内测配置                      | 说明                                       |
| ----------------------------------- | --------------------------------- | ------------------------------------------ |
| PORT                                | 80                                | 与控制台监听端口一致                       |
| MUSIC_DATABASE_URL                  | sqlite+aiosqlite:///data/music.db | 对应容器内 /app/data/music.db              |
| MUSIC_REQUEST_CONCURRENCY           | 8                                 | 普通请求最大并发                           |
| MUSIC_SEARCH_TASK_LIMIT             | 2                                 | 搜索后台任务上限                           |
| MUSIC_PROVIDER_CONCURRENCY          | 2                                 | 音乐源工作线程                             |
| MUSIC_PROVIDER_QUEUE_SIZE           | 4                                 | 音乐源额外排队容量                         |
| MUSIC_FULL_AUDIO_VERIFY_CONCURRENCY | 1                                 | 降低后台验证内存和网络压力                 |
| MUSIC_VERIFICATION_QUEUE_SIZE       | 50                                | 验证队列容量，溢出候选保留在数据库等待补入 |
| MUSIC_CATALOG_TARGET                | 100                               | 首次推荐曲库目标，减少冷启动后的验证工作量 |
| MUSIC_STREAM_CONCURRENCY            | 3                                 | 全局音频连接上限，不代表保证 3 人流畅播放  |

不设置额外启动参数，不启用 `--reload`，不要增加 worker 或实例数，现有 SQLite 和进程内限流按单实例、单 worker 设计

## 部署结果检查

正常启动日志应包含：

```text
Application startup complete.
Uvicorn running on http://0.0.0.0:80
```

健康接口应返回：

```json
{ "status": "ok", "database": "ok" }
```

- 如果日志仍是 `0.0.0.0:10000`，说明使用了旧镜像、旧 PORT 环境变量或手动启动命令，检查实际部署版本和版本配置
- 如果平台报 `dial tcp ...:80: connect: connection refused`，检查实际监听端口、启动是否完成及启动错误，不能靠修改页面或前端端口解决
- 如果仍弹出账号密码框或提示未配置访问密码，检查是否还在访问旧镜像、旧版本流量或平台额外设置的认证，新程序没有这层认证
- 如果出现内存不足或进程被终止，先降低验证并发并核对内存规格，不把它当成端口故障
- 如果构建阶段拉取固定 musicdl 提交时出现 `RPC failed`、`early EOF` 或 `Network is unreachable`，属于构建网络或 GitHub 连接中断，先重新构建并检查构建网络，不把它当成端口错误，也不要改成不受控的第三方镜像源

如果已开通公网访问，使用控制台提供的 HTTPS 地址进行网页测试，不要使用明文公网 HTTP 传输请求和音频；只有云调用入口时，先核对控制台是否已提供浏览器可访问的入口

## 基础镜像拉取失败

构建时如果还没有执行 npm、uv 或启动命令，就在 FROM 拉取阶段失败，先检查镜像仓库网络，不要修改程序端口

- 日志中的 Docker Hub `429 Too Many Requests` 表示拉取受限或请求过于频繁，重试可能恢复，但不保证共享构建出口可用
- `mirror.ccs.tencentyun.com` 的 `x509: certificate has expired or is not yet valid` 属于镜像加速地址的 TLS 证书校验失败，不应关闭证书校验或修改应用数据库
- 本次日志显示证书有效期截至 UTC 2026-11-12 23:59:59，即北京时间 2026-11-13 07:59:59，10:33 左右的构建已经超过该时间，应用容器内更新 CA 也无法修复构建器在拉取基础镜像之前的失败
- 当前 Dockerfile 默认使用 ECR Public 上的 Docker Official Images，镜像系列仍为 Node 22 bookworm-slim 和 Python 3.13 slim-bookworm
- 已移除会额外从 Docker Hub 拉取 docker/dockerfile:1 的 syntax 指令，使用构建器内置 Dockerfile 前端，本项目没有依赖外部前端的特殊语法

默认基础镜像：

```text
public.ecr.aws/docker/library/node:22-bookworm-slim
public.ecr.aws/docker/library/python:3.13-slim-bookworm
```

选择最新 master 并重新构建，构建日志的基础镜像路径应以 public.ecr.aws/docker/library 开头；旧版本镜像重启不会应用 Dockerfile 修改

ECR Public 可访问性仍取决于云构建网络，不保证微信构建节点一定可达，镜像仓库切换也不解决后续 GitHub、npm 或 Python 依赖下载失败

如果 ECR Public 无法访问，可以在可信环境将已核验镜像同步到自己授权的腾讯容器镜像仓库，然后通过 Docker 构建参数 NODE_IMAGE 和 PYTHON_IMAGE 指定完整地址，保留对应运行时版本

这些是镜像构建参数，不是容器运行环境变量，在控制台填写运行环境变量不会修改 FROM；若控制台不支持传递构建参数，需要在受控构建流程传入或修改 Dockerfile 的默认镜像地址，不在仓库保存仓库密码

若仍使用平台默认镜像加速器并报证书错误，联系云托管支持排查该构建节点的镜像加速器证书，不使用 insecure registry、跳过 TLS 校验或不受控第三方镜像源

## 非 root 绑定 80

镜像构建时，仅给 Python 解释器设置 `cap_net_bind_service`，应用仍以 UID 10001 运行，不把整个服务改成 root

如果 Python 已正常启动，只是在绑定 80 时出现 `Permission denied`，可将控制台端口和环境变量同时改为 `8080`，镜像启动和健康探针都会读取 PORT

如果构建时的 `setcap` 或执行 Python 本身就出现 `Operation not permitted`，说明平台限制了文件能力，不能只改 PORT，需要改用不设置文件能力的高端口镜像再部署，不要通过改用 root 绕过

Docker 的 HEALTHCHECK 用于可识别该配置的容器运行环境，不能假设它会自动覆盖微信控制台的 TCP/HTTP 健康探针设置

## 内测边界

- 最小实例 0 可以缩容到零，后台验证及复检不保证在无人访问时持续执行，重新启动后继续处理
- 不依赖容器本地文件持久保存，容器重建或替换后歌曲详情、链接缓存和统计可能丢失，首次访问需要重新采集和验证
- 音频通过服务转发，会消耗云托管流量，关注试用额度、出站流量、请求超时和费用告警，试用不等于永久免费
- 云出口 IP 下真实音乐源是否可访问，必须部署后独立联调，本地模拟音频通过不代表汽水真实链路已经通过
- 当前配置用于网页内测，不等于音乐小程序已经具备发布资质，后续小程序身份识别需要单独设计
- 其他公开访问与资源限制见 [安全说明](security.md)，已知依赖告警仍需单独处理
