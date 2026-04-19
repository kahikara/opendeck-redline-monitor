const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileExists, readText, warnOnce } = require('../utils');

function unavailableFanStats() {
  return {
    available: false,
    id: '',
    source: '',
    chip: '',
    label: '',
    displayName: '',
    rpm: null,
    percent: null,
    pwmRaw: null,
    pwmEnable: null,
    isGpu: false,
  };
}

function readOptionalText(filePath) {
  try {
    return fileExists(filePath) ? readText(filePath) : '';
  } catch (error) {
    return '';
  }
}

function readOptionalInt(filePath) {
  const value = Number.parseInt(readOptionalText(filePath), 10);
  return Number.isFinite(value) ? value : null;
}

function normalizePercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (value >= 0 && value <= 100) {
    return value;
  }

  if (value >= 0 && value <= 255) {
    return Math.round((value / 255) * 100);
  }

  return null;
}

function getHwmonDeviceKey(hwmonDir) {
  try {
    return path.basename(fs.realpathSync(path.join(hwmonDir, 'device')));
  } catch (error) {
    return path.basename(hwmonDir);
  }
}

function buildHwmonDisplayName(chip, fanKey, label = '') {
  const cleanLabel = String(label || '').trim();
  if (cleanLabel) {
    return cleanLabel;
  }

  if (chip === 'amdgpu') {
    return 'AMD GPU Fan';
  }

  const fanNumber = Number.parseInt(String(fanKey || '').replace(/^fan/i, ''), 10);
  if (Number.isFinite(fanNumber)) {
    return `System Fan ${fanNumber}`;
  }

  return 'System Fan';
}

function scoreFan(entry = {}) {
  const name = String(entry.displayName || '').toLowerCase();
  const rpm = Number.isFinite(entry.rpm) ? entry.rpm : null;
  const hasRpm = rpm !== null && rpm > 0;
  let score = 0;

  if (/cpu/.test(name) && hasRpm) score += 500;
  if (/pump/.test(name) && hasRpm) score += 440;
  if (/rear|front|case|chassis|system/.test(name) && hasRpm) score += 260;
  if (!entry.isGpu && hasRpm) score += 220;
  if (entry.isGpu && hasRpm) score += 180;
  if (entry.label) score += 80;
  if (hasRpm) score += 60;
  if (Number.isFinite(entry.percent)) score += 20;

  if (rpm === 0) score -= 500;

  return score;
}

function sortFans(list = []) {
  return [...list].sort((a, b) => {
    const byScore = scoreFan(b) - scoreFan(a);
    if (byScore !== 0) {
      return byScore;
    }

    return `${a.source}:${a.displayName}:${a.id}`.localeCompare(`${b.source}:${b.displayName}:${b.id}`);
  });
}

function isRunningFan(entry = {}) {
  return Number.isFinite(entry.rpm) && entry.rpm > 0;
}

function isLikelyPrimarySystemFan(entry = {}) {
  const name = String(entry.displayName || '').toLowerCase();
  return !entry.isGpu && (/cpu|pump|rear|front|case|chassis|system/.test(name) || !!entry.label);
}

function getAutoFanCandidates(fans = []) {
  const sorted = sortFans(fans);

  const primaryRunningSystem = sorted.filter((entry) => isLikelyPrimarySystemFan(entry) && isRunningFan(entry));
  if (primaryRunningSystem.length > 0) {
    return primaryRunningSystem;
  }

  const anyRunningSystem = sorted.filter((entry) => !entry.isGpu && isRunningFan(entry));
  if (anyRunningSystem.length > 0) {
    return anyRunningSystem;
  }

  const runningGpu = sorted.filter((entry) => entry.isGpu && isRunningFan(entry));
  if (runningGpu.length > 0) {
    return runningGpu;
  }

  const anySystem = sorted.filter((entry) => !entry.isGpu);
  if (anySystem.length > 0) {
    return anySystem;
  }

  return sorted;
}

