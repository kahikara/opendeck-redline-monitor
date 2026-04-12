const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const state = require('../state');
const { fileExists, readText, warnOnce } = require('../utils');

function unavailableGpuStats() {
  return {
    available: false,
    temp: 0,
    power: 0,
    usage: 0,
    vramUsed: 0,
    vramTotal: 0,
  };
}

function getPciBusIdFromHwmonDir(gpuDir) {
  try {
    const devicePath = fs.realpathSync(path.join(gpuDir, 'device'));
    const maybePciBusId = path.basename(devicePath);
    return /^\d{4}:\d{2}:\d{2}\.\d$/.test(maybePciBusId) ? maybePciBusId : '';
  } catch (error) {
    return '';
  }
}

function scanAmdGpuDirs() {
  try {
    const hwmonRoot = '/sys/class/hwmon';
    const dirs = fs.readdirSync(hwmonRoot);
    const matches = [];

    for (const dir of dirs) {
      const fullPath = path.join(hwmonRoot, dir);
      const namePath = path.join(fullPath, 'name');

      if (!fileExists(namePath)) continue;
      if (readText(namePath) === 'amdgpu') {
        matches.push(fullPath);
      }
    }

    return matches;
  } catch (error) {
    warnOnce('amdgpu-scan-failed', `amdgpu scan failed: ${error.message}`);
    return [];
  }
}

function getAmdGpuEntries(force = false) {
  const scanned = scanAmdGpuDirs();
  let ordered = scanned;

  if (!force && state.amdgpuDirCache && fileExists(path.join(state.amdgpuDirCache, 'name')) && scanned.includes(state.amdgpuDirCache)) {
    ordered = [state.amdgpuDirCache, ...scanned.filter((dir) => dir !== state.amdgpuDirCache)];
  }

  state.amdgpuDirCache = ordered[0] || null;

  return ordered.map((gpuDir, index) => {
    const pciBusId = getPciBusIdFromHwmonDir(gpuDir);
    const id = `amd:${pciBusId || index}`;

    return {
      kind: 'amd',
      id,
      legacyId: `amd:${index}`,
      pciBusId,
      gpuDir,
      label: `AMD GPU ${index + 1}${pciBusId ? ` (${pciBusId})` : ''}`,
    };
  });
}

function findAmdGpuDir(force = false) {
  if (state.amdgpuDirCache && !force && fileExists(path.join(state.amdgpuDirCache, 'name'))) {
    return state.amdgpuDirCache;
  }

  const entries = getAmdGpuEntries(force);
  return entries[0]?.gpuDir || null;
}

function getAmdGpuStatsFromDir(gpuDir) {
  if (!gpuDir) {
    return unavailableGpuStats();
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
    state.amdgpuDirCache = null;
    warnOnce('amdgpu-read-failed', `amdgpu read failed: ${error.message}`);
    return unavailableGpuStats();
  }
}

function getAmdGpuStats() {
  return getAmdGpuStatsFromDir(findAmdGpuDir());
}

function getAmdGpuStatsBySelector(selector) {
  const entry = getAmdGpuEntries().find((candidate) => selector === candidate.id || selector === candidate.legacyId);
  return entry ? getAmdGpuStatsFromDir(entry.gpuDir) : unavailableGpuStats();
}

function parseNvidiaCsvNumber(value) {
  const numeric = Number.parseFloat(String(value || '').trim());
  return Number.isFinite(numeric) ? numeric : 0;
}

function runNvidiaQuery(fields) {
  return execFileSync(
    'nvidia-smi',
    [
      `--query-gpu=${fields.join(',')}`,
      '--format=csv,noheader,nounits',
    ],
    { encoding: 'utf8', timeout: 1500 }
  ).trim();
}

function parseNvidiaCsvLine(line) {
  return String(line || '').split(',').map((part) => part.trim());
}

