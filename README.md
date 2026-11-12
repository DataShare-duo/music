# 听见 · 个人在线音乐空间

一个面向个人使用的轻量在线听音乐系统，后端使用 FastAPI + SQLite，前端使用 Vue 3 + TypeScript，默认以汽水音乐为主要来源，并保留网易云音乐、酷我音乐的手动搜索入口

## 功能

- 首页按热门关键词建立候选曲库，后台验证完整音频后随机展示最多 100 首
- 搜索结果先进入待验证队列，只展示已确认存在完整音频的歌曲
- 汽水音乐无完整音频时，按严格歌名、歌手、版本和时长匹配网易云音乐、酷我音乐
- 完整版验证失败的歌曲暂时隐藏，不播放试听片段，并在默认 6 小时后自动复检
- 汽水官方后续提供完整音频时，复检通过后自动恢复展示
- 点击歌曲时实时解析当前音源链接，播放中链接失效时最多刷新一次
- 数据库记录歌曲详情、入库日期、验证状态、实际音源、点击次数和有效播放次数
- 后端流式代理播放，支持 Range 请求和进度拖动
- 播放器只显示实际音源名称，例如“汽水音乐”“网易云音乐”
- 不下载完整音频，不绕过会员或访问权限，不把上游临时链接直接暴露给浏览器

## 验证规则

歌曲必须通过音频元数据验证才会进入首页或搜索结果，验证过程会检查：

- 歌名、歌手和版本是否一致
- 候选歌曲总时长是否匹配
- 实际音频响应是否为音频内容
- 当前音频容器能否读取出可靠的播放时长
- 实际播放时长是否与歌曲元数据一致

汽水公开试听链接如果实际响应覆盖完整歌曲，也可以通过验证并作为汽水音源使用，不能仅根据 URL 字段名称判断结果

网络超时、限流等暂时性错误使用短冷却后重试，明确只有试听或无法确认完整性的歌曲默认 6 小时后再次检查，歌曲详情和统计数据不会被删除

## 边界与来源说明

首页显示的是热门关键词推荐，不是汽水音乐官方实时热榜，候选关键词位于 `src/music/core/config.py`，也可以通过 `MUSIC_KEYWORDS` 配置覆盖

当前固定使用 musicdl `2.14.2` 对应提交 `dca2f0967e46a8faf8d279737535471102d74ca3`，许可证文本见 [THIRD_PARTY_LICENSE_MUSICDL.txt](THIRD_PARTY_LICENSE_MUSICDL.txt)，仅用于个人非商业场景，平台可播放性以实时响应为准

项目不使用第三方解析接口，不绕过会员、付费限制或 DRM，不对受保护音频执行解密操作

## 后端启动

需要 Python 3.13 和 uv

```powershell
uv sync
Copy-Item .env.example .env
uv run uvicorn music.app:app --reload --host 127.0.0.1 --port 8000
```

首次启动会自动执行 Alembic 迁移，SQLite 文件默认位于 `data/music.db`

如果本机 uv 使用的是受限环境，也可以在虚拟环境激活后启动

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn music.app:app --reload --host 127.0.0.1 --port 8000
```

## 前端启动

```powershell
cd frontend
npm install
npm run dev
```

开发页面访问 `http://127.0.0.1:5173`，Vite 会把 `/api` 请求代理到 FastAPI 的 8000 端口

构建生产前端后，FastAPI 会自动托管 `frontend/dist`

```powershell
npm run build
cd ..
uv run uvicorn music.app:app --host 127.0.0.1 --port 8000
```

## 配置

复制 `.env.example` 后可调整以下配置

- `MUSIC_DATABASE_URL`：SQLite 连接地址
- `MUSIC_NETWORK_TIMEOUT`：单次音乐平台请求超时时间，默认 12 秒
- `MUSIC_PROVIDER_CONCURRENCY`：音乐平台请求并发数，默认 3
- `MUSIC_FALLBACK_SOURCES`：备用音源顺序，默认网易云、酷我
- `MUSIC_FULL_AUDIO_VERIFY_TIMEOUT`：单首歌曲完整版验证总超时时间，默认 30 秒
- `MUSIC_FULL_AUDIO_VERIFY_CONCURRENCY`：后台同时验证的歌曲数量，默认 2
- `MUSIC_FULL_AUDIO_RECHECK_INTERVAL`：无法确认完整版后的默认复检间隔，默认 21600 秒，也就是 6 小时
- `MUSIC_CATALOG_TARGET`：推荐曲库中已验证完整版的目标数量，默认 500
- `MUSIC_CATALOG_TTL`：推荐曲库缓存时间，默认 21600 秒
- `MUSIC_SEARCH_TTL`：搜索元数据缓存时间，默认 600 秒
- `MUSIC_FAILURE_COOLDOWN`：网络错误或限流后的短冷却时间，默认 60 秒
- `MUSIC_PLAYBACK_TTL`：播放会话有效时间，默认 7200 秒
- `MUSIC_KEYWORDS`：首页热门关键词 JSON 数组

## API

主要接口都在 `/api` 下

- `GET /api/home`
- `GET /api/search?q=关键词&source=soda&page=1`
- `POST /api/songs/{song_id}/playbacks`
- `GET /api/playbacks/{id}/stream`
- `POST /api/playbacks/{id}/started`
- `POST /api/playbacks/{id}/refresh`
- `GET /api/sources`
- `GET /api/health`

首页和搜索接口会返回验证统计字段：

