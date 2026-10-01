<div align="center">

<img src="assets/images/logo-256.png" width="112" alt="速笺 SuJot" />

# 速笺 SuJot

**个人极简笔记库**

A minimal, self-hosted Markdown notebook.

[![许可](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.8%2B-blue.svg)](https://www.python.org/downloads/)
[![依赖](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](document.md#design)
[![版本](https://img.shields.io/badge/version-0.1.0-informational.svg)](changelog.md)
[![平台](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#quickstart)

<sub>一条进程 · 一个目录 · 零依赖 · 无数据库 · 无构建步骤</sub>

</div>

![速笺 SuJot 的欢迎页](docs/screenshots/01-welcome.png)

---

<a id="intro"></a>
## 📖 简介 · Introduction

**个人极简笔记库**。 自己写、自己看、自己备份 —— 不打算做成协作工具，也没打算做成 SaaS，更不要求你信任任何人的服务器。

它有两种应用环境，用的是**同一份代码**：

| 怎么用 | 适合谁 | 长什么样 |
| --- | --- | --- |
| **个人电脑** | 想有个安静地方记笔记，不想折腾服务器 | 浏览器打开 `127.0.0.1:8013` 就是你的笔记库；关掉窗口就是关掉服务 |
| **服务器** | 想在任何设备上打开，想让笔记长期在线 | 一条命令装成 systemd 服务（开机自启），前面挂 nginx + HTTPS，域名一填就能从手机、平板、公司电脑访问 |

无论哪种活法，**笔记始终是磁盘上普通的 `.md` 文件** —— 服务挂了、你不想用了，用任何编辑器都能直接把笔记打开。

技术上：只用 **Python 标准库 + 原生 JS**，**零依赖、零构建、无数据库**、单进程，
Markdown 是唯一正文数据源，前端没有 Node 工具链，没有任何会腐烂的依赖。

**它适合你，如果：**

- 你希望笔记是**自己的文件**，而不是锁在某个平台数据库里的数据
- 你想要 Markdown + LaTeX 公式 + 粘贴截图，但不想为此装一整套 Node 工具链
- 你有一台服务器（或树莓派、或自己的电脑），想长期挂着一个安静的私人站点
- 你在意「十年后还能不能打开」—— 这里没有任何需要持续维护的依赖

**它不适合你，如果：** 需要多人协作、需要手机 App、需要端到端加密同步、
需要导出成各种格式。速笺有意不做这些（见[设计取舍](document.md#design)）。

---

<a id="quickstart"></a>
## 🚀 快速开始 · Quick Start

要求：**Python 3.8+**。整个项目只用标准库，不装任何第三方包。

**Windows**

1. Python环境。到 <https://www.python.org/downloads/> 下安装包，装的时候**勾上「Add Python to PATH」**
2. 解压发布包，**双击 `start_run_locally.cmd`**
3. 浏览器打开 <http://127.0.0.1:8013>

**Linux / macOS**

```bash
git clone https://github.com/Primerusse/SuJot.git
cd 你解压出来的目录
./start_run_locally.sh 
# 会先检查 Python 版本、准备数据目录（不联网、不装东西）→ http://127.0.0.1:8013
```

数据会自动落在项目旁边的 `data/`（Windows 是 `data\`），不写任何系统目录；
想放别处：`SUJIAN_BASE=/your/path ./start_run_locally.sh`。

浏览器打开后用**初始账号 `admin` / `admin`** 登录，登录后**强制**改用户名和密码 ——
改完才算真正可用（在此之前，保存、新建、删除等写操作会被服务端拒绝）。
首次启动会自动建目录、生成会话密钥，并从 `assets/` 铺入 4 篇样板笔记。

> 默认只绑本机。要让外网访问，用 nginx 反代 + HTTPS（见[部署](document.md#deploy)），
> 别把 8013 直接暴露出去 —— 登录 Cookie 带 `Secure` 标记，纯 HTTP 下浏览器不会保存它。

---

## 📄 文档

详见 **[document.md](document.md)**

---

## 👤 关于作者 · Author
**Primerusse**
*   学历(Education)：在读本科 (Undergraduate Student)
*   个人博客(Blog)：[primerusse.top](https://primerusse.top)
*   邮箱(Email)：primerusse@gmail.com <br> (📧 来信请在主题说明来意 / 📧 Please state the purpose of your email in the subject line)
*   研究兴趣(Research Interests)：<br>计算力学 (Computational Mechanics)<br>有限元分析 (Finite Element Analysis)<br>数值仿真 (Numerical Simulation)<br>数学 (Mathematics)

⭐ 如果这些代码对你的学习有帮助，欢迎给个 Star 支持一下！<br>
⭐ If these codes are helpful to your study, please give a Star to support!
