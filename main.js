const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} = require('electron');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const DEV_SERVER_URL = 'http://127.0.0.1:5173';
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
const PROTECTED_PROCESS_NAMES = new Set([
  'csrss.exe',
  'dwm.exe',
  'lsass.exe',
  'registry',
  'services.exe',
  'smss.exe',
  'svchost.exe',
  'system',
  'system idle process',
  'wininit.exe',
  'winlogon.exe',
]);
const PROBE_TARGETS = [
  {
    label: 'localhost',
    hostname: 'localhost',
    addressFamily: 'Auto',
    url: (port) => `http://localhost:${port}/`,
  },
  {
    label: '127.0.0.1',
    hostname: '127.0.0.1',
    family: 4,
    addressFamily: 'IPv4',
    url: (port) => `http://127.0.0.1:${port}/`,
  },
  {
    label: '::1',
    hostname: '::1',
    family: 6,
    addressFamily: 'IPv6',
    url: (port) => `http://[::1]:${port}/`,
  },
];

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#e8edf4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  return mainWindow;
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="8" y="8" width="48" height="48" rx="14" fill="#2f6df6"/>
      <path d="M22 34h20M22 24h20M22 44h12" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
    </svg>
  `;

  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 16, height: 16 });
}

function showMainWindow() {
  const window = createWindow();

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const isVisible = Boolean(mainWindow && mainWindow.isVisible());

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: isVisible ? '隐藏主窗口' : '显示主窗口',
        click: () => {
          if (isVisible && mainWindow) {
            mainWindow.hide();
          } else {
            showMainWindow();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Port Manager');
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
  return tray;
}

function ensureWindows() {
  if (process.platform !== 'win32') {
    throw new Error('This desktop version currently supports Windows commands only.');
  }
}

function normalizePort(port) {
  const parsedPort = Number(port);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('Please enter a valid port number between 1 and 65535.');
  }

  return parsedPort;
}

function normalizePid(pid) {
  const parsedPid = Number(pid);

  if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
    throw new Error('Please provide a valid PID.');
  }

  return parsedPid;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function extractPortFromAddress(address) {
  const match = String(address).match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function detectAddressFamily(address) {
  return String(address).includes('[') ? 'IPv6' : 'IPv4';
}

function parseNetstatRecords(output) {
  const records = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('Active Connections') || trimmedLine.startsWith('Proto')) {
      continue;
    }

    const columns = trimmedLine.split(/\s+/);
    const protocol = (columns[0] || '').toUpperCase();

    if (protocol === 'TCP' && columns.length >= 5) {
      const [, localAddress, foreignAddress, state, pidToken] = columns;
      const port = extractPortFromAddress(localAddress);

      records.push({
        protocol,
        addressFamily: detectAddressFamily(localAddress),
        localAddress,
        foreignAddress,
        pid: Number(pidToken),
        port,
        state,
      });
    }

    if (protocol === 'UDP' && columns.length >= 4) {
      const [, localAddress, foreignAddress, pidToken] = columns;
      const port = extractPortFromAddress(localAddress);

      records.push({
        protocol,
        addressFamily: detectAddressFamily(localAddress),
        localAddress,
        foreignAddress,
        pid: Number(pidToken),
        port,
        state: 'BOUND',
      });
    }
  }

  return records.filter((record) => Number.isInteger(record.port));
}

function sortPortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.port !== right.port) {
      return left.port - right.port;
    }

    if (left.protocol !== right.protocol) {
      return left.protocol.localeCompare(right.protocol);
    }

    if (left.addressFamily !== right.addressFamily) {
      return left.addressFamily.localeCompare(right.addressFamily);
    }

    return left.localAddress.localeCompare(right.localAddress);
  });
}

function isListeningRecord(record) {
  return record.protocol === 'UDP' || record.state === 'LISTENING';
}

function pickPrimaryRecord(records) {
  if (!records.length) {
    return null;
  }

  const sortWeight = (record) => {
    if (record.state === 'LISTENING') {
      return 0;
    }

    if (record.protocol === 'TCP') {
      return 1;
    }

    return 2;
  };

  return [...records].sort((left, right) => sortWeight(left) - sortWeight(right))[0];
}

function parseCsvLine(line) {
  const matches = String(line).match(/"([^"]*)"/g) || [];
  return matches.map((item) => item.slice(1, -1));
}

function getProtectedProcessReason(pid, processName) {
  const normalizedName = String(processName || '').trim().toLowerCase();

  if (pid === 0 || pid === 4) {
    return '系统关键 PID 已受保护，不能在工具内直接结束。';
  }

  if (PROTECTED_PROCESS_NAMES.has(normalizedName)) {
    return `进程 ${processName} 已加入保护列表，不能在工具内直接结束。`;
  }

  return null;
}

async function getProcessMap() {
  const { stdout } = await runCommand('tasklist /FO CSV /NH');
  const processMap = new Map();

  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const [processName, pidToken] = parseCsvLine(line);
    const pid = Number(pidToken);

    if (processName && Number.isInteger(pid)) {
      processMap.set(pid, processName);
    }
  }

  return processMap;
}

async function getProcessName(pid) {
  const { stdout } = await runCommand(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  const firstDataLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('"'));

  const [processName] = parseCsvLine(firstDataLine);
  return processName || null;
}

async function getProcessDetails(pid) {
  const command =
    `powershell -NoProfile -Command "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    `if ($process) { [PSCustomObject]@{ ExecutablePath = $process.ExecutablePath; CommandLine = $process.CommandLine } | ` +
    `ConvertTo-Json -Compress }"`;

  try {
    const { stdout } = await runCommand(command);
    const jsonText = stdout.trim();

    if (!jsonText) {
      return null;
    }

    return JSON.parse(jsonText);
  } catch (error) {
    return null;
  }
}

