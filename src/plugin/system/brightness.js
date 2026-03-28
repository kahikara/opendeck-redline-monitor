const state = require('../state');
const { BRIGHTNESS_REFRESH_MS } = require('../constants');
const { commandExists, runCommand, clamp, warnOnce } = require('../utils');

async function refreshMonitorBrightness(force = false) {
  const now = Date.now();

  if (!force && (now - state.lastBrightnessSync) < BRIGHTNESS_REFRESH_MS) {
    return state.monitorBrightnessAvailable;
  }

  state.lastBrightnessSync = now;

  if (!(await commandExists('ddcutil'))) {
    return state.monitorBrightnessAvailable;
  }

  const result = await runCommand('ddcutil getvcp 10 --brief', 2500);
  const match =
    result.stdout.match(/current value =\s*([0-9]+)/i) ||
    result.stdout.match(/current value:\s*([0-9]+)/i) ||
    result.stdout.match(/C\s+([0-9]+)/);

  if (match) {
    state.monitorBrightness = clamp(Number.parseInt(match[1], 10) || 50, 0, 100);
    state.monitorBrightnessAvailable = true;
    return true;
  }

  warnOnce('ddcutil-brightness-read-failed', 'ddcutil brightness read failed');
  return state.monitorBrightnessAvailable;
}

async function setMonitorBrightness(value) {
  state.monitorBrightness = clamp(value, 0, 100);

  if (!(await commandExists('ddcutil'))) {
    return false;
  }

  state.monitorBrightnessAvailable = true;

  clearTimeout(state.ddcutilTimeout);
  state.ddcutilTimeout = setTimeout(() => {
    runCommand(`ddcutil setvcp 10 ${state.monitorBrightness} --noverify`, 2500).catch(() => {});
  }, 300);

  return true;
}

function getBrightnessState() {
  return {
    monitorBrightness: state.monitorBrightness,
    monitorBrightnessAvailable: state.monitorBrightnessAvailable,
  };
}

module.exports = {
  refreshMonitorBrightness,
  setMonitorBrightness,
  getBrightnessState,
};
