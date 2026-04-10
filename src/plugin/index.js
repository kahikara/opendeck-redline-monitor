const WebSocket = require('ws');
const si = require('systeminformation');

const state = require('./state');
const { ACTIONS } = require('./constants');
const { log, warn, clamp, runCommand, commandExists } = require('./utils');
const { storeSettingsForContext, getSettingsForContext, getPluginWideSettings, getResolvedAction } = require('./settings');
const { generateButtonImage, generateCenteredHeaderButtonImage, generateDialImage, generateFooterButtonImage, generatePageDialImage, generateBlankButtonImage, generateHiddenPageButtonImage, unavailableButton, unavailableDial } = require('./renderer');
const transport = require('./transport');

const { getCpuPower } = require('./system/cpu');
const { getGpuStats } = require('./system/gpu');
const { getNetworkStats } = require('./system/network');
const { refreshMonitorBrightness, setMonitorBrightness, getBrightnessState } = require('./system/brightness');
const { getAudio, adjustVolume, toggleMute } = require('./system/audio');
const { getPingState, getPing } = require('./system/ping');
const { getTopProcessSummary } = require('./system/top');
const { summarizeDisks } = require('./system/disk');

const ACTION_LAUNCHERS = Object.freeze({
  [ACTIONS.cpu]: {
    command: 'plasma-systemmonitor > /dev/null 2>&1 &',
    check: 'plasma-systemmonitor',
    success: { icon: '💻', title: 'CPU', line1: 'OPEN', line2: 'Monitor' },
    failure: { icon: '💻', title: 'CPU', line1: 'NO APP', line2: 'Install it' },
  },
  [ACTIONS.gpu]: {
    command: 'lact gui > /dev/null 2>&1 &',
    check: 'lact',
    success: { icon: '🎮', title: 'GPU', line1: 'OPEN', line2: 'LACT' },
    failure: { icon: '🎮', title: 'GPU', line1: 'NO LACT', line2: 'Install it' },
  },
});

function parseArgs() {
  const args = process.argv.slice(2);
  let port;
  let pluginUUID;
  let registerEvent;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-port') port = args[i + 1];
    else if (args[i] === '-pluginUUID') pluginUUID = args[i + 1];
    else if (args[i] === '-registerEvent') registerEvent = args[i + 1];
  }

  return { port, pluginUUID, registerEvent };
}

function ensureTimer(context) {
  if (!state.activeTimers[context]) {
    state.activeTimers[context] = { total: 0, remaining: 0, state: 'stopped' };
  }
  return state.activeTimers[context];
}

function updateTimerUI(context) {
  const timer = state.activeTimers[context];
  if (!timer) return;

  const timeString = `${Math.floor(timer.remaining / 60)}:${String(timer.remaining % 60).padStart(2, '0')}`;
  const percent = timer.total > 0 ? Math.round((timer.remaining / timer.total) * 100) : 0;

  let color = 'rgb(59, 130, 246)';
  let title = 'TIMER';
  let icon = '⏱️';

  if (timer.state === 'running') color = 'rgb(74, 222, 128)';
  if (timer.state === 'paused') color = 'rgb(250, 204, 21)';

  if (timer.state === 'ringing') {
    color = 'rgb(239, 68, 68)';
    title = 'ALARM!';
    icon = '🔔';
  }

  transport.sendUpdateIfChanged(context, generateDialImage(icon, title, timeString, percent, color));
}

function updateBrightnessUI(context) {
  const { monitorBrightness, monitorBrightnessAvailable } = getBrightnessState();

  if (!monitorBrightnessAvailable) {
    transport.sendUpdateIfChanged(context, unavailableDial('☀️', 'MONITOR', 'NO DDC'));
    return;
  }

  transport.sendUpdateIfChanged(
    context,
    generateDialImage('☀️', 'MONITOR', `${monitorBrightness}%`, monitorBrightness, 'rgb(250, 204, 21)')
  );
}

