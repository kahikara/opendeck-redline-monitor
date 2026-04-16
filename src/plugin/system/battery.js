const { runCommand, shellEscape } = require('../utils');

let cachedDevicePath = '';
let lastDeviceScan = 0;

const DEVICE_CACHE_MS = 30000;

function parseBatteryInfo(text = '') {
  const percentageMatch = text.match(/percentage:\s*([0-9]+)%/i);
  const stateMatch = text.match(/state:\s*([^\n\r]+)/i);
  const modelMatch = text.match(/model:\s*([^\n\r]+)/i);

  const percentage = percentageMatch ? Number.parseInt(percentageMatch[1], 10) : NaN;

  return {
    percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null,
    state: stateMatch ? stateMatch[1].trim() : '',
    model: modelMatch ? modelMatch[1].trim() : '',
  };
}

function scoreDevice(path) {
  let score = 0;

  if (/hidpp_battery/i.test(path)) score += 100;
  if (/mouse/i.test(path)) score += 20;
  if (/battery_/i.test(path)) score += 10;

  return score;
}

async function resolveBatteryDevice(force = false) {
  if (!force && cachedDevicePath && (Date.now() - lastDeviceScan) < DEVICE_CACHE_MS) {
    return cachedDevicePath;
  }

  const result = await runCommand('upower -e', 3000);
  lastDeviceScan = Date.now();

  if (result.error || !result.stdout) {
    cachedDevicePath = '';
    return '';
  }

  const devices = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes('/org/freedesktop/UPower/devices/battery_'))
    .sort((a, b) => scoreDevice(b) - scoreDevice(a));

  cachedDevicePath = devices[0] || '';
  return cachedDevicePath;
}

async function readBatteryDevice(devicePath) {
  const result = await runCommand(`upower -i ${shellEscape(devicePath)}`, 4000);

  if (result.error || !result.stdout) {
    return null;
  }

  const info = parseBatteryInfo(result.stdout);

  if (info.percentage === null) {
    return null;
  }

  return {
    devicePath,
    ...info,
  };
}

function normalizeState(state) {
  const value = String(state || '').trim().toLowerCase();

  if (value === 'charging') return 'CHARGING';
  if (value === 'discharging') return 'DISCHARGING';
  if (value === 'fully-charged') return 'FULL';
  if (value === 'pending-charge') return 'PENDING';
  if (value === 'empty') return 'EMPTY';

  return value ? value.toUpperCase() : 'UPOWER';
}

async function getMouseBattery() {
  let devicePath = await resolveBatteryDevice(false);

  if (!devicePath) {
    return { available: false };
  }

  let info = await readBatteryDevice(devicePath);

  if (!info) {
    cachedDevicePath = '';
    devicePath = await resolveBatteryDevice(true);

    if (!devicePath) {
      return { available: false };
    }

    info = await readBatteryDevice(devicePath);
  }

  if (!info) {
    return { available: false };
  }

  return {
    available: true,
    percentage: info.percentage,
    state: normalizeState(info.state),
    model: info.model || 'HIDPP',
    path: info.devicePath,
  };
}

module.exports = {
  getMouseBattery,
};
