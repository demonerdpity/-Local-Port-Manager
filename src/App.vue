<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

function unavailable() {
  throw new Error('未检测到 Electron 预加载 API，请使用 npm run dev 或 npm start 启动应用。');
}

const desktopApi = window.api || {
  copyText: unavailable,
  exportReport: unavailable,
  getDiagnostics: unavailable,
  getPortInfo: unavailable,
  getPortList: unavailable,
  getProcessInfo: unavailable,
  killProcess: unavailable,
  openExternal: unavailable,
  probeHttp: unavailable,
  revealPath: unavailable,
};

const views = [
  { key: 'query', label: '端口查询' },
  { key: 'ports', label: '端口列表' },
  { key: 'diagnostics', label: '诊断导出' },
];
const quickPorts = [3000, 5173, 8080, 8000, 3306, 6379];

const activeView = ref('query');
const autoRefresh = ref(false);
const diagnostics = ref(null);
const errorMessage = ref('');
const feedbackMessage = ref('');
const isDiagnosticsLoading = ref(false);
const isKilling = ref(false);
const isListLoading = ref(false);
const isLoading = ref(false);
const isProbing = ref(false);
const lastQueriedPort = ref('');
const portInput = ref('8080');
const portList = ref([]);
const portListFilter = ref('');
const portListGeneratedAt = ref('');
const portResult = ref(null);
const probeResult = ref(null);
const processResult = ref(null);
const showInfoPanel = ref(false);
const showKillConfirm = ref(false);

let refreshTimer = null;
let queryToken = 0;

const primaryRecord = computed(() => portResult.value?.primaryRecord || null);
const statusText = computed(() => {
  if (isLoading.value) {
    return '查询中';
  }

  if (!portResult.value) {
    return '待查询';
  }

  return portResult.value.occupied ? '占用中' : '空闲';
});
const displayPort = computed(() => portResult.value?.port || lastQueriedPort.value || '--');
const processName = computed(() => {
  if (processResult.value?.processName) {
    return processResult.value.processName;
  }

  if (portResult.value?.occupied) {
    return '未获取';
  }

  return '--';
});
const canRefresh = computed(() => Boolean(lastQueriedPort.value) && !isLoading.value);
const killGuardReason = computed(() => {
  if (!primaryRecord.value?.pid) {
    return '当前没有可结束的进程。';
  }

  return processResult.value?.protectedReason || '';
});
const canKill = computed(() => Boolean(primaryRecord.value?.pid) && !isKilling.value && !killGuardReason.value);
const probeTargets = computed(() => probeResult.value?.targets || []);
const bestOpenUrl = computed(() => {
  const reachableTarget = probeTargets.value.find((target) => target.reachable);

  if (reachableTarget) {
    return reachableTarget.url;
  }

  if (lastQueriedPort.value) {
    return `http://localhost:${lastQueriedPort.value}/`;
  }

  return null;
});
const currentSummary = computed(() => {
  if (!portResult.value) {
    return '当前还没有查询结果。';
  }

  return [
    `端口: ${displayPort.value}`,
    `状态: ${portResult.value.occupied ? '占用中' : '空闲'}`,
    `协议: ${primaryRecord.value ? `${primaryRecord.value.protocol} / ${primaryRecord.value.addressFamily}` : '--'}`,
    `本地地址: ${primaryRecord.value?.localAddress || '--'}`,
    `PID: ${primaryRecord.value?.pid || '--'}`,
    `进程名: ${processName.value}`,
    `HTTP 可达目标: ${probeTargets.value.filter((target) => target.reachable).map((target) => target.label).join('、') || '无'}`,
  ].join('\n');
});
const filteredPortList = computed(() => {
  const keyword = portListFilter.value.trim().toLowerCase();

  if (!keyword) {
    return portList.value;
  }

  return portList.value.filter((row) =>
    [row.port, row.protocol, row.addressFamily, row.localAddress, row.pid, row.processName]
      .map((value) => String(value || '').toLowerCase())
      .some((value) => value.includes(keyword)),
  );
});
const diagnosticJsonText = computed(() => (diagnostics.value ? JSON.stringify(diagnostics.value, null, 2) : ''));
const rawRecordsText = computed(() => {
  if (!diagnostics.value?.portInfo?.records?.length) {
    return '暂无匹配记录。';
  }

  return diagnostics.value.portInfo.records
    .map(
      (record) =>
        `${record.protocol} ${record.addressFamily} ${record.localAddress} -> ${record.foreignAddress} ${record.state} PID ${record.pid}`,
    )
    .join('\n');
});

