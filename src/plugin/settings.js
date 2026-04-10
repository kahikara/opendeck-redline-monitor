const state = require('./state');
const { DEFAULT_SETTINGS } = require('./constants');
const { clamp } = require('./utils');

function hasOwn(settings, key) {
  return Object.prototype.hasOwnProperty.call(settings, key);
}

function normalizeSettings(settings = {}) {
  const normalized = {
    ...DEFAULT_SETTINGS,
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
  normalized.refreshRate = [1, 3, 5, 10].includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshRate;

  if (settings.pressAction === 'command' || settings.pressAction === 'default') {
    normalized.pressAction = settings.pressAction;
  }

  if (typeof settings.pressCommand === 'string') {
    normalized.pressCommand = settings.pressCommand.trim();
  }

  return normalized;
}


function normalizePluginWideSettings(settings = {}) {
  const refresh = Number.parseInt(settings.refreshRate, 10);
  return {
    refreshRate: [1, 3, 5, 10].includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshRate,
  };
}

function storeSettingsForContext(context, settings = {}) {
  const before = getPluginWideSettings().refreshRate;
  const currentSettings = context ? (state.contextSettings[context] || {}) : {};
  const normalized = normalizeSettings({
    ...currentSettings,
    ...settings,
  });

  if (context) {
    state.contextSettings[context] = normalized;
  }

  if (
    hasOwn(settings, 'refreshRate') ||
  ) {
    state.globalPluginSettings = normalizePluginWideSettings({
      ...state.globalPluginSettings,
      refreshRate: hasOwn(settings, 'refreshRate') ? settings.refreshRate : state.globalPluginSettings.refreshRate,
    });
  }

  return before !== getPluginWideSettings().refreshRate;
}

function getSettingsForContext(context) {
  return normalizeSettings(state.contextSettings[context] || {});
}

function getPluginWideSettings() {
  return normalizePluginWideSettings(state.globalPluginSettings || {});
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