function getNvidiaGpuStatsFromValues(usageRaw, tempRaw, vramUsedRaw, vramTotalRaw, powerRaw) {
  return {
    available: true,
    temp: Math.round(parseNvidiaCsvNumber(tempRaw)),
    power: Math.round(parseNvidiaCsvNumber(powerRaw)),
    usage: Math.round(parseNvidiaCsvNumber(usageRaw)),
    vramUsed: Math.round(parseNvidiaCsvNumber(vramUsedRaw) * 1024 * 1024),
    vramTotal: Math.round(parseNvidiaCsvNumber(vramTotalRaw) * 1024 * 1024),
  };
}

function getNvidiaGpuEntries() {
  try {
    const output = runNvidiaQuery(['index', 'pci.bus_id', 'name']);

    if (!output) {
      return [];
    }

    return output
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, position) => {
        const [indexRaw, pciBusIdRaw, nameRaw] = parseNvidiaCsvLine(line);
        const index = String(indexRaw || position).trim();
        const pciBusId = String(pciBusIdRaw || '').trim();
        const name = nameRaw || `GPU ${position + 1}`;

        return {
          kind: 'nvidia',
          id: `nvidia:${pciBusId || index}`,
          legacyId: `nvidia:${index}`,
          index,
          pciBusId,
          label: `NVIDIA ${name}${pciBusId ? ` (${pciBusId})` : ''}`,
        };
      });
  } catch (error) {
    warnOnce('nvidia-smi-scan-failed', `nvidia-smi scan failed: ${error.message}`);
    return [];
  }
}

function getNvidiaGpuStats() {
  try {
    const output = runNvidiaQuery(['utilization.gpu', 'temperature.gpu', 'memory.used', 'memory.total', 'power.draw']);

    if (!output) {
      return unavailableGpuStats();
    }

    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) {
      return unavailableGpuStats();
    }

    const [usageRaw, tempRaw, vramUsedRaw, vramTotalRaw, powerRaw] = parseNvidiaCsvLine(firstLine);
    return getNvidiaGpuStatsFromValues(usageRaw, tempRaw, vramUsedRaw, vramTotalRaw, powerRaw);
  } catch (error) {
    warnOnce('nvidia-smi-read-failed', `nvidia-smi read failed: ${error.message}`);
    return unavailableGpuStats();
  }
}

function getNvidiaGpuStatsBySelector(selector) {
  try {
    const output = runNvidiaQuery(['index', 'pci.bus_id', 'utilization.gpu', 'temperature.gpu', 'memory.used', 'memory.total', 'power.draw']);

    if (!output) {
      return unavailableGpuStats();
    }

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;

      const [indexRaw, pciBusIdRaw, usageRaw, tempRaw, vramUsedRaw, vramTotalRaw, powerRaw] = parseNvidiaCsvLine(line);
      const index = String(indexRaw || '').trim();
      const pciBusId = String(pciBusIdRaw || '').trim();

      if (selector === `nvidia:${pciBusId}` || selector === `nvidia:${index}`) {
        return getNvidiaGpuStatsFromValues(usageRaw, tempRaw, vramUsedRaw, vramTotalRaw, powerRaw);
      }
    }

    return unavailableGpuStats();
  } catch (error) {
    warnOnce('nvidia-smi-read-failed', `nvidia-smi read failed: ${error.message}`);
    return unavailableGpuStats();
  }
}

function listAvailableGpus() {
  return [
    ...getAmdGpuEntries(),
    ...getNvidiaGpuEntries(),
  ].map(({ id, label }) => ({ id, label }));
}

function getGpuStats(selector = 'auto') {
  const normalizedSelector = typeof selector === 'string' ? selector.trim() : '';

  if (!normalizedSelector || normalizedSelector === 'auto') {
    const amdStats = getAmdGpuStats();
    if (amdStats.available) {
      return amdStats;
    }

    return getNvidiaGpuStats();
  }

  if (normalizedSelector.startsWith('amd:')) {
    return getAmdGpuStatsBySelector(normalizedSelector);
  }

  if (normalizedSelector.startsWith('nvidia:')) {
    return getNvidiaGpuStatsBySelector(normalizedSelector);
  }

  return getGpuStats('auto');
}

module.exports = {
  getAmdGpuStats,
  getGpuStats,
  listAvailableGpus,
};
