/*
 * electron/preload.cjs —— 主进程与网页之间的安全桥
 *
 * 【为什么需要它】
 *   主进程开了 contextIsolation（隔离），网页里的 JS 默认碰不到 Electron API。
 *   这是安全设计：网页是本地 HTML，但万一被注入恶意脚本，也不能借 Electron
 *   的能力读文件、执行命令。preload 是唯一允许暴露受控 API 的地方。
 *
 * 【这里暴露什么】
 *   只暴露一个只读的 isElectron 标记 —— 让网页知道"我跑在桌面版里"，
 *   将来可以在界面上做一点适配（比如显示"桌面版"字样）。
 *   不暴露任何能读文件、执行命令的能力。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
});
