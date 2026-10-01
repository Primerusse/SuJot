# 在自己的电脑上运行（速查）

目标：解压 → 跑起来 → 浏览器里写笔记。全程约 3 分钟。

**前提**：装了 **Python 3.8+**，就这一个要求（项目只用标准库，不装任何第三方包）。
没有的话去 <https://www.python.org/downloads/> 下安装包，**装的时候勾上「Add Python to PATH」**。

## Windows

1. 把 zip 解压到任意目录（比如 `D:\sujot`），**不要解压到 C 盘根目录或 Program Files**
2. 进入解压出来的文件夹，**双击 `start_run_locally.cmd`**
3. 浏览器会**自动打开** <http://127.0.0.1:8013>（没弹出就手动开这个地址）
4. 用初始账号 **`admin` / `admin`** 登录 → 按提示改用户名和密码
5. 关掉那个黑窗口就是停止服务

命令行也行：

```bat
cd /d D:\sujot
start_run_locally.cmd
```

## Linux / macOS

```bash
cd 你解压出来的目录
./start_run_locally.sh          # 会先检查 Python 版本、备好数据目录（不联网、不装东西），然后启动
```

不想让它自动开浏览器：`SUJIAN_NO_OPEN=1 ./start_run_locally.sh`。

`Ctrl+C` 停止。

## 数据在哪

第一次启动会在项目旁边建一个 `data/`（Windows 是 `data\`），你的笔记就在里面：

```
data/notes/      笔记正文（*.md）和图片（notes/assets/）—— 你真正在乎的东西
data/.history/   历史版本    data/.trash/   回收站
data/users.json  账号        data/.secret   会话密钥
```

**备份 = 拷这个 `data/` 目录**；**迁移 = 把它拷到新机器的同一个位置**。

想改端口 / 数据目录这些，直接编辑项目根的 `_config.json`（里面每一项都有注释说明）；
临时改一次也可以加环境变量，比如 `SUJIAN_PORT=8014 ./start_run_locally.sh`。

想放到别处（比如移动硬盘）：

```bash
SUJIAN_BASE=/e/我的笔记 ./start_run_locally.sh          # Linux / macOS
set SUJIAN_BASE=E:\我的笔记 && start_run_locally.cmd    # Windows
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 窗口一闪就没 / 提示找不到 Python | 没装 Python 或没勾「Add to PATH」，重装一次勾上 |
| 浏览器打不开 | 看黑窗口里有没有报错；端口被占就 `set SUJIAN_PORT=8014 && start_run_locally.cmd` |
| 页面能开但登录后又跳回登录页 | 别用别的主机名访问，就用 `http://127.0.0.1:8013` |
| 想让局域网里别的设备也能看 | 设 `SUJIAN_HOST=0.0.0.0`，并注意登录 Cookie 需要 HTTPS，最好还是挂 nginx |
| 想换端口 | `SUJIAN_PORT=8014 ./start_run_locally.sh`（Windows 用 `set SUJIAN_PORT=8014`） |

想放到服务器上长期跑、外面也能访问，见 `docs/服务器部署步骤.md`。
