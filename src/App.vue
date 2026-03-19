<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const desktopApi = window.api || {
  async getPortInfo() {
    throw new Error('Electron preload API is unavailable. Start the app with npm run dev or npm start.');
  },
  async getProcessInfo() {
    throw new Error('Electron preload API is unavailable. Start the app with npm run dev or npm start.');
  },
  async killProcess() {
    throw new Error('Electron preload API is unavailable. Start the app with npm run dev or npm start.');
  },
};

const quickPorts = [3000, 5173, 8080, 8000, 3306, 6379];
const portInput = ref('8080');
const lastQueriedPort = ref('');
const autoRefresh = ref(false);
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

async function lookupPort(port = portInput.value) {
  const value = String(port).trim();

  if (!value) {
    errorMessage.value = 'Please enter a port number.';
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
      errorMessage.value = result.message || 'Failed to inspect the selected port.';
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
        feedbackMessage.value = processInfo.message || 'Process details are not available.';
      }
    }
  } catch (error) {
    errorMessage.value = error.message || 'Unexpected error while querying the port.';
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
      errorMessage.value = result.message || 'Failed to terminate the process.';
      return;
    }

    feedbackMessage.value = result.message || 'Process terminated.';
    await lookupPort(lastQueriedPort.value || portInput.value);
  } catch (error) {
    errorMessage.value = error.message || 'Unexpected error while killing the process.';
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
    <div class="orb orb-left"></div>
    <div class="orb orb-right"></div>

    <main class="dashboard">
      <section class="hero">
        <p class="eyebrow">Desktop Port Inspector</p>
        <h1>Port Manager</h1>
        <p class="hero-copy">
          Inspect local port usage, resolve the owning process, and terminate it without falling back to
          netstat or taskkill in a terminal.
        </p>
      </section>

      <section class="controls">
        <label class="field">
          <span class="field-label">Port</span>
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

        <button class="primary-btn" :disabled="isLoading" @click="lookupPort()">
          {{ isLoading ? 'Searching...' : 'Query Port' }}
        </button>

        <button class="ghost-btn" :disabled="!canRefresh" @click="refreshCurrentPort">
          Refresh
        </button>
      </section>

      <section class="shortcut-bar">
        <div class="shortcut-group">
          <span class="shortcut-label">Quick Ports</span>
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
          <span>Auto refresh every 2 seconds</span>
        </label>
      </section>

      <p v-if="errorMessage" class="message error-message">{{ errorMessage }}</p>
      <p v-else-if="feedbackMessage" class="message success-message">{{ feedbackMessage }}</p>

      <section v-if="portResult" class="result-grid">
        <article class="card">
          <div class="card-header">
            <div>
              <p class="card-label">Port Summary</p>
              <h2>{{ portResult.port }}</h2>
            </div>

            <span class="status-pill" :class="portResult.occupied ? 'status-busy' : 'status-free'">
              {{ portResult.occupied ? 'Occupied' : 'Free' }}
            </span>
          </div>

          <div class="stats-grid">
            <div class="stat-box">
              <span>Status</span>
              <strong>{{ portResult.occupied ? 'In Use' : 'Available' }}</strong>
            </div>
            <div class="stat-box">
              <span>Protocol</span>
              <strong>{{ primaryRecord?.protocol || '--' }}</strong>
            </div>
            <div class="stat-box">
              <span>Local Address</span>
              <strong>{{ primaryRecord?.localAddress || '--' }}</strong>
            </div>
            <div class="stat-box">
              <span>PID</span>
              <strong>{{ primaryRecord?.pid || '--' }}</strong>
            </div>
            <div class="stat-box">
              <span>Process Name</span>
              <strong>{{ processResult?.processName || '--' }}</strong>
            </div>
          </div>

          <div v-if="portResult.records?.length" class="record-list">
            <div class="record-row record-head">
              <span>Protocol</span>
              <span>Local Address</span>
              <span>State</span>
              <span>PID</span>
            </div>

            <div
              v-for="record in portResult.records"
              :key="`${record.protocol}-${record.localAddress}-${record.pid}`"
              class="record-row"
            >
              <span>{{ record.protocol }}</span>
              <span>{{ record.localAddress }}</span>
              <span>{{ record.state }}</span>
              <span>{{ record.pid }}</span>
            </div>
          </div>

          <p v-else class="empty-copy">
            No matching listener or socket was found for this local port.
          </p>
        </article>

        <article class="card">
          <div class="card-header">
            <div>
              <p class="card-label">Process Details</p>
              <h2>{{ processResult?.processName || (portResult.occupied ? 'Unavailable' : 'No Owner') }}</h2>
            </div>

            <button class="danger-btn" :disabled="!canKill" @click="killCurrentProcess">
              {{ isKilling ? 'Killing...' : 'Kill Process' }}
            </button>
          </div>

          <div class="detail-stack">
            <div class="detail-block">
              <span>Executable Path</span>
              <code>{{ processResult?.executablePath || 'Unavailable or restricted by the system.' }}</code>
            </div>

            <div class="detail-block">
              <span>Command Line</span>
              <code>{{ processResult?.commandLine || 'Unavailable or restricted by the system.' }}</code>
            </div>
          </div>
        </article>
      </section>
    </main>
  </div>
</template>
