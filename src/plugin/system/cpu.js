const fs = require('fs');
const path = require('path');
const state = require('../state');
const { CPU_POWER_SOURCE_CACHE_MS } = require('../constants');
const { fileExists, readText, warnOnce } = require('../utils');

function scanCpuPowerSources(force = false) {
  const now = Date.now();

  if (!force && (now - state.cpuPowerSourceCache.timestamp) < CPU_POWER_SOURCE_CACHE_MS && state.cpuPowerSourceCache.sources.length > 0) {
    return state.cpuPowerSourceCache.sources;
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

        const labelPath = path.join(
          fullPath,
          entry.replace(/_average$/, '_label').replace(/_input$/, '_label')
        );

        sources.push({
          name,
          type,
          path: entryPath,
          file: entry,
          label: fileExists(labelPath) ? readText(labelPath) : '',
        });
      }
    }
  } catch (error) {
    warnOnce('cpu-power-scan-failed', `cpu power scan failed: ${error.message}`);
  }

  state.cpuPowerSourceCache = {
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
      const sample = state.cpuPowerSampleCache[source.path] || {
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
      state.cpuPowerSampleCache[source.path] = sample;

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

  const rounded = best.watts < 10
    ? Math.round(best.watts * 10) / 10
    : Math.round(best.watts);

  return { available: true, watts: rounded };
}

module.exports = {
  getCpuPower,
};