function clearMessages() {
  errorMessage.value = '';
  feedbackMessage.value = '';
}

function setError(message) {
  errorMessage.value = message;
  feedbackMessage.value = '';
}

function setFeedback(message) {
  feedbackMessage.value = message;
  errorMessage.value = '';
}

function formatDateTime(value) {
  if (!value) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function buildDefaultUrl(port, addressFamily = 'Auto') {
  if (addressFamily === 'IPv6') {
    return `http://[::1]:${port}/`;
  }

  if (addressFamily === 'IPv4') {
    return `http://127.0.0.1:${port}/`;
  }

  return `http://localhost:${port}/`;
}

function toCsvCell(value) {
  const normalizedValue = String(value ?? '');
  return `"${normalizedValue.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  return rows.map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildPortListCsv(rows) {
  return toCsv([
    ['Port', 'Protocol', 'AddressFamily', 'LocalAddress', 'PID', 'ProcessName'],
    ...rows.map((row) => [row.port, row.protocol, row.addressFamily, row.localAddress, row.pid, row.processName || '']),
  ]);
}

function buildDiagnosticsCsv(report) {
  return toCsv([
    ['Section', 'Field1', 'Field2', 'Field3', 'Field4', 'Field5', 'Field6'],
    ['overview', 'port', report.port, 'status', report.portInfo.occupied ? 'occupied' : 'free', 'generatedAt', report.generatedAt],
    ['process', 'name', report.processInfo?.processName || '', 'pid', report.processInfo?.pid || '', 'path', report.processInfo?.executablePath || ''],
    ...report.hints.map((hint, index) => ['hint', index + 1, hint, '', '', '', '']),
    ...report.portInfo.records.map((record) => [
      'portRecord',
      record.protocol,
      record.addressFamily,
      record.localAddress,
      record.state,
      record.pid,
      record.foreignAddress,
    ]),
    ...report.probeResult.targets.map((target) => [
      'httpProbe',
      target.label,
      target.addressFamily,
      target.url,
      target.reachable ? 'reachable' : 'failed',
      target.statusCode || '',
      target.error || '',
    ]),
  ]);
}

async function copyTextAction(text, successMessage) {
  try {
    const result = await desktopApi.copyText(text);

    if (!result.success) {
      setError(result.message || '复制失败。');
      return;
    }

    setFeedback(successMessage);
  } catch (error) {
    setError(error.message || '复制失败。');
  }
}

async function openExternalUrl(url) {
  try {
    const result = await desktopApi.openExternal(url);

    if (!result.success) {
      setError(result.message || '打开浏览器失败。');
      return;
    }

    setFeedback('已在默认浏览器中打开地址。');
  } catch (error) {
    setError(error.message || '打开浏览器失败。');
  }
}

async function revealExecutablePath() {
  if (!processResult.value?.executablePath) {
    setError('当前进程没有可打开的可执行路径。');
    return;
  }

  try {
    const result = await desktopApi.revealPath(processResult.value.executablePath);

    if (!result.success) {
      setError(result.message || '打开所在目录失败。');
      return;
    }

    setFeedback('已打开可执行文件所在目录。');
  } catch (error) {
    setError(error.message || '打开所在目录失败。');
  }
}

async function loadProcessInfo(pid, requestId) {
  try {
    const result = await desktopApi.getProcessInfo(pid);

    if (requestId !== queryToken) {
      return;
    }

    if (!result.success) {
      processResult.value = null;
      setFeedback(result.message || '未能获取进程详细信息。');
      return;
    }

    processResult.value = result;
  } catch (error) {
    if (requestId === queryToken) {
      setError(error.message || '获取进程信息时发生异常。');
    }
  }
}

async function loadProbeInfo(port, requestId) {
  isProbing.value = true;

  try {
    const result = await desktopApi.probeHttp(port);

    if (requestId !== queryToken) {
      return;
    }

    if (!result.success) {
      probeResult.value = null;
      setFeedback(result.message || 'HTTP 探测失败。');
      return;
    }

    probeResult.value = result;
  } catch (error) {
    if (requestId === queryToken) {
      setError(error.message || 'HTTP 探测失败。');
    }
  } finally {
    if (requestId === queryToken) {
      isProbing.value = false;
    }
  }
}

async function lookupPort(port = portInput.value) {
  const value = String(port).trim();

  if (!value) {
    setError('请输入端口号。');
    return;
  }

  const requestId = ++queryToken;
  isLoading.value = true;
  clearMessages();
  diagnostics.value = null;

  try {
    const result = await desktopApi.getPortInfo(value);

    if (requestId !== queryToken) {
      return;
    }

    if (!result.success) {
      portResult.value = null;
      processResult.value = null;
      probeResult.value = null;
      setError(result.message || '端口查询失败。');
      return;
    }

    portResult.value = result;
    processResult.value = null;
    probeResult.value = null;
    lastQueriedPort.value = String(result.port);

    if (result.occupied && result.primaryRecord?.pid) {
      loadProcessInfo(result.primaryRecord.pid, requestId);
    }

    loadProbeInfo(result.port, requestId);
  } catch (error) {
    if (requestId === queryToken) {
      setError(error.message || '查询端口时发生异常。');
    }
  } finally {
    if (requestId === queryToken) {
      isLoading.value = false;
    }
  }
}

async function refreshCurrentPort() {
  if (!lastQueriedPort.value) {
    setError('请先查询一个端口。');
    return;
  }

  await lookupPort(lastQueriedPort.value);
}

async function selectQuickPort(port) {
  portInput.value = String(port);
  activeView.value = 'query';
  await lookupPort(port);
}

async function loadPortList() {
  isListLoading.value = true;

  try {
    const result = await desktopApi.getPortList();

    if (!result.success) {
      setError(result.message || '端口列表加载失败。');
      return;
    }

    portList.value = result.rows || [];
    portListGeneratedAt.value = result.generatedAt || '';
  } catch (error) {
    setError(error.message || '端口列表加载失败。');
  } finally {
    isListLoading.value = false;
  }
}

async function viewPortFromList(row) {
  portInput.value = String(row.port);
  activeView.value = 'query';
  await lookupPort(row.port);
}

async function openPortFromRow(row) {
  await openExternalUrl(buildDefaultUrl(row.port, row.addressFamily));
}

function askKillCurrentProcess() {
  if (!primaryRecord.value?.pid) {
    setError('当前没有可结束的进程。');
    return;
  }

  if (killGuardReason.value) {
    setError(killGuardReason.value);
    return;
  }

  showKillConfirm.value = true;
}

async function confirmKillCurrentProcess() {
  if (!primaryRecord.value?.pid) {
    showKillConfirm.value = false;
    return;
  }

  isKilling.value = true;
  showKillConfirm.value = false;
  clearMessages();

  try {
    const result = await desktopApi.killProcess(primaryRecord.value.pid);

    if (!result.success) {
      setError(result.message || '结束进程失败。');
      return;
    }

    setFeedback(result.message || '进程已结束。');
    await Promise.all([lookupPort(lastQueriedPort.value || portInput.value), loadPortList()]);
  } catch (error) {
    setError(error.message || '结束进程时发生异常。');
  } finally {
    isKilling.value = false;
  }
}

async function loadDiagnostics(port = lastQueriedPort.value) {
  const value = String(port || '').trim();

  if (!value) {
    setError('请先查询一个端口，再运行诊断。');
    return null;
  }

  isDiagnosticsLoading.value = true;

  try {
    const result = await desktopApi.getDiagnostics(value);

    if (!result.success) {
      setError(result.message || '运行诊断失败。');
      return null;
    }

    diagnostics.value = result;
    return result;
  } catch (error) {
    setError(error.message || '运行诊断失败。');
    return null;
  } finally {
    isDiagnosticsLoading.value = false;
  }
}

async function openDiagnosticsView() {
  activeView.value = 'diagnostics';
  await loadDiagnostics();
}

async function exportCurrentDiagnosticsJson() {
  const report = diagnostics.value || (await loadDiagnostics());

  if (!report) {
    return;
  }

  const result = await desktopApi.exportReport({
    content: JSON.stringify(report, null, 2),
    defaultFileName: `port-${report.port}-diagnostics.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  });

  if (!result.success) {
    if (!result.canceled) {
      setError(result.message || '导出诊断 JSON 失败。');
    }
    return;
  }

  setFeedback(`诊断 JSON 已导出到 ${result.filePath}`);
}

