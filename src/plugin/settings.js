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

  if (settings.pageSlot !== undefined) {
    normalized.pageSlot = clamp(Number.parseInt(settings.pageSlot, 10) || DEFAULT_SETTINGS.pageSlot, 1, 4);
  }

  return normalized;
}

function normalizePageName(value, fallback) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().slice(0, 16);
  }
  return fallback;
}

function normalizePluginWideSettings(settings = {}) {
  const refresh = Number.parseInt(settings.refreshRate, 10);
  const pageCount = clamp(Number.parseInt(settings.pageCount, 10) || DEFAULT_SETTINGS.pageCount, 1, 4);

  return {
    refreshRate: [1, 3, 5, 10].includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshRate,
    pageCount,
    pageName1: normalizePageName(settings.pageName1, DEFAULT_SETTINGS.pageName1),
    pageName2: normalizePageName(settings.pageName2, DEFAULT_SETTINGS.pageName2),
    pageName3: normalizePageName(settings.pageName3, DEFAULT_SETTINGS.pageName3),
    pageName4: normalizePageName(settings.pageName4, DEFAULT_SETTINGS.pageName4),
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
    hasOwn(settings, 'pageCount') ||
    hasOwn(settings, 'pageName1') ||
    hasOwn(settings, 'pageName2') ||
    hasOwn(settings, 'pageName3') ||
    hasOwn(settings, 'pageName4')
  ) {
    state.globalPluginSettings = normalizePluginWideSettings({
      ...state.globalPluginSettings,
      refreshRate: hasOwn(settings, 'refreshRate') ? settings.refreshRate : state.globalPluginSettings.refreshRate,
      pageCount: hasOwn(settings, 'pageCount') ? settings.pageCount : state.globalPluginSettings.pageCount,
      pageName1: hasOwn(settings, 'pageName1') ? settings.pageName1 : state.globalPluginSettings.pageName1,
      pageName2: hasOwn(settings, 'pageName2') ? settings.pageName2 : state.globalPluginSettings.pageName2,
      pageName3: hasOwn(settings, 'pageName3') ? settings.pageName3 : state.globalPluginSettings.pageName3,
      pageName4: hasOwn(settings, 'pageName4') ? settings.pageName4 : state.globalPluginSettings.pageName4,
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
