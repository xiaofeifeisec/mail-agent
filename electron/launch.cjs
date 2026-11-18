/*
 * electron/launch.cjs —— Electron 启动器
 *
 * 【为什么多这一层，不直接 electron main.cjs】
 *   有些开发环境（AI 工具、某些终端）会注入 ELECTRON_RUN_AS_NODE=1，
 *   它会让 Electron 以「纯 Node 模式」启动 —— 结果就是没有窗口、
 *   require('electron') 拿不到 app 对象，直接报错退出。
 *   这个启动器做的唯一一件事：把这个变量删掉，再用真正的 Electron
 *   二进制拉起主进程。普通用户感觉不到它的存在，但它让"到处都能跑"。
 *
 *   用法：npm run electron       （等价于 node electron/launch.cjs）
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// 关键：清掉这个变量，否则 Electron 退化成 Node，没有 GUI
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// electron 包导出的是二进制绝对路径
const electronBin = require('electron');
const mainFile = path.join(__dirname, 'main.cjs');
const extraArgs = process.argv.slice(2);

// --no-sandbox：兼容受限环境（如某些 CI / 远程桌面 / 沙箱化终端）。
// 普通桌面环境加上它也无副作用，只是关闭 Chromium 的内层沙箱；
// 应用自身的 contextIsolation / nodeIntegration:false 仍在，安全性不靠它。
const electronArgs = [mainFile];
if (process.env.MAIL_ELECTRON_NO_SANDBOX === '1') {
  electronArgs.unshift('--no-sandbox', '--disable-gpu');
}
electronArgs.push(...extraArgs);

const child = spawn(electronBin, electronArgs, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', (e) => {
  console.error('无法启动 Electron：', e.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code || 0);
});
