# FastAPI + MySQL 用户空间与小程序部署

## 当前架构

本项目只面向原生微信小程序，作者为 DataShare

- FastAPI 负责音乐、播放、收藏、喜欢、最近播放、搜索历史和头像接口
- MySQL 8.0 保存全部业务数据和头像 BLOB
- 不使用 SQLite、微信云数据库、微信云函数或微信云存储
- 小程序所有业务请求通过 wx.cloud.callContainer 调用 FastAPI
- 生产关闭云托管公网访问，只允许小程序云调用
- Web 源码保留在仓库中，但不进入生产 Docker 镜像，也不由 FastAPI 托管

## MySQL 地址

测试地址，仅用于本机联调：

```text
sh-cynosdbmysql-grp-av8hrd0w.sql.tencentcdb.com:27432
```

生产地址：

```text
10.17.106.21:3306
```

生产环境变量只使用内网地址：

```env
MUSIC_DATABASE_URL=mysql+asyncmy://music:密码@10.17.106.21:3306/music?charset=utf8mb4
MUSIC_AUTO_MIGRATE=false
MUSIC_WECHAT_APP_ID=wxe1af0ed55ed257b7
```

密码不写入 Git、镜像、日志或小程序代码，公网测试完成后关闭公网访问或收紧数据库白名单

## 账号权限

运行账号 `music` 只保留：

```text
SELECT INSERT UPDATE DELETE
```

初始化与升级账号 `music_migrate` 使用：

```text
SELECT INSERT UPDATE DELETE CREATE ALTER INDEX REFERENCES DROP
```

不授予 `ALL PRIVILEGES`、`GRANT OPTION`、`CREATE USER`、`FILE`、`PROCESS`、`SUPER`、复制、事件、触发器和存储过程权限

生产应用只使用 `music`，执行 `alembic upgrade head` 时临时使用 `music_migrate`

## 初始化数据库

当前没有线上业务数据，不执行 SQLite 或云数据库数据导入，直接初始化 MySQL 空库

```powershell
$env:MUSIC_MIGRATION_DATABASE_URL = 'mysql+asyncmy://music_migrate:密码@sh-cynosdbmysql-grp-av8hrd0w.sql.tencentcdb.com:27432/music?charset=utf8mb4'
uv run alembic upgrade head
```

生产执行时将连接地址换为：

```text
mysql+asyncmy://music_migrate:密码@10.17.106.21:3306/music?charset=utf8mb4
```

初始化后应存在：

```text
songs
song_stats
audio_links
playback_sessions
provider_cache
users
user_marks
user_history
user_history_state
user_operations
alembic_version
```

## FastAPI 个人接口

小程序个人数据统一调用：

```text
POST /api/miniprogram/personal
```

请求体使用 action 和 data，支持：

| action | 用途 |
| --- | --- |
| profile.get | 获取当前用户资料和收藏状态 |
| profile.enable | 创建个人空间 |
| mark.set | 设置收藏或喜欢 |
| history.sync | 同步搜索历史和最近播放 |
| avatar.set | 将头像 Base64 写入 MySQL |
| avatar.get | 读取当前用户头像 |

服务端校验微信云调用请求头：

- `X-WX-APPID` 必须匹配 `wxe1af0ed55ed257b7`
- `X-WX-OPENID` 必须存在
- `X-WX-SOURCE` 必须为允许的小程序调用来源
- 请求体不能指定其他用户的 OpenID、用户 ID 或用户摘要

用户身份只保存 AppID 和 OpenID 的 SHA-256 摘要，不保存原始 OpenID

## 头像规则

- 最大 2 MiB
- 只接受 JPEG、PNG、WebP
- 服务端检查文件头和 SHA-256
- 写入 MySQL `users.avatar_blob`，类型为 `MEDIUMBLOB`
- 不使用 `wx.cloud.uploadFile`
- 不记录头像内容日志
- 头像只能由当前微信用户读取

头像接口使用专用请求体限制，普通接口仍保持原有资源限制，头像上传失败不会影响搜索和播放

## Docker 与云托管

Docker 只构建 Python 后端：

- 不安装 Node
- 不构建 Web 前端
- 不复制 `frontend/dist`
- 不创建 SQLite 数据目录
- 使用单 worker、单实例
- 监听端口 `80`
- 生产设置 `MUSIC_AUTO_MIGRATE=false`

部署顺序：

1. 确认云托管和 MySQL 位于同一 VPC
2. 为 MySQL 配置 VPC 白名单
3. 使用 `music_migrate` 执行 `alembic upgrade head`
4. 设置 FastAPI 使用生产内网地址和 `music` 账号
5. 部署 FastAPI 服务并检查 `/api/health`
6. 确认关闭公网访问后小程序仍能通过 `callContainer` 调用
7. 构建并上传小程序开发版
8. 使用两个微信账号验证收藏、喜欢、历史、头像和播放

## 本地测试

```powershell
Set-Location 'E:\个人\agent\agent-codex\music'
$env:MUSIC_DATABASE_URL = 'mysql+asyncmy://music:密码@sh-cynosdbmysql-grp-av8hrd0w.sql.tencentcdb.com:27432/music?charset=utf8mb4'
uv run alembic upgrade head
.\.venv\Scripts\python.exe -m pytest -q

Set-Location 'E:\个人\agent\agent-codex\music\miniprogram'
npm test
```

公网测试完成后不要把公网连接串复制到生产环境，生产只使用 `10.17.106.21:3306`

## 验收边界

本次不做旧 SQLite 数据导出、不做旧云数据库数据导出、不做双写、不做 Web 部署、不提交审核或发布正式版

需要分别确认：源码测试通过、MySQL 空库初始化成功、云托管内网连接成功、小程序开发版上传成功、两个真实微信账号验收通过
