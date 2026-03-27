const WebSocket = require('ws');
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const args = process.argv.slice(2);
let port;
let pluginUUID;
let registerEvent;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-port') port = args[i + 1];
  else if (args[i] === '-pluginUUID') pluginUUID = args[i + 1];
  else if (args[i] === '-registerEvent') registerEvent = args[i + 1];
}

if (!port || !pluginUUID || !registerEvent) {
  console.error('[Redline] Missing OpenDeck startup arguments');
  process.exit(1);
}

const PLUGIN_PREFIX = 'com.kahikara.opendeck-redline';
const ACTIONS = Object.freeze({
  cpu: `${PLUGIN_PREFIX}.cpu`,
  gpu: `${PLUGIN_PREFIX}.gpu`,
  ram: `${PLUGIN_PREFIX}.ram`,
  vram: `${PLUGIN_PREFIX}.vram`,
  net: `${PLUGIN_PREFIX}.net`,
  disk: `${PLUGIN_PREFIX}.disk`,
  ping: `${PLUGIN_PREFIX}.ping`,
  top: `${PLUGIN_PREFIX}.top`,
  time: `${PLUGIN_PREFIX}.time`,
  audio: `${PLUGIN_PREFIX}.audio`,
  timer: `${PLUGIN_PREFIX}.timer`,
  monbright: `${PLUGIN_PREFIX}.monbright`,
});

const POLL_INTERVAL_MS = 2000;
const TOP_REFRESH_MS = 4000;
const NETWORK_CACHE_MS = 10000;
const BRIGHTNESS_REFRESH_MS = 15000;
const TRANSIENT_IMAGE_MS = 1250;

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

const activeContexts = Object.create(null);
const activeTimers = Object.create(null);
const lastSentImages = Object.create(null);
const transientImageTimers = Object.create(null);

let pollingInterval = null;
let timerInterval = null;
let pollingInProgress = false;
let ddcutilTimeout = null;
let shuttingDown = false;

let monitorBrightness = 50;
let monitorBrightnessAvailable = false;
let lastBrightnessSync = 0;

let lastPing = 0;
let failedPings = 0;
let lastPingTime = 0;

let amdgpuDirCache = null;
let cpuPowerFileCache = null;
let procCache = { timestamp: 0, data: { list: [] } };
let networkCache = { timestamp: 0, iface: null };

const toolCache = new Map();
const warnedKeys = new Set();
const coreCount = Math.max(1, os.cpus().length);

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

function log(...parts) {
  console.log('[Redline]', ...parts);
}

function warn(...parts) {
  console.warn('[Redline]', ...parts);
}

function warnOnce(key, ...parts) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  warn(...parts);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runCommand(command, timeout = 2000) {
  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

async function commandExists(command) {
  if (toolCache.has(command)) return toolCache.get(command);

  const result = await runCommand(`command -v ${command}`, 1500);
  const exists = !result.error && result.stdout.trim().length > 0;
  toolCache.set(command, exists);

  if (!exists) warnOnce(`missing-tool:${command}`, `${command} not found`);

  return exists;
}

function safeSend(payload) {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    warn('WebSocket send failed:', error.message);
  }
}

function sendUpdateIfChanged(context, image) {
  if (!image || image === lastSentImages[context]) return;

  safeSend({
    event: 'setImage',
    context,
    payload: {
      image,
      target: 0,
    },
  });

  lastSentImages[context] = image;
}

function clearTransientTimer(context) {
  if (transientImageTimers[context]) {
    clearTimeout(transientImageTimers[context]);
    delete transientImageTimers[context];
  }
}

function showTransientImage(context, image, duration = TRANSIENT_IMAGE_MS) {
  clearTransientTimer(context);
  sendUpdateIfChanged(context, image);

  transientImageTimers[context] = setTimeout(() => {
    delete lastSentImages[context];
    delete transientImageTimers[context];
  }, duration);
}

