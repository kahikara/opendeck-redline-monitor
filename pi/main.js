(() => {
  const $ = (id) => document.getElementById(id);

  const fields = {
    pingHost: $('pingHost'),
    networkInterface: $('networkInterface'),
    gpuSelector: $('gpuSelector'),
    batteryDevice: $('batteryDevice'),
    volumeStep: $('volumeStep'),
    brightnessStep: $('brightnessStep'),
    timerStep: $('timerStep'),
    topMode: $('topMode'),
    refreshRate: $('refreshRate'),
    pressAction: $('pressAction'),
    pressCommand: $('pressCommand'),
  };

  const pressCommandWrap = $('pressCommandWrap');
  const gpuSelectorWrap = $('gpuSelectorWrap');
  const batterySelectorWrap = $('batterySelectorWrap');
  const saveButton = $('saveButton');
  const statusText = $('statusText');

  let websocket = null;
  let uuid = null;
  let actionInfo = null;
  let actionContext = null;
  let currentGpuOptions = [];
  let currentBatteryOptions = [];

  const DEFAULT_SETTINGS = Object.freeze({
    pingHost: '1.1.1.1',
    networkInterface: '',
    gpuSelector: 'auto',
    batteryDevice: 'auto',
    volumeStep: 2,
    brightnessStep: 5,
    timerStep: 1,
    topMode: 'grouped',
    refreshRate: 3,
    pressAction: 'default',
    pressCommand: '',
  });

  function setStatus(text) {
    statusText.textContent = text;
  }

  function actionUsesGpuSelector() {
    const actionId = actionInfo?.action || '';
    return actionId.endsWith('.gpu') || actionId.endsWith('.vram');
  }

  function actionUsesBatterySelector() {
    const actionId = actionInfo?.action || '';
    return actionId.endsWith('.battery');
  }

  function updateGpuSelectorVisibility() {
    gpuSelectorWrap.classList.toggle('hidden', !actionUsesGpuSelector());
  }

  function updateBatterySelectorVisibility() {
    batterySelectorWrap.classList.toggle('hidden', !actionUsesBatterySelector());
  }

  function renderGpuOptions(options = [], selectedValue = DEFAULT_SETTINGS.gpuSelector) {
    const merged = [{ id: DEFAULT_SETTINGS.gpuSelector, label: 'Auto' }];

    if (Array.isArray(options)) {
      for (const option of options) {
        const id = typeof option?.id === 'string' ? option.id.trim() : '';
        if (!id || merged.some((entry) => entry.id === id)) {
          continue;
        }

        const label = typeof option?.label === 'string' && option.label.trim() ? option.label.trim() : id;
        merged.push({ id, label });
      }
    }

    const desiredValue = String(selectedValue || DEFAULT_SETTINGS.gpuSelector).trim() || DEFAULT_SETTINGS.gpuSelector;
    if (!merged.some((entry) => entry.id === desiredValue)) {
      merged.push({ id: desiredValue, label: `${desiredValue} (missing)` });
    }

    fields.gpuSelector.innerHTML = '';

    for (const option of merged) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      fields.gpuSelector.appendChild(node);
    }

    fields.gpuSelector.value = desiredValue;
  }

  function renderBatteryOptions(options = [], selectedValue = DEFAULT_SETTINGS.batteryDevice) {
    const merged = [{ id: DEFAULT_SETTINGS.batteryDevice, label: 'Auto' }];

    if (Array.isArray(options)) {
      for (const option of options) {
        const id = typeof option?.id === 'string' ? option.id.trim() : '';
        if (!id || merged.some((entry) => entry.id === id)) {
          continue;
        }

        const label = typeof option?.label === 'string' && option.label.trim() ? option.label.trim() : id;
        merged.push({ id, label });
      }
    }

    const desiredValue = String(selectedValue || DEFAULT_SETTINGS.batteryDevice).trim() || DEFAULT_SETTINGS.batteryDevice;
    if (!merged.some((entry) => entry.id === desiredValue)) {
      merged.push({ id: desiredValue, label: `${desiredValue} (missing)` });
    }

    fields.batteryDevice.innerHTML = '';

    for (const option of merged) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      fields.batteryDevice.appendChild(node);
    }

    fields.batteryDevice.value = desiredValue;
  }

  function updatePressCommandVisibility() {
    pressCommandWrap.classList.toggle('hidden', fields.pressAction.value !== 'command');
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

    if (typeof settings.gpuSelector === 'string') {
      const gpuSelector = settings.gpuSelector.trim();
      normalized.gpuSelector = gpuSelector || DEFAULT_SETTINGS.gpuSelector;
    }

    if (typeof settings.batteryDevice === 'string') {
      const batteryDevice = settings.batteryDevice.trim();
      normalized.batteryDevice = batteryDevice || DEFAULT_SETTINGS.batteryDevice;
    }

    if (settings.volumeStep !== undefined) {
      normalized.volumeStep = Math.max(1, Math.min(20, Number.parseInt(settings.volumeStep, 10) || DEFAULT_SETTINGS.volumeStep));
    }

    if (settings.brightnessStep !== undefined) {
      normalized.brightnessStep = Math.max(1, Math.min(25, Number.parseInt(settings.brightnessStep, 10) || DEFAULT_SETTINGS.brightnessStep));
    }

    if (settings.timerStep !== undefined) {
      normalized.timerStep = Math.max(1, Math.min(60, Number.parseInt(settings.timerStep, 10) || DEFAULT_SETTINGS.timerStep));
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

  function applySettings(settings = {}) {
    const normalized = normalizeSettings(settings);

    fields.pingHost.value = normalized.pingHost;
    fields.networkInterface.value = normalized.networkInterface;
    renderGpuOptions(currentGpuOptions, normalized.gpuSelector);
    renderBatteryOptions(currentBatteryOptions, normalized.batteryDevice);
    fields.volumeStep.value = String(normalized.volumeStep);
    fields.brightnessStep.value = String(normalized.brightnessStep);
    fields.timerStep.value = String(normalized.timerStep);
    fields.topMode.value = normalized.topMode;
    fields.refreshRate.value = String(normalized.refreshRate);
    fields.pressAction.value = normalized.pressAction;
    fields.pressCommand.value = normalized.pressCommand;

    updatePressCommandVisibility();
    updateGpuSelectorVisibility();
    updateBatterySelectorVisibility();
  }

  function collectSettings() {
    return normalizeSettings({
      pingHost: fields.pingHost.value,
      networkInterface: fields.networkInterface.value,
      gpuSelector: fields.gpuSelector.value,
      batteryDevice: fields.batteryDevice.value,
      volumeStep: fields.volumeStep.value,
      brightnessStep: fields.brightnessStep.value,
      timerStep: fields.timerStep.value,
      topMode: fields.topMode.value,
      refreshRate: fields.refreshRate.value,
      pressAction: fields.pressAction.value,
      pressCommand: fields.pressCommand.value,
    });
  }

  function send(payload) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    websocket.send(JSON.stringify(payload));
  }

  function extractIncomingSettings(payload = {}) {
    const knownKeys = ['pingHost', 'networkInterface', 'gpuSelector', 'batteryDevice', 'volumeStep', 'brightnessStep', 'timerStep', 'topMode', 'refreshRate', 'pressAction', 'pressCommand'];

    function visit(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 6) {
        return {};
      }

      const direct = {};
      for (const key of knownKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          direct[key] = value[key];
        }
      }

      if (Object.keys(direct).length > 0) {
        return direct;
      }

      if (value.settings && typeof value.settings === 'object') {
        const nestedSettings = visit(value.settings, depth + 1);
        if (Object.keys(nestedSettings).length > 0) {
          return nestedSettings;
        }
      }

      for (const nested of Object.values(value)) {
        const result = visit(nested, depth + 1);
        if (Object.keys(result).length > 0) {
          return result;
        }
      }

      return {};
    }

    return visit(payload);
  }

  function extractGpuOptions(payload = {}) {
    if (Array.isArray(payload.gpuOptions)) {
      return payload.gpuOptions;
    }

    if (payload.settings && Array.isArray(payload.settings.gpuOptions)) {
      return payload.settings.gpuOptions;
    }

    return [];
  }

  function extractBatteryOptions(payload = {}) {
    if (Array.isArray(payload.batteryOptions)) {
      return payload.batteryOptions;
    }

    if (payload.settings && Array.isArray(payload.settings.batteryOptions)) {
      return payload.settings.batteryOptions;
    }

    return [];
  }

  function saveSettings() {
    const settings = collectSettings();

    if (!actionContext) {
      console.log('[Redline PI] local save', settings);
      setStatus('Local preview only');
      return;
    }

    send({
      event: 'setSettings',
      context: actionContext,
      payload: settings,
    });

    if (actionInfo?.action) {
      send({
        event: 'sendToPlugin',
        action: actionInfo.action,
        context: actionContext,
        payload: {
          type: 'saveSettings',
          settings,
        },
      });
    }

    setStatus('Settings saved');
  }

  function requestSettings() {
    if (!actionContext) return;

    send({
      event: 'getSettings',
      context: actionContext,
    });
  }

  window.connectElgatoStreamDeckSocket = function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
    uuid = inUUID;

    try {
      actionInfo = inActionInfo ? JSON.parse(inActionInfo) : null;
    } catch (error) {
      console.error('[Redline PI] Failed to parse action info', error);
      actionInfo = null;
    }

    actionContext = actionInfo?.context || null;
    updateGpuSelectorVisibility();
    updateBatterySelectorVisibility();

    applySettings(extractIncomingSettings(actionInfo?.payload || {}));
    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);

    websocket.addEventListener('open', () => {
      send({
        event: inRegisterEvent,
        uuid: inUUID,
      });

      requestSettings();
      setStatus('Connected');
    });

    websocket.addEventListener('message', (event) => {
      let message = null;

      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error('[Redline PI] Failed to parse message', error);
        return;
      }

      const incomingSettings = extractIncomingSettings(message.payload);

      if (message.event === 'didReceiveSettings' && message.context === actionContext) {
        applySettings(incomingSettings);
        setStatus('Settings loaded');
      }

      if (message.event === 'sendToPropertyInspector' && message.context === actionContext) {
        if (Array.isArray(message.payload?.gpuOptions)) {
          currentGpuOptions = extractGpuOptions(message.payload);
          renderGpuOptions(currentGpuOptions, fields.gpuSelector.value);
        }

        if (Array.isArray(message.payload?.batteryOptions)) {
          currentBatteryOptions = extractBatteryOptions(message.payload);
          renderBatteryOptions(currentBatteryOptions, fields.batteryDevice.value);
        }

        if (Object.keys(incomingSettings).length > 0) {
          applySettings(incomingSettings);
          setStatus('Settings synced');
        } else if (Array.isArray(message.payload?.gpuOptions) || Array.isArray(message.payload?.batteryOptions)) {
          setStatus('Options updated');
        }
      }
    });

    websocket.addEventListener('close', () => {
      setStatus('Disconnected');
    });

    websocket.addEventListener('error', () => {
      setStatus('Connection error');
    });
  };

  saveButton.addEventListener('click', saveSettings);
  fields.pressAction.addEventListener('change', updatePressCommandVisibility);
  applySettings({});
  setStatus('Waiting for OpenDeck');
})();
