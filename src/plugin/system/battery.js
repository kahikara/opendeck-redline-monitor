const { runCommand, shellEscape } = require('../utils');

let cachedDevices = [];
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

function normalizeState(state) {
  const value = String(state || '').trim().toLowerCase();

  if (value === 'charging') return 'CHARGING';
  if (value === 'discharging') return 'DISCHARGING';
  if (value === 'fully-charged') return 'FULL';
  if (value === 'pending-charge') return 'PENDING';
  if (value === 'empty') return 'EMPTY';

  return value ? value.toUpperCase() : 'UPOWER';
}

function humanizeDevicePath(devicePath = '') {
  const tail = String(devicePath || '').split('/').pop() || '';
  const base = tail.replace(/^battery_/i, '').replace(/_/g, ' ').trim();

  if (!base) {
    return 'Battery';
  }

  return base
    .split(' ')
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function getDeviceLabel(devicePath, model = '') {
  const safeModel = String(model || '').trim();
  return safeModel || humanizeDevicePath(devicePath);
}

function scoreDevice(devicePath, label = '') {
  let score = 0;
  const path = String(devicePath || '').toLowerCase();
  const name = String(label || '').toLowerCase();

  if (path.includes('hidpp_battery')) score += 100;
  if (path.includes('mouse')) score += 20;
  if (name.includes('mouse')) score += 20;
  if (name.includes('logitech')) score += 10;
  if (path.includes('battery_')) score += 10;

  return score;
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

async function listBatteryDevices(force = false) {
  if (!force && cachedDevices.length > 0 && (Date.now() - lastDeviceScan) < DEVICE_CACHE_MS) {
    return cachedDevices;
  }

  const result = await runCommand('upower -e', 3000);
  lastDeviceScan = Date.now();

  if (result.error || !result.stdout) {
    cachedDevices = [];
    return cachedDevices;
  }

  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes('/org/freedesktop/UPower/devices/battery_'));

  const devices = await Promise.all(paths.map(async (devicePath) => {
    const info = await readBatteryDevice(devicePath);
    const label = getDeviceLabel(devicePath, info?.model || '');

    return {
      id: devicePath,
      label,
      model: info?.model || '',
      percentage: info?.percentage ?? null,
      state: normalizeState(info?.state || ''),
    };
  }));

  cachedDevices = devices.sort((a, b) => scoreDevice(b.id, b.label) - scoreDevice(a.id, a.label));
  return cachedDevices;
}

async function resolveBatteryDevice(selectedDevice = 'auto', force = false) {
  const selected = String(selectedDevice || '').trim();

  if (selected && selected !== 'auto') {
    return selected;
  }

  const devices = await listBatteryDevices(force);
  return devices[0]?.id || '';
}

async function getMouseBattery(selectedDevice = 'auto') {
  let devicePath = await resolveBatteryDevice(selectedDevice, false);

  if (!devicePath) {
    return { available: false };
  }

  let info = await readBatteryDevice(devicePath);

  if (!info) {
    if (String(selectedDevice || '').trim() === 'auto') {
      devicePath = await resolveBatteryDevice('auto', true);
      if (!devicePath) {
        return { available: false };
      }
    }

    info = await readBatteryDevice(devicePath);
  }

  if (!info) {
    return { available: false };
  }

  const devices = await listBatteryDevices(false);
  const deviceMeta = devices.find((entry) => entry.id === devicePath);

  return {
    available: true,
    percentage: info.percentage,
    state: normalizeState(info.state),
    label: deviceMeta?.label || getDeviceLabel(devicePath, info.model),
    model: info.model || '',
    path: devicePath,
  };
}

module.exports = {
  listBatteryDevices,
  getMouseBattery,
};
