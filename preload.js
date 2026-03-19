const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = {
  COPY_TEXT: 'system:copy-text',
  EXPORT_REPORT: 'system:export-report',
  GET_DIAGNOSTICS: 'diagnostics:get-report',
  GET_PORT_INFO: 'port:get-info',
  GET_PORT_LIST: 'port:get-list',
  GET_PROCESS_INFO: 'process:get-info',
  KILL_PROCESS: 'process:kill',
  OPEN_EXTERNAL: 'system:open-external',
  PROBE_HTTP: 'port:probe-http',
  REVEAL_PATH: 'system:reveal-path',
};

contextBridge.exposeInMainWorld('api', {
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.COPY_TEXT, text),
  exportReport: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_REPORT, payload),
  getDiagnostics: (port) => ipcRenderer.invoke(IPC_CHANNELS.GET_DIAGNOSTICS, port),
  getPortInfo: (port) => ipcRenderer.invoke(IPC_CHANNELS.GET_PORT_INFO, port),
  getPortList: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PORT_LIST),
  getProcessInfo: (pid) => ipcRenderer.invoke(IPC_CHANNELS.GET_PROCESS_INFO, pid),
  killProcess: (pid) => ipcRenderer.invoke(IPC_CHANNELS.KILL_PROCESS, pid),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  probeHttp: (port) => ipcRenderer.invoke(IPC_CHANNELS.PROBE_HTTP, port),
  revealPath: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.REVEAL_PATH, targetPath),
});
