(() => {
  const $ = (id) => document.getElementById(id);

  const fields = {
    pingHost: $('pingHost'),
    networkInterface: $('networkInterface'),
    volumeStep: $('volumeStep'),
    brightnessStep: $('brightnessStep'),
    timerStep: $('timerStep'),
    topMode: $('topMode'),
    refreshRate: $('refreshRate'),
  };

  const saveButton = $('saveButton');
  const statusText = $('statusText');

  let websocket = null;
  let uuid = null;
  let actionInfo = null;
  let actionContext = null;

  const DEFAULT_SETTINGS = Object.freeze({
    pingHost: '1.1.1.1',
    networkInterface: '',
    volumeStep: 2,
    brightnessStep: 5,
    timerStep: 1,
    topMode: 'grouped',
    refreshRate: 3,
  });

  function setStatus(text) {
    statusText.textContent = text;
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

    return normalized;
  }

  function applySettings(settings = {}) {
    const normalized = normalizeSettings(settings);

    fields.pingHost.value = normalized.pingHost;
    fields.networkInterface.value = normalized.networkInterface;
    fields.volumeStep.value = String(normalized.volumeStep);
    fields.brightnessStep.value = String(normalized.brightnessStep);
    fields.timerStep.value = String(normalized.timerStep);
    fields.topMode.value = normalized.topMode;
    fields.refreshRate.value = String(normalized.refreshRate);
  }

  function collectSettings() {
    return normalizeSettings({
      pingHost: fields.pingHost.value,
      networkInterface: fields.networkInterface.value,
      volumeStep: fields.volumeStep.value,
      brightnessStep: fields.brightnessStep.value,
      timerStep: fields.timerStep.value,
      topMode: fields.topMode.value,
      refreshRate: fields.refreshRate.value,
    });
  }

  function send(payload) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    websocket.send(JSON.stringify(payload));
  }

  function extractIncomingSettings(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    if (payload.settings && typeof payload.settings === 'object') {
      return payload.settings;
    }

    const knownKeys = ['pingHost', 'networkInterface', 'volumeStep', 'brightnessStep', 'timerStep', 'topMode', 'refreshRate'];
    if (knownKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
      return payload;
    }

    return {};
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
        if (Object.keys(incomingSettings).length > 0) {
          applySettings(incomingSettings);
          setStatus('Settings synced');
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
  applySettings({});
  setStatus('Waiting for OpenDeck');
})();
