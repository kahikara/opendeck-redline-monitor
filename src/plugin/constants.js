const PLUGIN_PREFIX = 'com.kahikara.opendeck-redline';

const ACTIONS = Object.freeze({
  cpu: `${PLUGIN_PREFIX}.cpu`,
  gpu: `${PLUGIN_PREFIX}.gpu`,
  ram: `${PLUGIN_PREFIX}.ram`,
  vram: `${PLUGIN_PREFIX}.vram`,
  net: `${PLUGIN_PREFIX}.net`,
  disk: `${PLUGIN_PREFIX}.disk`,
  ping: `${PLUGIN_PREFIX}.ping`,
  top: `${PLUGIN_PREFIX}.top`,
  time: `${PLUGIN_PREFIX}.time`,
  audio: `${PLUGIN_PREFIX}.audio`,
  timer: `${PLUGIN_PREFIX}.timer`,
  monbright: `${PLUGIN_PREFIX}.monbright`,
});

const DEFAULT_SETTINGS = Object.freeze({
  pingHost: '1.1.1.1',
  networkInterface: '',
  volumeStep: 2,
  brightnessStep: 5,
  timerStep: 1,
  topMode: 'grouped',
  refreshRate: 3,
  pressAction: 'default',
  pressCommand: '',
});

const POLL_INTERVAL_MS = 2000;
const TOP_REFRESH_MS = 4000;
const NETWORK_CACHE_MS = 10000;
const BRIGHTNESS_REFRESH_MS = 15000;
const CPU_POWER_SOURCE_CACHE_MS = 10000;
const TRANSIENT_IMAGE_MS = 1250;

const NETWORK_EXCLUDED_PREFIXES = ['lo', 'docker', 'br-', 'veth', 'virbr', 'vmnet', 'vboxnet', 'tailscale', 'zt', 'tun', 'tap', 'wg'];
const NETWORK_PREFERRED_PREFIXES = ['en', 'eth', 'wl', 'wlan', 'ww', 'usb'];

module.exports = {
  PLUGIN_PREFIX,
  ACTIONS,
  DEFAULT_SETTINGS,
  POLL_INTERVAL_MS,
  TOP_REFRESH_MS,
  NETWORK_CACHE_MS,
  BRIGHTNESS_REFRESH_MS,
  CPU_POWER_SOURCE_CACHE_MS,
  TRANSIENT_IMAGE_MS,
  NETWORK_EXCLUDED_PREFIXES,
  NETWORK_PREFERRED_PREFIXES,
};