async function updateAudioImmediately(context) {
  const audioData = await getAudio();

  if (!audioData.available) {
    transport.sendUpdateIfChanged(context, unavailableDial('🔊', 'VOLUME', 'NO AUDIO'));
    return;
  }

  const valueText = audioData.muted ? 'MUTED' : `${audioData.vol}%`;
  const barColor = audioData.muted ? 'rgb(239, 68, 68)' : 'rgb(74, 222, 128)';
  const icon = audioData.muted ? '🔇' : '🔊';

  transport.sendUpdateIfChanged(context, generateDialImage(icon, 'VOLUME', valueText, audioData.vol, barColor));
}

function updatePageDialImmediately(context) {
  const pluginWide = getPluginWideSettings();
  const pageCount = Math.max(1, Math.min(4, pluginWide.pageCount || 1));
  state.activePageIndex = Math.max(0, Math.min(state.activePageIndex, pageCount - 1));
  const pageName = pluginWide[`pageName${state.activePageIndex + 1}`] || `Page ${state.activePageIndex + 1}`;
  transport.sendUpdateIfChanged(
    context,
    generatePageDialImage('📑', 'PAGE', pageName.toUpperCase(), state.activePageIndex, pageCount)
  );
}

async function updatePingImmediately(context) {
  const settings = getSettingsForContext(context);
  const target = settings.pingHost || '1.1.1.1';
  const targetLabel = target.length > 12 ? `${target.slice(0, 11)}…` : target;
  const pingState = getPingState(context);

  transport.sendUpdateIfChanged(context, generateButtonImage('⚡', 'PING', '... ms', targetLabel, 0));
  pingState.lastPingTime = Date.now();
  await getPing(context, target, true);
  transport.sendUpdateIfChanged(
    context,
    generateButtonImage('⚡', 'PING', `${pingState.lastPing} ms`, targetLabel, Math.min(100, pingState.lastPing))
  );
}

async function openActionTool(action, context) {
  const launcher = ACTION_LAUNCHERS[action];
  if (!launcher) return false;

  const available = await commandExists(launcher.check);

  if (!available) {
    transport.showTransientImage(
      context,
      generateButtonImage(launcher.failure.icon, launcher.failure.title, launcher.failure.line1, launcher.failure.line2, -1)
    );
    return false;
  }

  await runCommand(launcher.command, 1500);

  transport.showTransientImage(
    context,
    generateButtonImage(launcher.success.icon, launcher.success.title, launcher.success.line1, launcher.success.line2, -1)
  );

  return true;
}

function isCustomPressEnabled(settings = {}) {
  return settings.pressAction === 'command';
}

function createPressFeedbackImage(context, icon, title, valueText, detailText, color = 'rgb(74, 222, 128)') {
  if (state.activeContexts[context]?.isEncoder) {
    return generateDialImage(icon, title, valueText, -1, color);
  }

  return generateButtonImage(icon, title, valueText, detailText, -1);
}

function ensureContextPageSlot(context, action) {
  if (!context || action === ACTIONS.page) return;

  const current = state.contextSettings[context] || {};
  if (Number.isFinite(Number.parseInt(current.pageSlot, 10))) return;

  storeSettingsForContext(context, {
    ...current,
    pageSlot: state.activePageIndex + 1,
  });
}

async function refreshActionAfterPress(context, resolvedAction) {
  if (!state.activeContexts[context]) return;

  transport.invalidateContext(context);

  if (resolvedAction === ACTIONS.audio) {
    await updateAudioImmediately(context);
    return;
  }

  if (resolvedAction === ACTIONS.monbright) {
    updateBrightnessUI(context);
    return;
  }

  if (resolvedAction === ACTIONS.timer) {
    updateTimerUI(context);
    return;
  }

  if (resolvedAction === ACTIONS.ping) {
    await updatePingImmediately(context);
    return;
  }

  await pollOnce();
}