function scanHwmonFans() {
  const root = '/sys/class/hwmon';

  if (!fileExists(root)) {
    return [];
  }

  try {
    const result = [];

    for (const dirName of fs.readdirSync(root).sort()) {
      const hwmonDir = path.join(root, dirName);
      const chip = readOptionalText(path.join(hwmonDir, 'name')) || dirName;

      for (const entryName of fs.readdirSync(hwmonDir).sort()) {
        const match = entryName.match(/^(fan\d+)_input$/);
        if (!match) {
          continue;
        }

        const fanKey = match[1];
        const rpm = readOptionalInt(path.join(hwmonDir, `${fanKey}_input`));
        const label = readOptionalText(path.join(hwmonDir, `${fanKey}_label`));
        const pwmKey = fanKey.replace('fan', 'pwm');
        const pwmRaw = readOptionalInt(path.join(hwmonDir, pwmKey));
        const pwmEnable = readOptionalInt(path.join(hwmonDir, `${pwmKey}_enable`));
        const deviceKey = getHwmonDeviceKey(hwmonDir);

        result.push({
          available: Number.isFinite(rpm) || Number.isFinite(pwmRaw),
          id: `hwmon:${chip}:${deviceKey}:${fanKey}`,
          source: 'hwmon',
          chip,
          label,
          displayName: buildHwmonDisplayName(chip, fanKey, label),
          rpm: Number.isFinite(rpm) ? rpm : null,
          percent: normalizePercent(pwmRaw),
          pwmRaw: Number.isFinite(pwmRaw) ? pwmRaw : null,
          pwmEnable: Number.isFinite(pwmEnable) ? pwmEnable : null,
          isGpu: chip === 'amdgpu',
        });
      }
    }

    return sortFans(result);
  } catch (error) {
    warnOnce('fans-hwmon-scan-failed', `fan hwmon scan failed: ${error.message}`);
    return [];
  }
}

function parseCsvLine(line = '') {
  return String(line).split(',').map((part) => part.trim());
}

function scanNvidiaFans() {
  try {
    const output = execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,pci.bus_id,name,fan.speed', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 1500 }
    ).trim();

    if (!output) {
      return [];
    }

    return sortFans(
      output
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, position) => {
          const [indexRaw, pciBusIdRaw, nameRaw, fanPercentRaw] = parseCsvLine(line);
          const index = String(indexRaw || position).trim();
          const pciBusId = String(pciBusIdRaw || '').trim();
          const fanPercent = Number.parseInt(fanPercentRaw, 10);

          return {
            available: Number.isFinite(fanPercent),
            id: `nvidia:${pciBusId || index}:fan`,
            source: 'nvidia-smi',
            chip: 'nvidia',
            label: '',
            displayName: `NVIDIA ${String(nameRaw || `GPU ${position + 1}`).trim()}`.trim(),
            rpm: null,
            percent: Number.isFinite(fanPercent) ? fanPercent : null,
            pwmRaw: null,
            pwmEnable: null,
            isGpu: true,
          };
        })
    );
  } catch (error) {
    if (!/ENOENT/.test(String(error && error.message || ''))) {
      warnOnce('fans-nvidia-scan-failed', `nvidia fan scan failed: ${error.message}`);
    }
    return [];
  }
}

function listAvailableFans() {
  return sortFans([
    ...scanHwmonFans(),
    ...scanNvidiaFans(),
  ]);
}

function getFanStats(selector = 'auto') {
  const fans = listAvailableFans();

  if (fans.length === 0) {
    return unavailableFanStats();
  }

  const normalizedSelector = String(selector || '').trim();
  const selectedFan = !normalizedSelector || normalizedSelector === 'auto'
    ? getAutoFanCandidates(fans)[0]
    : fans.find((entry) => entry.id === normalizedSelector);

  return selectedFan || unavailableFanStats();
}

module.exports = {
  listAvailableFans,
  getFanStats,
};