async function getPortInfo(port) {
  ensureWindows();
  const normalizedPort = normalizePort(port);
  const { stdout } = await runCommand('netstat -ano');
  const records = parseNetstatRecords(stdout).filter((record) => record.port === normalizedPort);

  return {
    success: true,
    occupied: records.length > 0,
    port: normalizedPort,
    primaryRecord: pickPrimaryRecord(records),
    records: sortPortRecords(records),
  };
}

async function getPortList() {
  ensureWindows();

  const [netstatResult, processMap] = await Promise.all([
    runCommand('netstat -ano'),
    getProcessMap().catch(() => new Map()),
  ]);
  const rows = [];
  const seenKeys = new Set();

  for (const record of sortPortRecords(parseNetstatRecords(netstatResult.stdout).filter(isListeningRecord))) {
    const key = `${record.protocol}-${record.localAddress}-${record.pid}`;

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    const processName = processMap.get(record.pid) || null;

    rows.push({
      ...record,
      killProtectedReason: getProtectedProcessReason(record.pid, processName),
      processName,
    });
  }

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    rows,
  };
}

async function getProcessInfo(pid) {
  ensureWindows();
  const normalizedPid = normalizePid(pid);

  const [processName, processDetails] = await Promise.all([
    getProcessName(normalizedPid).catch(() => null),
    getProcessDetails(normalizedPid),
  ]);

  if (!processName && !processDetails) {
    return {
      success: false,
      message: 'Process not found or access denied.',
      pid: normalizedPid,
    };
  }

  return {
    success: true,
    commandLine: processDetails?.CommandLine || null,
    executablePath: processDetails?.ExecutablePath || null,
    pid: normalizedPid,
    processName,
    protectedReason: getProtectedProcessReason(normalizedPid, processName),
  };
}

async function killProcess(pid) {
  ensureWindows();
  const normalizedPid = normalizePid(pid);
  const processName = await getProcessName(normalizedPid).catch(() => null);
  const protectedReason = getProtectedProcessReason(normalizedPid, processName);

  if (protectedReason) {
    return {
      success: false,
      message: protectedReason,
      pid: normalizedPid,
      processName,
      protected: true,
    };
  }

  try {
    const { stdout, stderr } = await runCommand(`taskkill /PID ${normalizedPid} /F`);

    return {
      success: true,
      message: (stdout || stderr || 'Process terminated successfully.').trim(),
      pid: normalizedPid,
      processName,
    };
  } catch (error) {
    return {
      success: false,
      message: (error.stderr || error.message || 'Failed to terminate the process.').trim(),
      pid: normalizedPid,
      processName,
    };
  }
}

function probeHttpTarget(target, port) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        family: target.family,
        headers: {
          Accept: 'text/html,application/json,*/*;q=0.8',
          'User-Agent': 'Port Manager',
        },
        hostname: target.hostname,
        method: 'GET',
        path: '/',
        port,
        timeout: 2500,
      },
      (response) => {
        response.resume();

        resolve({
          addressFamily: target.addressFamily,
          contentType: response.headers['content-type'] || null,
          label: target.label,
          location: response.headers.location || null,
          reachable: true,
          server: response.headers.server || null,
          statusCode: response.statusCode || null,
          statusMessage: response.statusMessage || '',
          url: target.url(port),
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Request timed out.'));
    });

    request.on('error', (error) => {
      resolve({
        addressFamily: target.addressFamily,
        error: error.code ? `${error.code}: ${error.message}` : error.message,
        label: target.label,
        reachable: false,
        url: target.url(port),
      });
    });

    request.end();
  });
}