async function runCustomPressCommand(context, settings, resolvedAction) {
  const command = String(settings.pressCommand || '').trim();

  if (!command) {
    transport.showTransientImage(
      context,
      createPressFeedbackImage(context, '⌘', 'COMMAND', 'NO CMD', 'Set command', 'rgb(239, 68, 68)'),
      1400
    );
    return false;
  }

  transport.showTransientImage(
    context,
    createPressFeedbackImage(context, '⌘', 'COMMAND', 'RUN', 'Please wait', 'rgb(250, 204, 21)'),
    900
  );

  const result = await runCommand(command, 10000);

  if (result.error) {
    transport.showTransientImage(
      context,
      createPressFeedbackImage(context, '⌘', 'COMMAND', 'FAIL', 'Check log', 'rgb(239, 68, 68)'),
      1600
    );
    return false;
  }

  transport.showTransientImage(
    context,
    createPressFeedbackImage(context, '⌘', 'COMMAND', 'OK', 'Done', 'rgb(74, 222, 128)'),
    700
  );

  await new Promise((resolve) => setTimeout(resolve, 750));
  transport.clearTransientTimer(context);
  await refreshActionAfterPress(context, resolvedAction);
  return true;
}

function extractIncomingSettings(payload = {}) {
  const knownKeys = ['pingHost', 'networkInterface', 'volumeStep', 'brightnessStep', 'timerStep', 'topMode', 'refreshRate', 'pressAction', 'pressCommand', 'pageSlot', 'pageCount', 'pageName1', 'pageName2', 'pageName3', 'pageName4'];

  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) {
      return {};
    }

    const direct = {};
    for (const key of knownKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        direct[key] = value[key];
      }
    }

    if (Object.keys(direct).length > 0) {
      return direct;
    }

    if (value.settings && typeof value.settings === 'object') {
      const nestedSettings = visit(value.settings, depth + 1);
      if (Object.keys(nestedSettings).length > 0) {
        return nestedSettings;
      }
    }

    for (const nested of Object.values(value)) {
      const result = visit(nested, depth + 1);
      if (Object.keys(result).length > 0) {
        return result;
      }
    }

    return {};
  }

  return visit(payload);
}

function trackPromise(promises, label, work) {
  promises.push(
    Promise.resolve()
      .then(work)
      .catch((error) => {
        warn(`${label} failed:`, error?.message || error);
      })
  );
}

function maybeRestartPolling(refreshChanged = false) {
  const desired = clamp(Number.parseInt(getPluginWideSettings().refreshRate, 10) || 3, 1, 10) * 1000;

  if (!state.pollingInterval) return;
  if (!refreshChanged && desired === state.currentPollingRateMs) return;

  clearInterval(state.pollingInterval);
  state.pollingInterval = null;
  state.currentPollingRateMs = 0;
  startPolling();
}

function cleanupRuntime() {
  clearInterval(state.pollingInterval);
  clearInterval(state.timerInterval);
  clearTimeout(state.ddcutilTimeout);

  state.pollingInterval = null;
  state.timerInterval = null;
  state.ddcutilTimeout = null;
  state.pollingInProgress = false;
  state.currentPollingRateMs = 0;

  for (const context of Object.keys(state.transientImageTimers)) {
    transport.clearTransientTimer(context);
  }
}

function shutdown(reason) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  log(`Shutting down (${reason})`);
  cleanupRuntime();
}

function startTimerLoop() {
  state.timerInterval = setInterval(() => {
    for (const context of Object.keys(state.activeTimers)) {
      const timer = state.activeTimers[context];
      if (!timer || timer.state !== 'running') continue;

      timer.remaining -= 1;

      if (timer.remaining <= 0) {
        timer.remaining = 0;
        timer.state = 'ringing';

        const soundCommand = 'paplay /usr/share/sounds/freedesktop/stereo/complete.oga || aplay /usr/share/sounds/alsa/Front_Center.wav';
        runCommand(`${soundCommand} ; sleep 0.3 ; ${soundCommand} ; sleep 0.3 ; ${soundCommand}`, 6000).catch(() => {});

        setTimeout(() => {
          if (state.activeTimers[context] && state.activeTimers[context].state === 'ringing') {
            state.activeTimers[context].state = 'stopped';
            state.activeTimers[context].remaining = state.activeTimers[context].total;

            if (state.activeContexts[context]) {
              updateTimerUI(context);
            }
          }
        }, 4000);
      }

      if (state.activeContexts[context]) {
        updateTimerUI(context);
      }
    }
  }, 1000);
}

