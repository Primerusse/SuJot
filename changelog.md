# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。

## [0.1.0] — 2026-10-01

**第一个版本。**

速笺是一个只给一个人用的私人笔记站：网页上写 Markdown、看公式、传图片、自动保存，
而笔记始终是磁盘上一个个普通的 `.md` 文件 —— 服务挂了、你不想用了，用任何编辑器都能直接打开它。

**两种活法，同一份代码**

- **只在自己电脑上跑**：双击 `start_run_locally.cmd`（Windows）或 `./start_run_locally.sh`（Linux、macOS），
  浏览器打开 `127.0.0.1:8013` 就是你的笔记库；关掉窗口就是关掉服务
- **部署到服务器**：`sudo deploy/install-service.sh` 装成 systemd 服务（开机自启、崩了自动拉起），
  前面挂 nginx + HTTPS，域名一填，手机、平板、公司电脑都能访问

**技术形态**

- 只用 **Python 标准库 + 原生 JS**：零第三方依赖、零构建步骤、无数据库、单进程
- **Markdown 是唯一正文数据源**；附件放在 `notes/assets/`，随时可以整个目录拷走
- 静态资源长缓存 + gzip；一条进程常态占用一百多 MB，768 MB 的小机器也跑得动
- 数学公式（KaTeX）、代码高亮、图片粘贴上传、历史版本、回收站、整库导出打包
- 全部可调参数集中在 **`_config.json`**（支持 `//` 注释），优先级：环境变量 > 配置文件 > 代码默认值

**安全**

- 初始账号 `admin` / `admin`，首次登录**强制**改用户名和密码，改完之前写操作一律拒绝
- 密码只存 **PBKDF2 加盐哈希**，不保存明文；会话令牌 HMAC 签名 + HttpOnly Cookie
- 默认只监听 `127.0.0.1`，外网访问一律经 nginx 反代 + HTTPS

**发布包**

- 一个包：`sujot-v0.1.0.zip`，解压出来就是项目根（不套外层目录），自带一次干净提交的 `.git`，
  可以直接 `git remote add` 后推到你自己的仓库，也可以 `git clone ./ 我的副本`
- 字体（Inter / JetBrains Mono / 霞鹜文楷）与 KaTeX 全部随包自托管，SIL OFL / MIT，可商用

[0.1.0]: https://github.com/Primerusse/SuJot/releases/tag/v0.1.0
