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

const DEFAULT_SETTINGS = Object.freeze({
  pingHost: '1.1.1.1',
  networkInterface: '',
  volumeStep: 2,
  brightnessStep: 5,
  timerStep: 1,
  topMode: 'grouped',
  refreshRate: 3,
});

const TOP_REFRESH_MS = 4000;
const TOP_HOLD_MS = 12000;
const NETWORK_CACHE_MS = 10000;
const BRIGHTNESS_REFRESH_MS = 15000;
const CPU_POWER_SOURCE_CACHE_MS = 10000;
const DISK_CACHE_MS = 30000;

const NETWORK_EXCLUDED_PREFIXES = ['lo', 'docker', 'br-', 'veth', 'virbr', 'vmnet', 'vboxnet', 'tailscale', 'zt', 'tun', 'tap', 'wg'];
const NETWORK_PREFERRED_PREFIXES = ['en', 'eth', 'wl', 'wlan', 'ww', 'usb'];
const TRANSIENT_IMAGE_MS = 1250;

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

const activeContexts = Object.create(null);
const activeTimers = Object.create(null);
const lastSentImages = Object.create(null);
const transientImageTimers = Object.create(null);
const renderRetryTimers = Object.create(null);
const contextSettings = Object.create(null);
const actionSettings = Object.create(null);
const pingStates = Object.create(null);

let pollingInterval = null;
let timerInterval = null;
let pollingInProgress = false;
let currentPollingRateMs = 0;
let ddcutilTimeout = null;
let shuttingDown = false;

let monitorBrightness = 50;
let monitorBrightnessAvailable = false;
let lastBrightnessSync = 0;

let amdgpuDirCache = null;
let cpuPowerSourceCache = {
  timestamp: 0,
  sources: [],
};
let cpuPowerSampleCache = Object.create(null);
let procCache = { timestamp: 0, data: { list: [] } };
let topProcessCache = {
  grouped: { name: '', cpu: 0, timestamp: 0 },
  raw: { name: '', cpu: 0, timestamp: 0 },
};
let networkCache = { timestamp: 0, iface: null };
let diskCache = {
  timestamp: 0,
  summary: { available: false, percent: 0, freeGB: 0 },
  refreshPromise: null,
};
let globalPluginSettings = null;

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

function getAdaptiveFontSize(text, baseSize, minSize, softLimit = 6, step = 2) {
  const length = String(text || '').length;
  if (length <= softLimit) return baseSize;
  return Math.max(minSize, baseSize - ((length - softLimit) * step));
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeSettings(settings = {}) {
  const normalized = {
    ...DEFAULT_SETTINGS,
  };

  if (typeof settings.pingHost === 'string' && settings.pingHost.trim()) {
    normalized.pingHost = settings.pingHost.trim();
  }

  if (typeof settings.networkInterface === 'string') {
    normalized.networkInterface = settings.networkInterface.trim();
  }

  if (settings.volumeStep !== undefined) {
    normalized.volumeStep = clamp(Number.parseInt(settings.volumeStep, 10) || DEFAULT_SETTINGS.volumeStep, 1, 20);
  }

  if (settings.brightnessStep !== undefined) {
    normalized.brightnessStep = clamp(Number.parseInt(settings.brightnessStep, 10) || DEFAULT_SETTINGS.brightnessStep, 1, 25);
  }

  if (settings.timerStep !== undefined) {
    normalized.timerStep = clamp(Number.parseInt(settings.timerStep, 10) || DEFAULT_SETTINGS.timerStep, 1, 60);
  }

  if (settings.topMode === 'raw' || settings.topMode === 'grouped') {
    normalized.topMode = settings.topMode;
  }

  const refresh = Number.parseInt(settings.refreshRate, 10);
  normalized.refreshRate = [1, 3, 5, 10].includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshRate;

  return normalized;
}

function getEffectiveRefreshRateMs() {
  const settings = normalizeSettings(globalPluginSettings || {});
  return settings.refreshRate * 1000;
}

function restartPollingIfNeeded() {
  const desired = getEffectiveRefreshRateMs();

  if (pollingInterval && currentPollingRateMs === desired) {
    return;
  }

  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    currentPollingRateMs = 0;
  }

  if (Object.keys(activeContexts).length > 0) {
    startPolling();
  }
}