async function getCachedNetworkStats(cache, networkInterface = '') {
  const key = String(networkInterface || '').trim() || '__auto__';

  if (!cache.has(key)) {
    cache.set(key, getNetworkStats(networkInterface));
  }

  return cache.get(key);
}

async function pollOnce() {
  if (state.pollingInProgress || state.shuttingDown) return;
  state.pollingInProgress = true;

  try {
    const actionsList = Object.values(state.activeContexts).map((entry) => entry.action);
    const pluginWide = getPluginWideSettings();
    const pageCount = Math.max(1, Math.min(4, pluginWide.pageCount || 1));
    state.activePageIndex = Math.max(0, Math.min(state.activePageIndex, pageCount - 1));
    if (actionsList.length === 0) return;

    let cpuData = {};
    let cpuTemp = {};
    let memData = {};
    let diskData = [];
    let audioData = { available: false, vol: 0, muted: false };
    let procData = state.procCache.data;
    const networkStatsCache = new Map();

    const needsCpu = actionsList.includes(ACTIONS.cpu);
    const needsRam = actionsList.includes(ACTIONS.ram);
    const needsDisk = actionsList.includes(ACTIONS.disk);
    const needsTop = actionsList.includes(ACTIONS.top);
    const needsAudio = actionsList.includes(ACTIONS.audio);
    const needsGpu = actionsList.includes(ACTIONS.gpu) || actionsList.includes(ACTIONS.vram);
    const needsBrightness = actionsList.includes(ACTIONS.monbright);

    const promises = [];

    if (needsCpu) {
      trackPromise(promises, 'si.currentLoad', async () => {
        cpuData = await si.currentLoad();
      });
      trackPromise(promises, 'si.cpuTemperature', async () => {
        cpuTemp = await si.cpuTemperature();
      });
    }

    if (needsRam) {
      trackPromise(promises, 'si.mem', async () => {
        memData = await si.mem();
      });
    }

    if (needsDisk) {
      trackPromise(promises, 'si.fsSize', async () => {
        diskData = await si.fsSize();
      });
    }

    if (needsAudio) {
      trackPromise(promises, 'getAudio', async () => {
        audioData = await getAudio();
      });
    }

    if (needsTop) {
      if ((Date.now() - state.procCache.timestamp) > 4000) {
        trackPromise(promises, 'si.processes', async () => {
          const data = await si.processes();
          state.procCache = { timestamp: Date.now(), data };
          procData = data;
        });
      } else {
        procData = state.procCache.data;
      }
    }

    if (needsBrightness) {
      trackPromise(promises, 'refreshMonitorBrightness', async () => {
        await refreshMonitorBrightness(false);
      });
    }

    await Promise.allSettled(promises);

    const gpuStats = needsGpu ? getGpuStats() : null;
    const cpuPower = needsCpu ? getCpuPower() : { available: false, watts: 0 };
    const diskSummary = summarizeDisks(diskData);

    for (const context of Object.keys(state.activeContexts)) {
      const { action } = state.activeContexts[context];
      const settings = getSettingsForContext(context);

      if (state.transientImageTimers[context]) {
        continue;
      }

      if (action === ACTIONS.page) {
        const pageName = pluginWide[`pageName${state.activePageIndex + 1}`] || `Page ${state.activePageIndex + 1}`;
        transport.sendUpdateIfChanged(context, generatePageDialImage('📑', 'PAGE', pageName.toUpperCase(), state.activePageIndex, pageCount));
        continue;
      }

      if (action === ACTIONS.audio) {
        if (!audioData.available) {
          transport.sendUpdateIfChanged(context, unavailableDial('🔊', 'VOLUME', 'NO AUDIO'));
        } else {
          const valueText = audioData.muted ? 'MUTED' : `${audioData.vol}%`;
          const barColor = audioData.muted ? 'rgb(239, 68, 68)' : 'rgb(74, 222, 128)';
          const icon = audioData.muted ? '🔇' : '🔊';
          transport.sendUpdateIfChanged(context, generateDialImage(icon, 'VOLUME', valueText, audioData.vol, barColor));
        }
        continue;
      }

      if (action === ACTIONS.monbright) {
        updateBrightnessUI(context);
        continue;
      }

      if (action === ACTIONS.timer) {
        updateTimerUI(context);
        continue;
      }

      let image = '';

      if (action === ACTIONS.cpu) {
        if (!Number.isFinite(cpuData.currentLoad)) {
          image = unavailableButton('💻', 'CPU', 'NO DATA');
        } else {
          const load = Math.round(cpuData.currentLoad || 0);
          const temp = Math.round(cpuTemp.main || 0);
          const wattsText = cpuPower.available ? `${cpuPower.watts}W` : 'NO PWR';
          image = generateButtonImage('💻', 'CPU', `${load}%`, `${wattsText} | ${temp}°C`, load);
        }
      } else if (action === ACTIONS.gpu) {
        if (!gpuStats?.available) {
          image = unavailableButton('🎮', 'GPU', 'NO GPU');
        } else {
          const usage = gpuStats.usage;
          image = generateButtonImage('🎮', 'GPU', `${usage}%`, `${gpuStats.power}W | ${gpuStats.temp}°C`, usage);
        }
      } else if (action === ACTIONS.ram) {
        const activeMemory = memData.active ?? memData.used ?? 0;
        const totalMemory = memData.total ?? 0;

        if (!totalMemory) {
          image = unavailableButton('🧠', 'RAM', 'NO DATA');
        } else {
          const percent = (activeMemory / totalMemory) * 100;
          const usedGB = (activeMemory / (1024 ** 3)).toFixed(1);
          const totalGB = (totalMemory / (1024 ** 3)).toFixed(0);
          image = generateButtonImage('🧠', 'RAM', `${Math.round(percent)}%`, `${usedGB} / ${totalGB} GB`, percent);
        }
      } else if (action === ACTIONS.vram) {
        if (!gpuStats?.available || !gpuStats.vramTotal) {
          image = unavailableButton('🎞️', 'VRAM', 'NO VRAM');
        } else {
          const usedGB = (gpuStats.vramUsed / (1024 ** 3)).toFixed(1);
          const totalGB = (gpuStats.vramTotal / (1024 ** 3)).toFixed(0);
          const percent = (gpuStats.vramUsed / gpuStats.vramTotal) * 100;
          image = generateButtonImage('🎞️', 'VRAM', `${Math.round(percent)}%`, `${usedGB} / ${totalGB} GB`, percent);
        }
      } else if (action === ACTIONS.net) {
        const netResult = await getCachedNetworkStats(networkStatsCache, settings.networkInterface);

        if (!netResult.available || netResult.data.length === 0) {
          image = unavailableButton('🌐', 'NET', 'NO NET');
        } else {
          const download = (((netResult.data[0].rx_sec || 0) * 8) / 1000000).toFixed(1);
          const upload = (((netResult.data[0].tx_sec || 0) * 8) / 1000000).toFixed(1);
          const ifaceLabel = (netResult.iface || 'auto').slice(0, 14);
          image = generateFooterButtonImage('🌐', 'NET', `↓${download}`, `↑${upload}`, ifaceLabel);
        }
      } else if (action === ACTIONS.disk) {
        if (!diskSummary.available) {
          image = generateButtonImage('🖴', 'DISKS', '...', 'Loading...', -1);
        } else {
          image = generateCenteredHeaderButtonImage('🖴', 'DISKS', `${Math.round(diskSummary.percent)}%`, `${Math.round(diskSummary.freeGB)} GB free`, diskSummary.percent);
        }
      } else if (action === ACTIONS.ping) {
        const pingState = getPingState(context);
        const target = settings.pingHost || '1.1.1.1';
        const targetLabel = target.length > 12 ? `${target.slice(0, 11)}…` : target;

        if (Date.now() - pingState.lastPingTime >= 5000) {
          pingState.lastPingTime = Date.now();
          await getPing(context, target, false);
        }

        image = generateButtonImage('⚡', 'PING', `${pingState.lastPing} ms`, targetLabel, Math.min(100, pingState.lastPing));
      } else if (action === ACTIONS.top) {
        const topProcess = getTopProcessSummary(procData, settings.topMode);

        if (topProcess) {
          image = generateButtonImage('🔥', 'TOP', topProcess.name, `${topProcess.cpu}% CPU`, topProcess.cpu);
        } else {
          image = unavailableButton('🔥', 'TOP', 'IDLE');
        }
      } else if (action === ACTIONS.time) {
        const now = new Date();
        image = generateButtonImage(
          '🕒',
          'UHR',
          now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
          -1
        );
      }

      if (image) {
        transport.sendUpdateIfChanged(context, image);
      }
    }
  } catch (error) {
    warn('Poll loop failed:', error.message);
  } finally {
    state.pollingInProgress = false;
  }
}

