const state = require('../state');
const { shellEscape, runCommand } = require('../utils');
const { DEFAULT_SETTINGS } = require('../constants');

function getPingState(context) {
  if (!state.pingStates[context]) {
    state.pingStates[context] = {
      lastPing: 0,
      failedPings: 0,
      lastPingTime: 0,
      target: '',
    };
  }

  return state.pingStates[context];
}

async function getPing(context, host, force = false) {
  const pingState = getPingState(context);
  const target = String(host || DEFAULT_SETTINGS.pingHost).trim() || DEFAULT_SETTINGS.pingHost;

  if (pingState.target !== target) {
    pingState.target = target;
    pingState.lastPing = 0;
    pingState.failedPings = 0;
    pingState.lastPingTime = 0;
  }

  const result = await runCommand(`LC_ALL=C ping -c 1 -W 2 ${shellEscape(target)}`, 4000);

  if (result.error || !result.stdout) {
    pingState.failedPings += 1;
    if (pingState.failedPings > 3 || force) pingState.lastPing = 0;
    return pingState.lastPing;
  }

  pingState.failedPings = 0;
  const match = result.stdout.match(/(?:time|Zeit)=([0-9]+(?:[.,][0-9]+)?)/i);

  if (match) {
    const milliseconds = Number.parseFloat(String(match[1]).replace(',', '.'));
    if (Number.isFinite(milliseconds)) {
      pingState.lastPing = milliseconds > 0 && milliseconds < 1 ? 1 : Math.round(milliseconds);
    }
  }

  return pingState.lastPing;
}

module.exports = {
  getPingState,
  getPing,
};