async function probeHttp(port) {
  const normalizedPort = normalizePort(port);
  const targets = await Promise.all(PROBE_TARGETS.map((target) => probeHttpTarget(target, normalizedPort)));

  return {
    success: true,
    port: normalizedPort,
    reachableCount: targets.filter((target) => target.reachable).length,
    scheme: 'http',
    targets,
  };
}

function buildDiagnosticHints(portInfo, probeResult) {
  const hints = [];
  const listeningRecords = portInfo.records.filter(isListeningRecord);
  const hasIPv4Listener = listeningRecords.some((record) => record.addressFamily === 'IPv4');
  const hasIPv6Listener = listeningRecords.some((record) => record.addressFamily === 'IPv6');
  const hasReachableProbe = probeResult.targets.some((target) => target.reachable);

  if (hasIPv6Listener && !hasIPv4Listener) {
    hints.push('该端口当前仅监听在 IPv6，127.0.0.1 可能无法访问。');
  }

  if (hasIPv4Listener && !hasIPv6Listener) {
    hints.push('该端口当前仅监听在 IPv4，::1 可能无法访问。');
  }

  if (portInfo.occupied && !hasReachableProbe) {
    hints.push('端口存在监听，但 HTTP 探测未连通，说明它可能不是 HTTP 服务，或只接受特定路径/协议。');
  }

  if (!portInfo.occupied && hasReachableProbe) {
    hints.push('HTTP 探测可访问，但 netstat 未匹配到监听记录，请检查本机代理、端口转发或容器映射。');
  }

  if (!hints.length) {
    hints.push('当前端口状态与 HTTP 探测结果基本一致。');
  }

  return hints;
}

async function getDiagnostics(port) {
  const normalizedPort = normalizePort(port);
  const [portInfo, probeResult] = await Promise.all([getPortInfo(normalizedPort), probeHttp(normalizedPort)]);
  let processInfo = null;

  if (portInfo.primaryRecord?.pid) {
    processInfo = await getProcessInfo(portInfo.primaryRecord.pid);
  }

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    hints: buildDiagnosticHints(portInfo, probeResult),
    port: normalizedPort,
    portInfo,
    probeResult,
    processInfo,
    system: {
      arch: process.arch,
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      username: os.userInfo().username,
    },
  };
}

async function exportReport(payload) {
  const filters = payload?.filters || [{ name: 'Text Files', extensions: ['txt'] }];
  const defaultFileName = payload?.defaultFileName || 'port-manager-report.txt';
  const content = String(payload?.content || '');
  const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const defaultPath = path.join(app.getPath('documents'), defaultFileName);
  const dialogResult = await dialog.showSaveDialog(parentWindow, {
    defaultPath,
    filters,
  });

  if (dialogResult.canceled || !dialogResult.filePath) {
    return {
      success: false,
      canceled: true,
    };
  }

  await fs.writeFile(dialogResult.filePath, content, 'utf8');

  return {
    success: true,
    filePath: dialogResult.filePath,
  };
}

async function copyText(text) {
  clipboard.writeText(String(text || ''));
  return { success: true };
}

async function openExternalUrl(urlValue) {
  const targetUrl = new URL(String(urlValue));

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw new Error('Only http and https URLs can be opened from this tool.');
  }

  await shell.openExternal(targetUrl.toString());
  return { success: true };
}

async function revealPath(targetPath) {
  const normalizedPath = String(targetPath || '').trim();

  if (!normalizedPath) {
    throw new Error('Please provide a valid file path.');
  }

  await fs.access(normalizedPath);
  shell.showItemInFolder(normalizedPath);
  return { success: true };
}

function wrapHandler(handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload);
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  };
}

function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_PORT_INFO, wrapHandler(getPortInfo));
  ipcMain.handle(IPC_CHANNELS.GET_PORT_LIST, wrapHandler(getPortList));
  ipcMain.handle(IPC_CHANNELS.GET_PROCESS_INFO, wrapHandler(getProcessInfo));
  ipcMain.handle(IPC_CHANNELS.KILL_PROCESS, wrapHandler(killProcess));
  ipcMain.handle(IPC_CHANNELS.PROBE_HTTP, wrapHandler(probeHttp));
  ipcMain.handle(IPC_CHANNELS.GET_DIAGNOSTICS, wrapHandler(getDiagnostics));
  ipcMain.handle(IPC_CHANNELS.EXPORT_REPORT, wrapHandler(exportReport));
  ipcMain.handle(IPC_CHANNELS.COPY_TEXT, wrapHandler(copyText));
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, wrapHandler(openExternalUrl));
  ipcMain.handle(IPC_CHANNELS.REVEAL_PATH, wrapHandler(revealPath));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createTray();
  createWindow();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
