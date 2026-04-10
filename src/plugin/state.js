const { DEFAULT_SETTINGS } = require('./constants');

module.exports = {
  activeContexts: Object.create(null),
  activeTimers: Object.create(null),
  lastSentImages: Object.create(null),
  transientImageTimers: Object.create(null),
  contextSettings: Object.create(null),
  pingStates: Object.create(null),

  globalPluginSettings: { ...DEFAULT_SETTINGS },

  pollingInterval: null,
  timerInterval: null,
  pollingInProgress: false,
  currentPollingRateMs: 0,
  ddcutilTimeout: null,
  shuttingDown: false,

  monitorBrightness: 50,
  monitorBrightnessAvailable: false,
  lastBrightnessSync: 0,
  activePageIndex: 0,

  amdgpuDirCache: null,
  cpuPowerSourceCache: {
    timestamp: 0,
    sources: [],
  },
  cpuPowerSampleCache: Object.create(null),

  procCache: { timestamp: 0, data: { list: [] } },
  topProcessCache: {
    grouped: { name: '', cpu: 0, timestamp: 0 },
    raw: { name: '', cpu: 0, timestamp: 0 },
  },
  networkCache: { timestamp: 0, iface: null },

  toolCache: new Map(),
  warnedKeys: new Set(),
};
