const state = require('./state');
const { DEFAULT_SETTINGS } = require('./constants');
const { clamp } = require('./utils');

function normalizeSettings(settings = {}) {
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...state.globalPluginSettings,
  };

  if (typeof settings.pingHost === 'string' && settings.pingHost.trim()) {
    normalized.pingHost = settings.pingHost.trim();
  }

  if (typeof settings.networkInterface === 'string') {
    normalized.networkInterface = settings.networkInterface.trim();
  }

  if (settings.volumeStep !== undefined) {
    normalized.volumeStep = clamp(Number.parseInt(settings.volumeStep, 10) || DEFAULT_SETTINGS.volumeStep, 1, 20);
  }

  if (settings.brightnessStep !== undefined) {
    normalized.brightnessStep = clamp(Number.parseInt(settings.brightnessStep, 10) || DEFAULT_SETTINGS.brightnessStep, 1, 25);
  }

  if (settings.timerStep !== undefined) {
    normalized.timerStep = clamp(Number.parseInt(settings.timerStep, 10) || DEFAULT_SETTINGS.timerStep, 1, 60);
  }

  if (settings.topMode === 'raw' || settings.topMode === 'grouped') {
    normalized.topMode = settings.topMode;
  }

  const refresh = Number.parseInt(settings.refreshRate, 10);
  normalized.refreshRate = [1, 3, 5, 10].includes(refresh) ? refresh : (state.globalPluginSettings.refreshRate || DEFAULT_SETTINGS.refreshRate);

  return normalized;
}

function storeSettingsForContext(context, settings = {}) {
  const before = getPluginWideSettings().refreshRate;
  const normalized = normalizeSettings(settings);

  if (context) {
    state.contextSettings[context] = normalized;
  }

  state.globalPluginSettings = {
    ...state.globalPluginSettings,
    ...normalized,
  };

  return before !== getPluginWideSettings().refreshRate;
}

function getSettingsForContext(context) {
  return normalizeSettings(state.contextSettings[context] || {});
}

function getPluginWideSettings() {
  return normalizeSettings(state.globalPluginSettings || {});
}

function getResolvedAction(context, fallbackAction = '') {
  return state.activeContexts[context]?.action || fallbackAction || '';
}

module.exports = {
  normalizeSettings,
  storeSettingsForContext,
  getSettingsForContext,
  getPluginWideSettings,
  getResolvedAction,
};