function storeSettingsForContext(context, settings, action = '') {
  const normalized = normalizeSettings(settings);
  const previousRate = getEffectiveRefreshRateMs();

  if (context) {
    contextSettings[context] = normalized;
  }

  const resolvedAction = action || activeContexts[context]?.action || '';
  if (resolvedAction) {
    actionSettings[resolvedAction] = normalized;
  }

  globalPluginSettings = {
    ...(globalPluginSettings || {}),
    ...normalized,
  };

  if (previousRate !== getEffectiveRefreshRateMs()) {
    restartPollingIfNeeded();
  }
}

function getSettingsForContext(context, action = '') {
  const resolvedAction = action || activeContexts[context]?.action || '';

  if (context && contextSettings[context]) {
    return normalizeSettings(contextSettings[context]);
  }

  if (resolvedAction && actionSettings[resolvedAction]) {
    return normalizeSettings(actionSettings[resolvedAction]);
  }

  if (globalPluginSettings) {
    return normalizeSettings(globalPluginSettings);
  }

  return normalizeSettings({});
}

function getPingState(context) {
  if (!pingStates[context]) {
    pingStates[context] = {
      lastPing: 0,
      failedPings: 0,
      lastPingTime: 0,
    };
  }

  return pingStates[context];
}

function getResolvedAction(context, fallbackAction = '') {
  return activeContexts[context]?.action || fallbackAction || '';
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
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

function clearRenderRetries(context) {
  if (renderRetryTimers[context]) {
    for (const timer of renderRetryTimers[context]) {
      clearTimeout(timer);
    }
    delete renderRetryTimers[context];
  }
}

function queueRenderRetries(context, imageFactory, delays = [0, 300, 900]) {
  clearRenderRetries(context);
  renderRetryTimers[context] = [];

  for (const delay of delays) {
    const timer = setTimeout(() => {
      if (!activeContexts[context]) return;
      delete lastSentImages[context];
      sendUpdateIfChanged(context, imageFactory());
    }, delay);

    renderRetryTimers[context].push(timer);
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
    .split(/[\\/\\\\]/)
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

function hasAnyPrefix(value, prefixes) {
  const lower = String(value || '').toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

function scoreNetworkInterface(iface) {
  const name = String(iface.iface || '');
  if (!name) return -10000;

  let score = 0;

  if (iface.operstate === 'up') score += 200;
  if (iface.default) score += 500;
  if (iface.ip4) score += 120;
  if (iface.ip6) score += 40;
  if (typeof iface.speed === 'number' && iface.speed > 0) score += Math.min(iface.speed, 1000) / 10;
  if (iface.type === 'wired') score += 80;
  if (iface.type === 'wireless') score += 60;
  if (hasAnyPrefix(name, NETWORK_PREFERRED_PREFIXES)) score += 180;
  if (hasAnyPrefix(name, NETWORK_EXCLUDED_PREFIXES)) score -= 1000;

  return score;
}

function isExcludedTopProcess(name) {
  const lower = String(name || '').toLowerCase();

  const blocked = [
    'node',
    'opendeck',
    'systemd',
    'kworker',
    'ananicy',
    'rtkit',
    'bash',
    'sh',
    'grep',
    'cat',
    'ps',
    'top',
    'pipewire',
    'wireplumber',
    'dbus-daemon',
    'xdg-desktop-portal',
    'xdg-document-portal',
  ];

  return blocked.some((entry) => lower === entry || lower.includes(entry));
}

function getTopProcessSummary(procData, mode = 'grouped') {
  const cacheKey = mode === 'raw' ? 'raw' : 'grouped';
  const cached = topProcessCache[cacheKey];
  const now = Date.now();
  const list = Array.isArray(procData?.list) ? procData.list : [];
  const filtered = [];

  for (const process of list) {
    const rawName = String(process.name || '').trim();
    const cpu = Number(process.cpu || 0);

    if (!rawName) continue;
    if (!Number.isFinite(cpu) || cpu <= 0.15) continue;
    if (isExcludedTopProcess(rawName)) continue;

    filtered.push({
      rawName,
      cpu,
      label: getShortProcName(rawName),
    });
  }

  const useCached = () => {
    if (cached && cached.name && (now - cached.timestamp) <= TOP_HOLD_MS) {
      return {
        name: cached.name,
        cpu: cached.cpu,
      };
    }

    return null;
  };

  if (filtered.length === 0) {
    return useCached();
  }

  let result = null;

  if (mode === 'raw') {
    const best = filtered.sort((a, b) => b.cpu - a.cpu)[0];

    if (best) {
      const normalizedCpu = clamp(
        Math.max(1, Math.round(best.cpu > 100 ? best.cpu / coreCount : best.cpu)),
        0,
        100
      );

      if (normalizedCpu >= 1) {
        result = {
          name: best.label,
          cpu: normalizedCpu,
        };
      }
    }
  } else {
    const grouped = new Map();

    for (const process of filtered) {
      grouped.set(process.label, (grouped.get(process.label) || 0) + process.cpu);
    }

    let bestName = '';
    let bestCpu = 0;

    for (const [name, cpu] of grouped.entries()) {
      if (cpu > bestCpu) {
        bestName = name;
        bestCpu = cpu;
      }
    }

    if (bestName) {
      const normalizedCpu = clamp(
        Math.max(1, Math.round(bestCpu > 100 ? bestCpu / coreCount : bestCpu)),
        0,
        100
      );

      if (normalizedCpu >= 1) {
        result = {
          name: bestName,
          cpu: normalizedCpu,
        };
      }
    }
  }

  if (result) {
    topProcessCache[cacheKey] = {
      name: result.name,
      cpu: result.cpu,
      timestamp: now,
    };
    return result;
  }

  return useCached();
}

function generateButtonImage(icon, title, line1, line2, percent = -1) {
  const safeTitle = String(title || '');
  const safeLine1 = String(line1 || '');
  const safeLine2 = String(line2 || '');

  const titleSize = getAdaptiveFontSize(safeTitle, 19, 15, 8, 1);
  const line1Size = getAdaptiveFontSize(safeLine1, 35, 21, 5, 2);
  const line2Size = getAdaptiveFontSize(safeLine2, 20, 13, 16, 1);

  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const r = p > 50 ? 255 : Math.floor((p * 2) * 255 / 100);
    const g = p < 50 ? 255 : Math.floor(((100 - p) * 2) * 255 / 100);
    const width = (112 * p) / 100;

    barHtml = `<rect x="16" y="122" width="112" height="8" fill="#333" rx="4"/><rect x="16" y="122" width="${width}" height="8" fill="rgb(${r},${g},0)" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="60" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="21" text-anchor="end">${escapeXml(icon)}</text>
    <text x="64" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" text-anchor="start">${escapeXml(safeTitle)}</text>
    <text x="72" y="76" fill="#ffffff" font-family="sans-serif" font-size="${line1Size}" font-weight="bold" text-anchor="middle">${escapeXml(safeLine1)}</text>
    <text x="72" y="104" fill="#a1a1aa" font-family="sans-serif" font-size="${line2Size}" text-anchor="middle">${escapeXml(safeLine2)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateDialImage(icon, title, valueText, percent = -1, barColor = 'rgb(74, 222, 128)') {
  const safeTitle = String(title || '');
  const safeValue = String(valueText || '');

  const titleSize = getAdaptiveFontSize(safeTitle, 18, 14, 10, 1);
  const valueSize = getAdaptiveFontSize(safeValue, 40, 24, 4, 2);

  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const width = (100 * p) / 100;
    barHtml = `<rect x="22" y="115" width="100" height="8" fill="#333" rx="4"/><rect x="22" y="115" width="${width}" height="8" fill="${escapeXml(barColor)}" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="60" y="32" fill="#a1a1aa" font-family="sans-serif" font-size="21" text-anchor="end">${escapeXml(icon)}</text>
    <text x="64" y="32" fill="#a1a1aa" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" text-anchor="start">${escapeXml(safeTitle)}</text>
    <text x="72" y="86" fill="#ffffff" font-family="sans-serif" font-size="${valueSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeValue)}</text>
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

function readOptionalText(filePath) {
  try {
    if (!fileExists(filePath)) return '';
    return readText(filePath);
  } catch {
    return '';
  }
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

function scanCpuPowerSources(force = false) {
  const now = Date.now();

  if (!force && (now - cpuPowerSourceCache.timestamp) < CPU_POWER_SOURCE_CACHE_MS && cpuPowerSourceCache.sources.length > 0) {
    return cpuPowerSourceCache.sources;
  }

  const sources = [];

  try {
    const hwmonRoot = '/sys/class/hwmon';
    const dirs = fs.readdirSync(hwmonRoot);

    for (const dir of dirs) {
      const fullPath = path.join(hwmonRoot, dir);
      const namePath = path.join(fullPath, 'name');

      if (!fileExists(namePath)) continue;

      const name = readText(namePath);
      if (!['zenpower', 'amd_energy', 'zenergy'].includes(name)) continue;

      const entries = fs.readdirSync(fullPath);

      for (const entry of entries) {
        let type = '';

        if (/^power\d+_(average|input)$/.test(entry) || entry === 'power_input') {
          type = 'power';
        } else if (/^energy\d+_input$/.test(entry) || entry === 'energy_input') {
          type = 'energy';
        } else {
          continue;
        }

        const entryPath = path.join(fullPath, entry);
        if (!fileExists(entryPath)) continue;

        const labelPath = entry
          .replace(/_average$/, '_label')
          .replace(/_input$/, '_label');

        sources.push({
          name,
          type,
          path: entryPath,
          file: entry,
          label: readOptionalText(path.join(fullPath, labelPath)),
        });
      }
    }
  } catch (error) {
    warnOnce('cpu-power-scan-failed', `cpu power scan failed: ${error.message}`);
  }

  cpuPowerSourceCache = {
    timestamp: now,
    sources,
  };

  return sources;
}

function getCpuPowerSourcePriority(source) {
  const text = `${source.name} ${source.label} ${source.file}`.toLowerCase();
  let score = 0;

  if (/(package|socket|total|cpu|ppt)/.test(text)) score += 1000;
  if (/core/.test(text)) score -= 25;
  if (/(soc|gfx|igpu|mem|misc)/.test(text)) score -= 350;

  if (source.type === 'power') score += 250;
  if (source.name === 'zenpower') score += 120;
  if (source.name === 'zenergy') score += 80;
  if (source.name === 'amd_energy') score += 20;

  return score;
}

function readCpuPowerSource(source) {
  try {
    const rawValue = Number.parseInt(readText(source.path), 10);
    if (!Number.isFinite(rawValue)) return null;

    if (source.type === 'power') {
      const watts = rawValue / 1000000;
      if (!Number.isFinite(watts) || watts < 0) return null;
      return watts;
    }

    if (source.type === 'energy') {
      const now = Date.now();
      const sample = cpuPowerSampleCache[source.path] || {
        lastRawValue: null,
        lastTimestamp: 0,
        watts: 0,
      };

      if (
        Number.isFinite(sample.lastRawValue) &&
        sample.lastTimestamp > 0 &&
        rawValue >= sample.lastRawValue
      ) {
        const deltaEnergyMicroJoules = rawValue - sample.lastRawValue;
        const deltaSeconds = (now - sample.lastTimestamp) / 1000;

        if (deltaSeconds > 0) {
          const watts = (deltaEnergyMicroJoules / 1000000) / deltaSeconds;
          if (Number.isFinite(watts) && watts >= 0) {
            sample.watts = watts;
          }
        }
      } else if (Number.isFinite(sample.lastRawValue) && rawValue < sample.lastRawValue) {
        sample.watts = 0;
      }

      sample.lastRawValue = rawValue;
      sample.lastTimestamp = now;
      cpuPowerSampleCache[source.path] = sample;

      if (Number.isFinite(sample.watts) && sample.watts >= 0) {
        return sample.watts;
      }
    }
  } catch (error) {
    warnOnce(`cpu-power-read-failed:${source.path}`, `cpu power read failed for ${source.path}: ${error.message}`);
  }

  return null;
}

function getCpuPower() {
  const sources = scanCpuPowerSources();

  if (!sources.length) {
    return { available: false, watts: 0 };
  }

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const source of sources) {
    const watts = readCpuPowerSource(source);
    if (!Number.isFinite(watts) || watts < 0) continue;

    const score = getCpuPowerSourcePriority(source) + Math.min(watts, 500);

    if (score > bestScore) {
      bestScore = score;
      best = { source, watts };
    }
  }

  if (!best) {
    return { available: false, watts: 0 };
  }

  warnOnce(
    `cpu-power-source:${best.source.path}`,
    `cpu power source selected: ${best.source.name} ${best.source.file}${best.source.label ? ` (${best.source.label})` : ''}`
  );

  return { available: true, watts: best.watts };
}

function buildDiskSummary(fsEntries) {
  const uniqueDisks = {};

  for (const disk of fsEntries) {
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
    return { available: false, percent: 0, freeGB: 0 };
  }

  return {
    available: true,
    percent: (totalUsed / totalSize) * 100,
    freeGB: (totalSize - totalUsed) / (1024 ** 3),
  };
}

async function refreshDiskSummary() {
  if (diskCache.refreshPromise) {
    return diskCache.refreshPromise;
  }

  diskCache.refreshPromise = si.fsSize()
    .then((entries) => {
      diskCache.summary = buildDiskSummary(entries);
      diskCache.timestamp = Date.now();
      return diskCache.summary;
    })
    .catch((error) => {
      warnOnce('disk-failed', `disk read failed: ${error.message}`);
      return diskCache.summary;
    })
    .finally(() => {
      diskCache.refreshPromise = null;
    });

  return diskCache.refreshPromise;
}

function getDiskSummary(force = false) {
  const now = Date.now();

  if (force || (now - diskCache.timestamp) > DISK_CACHE_MS) {
    void refreshDiskSummary();
  }

  return diskCache.summary;
}

function updateDiskUI(context) {
  const diskSummary = getDiskSummary(false);

  if (!diskSummary.available) {
    sendUpdateIfChanged(context, generateButtonImage('🖴', 'DISKS', '...', 'Loading...', -1));
    return;
  }

  sendUpdateIfChanged(
    context,
    generateButtonImage('🖴', 'DISKS', `${Math.round(diskSummary.percent)}%`, `${Math.round(diskSummary.freeGB)} GB free`, diskSummary.percent)
  );
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

    if (candidates.length === 0) {
      return null;
    }

    const preferred = [...candidates].sort((a, b) => scoreNetworkInterface(b) - scoreNetworkInterface(a))[0] || null;

    networkCache.iface = preferred ? preferred.iface : null;
    return networkCache.iface;
  } catch (error) {
    warnOnce('network-interface-detect-failed', `network interface detection failed: ${error.message}`);
    return null;
  }
}

async function getNetworkStats(overrideInterface = '') {
  let iface = String(overrideInterface || '').trim();

  try {
    if (iface) {
      const data = await si.networkStats(iface);
      if (Array.isArray(data) && data.length > 0) {
        return { available: true, iface, data };
      }
    }

    iface = await detectActiveInterface();

    if (iface) {
      let data = await si.networkStats(iface);

      if (Array.isArray(data) && data.length > 0) {
        return { available: true, iface, data };
      }

      iface = await detectActiveInterface(true);

      if (iface) {
        data = await si.networkStats(iface);
        if (Array.isArray(data) && data.length > 0) {
          return { available: true, iface, data };
        }
      }
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

async function getPing(context, host, force = false) {
  const state = getPingState(context);
  const target = String(host || DEFAULT_SETTINGS.pingHost).trim() || DEFAULT_SETTINGS.pingHost;
  const result = await runCommand(`ping -c 1 -W 2 ${shellEscape(target)}`, 4000);

  if (result.error || !result.stdout) {
    state.failedPings += 1;
    if (state.failedPings > 3 || force) state.lastPing = 0;
    return state.lastPing;
  }

  state.failedPings = 0;
  const match = result.stdout.match(/time=([0-9.]+)/);

  if (match) {
    const milliseconds = Number.parseFloat(match[1]);
    if (Number.isFinite(milliseconds)) {
      state.lastPing = milliseconds > 0 && milliseconds < 1 ? 1 : Math.round(milliseconds);
    }
  }

  return state.lastPing;
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

async function adjustVolume(ticks, stepPercent = 2) {
  if (!(await commandExists('wpctl'))) return false;
  const step = clamp(Number.parseInt(stepPercent, 10) || 2, 1, 20);
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ 0', 1500);
  await runCommand(`wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ ${ticks > 0 ? `${step}%+` : `${step}%-`}`, 1500);
  return true;
}

async function toggleMute() {
  if (!(await commandExists('wpctl'))) return false;
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle', 1500);
  return true;
}

function getTimerImage(context) {
  const timer = activeTimers[context];
  if (!timer) {
    return generateDialImage('⏱️', 'TIMER', '0:00', 0, 'rgb(59, 130, 246)');
  }

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

  return generateDialImage(icon, title, timeString, percent, color);
}

function updateTimerUI(context) {
  sendUpdateIfChanged(context, getTimerImage(context));
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
  const settings = getSettingsForContext(context, ACTIONS.ping);
  const target = settings.pingHost || DEFAULT_SETTINGS.pingHost;
  const targetLabel = target.length > 12 ? `${target.slice(0, 11)}…` : target;
  const state = getPingState(context);

  sendUpdateIfChanged(context, generateButtonImage('⚡', 'PING', '... ms', targetLabel, 0));
  state.lastPingTime = Date.now();
  await getPing(context, target, true);
  sendUpdateIfChanged(context, generateButtonImage('⚡', 'PING', `${state.lastPing} ms`, targetLabel, Math.min(100, state.lastPing)));
}

function primeActionUI(context, action) {
  if (!context || !action) return;

  if (action === ACTIONS.audio) {
    queueRenderRetries(context, () => generateDialImage('🔊', 'VOLUME', '...', 0, 'rgb(74, 222, 128)'));
    void updateAudioImmediately(context);
    return;
  }

  if (action === ACTIONS.timer) {
    queueRenderRetries(context, () => getTimerImage(context));
    updateTimerUI(context);
    return;
  }

  if (action === ACTIONS.monbright) {
    queueRenderRetries(context, () => generateDialImage('☀️', 'MONITOR', '...', 50, 'rgb(250, 204, 21)'));
    void refreshMonitorBrightness(true).then(() => {
      if (activeContexts[context]) {
        updateBrightnessUI(context);
      }
    });
    return;
  }

  if (action === ACTIONS.disk) {
    queueRenderRetries(context, () => generateButtonImage('🖴', 'DISKS', '...', 'Loading...', -1));
    updateDiskUI(context);
    void refreshDiskSummary().then(() => {
      if (activeContexts[context]) {
        delete lastSentImages[context];
        updateDiskUI(context);
      }
    });
  }
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
  currentPollingRateMs = 0;

  for (const context of Object.keys(transientImageTimers)) {
    clearTransientTimer(context);
  }

  for (const context of Object.keys(renderRetryTimers)) {
    clearRenderRetries(context);
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

      storeSettingsForContext(context, message.payload?.settings || {}, action);

      if (action === ACTIONS.timer && !activeTimers[context]) {
        activeTimers[context] = { total: 0, remaining: 0, state: 'stopped' };
      }

      primeActionUI(context, action);

      restartPollingIfNeeded();

      if (!timerInterval) startTimerLoop();
      return;
    }

    if (event === 'didReceiveSettings') {
      const resolvedAction = getResolvedAction(context, action);
      storeSettingsForContext(context, message.payload?.settings || {}, resolvedAction);
      delete lastSentImages[context];

      if (resolvedAction === ACTIONS.audio) {
        await updateAudioImmediately(context);
      } else if (resolvedAction === ACTIONS.monbright) {
        updateBrightnessUI(context);
      } else if (resolvedAction === ACTIONS.ping) {
        await updatePingImmediately(context);
      } else if (resolvedAction === ACTIONS.timer) {
        updateTimerUI(context);
      } else if (resolvedAction === ACTIONS.disk) {
        updateDiskUI(context);
      }

      restartPollingIfNeeded();
      return;
    }

    if (event === 'sendToPlugin') {
      if (message.payload?.type === 'saveSettings') {
        const resolvedAction = getResolvedAction(context, action);
        storeSettingsForContext(context, message.payload?.settings || {}, resolvedAction);
        delete lastSentImages[context];

        if (resolvedAction === ACTIONS.audio) {
          await updateAudioImmediately(context);
        } else if (resolvedAction === ACTIONS.monbright) {
          updateBrightnessUI(context);
        } else if (resolvedAction === ACTIONS.ping) {
          await updatePingImmediately(context);
        } else if (resolvedAction === ACTIONS.timer) {
          updateTimerUI(context);
        } else if (resolvedAction === ACTIONS.disk) {
          updateDiskUI(context);
        }

        restartPollingIfNeeded();
      }
      return;
    }

    if (event === 'willDisappear') {
      delete activeContexts[context];
      delete activeTimers[context];
      delete lastSentImages[context];
      delete contextSettings[context];
      delete pingStates[context];
      clearTransientTimer(context);
      clearRenderRetries(context);

      if (Object.keys(activeContexts).length === 0) {
        cleanupRuntime();
        procCache = { timestamp: 0, data: { list: [] } };
      }
      return;
    }

    if (event === 'dialRotate') {
      const ticks = message.payload?.ticks || 0;
      const resolvedAction = getResolvedAction(context, action);
      const settings = getSettingsForContext(context, resolvedAction);

      if (resolvedAction === ACTIONS.audio) {
        await adjustVolume(ticks, settings.volumeStep);
        await updateAudioImmediately(context);
      }

      if (resolvedAction === ACTIONS.timer) {
        const timer = activeTimers[context];
        if (timer && (timer.state === 'stopped' || timer.state === 'paused')) {
          timer.total = Math.max(0, timer.total + (ticks * settings.timerStep * 60));
          timer.remaining = timer.total;
          updateTimerUI(context);
        }
      }

      if (resolvedAction === ACTIONS.monbright) {
        await setMonitorBrightness(monitorBrightness + (ticks * settings.brightnessStep));
        updateBrightnessUI(context);
      }

      return;
    }

    if (event === 'dialDown' || event === 'keyDown') {
      const resolvedAction = getResolvedAction(context, action);

      if (!activeContexts[context]?.isEncoder) {
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

      if (resolvedAction === ACTIONS.monbright) {
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
  currentPollingRateMs = getEffectiveRefreshRateMs();

  pollingInterval = setInterval(async () => {
    if (pollingInProgress || shuttingDown) return;
    pollingInProgress = true;

    try {
      const actionsList = Object.values(activeContexts).map((entry) => entry.action);
      if (actionsList.length === 0) return;

      let cpuData = {};
      let cpuTemp = {};
      let memData = {};
      let diskSummary = getDiskSummary(false);
      let audioData = { available: false, vol: 0, muted: false };
      let procData = procCache.data;

      const needsCpu = actionsList.includes(ACTIONS.cpu);
      const needsRam = actionsList.includes(ACTIONS.ram);
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

      if (needsDisk) {
        promises.push(Promise.resolve().then(() => {
          diskSummary = getDiskSummary(false);
        }));
      }

      if (needsAudio) {
        promises.push(getAudio().then((data) => { audioData = data; }));
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
        const settings = getSettingsForContext(context, action);

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
            const wattsText = cpuPower.available ? `${Math.max(0, Math.round(cpuPower.watts))}W` : 'NO PWR';
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
          const netResult = await getNetworkStats(settings.networkInterface);
          if (!netResult.available || netResult.data.length === 0) {
            image = unavailableButton('🌐', 'NET', 'NO NET');
          } else {
            const download = (((netResult.data[0].rx_sec || 0) * 8) / 1000000).toFixed(1);
            const upload = (((netResult.data[0].tx_sec || 0) * 8) / 1000000).toFixed(1);
            image = generateButtonImage('🌐', 'NET', `↓ ${download}`, `↑ ${upload} Mb/s`, -1);
          }
        } else if (action === ACTIONS.disk) {
          if (!diskSummary.available) {
            image = generateButtonImage('🖴', 'DISKS', '...', 'Loading...', -1);
          } else {
            image = generateButtonImage('🖴', 'DISKS', `${Math.round(diskSummary.percent)}%`, `${Math.round(diskSummary.freeGB)} GB free`, diskSummary.percent);
          }
        } else if (action === ACTIONS.ping) {
          const state = getPingState(context);
          const target = settings.pingHost || DEFAULT_SETTINGS.pingHost;
          const targetLabel = target.length > 12 ? `${target.slice(0, 11)}…` : target;

          if (Date.now() - state.lastPingTime >= 5000) {
            state.lastPingTime = Date.now();
            await getPing(context, target, false);
          }

          image = generateButtonImage('⚡', 'PING', `${state.lastPing} ms`, targetLabel, Math.min(100, state.lastPing));
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
          sendUpdateIfChanged(context, image);
        }
      }
    } catch (error) {
      warn('Poll loop failed:', error.message);
    } finally {
      pollingInProgress = false;
    }
  }, currentPollingRateMs);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => cleanupRuntime());
