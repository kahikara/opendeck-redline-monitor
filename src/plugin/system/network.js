const si = require('systeminformation');
const state = require('../state');
const {
  NETWORK_CACHE_MS,
  NETWORK_EXCLUDED_PREFIXES,
  NETWORK_PREFERRED_PREFIXES,
} = require('../constants');
const { warnOnce } = require('../utils');

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

async function detectActiveInterface(force = false) {
  const now = Date.now();

  if (!force && state.networkCache.iface && (now - state.networkCache.timestamp) < NETWORK_CACHE_MS) {
    return state.networkCache.iface;
  }

  state.networkCache = { timestamp: now, iface: null };

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

    state.networkCache.iface = preferred ? preferred.iface : null;
    return state.networkCache.iface;
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

module.exports = {
  getNetworkStats,
};
