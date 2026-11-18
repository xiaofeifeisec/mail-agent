/*
 * electron/main.cjs —— Electron 桌面版主进程
 *
 * 【为什么要单独写这个文件】
 *   Electron 有两个进程：
 *     - 主进程（这里）：管窗口、菜单、应用生命周期，能调 Node/OS 能力
 *     - 渲染进程（窗口里的网页）：就是现有的 web/index.html
 *   主进程负责"把后台服务拉起来 + 开一个窗口指向它"。
 *
 * 【为什么不直接用现有的 .app】
 *   现有的「邮箱助手.app」只是启动服务后开【系统浏览器】；
 *   Electron 是开一个【自带独立窗口】的应用，更像原生软件——
 *   有自己的任务栏图标、不依赖用户装了什么浏览器、可离线打包。
 *
 * 【架构选择：子进程 vs 内联 serve()】
 *   本可以用 import serve() 内联启服务，但 server.ts 的 bootMonitor()
 *   （后台守护轮询）没有导出，内联会丢掉这个功能。所以这里用
 *   child_process 启动现成的 server.ts —— 复用全部已验证行为，零改动后端。
 *
 * 【为什么用 .cjs 后缀】
 *   项目 package.json 是 "type": "module"，.js 会被当 ESM；
 *   Electron 主进程用 CommonJS 最省事，.cjs 显式告诉 Node 用 CJS。
 */

const { app, BrowserWindow, shell, Menu, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.MAIL_ELECTRON_PORT || 5173);
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;

let mainWindow = null;
let serverProc = null;
let serverStartedByUs = false;

function log(...args) {
  console.log('[mail-agent electron]', ...args);
}

/* ---------- 探测服务是否已在运行 ---------- */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ---------- 等待服务就绪（最多 30 秒）---------- */
async function waitReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/* ---------- 启动后端服务子进程 ---------- */
function startServer() {
  // 找 node 可执行文件：优先用项目里的，其次系统 PATH
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  let nodeBin = candidates.find((p) => { try { return fs.accessSync(p, fs.constants.X_OK), true; } catch { return false; } });
  if (!nodeBin) nodeBin = 'node'; // 交给 PATH 解析

  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverTs = path.join(ROOT, 'src', 'web', 'server.ts');

  const env = { ...process.env, PORT: String(PORT) };
  // 本机有 HTTP 代理时，不绕过会导致请求 127.0.0.1 被代理拦成 502
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  // 守护循环保持开启（server.ts 默认开，这里不传 MAIL_MONITOR=0）

  serverProc = spawn(nodeBin, [tsxCli, serverTs], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverStartedByUs = true;

  // 把后端日志转发到终端，方便排错
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('error', (e) => log('服务进程启动失败:', e.message));
  serverProc.on('exit', (code) => {
    log(`服务进程退出，code=${code}`);
    serverProc = null;
  });
}

/* ---------- 清理：退出时关掉我们启动的服务 ---------- */
function stopServer() {
  if (serverProc && !serverProc.killed) {
    log('正在关闭后端服务...');
    try { serverProc.kill('SIGTERM'); } catch { /* 已退出 */ }
    serverProc = null;
  }
}

/* ---------- 创建主窗口 ---------- */
function createWindow() {
  const iconFile = path.join(ROOT, 'web', 'logo-1024.png');
  const win = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: '邮箱助手',
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,   // 隔离网页 JS 和 Electron API（安全）
      nodeIntegration: false,   // 网页里不能直接 require Node（安全）
      sandbox: false,           // 允许 preload 用有限 Node API
      webSecurity: true,
    },
  });
  mainWindow = win;

  win.loadURL(URL).catch((e) => log('加载页面失败:', e.message));

  // 外部链接用系统浏览器打开，不在应用窗口里跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('closed', () => { mainWindow = null; });
  return win;
}

/* ---------- 菜单：精简成原生应用的样子 ---------- */
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: '邮箱助手',
      submenu: [
        { role: 'about', label: '关于邮箱助手' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    }] : []),
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 单实例锁：重复双击只聚焦已有窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();

    // 放行网页的麦克风权限请求，否则渲染进程里的 getUserMedia 会被 Chromium 拒绝。
    // 注意：macOS 系统层还要 Info.plist 里的 NSMicrophoneUsageDescription，
    // 两者缺一不可 —— 只改这里，系统弹窗仍会被跳过并直接拒绝。
    session.defaultSession.setPermissionRequestHandler(function (wc, permission, callback) {
      // 本地页面只加载 http://127.0.0.1，无第三方内容，其余权限也放行以免误伤剪贴板等。
      callback(true);
    });

    // 服务没跑就启动它；已在跑（比如用户开了 npm run web）就复用
    if (!(await probe())) {
      log('后端服务未运行，正在启动...');
      startServer();
      const ready = await waitReady();
      if (!ready) {
        dialog.showErrorBox(
          '邮箱助手启动失败',
          `后端服务未能在 30 秒内就绪（${URL}）。\n请检查：\n1. Node.js 是否已安装（≥20）\n2. 依赖是否装好（npm install）\n3. 端口 ${PORT} 是否被其它程序占用`,
        );
        app.quit();
        return;
      }
      log('后端服务已就绪');
    } else {
      log('复用已运行的后端服务');
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 所有窗口关闭就退出（macOS 上保留 app 常驻也可，这里按传统桌面应用处理）
  app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', stopServer);
  process.on('exit', stopServer);
  // 兜底：收到终止信号也清理子进程
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { stopServer(); app.quit(); });
  }
}