- `verification_total`：候选歌曲总数
- `verification_pending`：待验证或验证中的歌曲数量
- `verification_available`：已确认完整音频的歌曲数量
- `verification_unavailable`：当前确认只有试听或没有完整音频的歌曲数量
- `verification_errors`：网络、限流等暂时性验证错误数量

## 检查命令

```powershell
# 后端静态检查和测试
.\.venv\Scripts\ruff.exe check src migrations tests
.\.venv\Scripts\python.exe -m pytest -q

# 前端构建、测试和格式检查
npm --prefix frontend run build
npm --prefix frontend run test
npm --prefix frontend run format:check

# 真实汽水搜索和完整版验证，不下载完整音频
$env:PYTHONPATH="src"
.\.venv\Scripts\python.exe scripts/check_live.py --full --query "四块五"
```

真实联调脚本会直接访问汽水搜索和公开分享页，如果平台接口受限会退出失败，不使用模拟歌曲掩盖问题

## 升级与 SQLite 备份

升级前停止后端服务，再备份 `data/` 目录中的数据库及 WAL 相关文件，不要只复制正在写入的 `.db` 文件

```powershell
# 后端停止后，在项目根目录执行
Copy-Item data ("data-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")) -Recurse
uv sync --locked
npm --prefix frontend ci
npm --prefix frontend run build
uv run uvicorn music.app:app --host 127.0.0.1 --port 8000
```

首次升级会自动应用 `0002` 迁移，保留原始歌曲和统计，将旧曲库设为待验证，并禁止旧试听会话绕过新规则，只有通过新版完整版验证的歌曲才会逐步显示

初次验证可能较慢，列表不足 100 首属于预期行为，系统不会用试听曲目或未验证歌曲填充；后台每 60 秒扫描到期记录，服务停止期间不执行复检，重新启动后继续处理

## Render 免费部署

项目可以使用 Render 的免费 Docker Web Service 部署，不需要购买域名或准备自己的服务器，部署后会获得一个 `onrender.com` 地址

Render 免费服务休眠或重启后，当前项目的 SQLite、歌曲缓存、验证状态和播放统计会丢失，服务会重新执行数据库迁移并重新采集和验证歌曲，这符合本项目不要求持久化歌曲数据的使用方式

### 部署步骤

不需要在本机安装 Docker，Render 会在云端构建镜像，连接的是当前这个 FastAPI + Vue 音乐系统仓库，而不是上游 musicdl 仓库

1. 将仓库推送到 GitHub，确保仓库根目录包含 `Dockerfile` 和 `render.yaml`
2. 登录 Render，选择 `New +` → `Blueprint`
3. 连接 GitHub 仓库，选择本项目仓库和分支
4. Render 读取 `render.yaml`，确认服务名称为 `listen-music`、类型为 Docker、计划为 Free
5. 点击创建并等待构建完成
6. 在 Render 服务页面打开实际生成的 `onrender.com` 地址，以控制台显示的地址为准
7. 使用该地址的 `/api/health` 检查后端，成功响应应包含 `status: ok` 和 `database: ok`

也可以不使用 Blueprint，手动创建 Web Service：

- `Runtime`：Docker
- `Dockerfile Path`：`./Dockerfile`
- `Docker Context`：`.`
- `Health Check Path`：`/api/health`
- `Plan`：Free
- `Root Directory`：留空，使用仓库根目录
- `Docker Command`：留空，使用 Dockerfile 内置启动命令

不要选择 Static Site，也不要手动配置 `npm run dev` 或 `--reload` 作为生产启动命令

Docker 构建会先在 `frontend/` 中执行 `npm ci && npm run build`，再安装锁定的 Python 生产依赖并由 FastAPI 托管 `frontend/dist`，启动直接使用镜像中已经安装的 Uvicorn，不会在每次唤醒时重新安装依赖

### 部署后的行为

- 用户访问 Render 地址时，休眠服务会自动唤醒
- 第一次唤醒可能需要等待一段时间，页面恢复后会开始后台验证歌曲
- 服务重启后 SQLite 数据会重新建立，首页可能先显示“正在验证可播放歌曲”
- 不要把 `.env` 提交到 GitHub，Render 配置通过 `render.yaml` 的非敏感变量提供
- Render 自动提供 HTTPS，不需要配置自己的域名
- 单个服务同时提供页面和 `/api`，无需另外设置前端 API 域名或跨域白名单
- 音频代理会产生公网出站流量，Free 实例不代表无限流量，部署后检查 Render 用量和计费设置
- 云端网络出口与本机不同，音乐平台可能限制地区或请求，页面部署成功不等于所有音源均可用

### 本地检查 Docker 配置

本机安装 Docker 后，可以在项目根目录执行：

```powershell
docker build -t listen-music .
docker run --rm -p 10000:10000 -e PORT=10000 listen-music
```

浏览器访问：

```text
http://127.0.0.1:10000
```

### 将当前项目推送到 GitHub

先在 GitHub 创建空仓库，不要额外初始化 README，再在项目根目录执行，远程地址替换为自己的仓库地址

```powershell
git status --short
git add .
git commit -m "Prepare Render deployment"
git remote add origin "https://github.com/你的用户名/你的仓库名.git"
git push -u origin HEAD
```

如果已经配置过 `origin`，不要重复添加，先使用 `git remote -v` 检查现有地址

不要提交 `.env`、`.venv/`、`frontend/node_modules/`、`data/` 或 `.cache/`，这些文件已通过 `.gitignore` 排除；不需要手动上传 `frontend/dist`，它会在 Render 构建时生成
