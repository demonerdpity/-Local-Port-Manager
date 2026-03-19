<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const desktopApi = window.api || {
  async getPortInfo() {
    throw new Error('未检测到 Electron 预加载 API，请使用 npm run dev 或 npm start 启动应用。');
  },
  async getProcessInfo() {
    throw new Error('未检测到 Electron 预加载 API，请使用 npm run dev 或 npm start 启动应用。');
  },
  async killProcess() {
    throw new Error('未检测到 Electron 预加载 API，请使用 npm run dev 或 npm start 启动应用。');
  },
};

const quickPorts = [3000, 5173, 8080, 8000, 3306, 6379];
const portInput = ref('8080');
const lastQueriedPort = ref('');
const autoRefresh = ref(false);
const showInfoPanel = ref(false);
const isLoading = ref(false);
const isKilling = ref(false);
const errorMessage = ref('');
const feedbackMessage = ref('');
const portResult = ref(null);
const processResult = ref(null);

let refreshTimer = null;

const primaryRecord = computed(() => portResult.value?.primaryRecord || null);
const canRefresh = computed(() => Boolean(lastQueriedPort.value) && !isLoading.value);
const canKill = computed(() => Boolean(primaryRecord.value?.pid) && !isKilling.value);
const statusText = computed(() => {
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

async function lookupPort(port = portInput.value) {
  const value = String(port).trim();

  if (!value) {
    errorMessage.value = '请输入端口号。';
    return;
  }

  isLoading.value = true;
  errorMessage.value = '';
  feedbackMessage.value = '';

  try {
    const result = await desktopApi.getPortInfo(value);

    if (!result.success) {
      portResult.value = null;
      processResult.value = null;
      errorMessage.value = result.message || '端口查询失败。';
      return;
    }

    portResult.value = result;
    processResult.value = null;
    lastQueriedPort.value = String(result.port);

    if (result.occupied && result.primaryRecord?.pid) {
      const processInfo = await desktopApi.getProcessInfo(result.primaryRecord.pid);

      if (processInfo.success) {
        processResult.value = processInfo;
      } else {
        feedbackMessage.value = processInfo.message || '未能获取进程详细信息。';
      }
    }
  } catch (error) {
    errorMessage.value = error.message || '查询端口时发生异常。';
  } finally {
    isLoading.value = false;
  }
}

function selectQuickPort(port) {
  portInput.value = String(port);
  lookupPort(port);
}

async function refreshCurrentPort() {
  if (!lastQueriedPort.value) {
    return;
  }

  await lookupPort(lastQueriedPort.value);
}

async function killCurrentProcess() {
  if (!primaryRecord.value?.pid) {
    return;
  }

  isKilling.value = true;
  errorMessage.value = '';
  feedbackMessage.value = '';

  try {
    const result = await desktopApi.killProcess(primaryRecord.value.pid);

    if (!result.success) {
      errorMessage.value = result.message || '结束进程失败。';
      return;
    }

    feedbackMessage.value = result.message || '进程已结束。';
    await lookupPort(lastQueriedPort.value || portInput.value);
  } catch (error) {
    errorMessage.value = error.message || '结束进程时发生异常。';
  } finally {
    isKilling.value = false;
  }
}

function syncRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = null;

  // Auto-refresh always reuses the last successful query, not the current input draft.
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

onBeforeUnmount(() => {
  clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <main class="window-panel">
      <header class="header-bar">
        <div class="header-left">
          <button class="info-btn" type="button" aria-label="打开说明" @click="showInfoPanel = true">i</button>
          <div class="title-block">
            <h1>Port Manager</h1>
            <p>本地端口管理</p>
          </div>
        </div>

        <span class="status-chip" :class="portResult?.occupied ? 'status-busy' : 'status-free'">
          {{ statusText }}
        </span>
      </header>

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

      <p v-if="errorMessage" class="message error-message">{{ errorMessage }}</p>
      <p v-else-if="feedbackMessage" class="message success-message">{{ feedbackMessage }}</p>

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

            <button class="danger-btn" type="button" :disabled="!canKill" @click="killCurrentProcess">
              {{ isKilling ? '结束中...' : '结束进程' }}
            </button>
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

      <div v-if="showInfoPanel" class="info-overlay" @click.self="showInfoPanel = false">
        <section class="info-panel">
          <div class="info-head">
            <h3>Information</h3>
            <button class="close-btn" type="button" @click="showInfoPanel = false">关闭</button>
          </div>

          <p>这个工具用于快速查看本机端口占用情况，并定位对应的进程。</p>
          <p>你可以输入端口或点击常用端口，查看协议、本地地址、PID、进程名等信息。</p>
          <p>如果端口被占用，还可以直接结束该进程；打开自动刷新后，会每 2 秒刷新一次当前端口状态。</p>
        </section>
      </div>
    </main>
  </div>
</template>