function startPolling() {
  state.currentPollingRateMs = clamp(Number.parseInt(getPluginWideSettings().refreshRate, 10) || 3, 1, 10) * 1000;
  void pollOnce();
  state.pollingInterval = setInterval(() => {
    void pollOnce();
  }, state.currentPollingRateMs);
}

async function handleMessage(data) {
  let message;

  try {
    message = JSON.parse(data);
  } catch (error) {
    warn('Failed to parse WebSocket message:', error.message);
    return;
  }

  const { event, action, context } = message;

  try {
    if (event === 'willAppear') {
      state.activeContexts[context] = {
        action,
        isEncoder: message.payload?.controller === 'Encoder',
      };

      transport.invalidateContext(context);
      const incomingSettings = extractIncomingSettings(message.payload);
      const refreshChanged = storeSettingsForContext(context, incomingSettings);
      ensureContextPageSlot(context, action);

      if (action === ACTIONS.timer) {
        ensureTimer(context);
      }

      if (action === ACTIONS.monbright) {
        await refreshMonitorBrightness(true);
        updateBrightnessUI(context);
      }

      if (action === ACTIONS.audio) {
        await updateAudioImmediately(context);
      }

      if (action === ACTIONS.page) {
        updatePageDialImmediately(context);
      }

      if (action === ACTIONS.timer) {
        updateTimerUI(context);
      }

      if (action === ACTIONS.disk) {
        transport.sendUpdateIfChanged(context, generateButtonImage('🖴', 'DISKS', '...', 'Loading...', -1));
      }

      transport.invalidateAllVisible();
      void pollOnce();

      if (!state.pollingInterval) startPolling();
      else maybeRestartPolling(refreshChanged);

      if (!state.timerInterval) startTimerLoop();
      return;
    }

    if (event === 'didReceiveSettings') {
      const resolvedAction = getResolvedAction(context, action);
      const incomingSettings = extractIncomingSettings(message.payload);
      const refreshChanged = storeSettingsForContext(context, incomingSettings);
      transport.invalidateContext(context);

      if (resolvedAction === ACTIONS.audio) {
        await updateAudioImmediately(context);
      } else if (resolvedAction === ACTIONS.monbright) {
        updateBrightnessUI(context);
      } else if (resolvedAction === ACTIONS.ping) {
        await updatePingImmediately(context);
      } else if (resolvedAction === ACTIONS.timer) {
        updateTimerUI(context);
      } else if (resolvedAction === ACTIONS.page) {
        updatePageDialImmediately(context);
      }

      maybeRestartPolling(refreshChanged);
      return;
    }

    if (event === 'sendToPlugin') {
      const incomingSettings = extractIncomingSettings(message.payload);

      if (message.payload?.type === 'saveSettings' || Object.keys(incomingSettings).length > 0) {
        const resolvedAction = getResolvedAction(context, action);
        const refreshChanged = storeSettingsForContext(context, incomingSettings);
        transport.invalidateContext(context);

        if (resolvedAction === ACTIONS.audio) {
          await updateAudioImmediately(context);
        } else if (resolvedAction === ACTIONS.monbright) {
          updateBrightnessUI(context);
        } else if (resolvedAction === ACTIONS.ping) {
          await updatePingImmediately(context);
        } else if (resolvedAction === ACTIONS.timer) {
          updateTimerUI(context);
        } else if (resolvedAction === ACTIONS.page) {
          updatePageDialImmediately(context);
        }

        maybeRestartPolling(refreshChanged);
      }
      return;
    }

    if (event === 'willDisappear') {
      delete state.activeContexts[context];
      delete state.activeTimers[context];
      delete state.lastSentImages[context];
      delete state.contextSettings[context];
      delete state.pingStates[context];
      transport.clearTransientTimer(context);

      if (Object.keys(state.activeContexts).length === 0) {
        cleanupRuntime();
        state.procCache = { timestamp: 0, data: { list: [] } };
      }
      return;
    }

    if (event === 'dialRotate') {
      const ticks = message.payload?.ticks || 0;
      const resolvedAction = getResolvedAction(context, action);
      const settings = getSettingsForContext(context);

      if (resolvedAction === ACTIONS.audio) {
        await adjustVolume(ticks, settings.volumeStep);
        await updateAudioImmediately(context);
      }

      if (resolvedAction === ACTIONS.timer) {
        const timer = ensureTimer(context);
        if (timer && (timer.state === 'stopped' || timer.state === 'paused')) {
          timer.total = Math.max(0, timer.total + (ticks * settings.timerStep * 60));
          timer.remaining = timer.total;
          updateTimerUI(context);
        }
      }

      if (resolvedAction === ACTIONS.monbright) {
        await setMonitorBrightness(getBrightnessState().monitorBrightness + (ticks * settings.brightnessStep));
        updateBrightnessUI(context);
      }

      if (resolvedAction === ACTIONS.page) {
        const pluginWide = getPluginWideSettings();
        const pageCount = Math.max(1, Math.min(4, pluginWide.pageCount || 1));
        state.activePageIndex = (state.activePageIndex + ticks) % pageCount;
        if (state.activePageIndex < 0) state.activePageIndex += pageCount;
        updatePageDialImmediately(context);
        transport.invalidateAllVisible();
        await pollOnce();
      }

      return;
    }

    if (event === 'dialDown' || event === 'keyDown') {
      const resolvedAction = getResolvedAction(context, action);
      const settings = getSettingsForContext(context);

      if (isCustomPressEnabled(settings)) {
        await runCustomPressCommand(context, settings, resolvedAction);
        return;
      }

      if (!state.activeContexts[context]?.isEncoder) {
        if (resolvedAction === ACTIONS.cpu || resolvedAction === ACTIONS.gpu) {
          await openActionTool(resolvedAction, context);
        }

        if (resolvedAction === ACTIONS.ping) {
          await updatePingImmediately(context);
        }
      }

      if (resolvedAction === ACTIONS.audio) {
        await toggleMute();
        await updateAudioImmediately(context);
      }

      if (resolvedAction === ACTIONS.timer) {
        const timer = ensureTimer(context);

        if (timer.state === 'ringing') {
          timer.state = 'stopped';
          timer.remaining = timer.total;
        } else if (timer.state === 'stopped' && timer.total > 0) {
          timer.state = 'running';
        } else if (timer.state === 'running') {
          timer.state = 'paused';
        } else if (timer.state === 'paused') {
          timer.state = 'running';
        }

        updateTimerUI(context);
      }

      if (resolvedAction === ACTIONS.monbright) {
        await setMonitorBrightness(50);
        updateBrightnessUI(context);
      }

      if (resolvedAction === ACTIONS.page) {
        const pluginWide = getPluginWideSettings();
        const pageCount = Math.max(1, Math.min(4, pluginWide.pageCount || 1));
        state.activePageIndex = (state.activePageIndex + 1) % pageCount;
        updatePageDialImmediately(context);
        transport.invalidateAllVisible();
        await pollOnce();
      }
    }
  } catch (error) {
    warn('Message handler failed:', error.message);
  }
}

function startPlugin() {
  const { port, pluginUUID, registerEvent } = parseArgs();

  if (!port || !pluginUUID || !registerEvent) {
    console.error('[Redline] Missing OpenDeck startup arguments');
    process.exit(1);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  transport.setWebSocket(ws);

  ws.on('open', () => {
    transport.safeSend({
      event: registerEvent,
      uuid: pluginUUID,
    });
  });

  ws.on('error', (error) => {
    warn('WebSocket error:', error.message);
  });

  ws.on('close', () => {
    log('WebSocket closed');
    cleanupRuntime();
  });

  ws.on('message', (data) => {
    void handleMessage(data);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => cleanupRuntime());
}

module.exports = {
  startPlugin,
};