async function exportCurrentDiagnosticsCsv() {
  const report = diagnostics.value || (await loadDiagnostics());

  if (!report) {
    return;
  }

  const result = await desktopApi.exportReport({
    content: buildDiagnosticsCsv(report),
    defaultFileName: `port-${report.port}-diagnostics.csv`,
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });

  if (!result.success) {
    if (!result.canceled) {
      setError(result.message || '导出诊断 CSV 失败。');
    }
    return;
  }

  setFeedback(`诊断 CSV 已导出到 ${result.filePath}`);
}

async function exportPortListCsv() {
  if (!portList.value.length) {
    await loadPortList();
  }

  const rows = filteredPortList.value;

  if (!rows.length) {
    setError('当前没有可导出的端口列表。');
    return;
  }

  const result = await desktopApi.exportReport({
    content: buildPortListCsv(rows),
    defaultFileName: 'port-list.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });

  if (!result.success) {
    if (!result.canceled) {
      setError(result.message || '导出端口列表失败。');
    }
    return;
  }

  setFeedback(`端口列表已导出到 ${result.filePath}`);
}

function syncRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = null;

  if (!autoRefresh.value || !lastQueriedPort.value) {
    return;
  }

  refreshTimer = setInterval(() => {
    if (!isLoading.value && !isKilling.value) {
      lookupPort(lastQueriedPort.value);
    }
  }, 2000);
}

watch(autoRefresh, syncRefreshTimer);
watch(lastQueriedPort, syncRefreshTimer);
watch(activeView, (view) => {
  if (view === 'ports' && !portList.value.length) {
    loadPortList();
  }

  if (view === 'diagnostics' && lastQueriedPort.value && !diagnostics.value) {
    loadDiagnostics();
  }
});

onMounted(() => {
  loadPortList();
});

onBeforeUnmount(() => {
  clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <main class="window-panel">
      <header class="header-bar">
        <div class="header-left">
          <div class="brand-mark" aria-hidden="true">
            <img src="/port-manager-icon.png" alt="" />
          </div>
          <div class="title-block">
            <h1>Port Manager</h1>
            <p>本地端口管理与诊断</p>
          </div>
          <button class="info-btn" type="button" aria-label="打开说明" @click="showInfoPanel = true">i</button>
        </div>

        <span v-if="activeView === 'query'" class="status-chip" :class="portResult?.occupied ? 'status-busy' : 'status-free'">
          {{ statusText }}
        </span>
      </header>

      <nav class="view-nav">
        <button
          v-for="view in views"
          :key="view.key"
          class="nav-btn"
          :class="{ 'nav-btn-active': activeView === view.key }"
          type="button"
          @click="activeView = view.key"
        >
          {{ view.label }}
        </button>
      </nav>

      <p v-if="errorMessage" class="message error-message">{{ errorMessage }}</p>
      <p v-else-if="feedbackMessage" class="message success-message">{{ feedbackMessage }}</p>

      <section v-if="activeView === 'query'" class="view-shell">
        <section class="query-panel">
          <label class="field field-port">
            <span class="field-label">端口</span>
            <input
              v-model="portInput"
              class="port-input"
              type="number"
              min="1"
              max="65535"
              placeholder="8080"
              @keyup.enter="lookupPort()"
            />
          </label>

          <button class="primary-btn" type="button" :disabled="isLoading" @click="lookupPort()">
            {{ isLoading ? '查询中...' : '查询' }}
          </button>

          <button class="ghost-btn" type="button" :disabled="!canRefresh" @click="refreshCurrentPort">
            刷新
          </button>

          <button class="ghost-btn" type="button" :disabled="!lastQueriedPort" @click="openDiagnosticsView">
            诊断
          </button>
        </section>

        <section class="toolbar-row">
          <div class="shortcut-group">
            <span class="field-label">常用端口</span>
            <button
              v-for="port in quickPorts"
              :key="port"
              class="chip-btn"
              type="button"
              @click="selectQuickPort(port)"
            >
              {{ port }}
            </button>
          </div>

          <label class="toggle">
            <input v-model="autoRefresh" type="checkbox" />
            <span>每 2 秒自动刷新</span>
          </label>
        </section>

        <section class="action-strip">
          <button class="mini-btn" type="button" :disabled="!portResult" @click="copyTextAction(currentSummary, '端口摘要已复制。')">
            复制摘要
          </button>
          <button
            class="mini-btn"
            type="button"
            :disabled="!primaryRecord?.pid"
            @click="copyTextAction(String(primaryRecord?.pid || ''), 'PID 已复制。')"
          >
            复制 PID
          </button>
          <button
            class="mini-btn"
            type="button"
            :disabled="!primaryRecord?.pid"
            @click="copyTextAction(`taskkill /PID ${primaryRecord?.pid || ''} /F`, '结束命令已复制。')"
          >
            复制结束命令
          </button>
          <button class="mini-btn" type="button" :disabled="!bestOpenUrl" @click="openExternalUrl(bestOpenUrl)">
            打开浏览器
          </button>
          <button
            class="mini-btn"
            type="button"
            :disabled="!processResult?.executablePath"
            @click="revealExecutablePath"
          >
            打开程序目录
          </button>
        </section>

        <section class="result-grid">
          <article class="card">
            <div class="card-head">
              <div>
                <p class="card-label">端口状态</p>
                <h2>{{ displayPort }}</h2>
              </div>

              <span class="mini-tag">
                {{ portResult ? (portResult.occupied ? '已占用' : '可用') : '未查询' }}
              </span>
            </div>

            <div class="info-grid">
              <div class="stat-box">
                <span>状态</span>
                <strong>{{ portResult ? (portResult.occupied ? '占用中' : '空闲') : '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>协议</span>
                <strong>{{ primaryRecord ? `${primaryRecord.protocol} / ${primaryRecord.addressFamily}` : '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>本地地址</span>
                <strong>{{ primaryRecord?.localAddress || '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>PID</span>
                <strong>{{ primaryRecord?.pid || '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>进程名</span>
                <strong>{{ processName }}</strong>
              </div>
            </div>

            <div v-if="portResult?.records?.length" class="record-list">
              <div class="record-row record-head">
                <span>协议</span>
                <span>网络</span>
                <span>本地地址</span>
                <span>状态</span>
                <span>PID</span>
              </div>

              <div
                v-for="record in portResult.records"
                :key="`${record.protocol}-${record.localAddress}-${record.pid}`"
                class="record-row"
              >
                <span>{{ record.protocol }}</span>
                <span>{{ record.addressFamily }}</span>
                <span>{{ record.localAddress }}</span>
                <span>{{ record.state }}</span>
                <span>{{ record.pid }}</span>
              </div>
            </div>

            <p v-else class="empty-copy">当前没有匹配到该端口的监听或连接记录。</p>
          </article>

          <article class="card">
            <div class="card-head">
              <div>
                <p class="card-label">进程信息</p>
                <h2>{{ processName }}</h2>
              </div>

              <button class="danger-btn" type="button" :disabled="!canKill" @click="askKillCurrentProcess">
                {{ isKilling ? '结束中...' : '结束进程' }}
              </button>
            </div>

            <div v-if="killGuardReason && primaryRecord?.pid" class="guard-note">
              {{ killGuardReason }}
            </div>

            <div class="detail-stack">
              <div class="detail-block">
                <span>可执行路径</span>
                <code>{{ processResult?.executablePath || '系统未返回，或当前权限不足。' }}</code>
              </div>

              <div class="detail-block">
                <span>命令行</span>
                <code>{{ processResult?.commandLine || '系统未返回，或当前权限不足。' }}</code>
              </div>
            </div>
          </article>
        </section>

        <article class="card probe-card">
          <div class="card-head">
            <div>
              <p class="card-label">HTTP 探测</p>
              <h2>{{ lastQueriedPort || '--' }}</h2>
            </div>

            <span class="mini-tag">{{ isProbing ? '探测中' : '已更新' }}</span>
          </div>

          <div class="probe-list">
            <div v-for="target in probeTargets" :key="target.label" class="probe-item">
              <div class="probe-top">
                <strong>{{ target.label }}</strong>
                <span class="probe-badge" :class="target.reachable ? 'probe-ok' : 'probe-fail'">
                  {{ target.reachable ? `HTTP ${target.statusCode || ''}` : '不可达' }}
                </span>
              </div>
              <p>{{ target.url }}</p>
              <small>{{ target.reachable ? (target.server || target.contentType || '服务已响应') : target.error }}</small>
            </div>
          </div>
        </article>
      </section>

      <section v-else-if="activeView === 'ports'" class="view-shell">
        <section class="query-panel">
          <label class="field field-port">
            <span class="field-label">筛选</span>
            <input v-model="portListFilter" class="port-input" type="text" placeholder="按端口、PID、进程名、本地地址筛选" />
          </label>

          <button class="primary-btn" type="button" :disabled="isListLoading" @click="loadPortList">
            {{ isListLoading ? '刷新中...' : '刷新列表' }}
          </button>

          <button class="ghost-btn" type="button" :disabled="!filteredPortList.length" @click="exportPortListCsv">
            导出 CSV
          </button>
        </section>

        <article class="card table-card">
          <div class="table-meta">
            <span>当前监听端口 {{ filteredPortList.length }} 条</span>
            <span>最近刷新 {{ formatDateTime(portListGeneratedAt) }}</span>
          </div>

          <div class="table-wrap">
            <table class="port-table">
              <thead>
                <tr>
                  <th>端口</th>
                  <th>协议</th>
                  <th>网络</th>
                  <th>本地地址</th>
                  <th>PID</th>
                  <th>进程名</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in filteredPortList" :key="`${row.protocol}-${row.localAddress}-${row.pid}`">
                  <td :title="String(row.port)">{{ row.port }}</td>
                  <td :title="row.protocol">{{ row.protocol }}</td>
                  <td :title="row.addressFamily">{{ row.addressFamily }}</td>
                  <td>
                    <span class="table-truncate" :title="row.localAddress">{{ row.localAddress }}</span>
                  </td>
                  <td :title="String(row.pid)">{{ row.pid }}</td>
                  <td>
                    <span class="table-truncate" :title="row.processName || '--'">{{ row.processName || '--' }}</span>
                  </td>
                  <td class="row-actions">
                    <button class="mini-btn" type="button" @click="viewPortFromList(row)">查看</button>
                    <button class="mini-btn" type="button" @click="openPortFromRow(row)">打开</button>
                    <button class="mini-btn" type="button" @click="copyTextAction(String(row.pid), 'PID 已复制。')">
                      复制 PID
                    </button>
                  </td>
                </tr>
                <tr v-if="!filteredPortList.length">
                  <td colspan="7" class="empty-row">当前没有匹配的监听端口。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section v-else class="view-shell">
        <section class="query-panel">
          <label class="field field-port">
            <span class="field-label">目标端口</span>
            <input
              v-model="portInput"
              class="port-input"
              type="number"
              min="1"
              max="65535"
              placeholder="8080"
              @keyup.enter="loadDiagnostics(portInput)"
            />
          </label>

          <button class="primary-btn" type="button" :disabled="isDiagnosticsLoading" @click="loadDiagnostics(portInput)">
            {{ isDiagnosticsLoading ? '诊断中...' : '运行诊断' }}
          </button>

          <button class="ghost-btn" type="button" :disabled="!diagnostics" @click="exportCurrentDiagnosticsJson">
            导出 JSON
          </button>

          <button class="ghost-btn" type="button" :disabled="!diagnostics" @click="exportCurrentDiagnosticsCsv">
            导出 CSV
          </button>
        </section>

        <section class="diagnostic-grid">
          <article class="card">
            <div class="card-head">
              <div>
                <p class="card-label">诊断摘要</p>
                <h2>{{ diagnostics?.port || '--' }}</h2>
              </div>

              <span class="mini-tag">生成于 {{ formatDateTime(diagnostics?.generatedAt) }}</span>
            </div>

            <div class="info-grid">
              <div class="stat-box">
                <span>监听状态</span>
                <strong>{{ diagnostics ? (diagnostics.portInfo.occupied ? '占用中' : '空闲') : '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>可达目标数</span>
                <strong>{{ diagnostics?.probeResult?.reachableCount ?? '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>主进程</span>
                <strong>{{ diagnostics?.processInfo?.processName || '--' }}</strong>
              </div>
              <div class="stat-box">
                <span>系统</span>
                <strong>{{ diagnostics ? `${diagnostics.system.platform} / ${diagnostics.system.arch}` : '--' }}</strong>
              </div>
            </div>

            <ul class="hint-list">
              <li v-for="hint in diagnostics?.hints || ['请先运行一次诊断。']" :key="hint">{{ hint }}</li>
            </ul>
          </article>

          <article class="card diagnostic-probe-card">
            <div class="card-head">
              <div>
                <p class="card-label">HTTP 探测结果</p>
                <h2>{{ diagnostics?.port || '--' }}</h2>
              </div>

              <button
                class="mini-btn"
                type="button"
                :disabled="!diagnostics"
                @click="copyTextAction(diagnosticJsonText, '诊断 JSON 已复制。')"
              >
                复制 JSON
              </button>
            </div>

            <div class="probe-list">
              <div v-for="target in diagnostics?.probeResult?.targets || []" :key="target.label" class="probe-item">
                <div class="probe-top">
                  <strong>{{ target.label }}</strong>
                  <span class="probe-badge" :class="target.reachable ? 'probe-ok' : 'probe-fail'">
                    {{ target.reachable ? `HTTP ${target.statusCode || ''}` : '不可达' }}
                  </span>
                </div>
                <p>{{ target.url }}</p>
                <small>{{ target.reachable ? (target.server || target.contentType || '服务已响应') : target.error }}</small>
              </div>
            </div>
          </article>

          <article class="card span-full">
            <div class="card-head">
              <div>
                <p class="card-label">原始匹配记录</p>
                <h2>{{ diagnostics?.port || '--' }}</h2>
              </div>

              <button
                class="mini-btn"
                type="button"
                :disabled="!rawRecordsText"
                @click="copyTextAction(rawRecordsText, '原始记录已复制。')"
              >
                复制记录
              </button>
            </div>

            <pre class="raw-block">{{ rawRecordsText }}</pre>
          </article>

          <article class="card span-full">
            <div class="card-head">
              <div>
                <p class="card-label">托盘模式</p>
                <h2>小窗口常驻</h2>
              </div>
            </div>

            <p class="tray-copy">关闭窗口不会直接退出应用，而是隐藏到系统托盘。</p>
            <p class="tray-copy">你可以通过托盘图标双击或右键菜单快速恢复主窗口，也可以从托盘菜单直接退出应用。</p>
          </article>
        </section>
      </section>

      <div v-if="showInfoPanel" class="overlay" @click.self="showInfoPanel = false">
        <section class="modal-card info-modal">
          <div class="modal-head">
            <h3>功能说明</h3>
            <button class="close-btn" type="button" @click="showInfoPanel = false">关闭</button>
          </div>

          <p>这个工具现在包含三个视图：端口查询、端口列表、诊断导出。</p>
          <p>主查询页适合快速看单个端口并结束对应进程，端口列表页适合排查当前全部监听端口。</p>
          <p>诊断导出页会把 netstat 结果、HTTP 探测、进程信息和提示语汇总起来，并支持导出为 JSON 或 CSV。</p>
          <p>关闭窗口后应用会隐藏到系统托盘，方便用小窗口常驻。</p>
        </section>
      </div>

      <div v-if="showKillConfirm" class="overlay" @click.self="showKillConfirm = false">
        <section class="modal-card">
          <div class="modal-head">
            <h3>确认结束进程</h3>
            <button class="close-btn" type="button" @click="showKillConfirm = false">取消</button>
          </div>

          <p>将要结束的进程：</p>
          <p class="confirm-copy">PID {{ primaryRecord?.pid }} · {{ processName }}</p>
          <p class="confirm-copy">执行命令：taskkill /PID {{ primaryRecord?.pid }} /F</p>

          <div class="modal-actions">
            <button class="ghost-btn" type="button" @click="showKillConfirm = false">再想想</button>
            <button class="danger-btn" type="button" @click="confirmKillCurrentProcess">确认结束</button>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
