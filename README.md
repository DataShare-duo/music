# 听见 · 个人在线音乐空间

**作者：DataShare**

一个基于 FastAPI、SQLite 和 Vue 3 的轻量音乐播放器，支持发现歌曲、多源搜索和在线播放

## 1、用户界面与使用

![听见音乐系统首页：音乐推荐、歌曲来源与底部播放器](docs/images/homepage.png)

首次访问时，浏览器会要求输入配置的访问账号和密码，默认账号为 `music`

| 页面或区域 | 使用方法                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 发现音乐   | 随机展示最多 100 首已验证可播放的歌曲，点击“换一批”刷新推荐，点击歌曲播放 |
| 搜索歌曲   | 输入歌名或歌手，点击“搜索”或按回车，可切换汽水音乐、网易云音乐和酷我音乐  |
| 底部播放器 | 支持播放、暂停、上一首、下一首、进度拖动和音量调整，并显示实际播放来源    |

仅展示通过完整版验证的歌曲，当前不可用的歌曲会暂时隐藏，后续复检通过后自动恢复，首次启动请等待后台验证

服务繁忙时会限制搜索或播放连接，稍后重试即可，重复刷新和服务繁忙不会单独导致正常歌曲被隐藏

## 2、部署

### 小服务器测试，推荐先用 SSH 隧道

服务器需要 Git 和 Docker，在项目目录执行：

```bash
git clone https://github.com/DataShare-duo/music.git
cd music
cp .env.example .env
# 编辑 .env，必须填写至少 16 字符的随机 MUSIC_ACCESS_PASSWORD
# 可以用 openssl rand -hex 24 生成密码，不要将密码提交到 Git
chmod 600 .env
docker build -t music-web .
docker run -d --name music --restart unless-stopped --env-file .env \
  -p 127.0.0.1:10000:10000 -v music-data:/app/data music-web
```

在自己电脑的终端建立隧道，保持窗口运行：

```powershell
ssh -N -L 18000:127.0.0.1:10000 用户名@服务器IP
```

浏览器访问 `http://127.0.0.1:18000`，输入账号和密码，安全组无需开放 10000 端口

- 不配置密码时，除 `/api/health` 外均拒绝访问
- 默认最多 6 路音频连接、同 IP 最多 3 路、同会话最多 2 路，为拖动进度保留连接余量
- 公开访问必须配置 HTTPS，账号密码不能通过公网明文 HTTP 传输
- 完整配置、限流行为、升级和备份说明见 [安全与服务器部署](docs/security.md)
- 保留 [Render 配置](render.yaml)，如使用 Render，需要在控制台填写访问密码

### 本地开发

需要 **Python 3.13、uv 和 Node.js 22.12+ / 24+**，先复制 `.env.example` 为 `.env` 并设置密码

终端一，在项目根目录启动后端：

```powershell
uv sync --locked
uv run uvicorn music.app:app --reload --host 127.0.0.1 --port 8000 --no-proxy-headers
```

终端二，启动前端：

```powershell
cd frontend
npm ci
npm run dev
```

先访问 `http://127.0.0.1:5173/api/sources` 完成浏览器认证，再访问 `http://127.0.0.1:5173`

---

仅供个人非商业使用，音乐适配依赖 [musicdl](https://github.com/CharlesPikachu/musicdl)，保留上游作者署名和 [许可证](THIRD_PARTY_LICENSE_MUSICDL.txt)，不绕过平台会员或访问限制
