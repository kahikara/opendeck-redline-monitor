const os = require('os');
const state = require('../state');
const { clamp } = require('../utils');

const coreCount = Math.max(1, os.cpus().length);

function getShortProcName(name) {
  const cleaned = String(name || '')
    .split(/[\/\\\\]/)
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
  const cached = state.topProcessCache[cacheKey];
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
    if (cached && cached.name && (now - cached.timestamp) <= 12000) {
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
    state.topProcessCache[cacheKey] = {
      name: result.name,
      cpu: result.cpu,
      timestamp: now,
    };
    return result;
  }

  return useCached();
}

module.exports = {
  getTopProcessSummary,
};
