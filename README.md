# Port Manager

本地端口管理工具（Windows 优先）：查询端口占用、查看进程信息、一键结束进程，并提供端口列表、HTTP 探测与诊断导出，替代繁琐的 `netstat / tasklist / taskkill` 命令行操作。

## 功能一览

- 端口查询：输入端口号，返回占用状态、协议（TCP/UDP）、IPv4/IPv6、本地地址、PID、匹配记录
- 进程信息：根据 PID 获取进程名，并尽量读取可执行路径、命令行（受权限影响）
- 一键结束：`taskkill /PID xxx /F`，并对部分系统关键进程做保护提示
- 常用端口：`3000 / 5173 / 8080 / 8000 / 3306 / 6379`
- 端口列表：列出当前所有监听端口（含进程名），支持筛选与导出 CSV
- HTTP 探测：对 `localhost / 127.0.0.1 / ::1` 做 HTTP 连通性与状态码探测
- 诊断导出：汇总 `netstat`、HTTP 探测、进程信息与提示语，支持导出 JSON/CSV
- 托盘模式：关闭窗口默认隐藏到系统托盘（托盘菜单可退出）

## 技术栈

- Electron（主进程 + preload + 渲染进程）
- Vue 3 + Vite
- IPC：`ipcMain.handle` + `ipcRenderer.invoke`（Promise 风格）
- 安全桥：`contextBridge.exposeInMainWorld`（不直接暴露 `ipcRenderer`）
- Windows 命令：`netstat -ano`、`tasklist`、`taskkill`

## 快速开始

环境要求：
- Windows 10/11（当前实现依赖 Windows 命令）
- Node.js 18+（建议更高版本）

安装依赖：
```bash
npm install
```

开发模式（Vite + Electron 联调）：
```bash
npm run dev
```

生产模式（先构建再启动 Electron）：
```bash
npm start
```

说明：
- 开发态 Vite 端口固定为 `39217`（避免占用常见开发端口）。
- 修改了 `main.js` / `preload.js` 之后，需要完整重启 Electron 进程才会生效。

## 使用说明

### 端口查询

1. 切换到「端口查询」
2. 输入端口或点击常用端口
3. 查看占用信息与进程信息
4. 如需结束进程，点击「结束进程」并确认

页面内快捷操作包括：
- 复制摘要 / 复制 PID / 复制结束命令
- 打开浏览器（优先打开 HTTP 探测成功的地址）
- 打开程序目录（若可执行路径可获取）

### 端口列表

1. 切换到「端口列表」
2. 可在筛选框输入：端口、PID、进程名、本地地址关键字
3. 点击「查看」可跳回端口查询页并自动查询该端口
4. 点击「导出 CSV」可导出当前筛选结果

### 诊断导出

1. 切换到「诊断导出」
2. 输入端口并点击「运行诊断」
3. 可导出 JSON/CSV，也可复制原始匹配记录与诊断 JSON

诊断会输出类似提示：
- “仅监听在 IPv6，127.0.0.1 可能无法访问”
- “端口存在监听，但 HTTP 探测不通，可能不是 HTTP 服务”

### 托盘模式

- 默认行为：关闭窗口不会退出应用，而是隐藏到托盘
- 托盘：双击恢复主窗口；右键可「显示/隐藏」与「退出」

## 项目结构

- `main.js`：主进程，执行系统命令、HTTP 探测、托盘、导出与所有 IPC handler
- `preload.js`：安全桥，暴露 `window.api.*`
- `src/App.vue`：渲染进程 UI（端口查询 / 端口列表 / 诊断导出三视图）
- `src/style.css`：紧凑桌面工具风格样式
- `scripts/generate-icons.ps1`：生成 Windows 兼容的 `PNG/ICO` 图标文件
- `public/port-manager-icon.ico`：窗口/任务栏/托盘图标（Windows）
- `public/port-manager-icon.png`：界面内品牌图标（renderer）

## Renderer API（window.api）

渲染层通过 preload 暴露的 API 与主进程通信：

- `getPortInfo(port)`
- `getPortList()`
- `getProcessInfo(pid)`
- `killProcess(pid)`
- `probeHttp(port)`
- `getDiagnostics(port)`
- `exportReport({ content, defaultFileName, filters })`
- `copyText(text)`
- `openExternal(url)`
- `revealPath(path)`

## 常见问题

### 1) 浏览器能打开，但端口查询显示空闲？

建议进入「诊断导出」运行一次诊断，重点看：
- `netstat` 匹配记录是否存在
- 是否只监听在 IPv6（例如 `[::1]:8080`）
- `localhost / 127.0.0.1 / ::1` 哪个探测可达

### 2) 进程路径/命令行显示“系统未返回或权限不足”

部分进程信息需要更高权限才能读取；可以尝试以管理员权限运行应用或查看系统策略限制。

### 3) 图标没有更新/托盘图标为空

Windows 图标缓存较激进。请从托盘菜单选择「退出」后重新启动应用（不要只关闭窗口），必要时结束残留 `electron.exe` 后再启动。

## 图标生成

运行以下脚本可重新生成 `public/port-manager-icon.png` 与 `public/port-manager-icon.ico`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\generate-icons.ps1
```