function getShortProcName(name) {
  const cleaned = String(name || '')
    .split(/[\/\\]/)
    .pop()
    .replace(/\.(exe|bin|AppImage)$/i, '');

  const lower = cleaned.toLowerCase();

  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('firefox')) return 'Firefox';
  if (lower.includes('discord')) return 'Discord';
  if (lower.includes('steam')) return 'Steam';
  if (lower.includes('wow')) return 'WoW';
  if (lower.includes('plasma')) return 'Plasma';
  if (lower.includes('kwin')) return 'KWin';

  return cleaned.length > 9 ? `${cleaned.slice(0, 8)}…` : cleaned;
}

function generateButtonImage(icon, title, line1, line2, percent = -1) {
  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const r = p > 50 ? 255 : Math.floor((p * 2) * 255 / 100);
    const g = p < 50 ? 255 : Math.floor(((100 - p) * 2) * 255 / 100);

    barHtml = `<rect x="15" y="122" width="114" height="8" fill="#333" rx="4"/><rect x="15" y="122" width="${1.14 * p}" height="8" fill="rgb(${r},${g},0)" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="72" y="24" fill="#a1a1aa" font-family="sans-serif" font-size="26" text-anchor="middle">${escapeXml(icon)}</text>
    <text x="72" y="48" fill="#a1a1aa" font-family="sans-serif" font-size="20" font-weight="bold" text-anchor="middle">${escapeXml(title)}</text>
    <text x="72" y="82" fill="#ffffff" font-family="sans-serif" font-size="28" font-weight="bold" text-anchor="middle">${escapeXml(line1)}</text>
    <text x="72" y="108" fill="#a1a1aa" font-family="sans-serif" font-size="18" text-anchor="middle">${escapeXml(line2)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateDialImage(icon, title, valueText, percent = -1, barColor = 'rgb(74, 222, 128)') {
  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    barHtml = `<rect x="22" y="115" width="100" height="8" fill="#333" rx="4"/><rect x="22" y="115" width="${p}" height="8" fill="${escapeXml(barColor)}" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="72" y="35" fill="#a1a1aa" font-family="sans-serif" font-size="28" text-anchor="middle">${escapeXml(icon)}</text>
    <text x="72" y="58" fill="#a1a1aa" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${escapeXml(title)}</text>
    <text x="72" y="100" fill="#ffffff" font-family="sans-serif" font-size="42" font-weight="bold" text-anchor="middle">${escapeXml(valueText)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function unavailableButton(icon, title, reason) {
  return generateButtonImage(icon, title, 'N/A', reason, -1);
}

function unavailableDial(icon, title, reason) {
  return generateDialImage(icon, title, reason, -1, 'rgb(239, 68, 68)');
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function findAmdGpuDir(force = false) {
  if (amdgpuDirCache && !force && fileExists(path.join(amdgpuDirCache, 'name'))) {
    return amdgpuDirCache;
  }

  amdgpuDirCache = null;

  try {
    const hwmonRoot = '/sys/class/hwmon';
    const dirs = fs.readdirSync(hwmonRoot);

    for (const dir of dirs) {
      const fullPath = path.join(hwmonRoot, dir);
      const namePath = path.join(fullPath, 'name');

      if (!fileExists(namePath)) continue;
      if (readText(namePath) === 'amdgpu') {
        amdgpuDirCache = fullPath;
        return amdgpuDirCache;
      }
    }
  } catch (error) {
    warnOnce('amdgpu-scan-failed', `amdgpu scan failed: ${error.message}`);
  }

  return null;
}

function getAmdGpuStats() {
  const gpuDir = findAmdGpuDir();

  if (!gpuDir) {
    return {
      available: false,
      temp: 0,
      power: 0,
      usage: 0,
      vramUsed: 0,
      vramTotal: 0,
    };
  }

  const readNumber = (file) => {
    const fullPath = path.join(gpuDir, file);
    if (!fileExists(fullPath)) return null;
    const value = Number.parseInt(readText(fullPath), 10);
    return Number.isFinite(value) ? value : null;
  };

  try {
    const tempEdge = readNumber('temp1_input');
    const power = readNumber('power1_average') ?? readNumber('power1_input');
    const usagePath = path.join(gpuDir, 'device', 'gpu_busy_percent');
    const vramUsedPath = path.join(gpuDir, 'device', 'mem_info_vram_used');
    const vramTotalPath = path.join(gpuDir, 'device', 'mem_info_vram_total');

    const usage = fileExists(usagePath) ? Number.parseInt(readText(usagePath), 10) : 0;
    const vramUsed = fileExists(vramUsedPath) ? Number.parseInt(readText(vramUsedPath), 10) : 0;
    const vramTotal = fileExists(vramTotalPath) ? Number.parseInt(readText(vramTotalPath), 10) : 0;

    return {
      available: true,
      temp: tempEdge ? Math.round(tempEdge / 1000) : 0,
      power: power ? Math.round(power / 1000000) : 0,
      usage: Number.isFinite(usage) ? usage : 0,
      vramUsed: Number.isFinite(vramUsed) ? vramUsed : 0,
      vramTotal: Number.isFinite(vramTotal) ? vramTotal : 0,
    };
  } catch (error) {
    amdgpuDirCache = null;
    warnOnce('amdgpu-read-failed', `amdgpu read failed: ${error.message}`);
    return {
      available: false,
      temp: 0,
      power: 0,
      usage: 0,
      vramUsed: 0,
      vramTotal: 0,
    };
  }
}

function findCpuPowerFile(force = false) {
  if (cpuPowerFileCache && !force && fileExists(cpuPowerFileCache)) {
    return cpuPowerFileCache;
  }

  cpuPowerFileCache = null;

  try {
    const hwmonRoot = '/sys/class/hwmon';
    const dirs = fs.readdirSync(hwmonRoot);

    for (const dir of dirs) {
      const fullPath = path.join(hwmonRoot, dir);
      const namePath = path.join(fullPath, 'name');

      if (!fileExists(namePath)) continue;

      const name = readText(namePath);
      if (!['zenpower', 'amd_energy', 'zenergy'].includes(name)) continue;

      const powerAverage = path.join(fullPath, 'power1_average');
      const powerInput = path.join(fullPath, 'power1_input');

      if (fileExists(powerAverage)) {
        cpuPowerFileCache = powerAverage;
        return cpuPowerFileCache;
      }

      if (fileExists(powerInput)) {
        cpuPowerFileCache = powerInput;
        return cpuPowerFileCache;
      }
    }
  } catch (error) {
    warnOnce('cpu-power-scan-failed', `cpu power scan failed: ${error.message}`);
  }

  return null;
}

function getCpuPower() {
  const powerFile = findCpuPowerFile();

  if (!powerFile) {
    return { available: false, watts: 0 };
  }

  try {
    const rawValue = Number.parseInt(readText(powerFile), 10);
    if (!Number.isFinite(rawValue)) {
      return { available: false, watts: 0 };
    }

    return { available: true, watts: Math.round(rawValue / 1000000) };
  } catch (error) {
    cpuPowerFileCache = null;
    warnOnce('cpu-power-read-failed', `cpu power read failed: ${error.message}`);
    return { available: false, watts: 0 };
  }
}

async function detectActiveInterface(force = false) {
  const now = Date.now();

  if (!force && networkCache.iface && (now - networkCache.timestamp) < NETWORK_CACHE_MS) {
    return networkCache.iface;
  }

  networkCache = { timestamp: now, iface: null };

  try {
    const interfaces = await si.networkInterfaces();

    const candidates = interfaces.filter((iface) => {
      const name = String(iface.iface || '');
      return !iface.internal && !iface.virtual && name && iface.operstate === 'up';
    });

    const preferred =
      candidates.find((iface) => iface.default) ||
      candidates.find((iface) => iface.ip4) ||
      candidates[0] ||
      null;

    networkCache.iface = preferred ? preferred.iface : null;
    return networkCache.iface;
  } catch (error) {
    warnOnce('network-interface-detect-failed', `network interface detection failed: ${error.message}`);
    return null;
  }
}

async function getNetworkStats() {
  const iface = await detectActiveInterface();

  try {
    if (iface) {
      const data = await si.networkStats(iface);
      return { available: Array.isArray(data) && data.length > 0, iface, data };
    }

    const data = await si.networkStats();
    return { available: Array.isArray(data) && data.length > 0, iface: null, data };
  } catch (error) {
    warnOnce('network-stats-failed', `network stats failed: ${error.message}`);
    return { available: false, iface: null, data: [] };
  }
}

async function refreshMonitorBrightness(force = false) {
  const now = Date.now();

  if (!force && (now - lastBrightnessSync) < BRIGHTNESS_REFRESH_MS) {
    return monitorBrightnessAvailable;
  }

  lastBrightnessSync = now;

  if (!(await commandExists('ddcutil'))) {
    monitorBrightnessAvailable = false;
    return false;
  }

  const result = await runCommand('ddcutil getvcp 10 --brief', 2500);
  const match =
    result.stdout.match(/current value =\s*([0-9]+)/i) ||
    result.stdout.match(/current value:\s*([0-9]+)/i) ||
    result.stdout.match(/C\s+([0-9]+)/);

  if (match) {
    monitorBrightness = clamp(Number.parseInt(match[1], 10) || 50, 0, 100);
    monitorBrightnessAvailable = true;
    return true;
  }

  monitorBrightnessAvailable = false;
  warnOnce('ddcutil-brightness-read-failed', 'ddcutil brightness read failed');
  return false;
}

async function setMonitorBrightness(value) {
  monitorBrightness = clamp(value, 0, 100);

  if (!(await commandExists('ddcutil'))) {
    monitorBrightnessAvailable = false;
    return false;
  }

  monitorBrightnessAvailable = true;

  clearTimeout(ddcutilTimeout);
  ddcutilTimeout = setTimeout(() => {
    runCommand(`ddcutil setvcp 10 ${monitorBrightness} --noverify`, 2500).catch(() => {});
  }, 300);

  return true;
}

async function getPing(force = false) {
  const result = await runCommand('ping -c 1 -W 2 1.1.1.1', 4000);

  if (result.error || !result.stdout) {
    failedPings += 1;
    if (failedPings > 3 || force) lastPing = 0;
    return lastPing;
  }

  failedPings = 0;
  const match = result.stdout.match(/time=([0-9.]+)/);

  if (match) {
    const milliseconds = Number.parseFloat(match[1]);
    if (Number.isFinite(milliseconds)) {
      lastPing = milliseconds > 0 && milliseconds < 1 ? 1 : Math.round(milliseconds);
    }
  }

  return lastPing;
}

async function getAudio() {
  if (!(await commandExists('wpctl'))) {
    return { available: false, vol: 0, muted: false };
  }

  const result = await runCommand('wpctl get-volume @DEFAULT_AUDIO_SINK@', 2000);
  if (result.error || !result.stdout) {
    return { available: false, vol: 0, muted: false };
  }

  const match = result.stdout.match(/([0-9]*\.?[0-9]+)/);
  const volume = match ? Math.round(Number.parseFloat(match[1]) * 100) : 0;
  const muted = result.stdout.includes('MUTED');

  return {
    available: true,
    vol: clamp(Number.isFinite(volume) ? volume : 0, 0, 100),
    muted,
  };
}

async function adjustVolume(ticks) {
  if (!(await commandExists('wpctl'))) return false;
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ 0', 1500);
  await runCommand(`wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ ${ticks > 0 ? '2%+' : '2%-'}`, 1500);
  return true;
}

async function toggleMute() {
  if (!(await commandExists('wpctl'))) return false;
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle', 1500);
  return true;
}

function updateTimerUI(context) {
  const timer = activeTimers[context];
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

  sendUpdateIfChanged(context, generateDialImage(icon, title, timeString, percent, color));
}

function updateBrightnessUI(context) {
  if (!monitorBrightnessAvailable) {
    sendUpdateIfChanged(context, unavailableDial('☀️', 'MONITOR', 'NO DDC'));
    return;
  }

  sendUpdateIfChanged(context, generateDialImage('☀️', 'MONITOR', `${monitorBrightness}%`, monitorBrightness, 'rgb(250, 204, 21)'));
}

async function updateAudioImmediately(context) {
  const audioData = await getAudio();

  if (!audioData.available) {
    sendUpdateIfChanged(context, unavailableDial('🔊', 'VOLUME', 'NO AUDIO'));
    return;
  }

  const valueText = audioData.muted ? 'MUTED' : `${audioData.vol}%`;
  const barColor = audioData.muted ? 'rgb(239, 68, 68)' : 'rgb(74, 222, 128)';
  const icon = audioData.muted ? '🔇' : '🔊';

  sendUpdateIfChanged(context, generateDialImage(icon, 'VOLUME', valueText, audioData.vol, barColor));
}

async function updatePingImmediately(context) {
  sendUpdateIfChanged(context, generateButtonImage('⚡', 'PING', '... ms', '1.1.1.1', 0));
  lastPingTime = Date.now();
  await getPing(true);
  sendUpdateIfChanged(context, generateButtonImage('⚡', 'PING', `${lastPing} ms`, '1.1.1.1', Math.min(100, lastPing)));
}

async function openActionTool(action, context) {
  const launcher = ACTION_LAUNCHERS[action];
  if (!launcher) return false;

  const available = await commandExists(launcher.check);

  if (!available) {
    showTransientImage(
      context,
      generateButtonImage(
        launcher.failure.icon,
        launcher.failure.title,
        launcher.failure.line1,
        launcher.failure.line2,
        -1
      )
    );
    return false;
  }

  await runCommand(launcher.command, 1500);

  showTransientImage(
    context,
    generateButtonImage(
      launcher.success.icon,
      launcher.success.title,
      launcher.success.line1,
      launcher.success.line2,
      -1
    )
  );

  return true;
}

function cleanupRuntime() {
  clearInterval(pollingInterval);
  clearInterval(timerInterval);
  clearTimeout(ddcutilTimeout);

  pollingInterval = null;
  timerInterval = null;
  ddcutilTimeout = null;
  pollingInProgress = false;

  for (const context of Object.keys(transientImageTimers)) {
    clearTransientTimer(context);
  }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`Shutting down (${reason})`);
  cleanupRuntime();

  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {
  }
}

ws.on('open', () => {
  safeSend({
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

ws.on('message', async (data) => {
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
      activeContexts[context] = {
        action,
        isEncoder: message.payload?.controller === 'Encoder',
      };

      if (action === ACTIONS.timer && !activeTimers[context]) {
        activeTimers[context] = { total: 0, remaining: 0, state: 'stopped' };
      }

      if (action === ACTIONS.monbright) {
        await refreshMonitorBrightness(true);
        updateBrightnessUI(context);
      }

      if (action === ACTIONS.audio) {
        await updateAudioImmediately(context);
      }

      if (!pollingInterval) startPolling();
      if (!timerInterval) startTimerLoop();
      return;
    }

    if (event === 'willDisappear') {
      delete activeContexts[context];
      delete activeTimers[context];
      delete lastSentImages[context];
      clearTransientTimer(context);

      if (Object.keys(activeContexts).length === 0) {
        cleanupRuntime();
        procCache = { timestamp: 0, data: { list: [] } };
      }
      return;
    }

    if (event === 'dialRotate') {
      const ticks = message.payload?.ticks || 0;

      if (action === ACTIONS.audio) {
        await adjustVolume(ticks);
        await updateAudioImmediately(context);
      }

      if (action === ACTIONS.timer) {
        const timer = activeTimers[context];
        if (timer && (timer.state === 'stopped' || timer.state === 'paused')) {
          timer.total = Math.max(0, timer.total + (ticks * 60));
          timer.remaining = timer.total;
          updateTimerUI(context);
        }
      }

      if (action === ACTIONS.monbright) {
        await setMonitorBrightness(monitorBrightness + (ticks * 5));
        updateBrightnessUI(context);
      }

      return;
    }

    if (event === 'dialDown' || event === 'keyDown') {
      if (!activeContexts[context]?.isEncoder) {
        if (action === ACTIONS.cpu || action === ACTIONS.gpu) {
          await openActionTool(action, context);
        }

        if (action === ACTIONS.ping) {
          await updatePingImmediately(context);
        }
      }

      if (action === ACTIONS.audio) {
        await toggleMute();
        await updateAudioImmediately(context);
      }

      if (action === ACTIONS.timer) {
        const timer = activeTimers[context];
        if (timer) {
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
      }

      if (action === ACTIONS.monbright) {
        await setMonitorBrightness(50);
        updateBrightnessUI(context);
      }
    }
  } catch (error) {
    warn('Message handler failed:', error.message);
  }
});

function startTimerLoop() {
  timerInterval = setInterval(() => {
    for (const context of Object.keys(activeTimers)) {
      const timer = activeTimers[context];
      if (!timer || timer.state !== 'running') continue;

      timer.remaining -= 1;

      if (timer.remaining <= 0) {
        timer.remaining = 0;
        timer.state = 'ringing';

        const soundCommand = 'paplay /usr/share/sounds/freedesktop/stereo/complete.oga || aplay /usr/share/sounds/alsa/Front_Center.wav';
        runCommand(`${soundCommand} ; sleep 0.3 ; ${soundCommand} ; sleep 0.3 ; ${soundCommand}`, 6000).catch(() => {});

        setTimeout(() => {
          if (activeTimers[context] && activeTimers[context].state === 'ringing') {
            activeTimers[context].state = 'stopped';
            activeTimers[context].remaining = activeTimers[context].total;

            if (activeContexts[context]) {
              updateTimerUI(context);
            }
          }
        }, 4000);
      }

      if (activeContexts[context]) {
        updateTimerUI(context);
      }
    }
  }, 1000);
}

function startPolling() {
  pollingInterval = setInterval(async () => {
    if (pollingInProgress || shuttingDown) return;
    pollingInProgress = true;

    try {
      const actionsList = Object.values(activeContexts).map((entry) => entry.action);
      if (actionsList.length === 0) return;

      let cpuData = {};
      let cpuTemp = {};
      let memData = {};
      let diskData = [];
      let audioData = { available: false, vol: 0, muted: false };
      let netResult = { available: false, iface: null, data: [] };
      let procData = procCache.data;

      const needsCpu = actionsList.includes(ACTIONS.cpu);
      const needsRam = actionsList.includes(ACTIONS.ram);
      const needsNet = actionsList.includes(ACTIONS.net);
      const needsDisk = actionsList.includes(ACTIONS.disk);
      const needsTop = actionsList.includes(ACTIONS.top);
      const needsAudio = actionsList.includes(ACTIONS.audio);
      const needsGpu = actionsList.includes(ACTIONS.gpu) || actionsList.includes(ACTIONS.vram);
      const needsBrightness = actionsList.includes(ACTIONS.monbright);

      const promises = [];

      if (needsCpu) {
        promises.push(si.currentLoad().then((data) => { cpuData = data; }).catch((error) => warnOnce('current-load-failed', `current load failed: ${error.message}`)));
        promises.push(si.cpuTemperature().then((data) => { cpuTemp = data; }).catch((error) => warnOnce('cpu-temp-failed', `cpu temperature failed: ${error.message}`)));
      }

      if (needsRam) {
        promises.push(si.mem().then((data) => { memData = data; }).catch((error) => warnOnce('mem-failed', `memory read failed: ${error.message}`)));
      }

      if (needsNet) {
        promises.push(getNetworkStats().then((data) => { netResult = data; }));
      }

      if (needsDisk) {
        promises.push(si.fsSize().then((data) => { diskData = data; }).catch((error) => warnOnce('disk-failed', `disk read failed: ${error.message}`)));
      }

      if (needsAudio) {
        promises.push(getAudio().then((data) => { audioData = data; }));
      }

      if (actionsList.includes(ACTIONS.ping)) {
        if (Date.now() - lastPingTime >= 5000) {
          lastPingTime = Date.now();
          promises.push(getPing());
        }
      }

      if (needsTop) {
        if ((Date.now() - procCache.timestamp) > TOP_REFRESH_MS) {
          promises.push(
            si.processes()
              .then((data) => {
                procCache = { timestamp: Date.now(), data };
                procData = data;
              })
              .catch((error) => warnOnce('processes-failed', `process list failed: ${error.message}`))
          );
        } else {
          procData = procCache.data;
        }
      }

      if (needsBrightness) {
        promises.push(refreshMonitorBrightness(false));
      }

      await Promise.all(promises);

      const gpuStats = needsGpu ? getAmdGpuStats() : null;
      const cpuPower = needsCpu ? getCpuPower() : { available: false, watts: 0 };

      for (const context of Object.keys(activeContexts)) {
        const { action } = activeContexts[context];

        if (transientImageTimers[context]) {
          continue;
        }

        if (action === ACTIONS.audio) {
          if (!audioData.available) {
            sendUpdateIfChanged(context, unavailableDial('🔊', 'VOLUME', 'NO AUDIO'));
          } else {
            const valueText = audioData.muted ? 'MUTED' : `${audioData.vol}%`;
            const barColor = audioData.muted ? 'rgb(239, 68, 68)' : 'rgb(74, 222, 128)';
            const icon = audioData.muted ? '🔇' : '🔊';
            sendUpdateIfChanged(context, generateDialImage(icon, 'VOLUME', valueText, audioData.vol, barColor));
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
            image = generateButtonImage('🧠', 'RAM', `${Math.round(percent)}%`, `${(activeMemory / (1024 ** 3)).toFixed(1)} GB`, percent);
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
          if (!netResult.available || netResult.data.length === 0) {
            image = unavailableButton('🌐', 'NET', 'NO NET');
          } else {
            const download = (((netResult.data[0].rx_sec || 0) * 8) / 1000000).toFixed(1);
            const upload = (((netResult.data[0].tx_sec || 0) * 8) / 1000000).toFixed(1);
            image = generateButtonImage('🌐', 'NET', `↓ ${download}`, `↑ ${upload} Mb/s`, -1);
          }
        } else if (action === ACTIONS.disk) {
          const uniqueDisks = {};

          for (const disk of diskData) {
            if (!disk.fs || !disk.fs.startsWith('/dev/')) continue;
            if (disk.fs.includes('loop')) continue;
            if (disk.mount && (disk.mount.includes('/snap/') || disk.mount.includes('/docker/'))) continue;
            uniqueDisks[disk.fs] = disk;
          }

          let totalSize = 0;
          let totalUsed = 0;

          for (const disk of Object.values(uniqueDisks)) {
            totalSize += disk.size || 0;
            totalUsed += disk.used || 0;
          }

          if (!totalSize) {
            image = unavailableButton('🖴', 'DISKS', 'NO DATA');
          } else {
            const percent = (totalUsed / totalSize) * 100;
            const freeGB = (totalSize - totalUsed) / (1024 ** 3);
            image = generateButtonImage('🖴', 'DISKS', `${Math.round(percent)}%`, `${Math.round(freeGB)} GB free`, percent);
          }
        } else if (action === ACTIONS.ping) {
          image = generateButtonImage('⚡', 'PING', `${lastPing} ms`, '1.1.1.1', Math.min(100, lastPing));
        } else if (action === ACTIONS.top) {
          const topProcess = procData.list
            ?.filter((process) => {
              const name = String(process.name || '').toLowerCase();
              return !name.includes('node')
                && !name.includes('opendeck')
                && !name.includes('systemd')
                && !name.includes('kworker')
                && !name.includes('ananicy')
                && !name.includes('rtkit')
                && name !== 'top'
                && name !== 'sh'
                && name !== 'cat'
                && name !== 'grep'
                && !name.includes('bash');
            })
            .sort((a, b) => b.cpu - a.cpu)[0];

          if (topProcess) {
            const cleanName = getShortProcName(topProcess.name);
            const load = topProcess.cpu > 100 ? (topProcess.cpu / coreCount) : topProcess.cpu;
            const loadPercent = Math.min(100, Math.round(load));
            image = generateButtonImage('🔥', 'TOP', cleanName, `${loadPercent}% CPU`, loadPercent);
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
          sendUpdateIfChanged(context, image);
        }
      }
    } catch (error) {
      warn('Poll loop failed:', error.message);
    } finally {
      pollingInProgress = false;
    }
  }, POLL_INTERVAL_MS);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => cleanupRuntime());
