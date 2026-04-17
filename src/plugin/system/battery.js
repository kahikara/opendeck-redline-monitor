const fs = require('fs');
const path = require('path');
const { runCommand, shellEscape } = require('../utils');

let cachedDevices = [];
let lastDeviceScan = 0;
const lastBatterySamples = new Map();

const DEVICE_CACHE_MS = 5000;
const SAMPLE_CACHE_MS = 180000;
const TRANSIENT_ZERO_HOLD_MS = 20000;
const SYSFS_POWER_SUPPLY_ROOT = '/sys/class/power_supply';

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    return '';
  }
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSysfsUeventValue(dirPath, key) {
  const lines = readText(path.join(dirPath, 'uevent')).split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim();
    }
  }

  return '';
}

function readSysfsBatteryState(dirPath) {
  const directStatus = readText(path.join(dirPath, 'status'));
  if (directStatus) {
    return directStatus;
  }

  const ueventStatus = readSysfsUeventValue(dirPath, 'POWER_SUPPLY_STATUS');
  if (ueventStatus) {
    return ueventStatus;
  }

  const online = readText(path.join(dirPath, 'online'));
  if (online === '1') {
    return 'Charging';
  }

  return '';
}

function parseBatteryInfo(text = '') {
  const percentageMatch = text.match(/percentage:\s*([0-9]+)%/i);
  const stateMatch = text.match(/state:\s*([^\n\r]+)/i);
  const modelMatch = text.match(/model:\s*([^\n\r]+)/i);
  const vendorMatch = text.match(/vendor:\s*([^\n\r]+)/i);

  const percentage = percentageMatch ? Number.parseInt(percentageMatch[1], 10) : NaN;

  return {
    percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null,
    state: stateMatch ? stateMatch[1].trim() : '',
    model: modelMatch ? modelMatch[1].trim() : '',
    manufacturer: vendorMatch ? vendorMatch[1].trim() : '',
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

function humanizePowerSupplyName(deviceId = '') {
  const base = String(deviceId || '')
    .replace(/^hidpp_battery_/i, 'HIDPP ')
    .replace(/^battery_/i, '')
    .replace(/_/g, ' ')
    .trim();

  if (!base) {
    return 'Battery';
  }

  return base
    .split(' ')
    .filter(Boolean)
    .map((part) => (part.length <= 4 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function getDeviceLabel(deviceId, model = '', manufacturer = '') {
  const safeManufacturer = String(manufacturer || '').trim();
  const safeModel = String(model || '').trim();

  if (safeManufacturer && safeModel) {
    return `${safeManufacturer} ${safeModel}`.trim();
  }

  if (safeModel) {
    return safeModel;
  }

  if (String(deviceId || '').startsWith('/org/freedesktop/UPower/devices/')) {
    return humanizeDevicePath(deviceId);
  }

  return humanizePowerSupplyName(deviceId);
}

function scoreDevice(deviceId, label = '', manufacturer = '') {
  let score = 0;
  const id = String(deviceId || '').toLowerCase();
  const name = String(label || '').toLowerCase();
  const vendor = String(manufacturer || '').toLowerCase();

  if (id.includes('hidpp_battery')) score += 100;
  if (id.includes('mouse')) score += 30;
  if (name.includes('mouse')) score += 20;
  if (name.includes('logitech')) score += 15;
  if (vendor.includes('logitech')) score += 15;
  if (id.includes('battery_')) score += 10;

  return score;
}

function cloneBatterySample(sample, fromCache = false) {
  if (!sample) {
    return null;
  }

  return {
    ...sample,
    fromCache,
  };
}

function getCachedBatterySample(deviceId, maxAgeMs = SAMPLE_CACHE_MS) {
  const sample = lastBatterySamples.get(deviceId);

  if (!sample) {
    return null;
  }

  if ((Date.now() - sample.updatedAt) > maxAgeMs) {
    return null;
  }

  return cloneBatterySample(sample, true);
}

function getBestCachedBatterySample() {
  const samples = Array.from(lastBatterySamples.values())
    .filter((sample) => sample && (Date.now() - sample.updatedAt) <= SAMPLE_CACHE_MS)
    .sort((a, b) => scoreDevice(b.deviceId, b.label, b.manufacturer) - scoreDevice(a.deviceId, a.label, a.manufacturer));

  return samples.length > 0 ? cloneBatterySample(samples[0], true) : null;
}

function storeBatterySample(sample) {
  if (!sample || !sample.deviceId || !Number.isFinite(sample.percentage)) {
    return null;
  }

  const stored = {
    ...sample,
    updatedAt: Date.now(),
    fromCache: false,
  };

  lastBatterySamples.set(sample.deviceId, stored);
  return cloneBatterySample(stored, false);
}

function normalizeBatteryReading(deviceId, info = {}, previousSample = null) {
  const normalizedState = normalizeState(info.state || previousSample?.state || '');
  const manufacturer = String(info.manufacturer || previousSample?.manufacturer || '').trim();
  const model = String(info.model || previousSample?.model || '').trim();

  let percentage = Number.isFinite(info.percentage) ? Math.max(0, Math.min(100, info.percentage)) : null;

  if (percentage === null && previousSample) {
    percentage = previousSample.percentage;
  }

  if (
    percentage === 0 &&
    previousSample &&
    previousSample.percentage > 0 &&
    normalizedState !== 'EMPTY' &&
    (Date.now() - previousSample.updatedAt) <= TRANSIENT_ZERO_HOLD_MS
  ) {
    percentage = previousSample.percentage;
  }

  if (!Number.isFinite(percentage)) {
    return null;
  }

  return storeBatterySample({
    deviceId,
    percentage,
    state: normalizedState,
    model,
    manufacturer,
    label: getDeviceLabel(deviceId, model, manufacturer),
    source: info.source || previousSample?.source || 'unknown',
  });
}

function isSysfsBatteryDevice(deviceId) {
  const dir = path.join(SYSFS_POWER_SUPPLY_ROOT, deviceId);
  const type = readText(path.join(dir, 'type'));
  const scope = readText(path.join(dir, 'scope'));

  if (type !== 'Battery') {
    return false;
  }

  if (scope && scope !== 'Device') {
    return false;
  }

  return true;
}

function readSysfsBatteryDevice(deviceId) {
  const previousSample = getCachedBatterySample(deviceId);
  const dir = path.join(SYSFS_POWER_SUPPLY_ROOT, deviceId);

  if (!fileExists(dir)) {
    return previousSample;
  }

  const percentage = parseInteger(readText(path.join(dir, 'capacity')));
  const state = readSysfsBatteryState(dir);
  const model = readText(path.join(dir, 'model_name'));
  const manufacturer = readText(path.join(dir, 'manufacturer'));

  const normalized = normalizeBatteryReading(deviceId, {
    percentage,
    state,
    model,
    manufacturer,
    source: 'sysfs',
  }, previousSample);

  return normalized || previousSample;
}

function listSysfsBatteryDevices() {
  try {
    if (!fileExists(SYSFS_POWER_SUPPLY_ROOT)) {
      return [];
    }

    return fs.readdirSync(SYSFS_POWER_SUPPLY_ROOT)
      .filter((deviceId) => isSysfsBatteryDevice(deviceId))
      .map((deviceId) => {
        const info = readSysfsBatteryDevice(deviceId);
        return {
          id: deviceId,
          label: info?.label || getDeviceLabel(deviceId),
          model: info?.model || '',
          manufacturer: info?.manufacturer || '',
          percentage: info?.percentage ?? null,
          state: normalizeState(info?.state || ''),
          source: 'sysfs',
          fromCache: Boolean(info?.fromCache),
        };
      })
      .sort((a, b) => scoreDevice(b.id, b.label, b.manufacturer) - scoreDevice(a.id, a.label, a.manufacturer));
  } catch (error) {
    return [];
  }
}

async function readUpowerBatteryDevice(devicePath) {
  const previousSample = getCachedBatterySample(devicePath);
  const result = await runCommand(`upower -i ${shellEscape(devicePath)}`, 4000);

  if (result.error || !result.stdout) {
    return previousSample;
  }

  const info = parseBatteryInfo(result.stdout);
  const normalized = normalizeBatteryReading(devicePath, {
    ...info,
    source: 'upower',
  }, previousSample);

  return normalized || previousSample;
}

async function listUpowerBatteryDevices() {
  const result = await runCommand('upower -e', 3000);

  if (result.error || !result.stdout) {
    return [];
  }

  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes('/org/freedesktop/UPower/devices/battery_'));

  const devices = await Promise.all(paths.map(async (devicePath) => {
    const info = await readUpowerBatteryDevice(devicePath);

    return {
      id: devicePath,
      label: info?.label || getDeviceLabel(devicePath, info?.model, info?.manufacturer),
      model: info?.model || '',
      manufacturer: info?.manufacturer || '',
      percentage: info?.percentage ?? null,
      state: normalizeState(info?.state || ''),
      source: 'upower',
      fromCache: Boolean(info?.fromCache),
    };
  }));

  return devices.sort((a, b) => scoreDevice(b.id, b.label, b.manufacturer) - scoreDevice(a.id, a.label, a.manufacturer));
}

function mergeCachedDevices(devices) {
  const merged = [...devices];
  const knownIds = new Set(merged.map((entry) => entry.id));

  for (const sample of lastBatterySamples.values()) {
    if (!sample || !sample.deviceId) continue;
    if ((Date.now() - sample.updatedAt) > SAMPLE_CACHE_MS) continue;
    if (knownIds.has(sample.deviceId)) continue;

    merged.push({
      id: sample.deviceId,
      label: sample.label || getDeviceLabel(sample.deviceId, sample.model, sample.manufacturer),
      model: sample.model || '',
      manufacturer: sample.manufacturer || '',
      percentage: sample.percentage,
      state: normalizeState(sample.state),
      source: sample.source || 'cache',
      fromCache: true,
    });
    knownIds.add(sample.deviceId);
  }

  return merged.sort((a, b) => scoreDevice(b.id, b.label, b.manufacturer) - scoreDevice(a.id, a.label, a.manufacturer));
}

async function listBatteryDevices(force = false) {
  if (!force && cachedDevices.length > 0 && (Date.now() - lastDeviceScan) < DEVICE_CACHE_MS) {
    return cachedDevices;
  }

  lastDeviceScan = Date.now();

  const sysfsDevices = listSysfsBatteryDevices();
  if (sysfsDevices.length > 0) {
    cachedDevices = mergeCachedDevices(sysfsDevices);
    return cachedDevices;
  }

  const upowerDevices = await listUpowerBatteryDevices();
  cachedDevices = mergeCachedDevices(upowerDevices);
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
  const selected = String(selectedDevice || '').trim();
  let deviceId = await resolveBatteryDevice(selectedDevice, false);

  if (!deviceId) {
    const cached = selected && selected !== 'auto'
      ? getCachedBatterySample(selected)
      : getBestCachedBatterySample();

    if (!cached) {
      return { available: false };
    }

    return {
      available: true,
      percentage: cached.percentage,
      state: normalizeState(cached.state),
      label: cached.label || getDeviceLabel(cached.deviceId, cached.model, cached.manufacturer),
      model: cached.model || '',
      manufacturer: cached.manufacturer || '',
      path: cached.deviceId,
      fromCache: true,
      source: cached.source || 'cache',
    };
  }

  let info = null;

  if (deviceId.startsWith('/org/freedesktop/UPower/devices/')) {
    info = await readUpowerBatteryDevice(deviceId);
  } else {
    info = readSysfsBatteryDevice(deviceId);
  }

  if (selected === 'auto' && (!info || info.fromCache)) {
    const refreshedId = await resolveBatteryDevice('auto', true);

    if (refreshedId) {
      deviceId = refreshedId;
      info = refreshedId.startsWith('/org/freedesktop/UPower/devices/')
        ? await readUpowerBatteryDevice(refreshedId)
        : readSysfsBatteryDevice(refreshedId) || info;
    }
  }

  if (!info) {
    const cached = getCachedBatterySample(deviceId) || (selected === 'auto' ? getBestCachedBatterySample() : null);

    if (!cached) {
      return { available: false };
    }

    info = cached;
    deviceId = cached.deviceId;
  }

  const devices = await listBatteryDevices(false);
  const deviceMeta = devices.find((entry) => entry.id === deviceId);

  return {
    available: true,
    percentage: info.percentage,
    state: normalizeState(info.state),
    label: deviceMeta?.label || info.label || getDeviceLabel(deviceId, info.model, info.manufacturer),
    model: info.model || '',
    manufacturer: info.manufacturer || '',
    path: deviceId,
    fromCache: Boolean(info.fromCache),
    source: info.source || deviceMeta?.source || 'unknown',
  };
}

module.exports = {
  listBatteryDevices,
  getMouseBattery,
};
