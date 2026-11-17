# FastAPI + MySQL 用户空间与小程序部署

## 当前交付状态

源码提交 `511ab2c2` 已推送，微信开发版 `0.5.0-511ab2c2` 已上传成功，未提审或发布

本机 MySQL 8.0.45 隔离测试库已完成 Alembic 空库初始化、个人数据写入和歌曲 upsert 验证；生产 MySQL `10.17.106.21:3306` 尚未连接，需在云托管 VPC 内配置密码和白名单后执行初始化

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

| action         | 用途                       |
| -------------- | -------------------------- |
| profile.get    | 获取当前用户资料和收藏状态 |
| profile.enable | 创建个人空间               |
| mark.set       | 设置收藏或喜欢             |
| history.sync   | 同步搜索历史和最近播放     |
| avatar.set     | 将头像 Base64 写入 MySQL   |
| avatar.get     | 读取当前用户头像           |

服务端校验微信云调用请求头：

- `X-WX-APPID` 必须匹配 `wxe1af0ed55ed257b7`
- `X-WX-OPENID` 必须存在
- `X-WX-SOURCE` 必须存在且有效，不假定其值固定为 `wx_client`，调用来源与用户身份均依赖可信微信云托管网关注入
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

## 个人空间身份排障

0.5.3 修正了后端将 `X-WX-SOURCE` 写死为 `wx_client` 导致其他合法调用来源被误拒绝的问题，仅修改小程序 `traceUser` 无法修正后端判断

微信官方说明见 [容器内变量信息](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/weixin/index.html)，按照来源头存在性、当前 AppID 和有效 OpenID 进行校验，不从请求体、客户端自设身份头或前端缓存恢复用户身份，不启用游客身份兜底

此信任边界要求云托管关闭公网访问，容器只接受微信云调用网关转发的身份头，不应直接向公网开放 FastAPI 或允许自建代理注入这些身份头，不要通过客户端手填 OpenID 修复报错

更新时先将 FastAPI 部署到包含此修复的提交并切换流量，再切换小程序体验包，数据库结构未变化，无需新迁移

进入“我的 → 服务检查与播放事件 → 检查身份”，该接口不创建用户、不增加播放计数，也不返回 OpenID 或完整身份请求头

| 错误码 | 检查方向 |
| --- | --- |
| `wechat_source_missing` | 是否通过 `wx.cloud.callContainer` 调用，云托管入口是否正确 |
| `wechat_appid_missing` | 微信应用身份是否被网关或中间代理丢弃 |
| `wechat_appid_mismatch` | 运行版本的 `MUSIC_WECHAT_APP_ID` 是否与当前小程序一致 |
| `wechat_openid_missing` | 用户身份是否透传，当前环境是否为同一小程序直属环境 |

当前只接收同一小程序直属环境身份，不自动将资源复用的 `X-WX-FROM-OPENID` 当作本环境用户，若使用资源复用需另行配置明确的信任关系

后端身份失败日志只记录错误码和各身份字段是否存在，不记录原始用户标识，未启用时“重试启用”会重新执行启用请求，已启用时“重试同步”保持原有同步行为

## 头像与个人音乐标签

0.5.4 将“我的”页中的收藏、喜欢、最近播放改为三个页内标签，可直接切换歌曲列表、分别翻页、取消标记、删除最近记录或确认清空，不再通过三个菜单跳转页面

标签切换不新建播放会话、不改变底部背景播放器，未完成的旧分类歌曲恢复请求在切换或离开页面后会被忽略，暂不可播放的个人记录继续保留

微信身份不等于头像授权，不能通过 OpenID 自动取得用户头像，按微信官方的 [头像昵称填写能力](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html) 使用 `chooseAvatar`，用户主动选择一次，仍可跳过，不影响听歌

“我的”页提供明确的“选择头像／更换头像”按钮，已保存头像在小程序启动、返回前台或进入个人空间时自动读取；此行为是加载用户此前主动保存的头像，不会自动读取或跟随微信账号头像变化

客户端按 JPEG、PNG、WebP 实际文件头填写 MIME，头像继续通过 `callContainer` 写入 FastAPI 与 MySQL，不使用云存储；从 MySQL 读取的头像转换为当前用户专属的本机图片文件再显示，不把整段 Base64 放入页面数据

替换成功后只清理本应用生成的旧头像缓存，不删除用户选图临时文件或其他本机文件，旧请求不能覆盖更新后的头像，不同用户的头像请求结果不能相互覆盖

本版本未修改 FastAPI 接口或数据库结构，后端已部署 0.5.3 身份校验修复时，只需更新小程序开发版，无需新增数据库迁移；仍需真机检查头像选择、重新打开自动显示、三个标签切换、最近播放删除和锁屏播放

## 最近播放优先与启用头像流程

0.5.5 将个人音乐标签调整为“最近播放、喜欢、收藏”，首次进入默认展示最近播放，保留显式分类链接和标签各自的分页位置

标签使用无灰底卡片的轻量下划线样式，选中时使用暖橙文字与短下划线，数量采用小号文字，不再叠加数量胶囊

未启用时不再因为打开“我的”页面就自动弹出启用提示，只有用户主动点击才开始流程：

1. 点击“启用个人空间”，打开微信原生 `chooseAvatar` 选择入口
2. 用户确认头像后，自动启用当前微信身份的个人空间、上传头像并显示，不再追加第二个启用确认弹窗
3. 取消头像选择不会触发启用或上传，仍可通过“暂不设置头像，直接启用”开启个人空间
4. 已有头像的用户继续自动读取此前保存在 MySQL 中的头像，不需要重新选择

此流程不是静默获取微信头像，不使用 `getUserProfile` 或 `getUserInfo` 获取通用头像作为替代，也不会在未确认头像时伪报已保存

普通收藏、喜欢操作和跳过头像的启用路径仍保留原有确认提示，仅明确的启用按钮原生头像确认事件可以省略重复确认，不改变服务端微信身份校验

本次不修改后端接口、MySQL 表结构或环境变量，只需切换新开发版／体验版，实际微信头像选择、取消及再次打开自动显示仍需真机验收

## 数据库时间

后续北京时间入库、保留旧时间原值和结构升级顺序见 [数据库时间规则](database-time.md)，需要先停止旧版写入并升级 Alembic 至 `0006`，再部署新版后端
