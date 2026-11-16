# 微信云托管部署

## 当前定位

当前服务只为原生微信小程序提供 FastAPI 接口，不部署 Web 页面，不使用 SQLite、微信云数据库、微信云函数或微信云存储

| 项目 | 配置 |
| --- | --- |
| 构建目录 | 仓库根目录 `.` |
| Dockerfile | `Dockerfile` |
| 监听地址 | `0.0.0.0:80` |
| 健康接口 | `GET /api/health` |
| 实例 | 单实例、单 worker |
| 生产数据库 | MySQL `10.17.106.21:3306` |
| 测试数据库 | 公网 MySQL `sh-cynosdbmysql-grp-av8hrd0w.sql.tencentcdb.com:27432` |

## MySQL 连接

测试阶段可以在本机使用公网地址：

```env
MUSIC_DATABASE_URL=mysql+asyncmy://music:密码@sh-cynosdbmysql-grp-av8hrd0w.sql.tencentcdb.com:27432/music?charset=utf8mb4
```

生产环境必须使用内网地址：

```env
MUSIC_DATABASE_URL=mysql+asyncmy://music:密码@10.17.106.21:3306/music?charset=utf8mb4
MUSIC_AUTO_MIGRATE=false
MUSIC_WECHAT_APP_ID=wxe1af0ed55ed257b7
```

公网测试完成后关闭 MySQL 公网访问，或收紧公网白名单，不把公网地址配置到生产容器

## 初始化顺序

1. 确认云托管服务和 MySQL 在同一 VPC
2. 配置 MySQL 私网白名单
3. 使用 `music_migrate` 执行数据库初始化
4. 检查 `alembic_version` 为最新迁移版本
5. 使用 `music` 账号部署 FastAPI
6. 检查 `/api/health`
7. 关闭云托管公网访问
8. 使用小程序 `wx.cloud.callContainer` 验证搜索、播放和个人接口

初始化命令：

```powershell
$env:MUSIC_MIGRATION_DATABASE_URL = 'mysql+asyncmy://music_migrate:密码@10.17.106.21:3306/music?charset=utf8mb4'
uv run alembic upgrade head
```

应用运行账号不执行数据库迁移，生产启动时 `MUSIC_AUTO_MIGRATE=false`

## 环境变量

| 变量 | 生产值 | 说明 |
| --- | --- | --- |
| `PORT` | `80` | 微信云托管监听端口 |
| `MUSIC_DATABASE_URL` | `mysql+asyncmy://music:REPLACE_IN_CLOUD_CONSOLE@10.17.106.21:3306/music?charset=utf8mb4` | 生产只使用内网 MySQL |
| `MUSIC_AUTO_MIGRATE` | `false` | 生产不自动改表 |
| `MUSIC_WECHAT_APP_ID` | `wxe1af0ed55ed257b7` | 个人接口身份校验 |
| `MUSIC_REQUEST_CONCURRENCY` | `8` | 普通请求并发上限 |
| `MUSIC_SEARCH_TASK_LIMIT` | `2` | 搜索任务上限 |
| `MUSIC_PROVIDER_CONCURRENCY` | `2` | 音乐源并发 |
| `MUSIC_FULL_AUDIO_VERIFY_CONCURRENCY` | `1` | 完整音频验证并发 |
| `MUSIC_STREAM_CONCURRENCY` | `3` | 音频流并发 |

其他默认值以 `.env.example` 和 `container.config.json` 为准，密码只能在云控制台密钥或环境变量中配置

## 个人接口安全

个人接口位于：

```text
POST /api/miniprogram/personal
```

FastAPI 校验 `X-WX-APPID`、`X-WX-OPENID` 和 `X-WX-SOURCE`，不接受请求体传入其他用户身份

生产关闭公网访问后，个人接口只能通过微信小程序云调用访问，不能通过浏览器或公网直接请求

头像最大 2 MiB，校验 JPEG、PNG、WebP 文件头后写入 MySQL `MEDIUMBLOB`

## 部署结果

健康检查应返回：

```json
{ "status": "ok", "database": "ok" }
```

生产验收必须分别确认：

- 云托管能访问 `10.17.106.21:3306`
- 生产没有使用公网 MySQL 地址
- `music` 账号无法建表和删表
- `music_migrate` 仅用于初始化和升级
- 关闭公网访问后小程序仍能调用 FastAPI
- 两个微信账号的收藏、喜欢、历史和头像互相隔离

详细个人功能说明见 [用户空间](personal-space.md)
