# 听见 · 个人在线音乐空间

**作者：DataShare**

一个基于 FastAPI、SQLite 和 Vue 3 的轻量音乐播放器，支持发现歌曲、多源搜索和在线播放

## 1、用户界面与使用

![听见音乐系统首页：音乐推荐、歌曲来源与底部播放器](docs/images/homepage.png)

| 页面或区域 | 使用方法                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 发现音乐   | 随机展示最多 100 首已验证可播放的歌曲，点击“换一批”刷新推荐，点击歌曲播放 |
| 搜索歌曲   | 输入歌名或歌手，点击“搜索”或按回车，可切换汽水音乐、网易云音乐和酷我音乐  |
| 底部播放器 | 支持播放、暂停、上一首、下一首、进度拖动和音量调整，并显示实际播放来源    |

仅展示通过完整版验证的歌曲，当前不可用的歌曲会暂时隐藏，后续复检通过后自动恢复，首次启动或重新部署后请等待后台验证

## 2、部署

### Render 公网部署

不需要自己的域名或服务器，Render 会自动构建前端并运行后端，本机也不需要安装 Docker

1. 在 GitHub 上 [Fork 本仓库](https://github.com/DataShare-duo/music/fork) 到自己的账号
2. 登录 [Render](https://render.com/)，选择 **New + → Blueprint**，连接自己的 Fork
3. 选择 `master` 分支，确认读取根目录的 [render.yaml](render.yaml)，服务类型为 **Docker Web Service**、计划为 **Free**
4. 按需调整环境变量，创建服务，等待部署完成后打开控制台提供的 `onrender.com` 地址

构建与启动命令已写在 [Dockerfile](Dockerfile) 中，无需手动填写，部署成功后可访问 `/api/health` 检查服务状态

- 云端环境变量见 [render.yaml](render.yaml)，修改后推送到自己的仓库并同步 Blueprint
- 不要提交 `.env`、Cookie、Token 或其他凭据，敏感值只在 Render 控制台填写
- 免费服务空闲时会休眠，再次访问会自动唤醒，SQLite 数据会在休眠、重启或重新部署后重建
- 音频代理会消耗流量，请留意 Render 免费额度，音乐源可用性也受平台和云端网络影响

### 本地开发

需要 **Python 3.13、uv 和 Node.js 22.12+ / 24+**

先获取项目：

```powershell
git clone https://github.com/DataShare-duo/music.git
cd music
```

终端一，启动后端：

```powershell
uv sync --locked
if (!(Test-Path .env)) { Copy-Item .env.example .env }
uv run uvicorn music.app:app --reload --host 127.0.0.1 --port 8000
```

终端二，在项目根目录启动前端：

```powershell
cd frontend
npm ci
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`，后续启动只需运行对应的启动命令，重新安装依赖前先停止正在运行的前端服务

---

仅供个人非商业使用，音乐适配依赖 [musicdl](https://github.com/CharlesPikachu/musicdl)，保留上游作者署名和 [许可证](THIRD_PARTY_LICENSE_MUSICDL.txt)，不绕过平台会员或访问限制
