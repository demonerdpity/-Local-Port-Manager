const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');

const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const IPC_CHANNELS = {
  GET_PORT_INFO: 'port:get-info',
  GET_PROCESS_INFO: 'process:get-info',
  KILL_PROCESS: 'process:kill',
};

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#e8edf4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Desktop tool style: remove the default menu row on Windows to keep the window compact.
  mainWindow.removeMenu();

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(DEV_SERVER_URL);
    return;
  }

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

function ensureWindows() {
  if (process.platform !== 'win32') {
    throw new Error('This MVP currently supports Windows commands only.');
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
    // All system commands stay in the main process. Renderer only talks through IPC.
    exec(
      command,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
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

function parseNetstatOutput(output, targetPort) {
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
      const localPort = extractPortFromAddress(localAddress);

      if (localPort === targetPort) {
        records.push({
          protocol,
          addressFamily: detectAddressFamily(localAddress),
          localAddress,
          foreignAddress,
          state,
          pid: Number(pidToken),
        });
      }
    }

    if (protocol === 'UDP' && columns.length >= 4) {
      const [, localAddress, foreignAddress, pidToken] = columns;
      const localPort = extractPortFromAddress(localAddress);

      if (localPort === targetPort) {
        records.push({
          protocol,
          addressFamily: detectAddressFamily(localAddress),
          localAddress,
          foreignAddress,
          state: 'LISTENING',
          pid: Number(pidToken),
        });
      }
    }
  }

  return records;
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

async function getProcessName(pid) {
  const { stdout } = await runCommand(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  const firstDataLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

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
  const records = parseNetstatOutput(stdout, normalizedPort);

  return {
    success: true,
    port: normalizedPort,
    occupied: records.length > 0,
    primaryRecord: pickPrimaryRecord(records),
    records,
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
      pid: normalizedPid,
      message: 'Process not found or access denied.',
    };
  }

  return {
    success: true,
    pid: normalizedPid,
    processName,
    executablePath: processDetails?.ExecutablePath || null,
    commandLine: processDetails?.CommandLine || null,
  };
}

async function killProcess(pid) {
  ensureWindows();
  const normalizedPid = normalizePid(pid);

  try {
    const { stdout, stderr } = await runCommand(`taskkill /PID ${normalizedPid} /F`);

    return {
      success: true,
      pid: normalizedPid,
      message: (stdout || stderr || 'Process terminated successfully.').trim(),
    };
  } catch (error) {
    return {
      success: false,
      pid: normalizedPid,
      message: (error.stderr || error.message || 'Failed to terminate the process.').trim(),
    };
  }
}

function registerIpcHandlers() {
  // Promise-style IPC: renderer uses ipcRenderer.invoke, main uses ipcMain.handle.
  ipcMain.handle(IPC_CHANNELS.GET_PORT_INFO, async (_event, port) => {
    try {
      return await getPortInfo(port);
    } catch (error) {
      return {
        success: false,
        port: Number(port) || null,
        occupied: false,
        primaryRecord: null,
        records: [],
        message: error.message,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_PROCESS_INFO, async (_event, pid) => {
    try {
      return await getProcessInfo(pid);
    } catch (error) {
      return {
        success: false,
        pid: Number(pid) || null,
        message: error.message,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KILL_PROCESS, async (_event, pid) => {
    try {
      return await killProcess(pid);
    } catch (error) {
      return {
        success: false,
        pid: Number(pid) || null,
        message: error.message,
      };
    }
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
