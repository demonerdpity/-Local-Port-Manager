const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = {
  GET_PORT_INFO: 'port:get-info',
  GET_PROCESS_INFO: 'process:get-info',
  KILL_PROCESS: 'process:kill',
};

contextBridge.exposeInMainWorld('api', {
  // Only expose a small, explicit surface. Do not leak ipcRenderer directly.
  getPortInfo: (port) => ipcRenderer.invoke(IPC_CHANNELS.GET_PORT_INFO, port),
  getProcessInfo: (pid) => ipcRenderer.invoke(IPC_CHANNELS.GET_PROCESS_INFO, pid),
  killProcess: (pid) => ipcRenderer.invoke(IPC_CHANNELS.KILL_PROCESS, pid),
});
