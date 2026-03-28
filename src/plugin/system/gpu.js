const path = require('path');
const state = require('../state');
const { fileExists, readText, warnOnce } = require('../utils');

function findAmdGpuDir(force = false) {
  if (state.amdgpuDirCache && !force && fileExists(path.join(state.amdgpuDirCache, 'name'))) {
    return state.amdgpuDirCache;
  }

  state.amdgpuDirCache = null;

  try {
    const hwmonRoot = '/sys/class/hwmon';
    const dirs = require('fs').readdirSync(hwmonRoot);

    for (const dir of dirs) {
      const fullPath = path.join(hwmonRoot, dir);
      const namePath = path.join(fullPath, 'name');

      if (!fileExists(namePath)) continue;
      if (readText(namePath) === 'amdgpu') {
        state.amdgpuDirCache = fullPath;
        return state.amdgpuDirCache;
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
    state.amdgpuDirCache = null;
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

module.exports = {
  getAmdGpuStats,
};
