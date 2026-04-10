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
    pressAction: $('pressAction'),
    pressCommand: $('pressCommand'),
  };

  const pressCommandWrap = $('pressCommandWrap');
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
    pressAction: 'default',
    pressCommand: '',
  });

  function setStatus(text) {
    statusText.textContent = text;
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
    fields.volumeStep.value = String(normalized.volumeStep);
    fields.brightnessStep.value = String(normalized.brightnessStep);
    fields.timerStep.value = String(normalized.timerStep);
    fields.topMode.value = normalized.topMode;
    fields.refreshRate.value = String(normalized.refreshRate);
    fields.pressAction.value = normalized.pressAction;
    fields.pressCommand.value = normalized.pressCommand;

    updatePressCommandVisibility();
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
    const knownKeys = ['pingHost', 'networkInterface', 'volumeStep', 'brightnessStep', 'timerStep', 'topMode', 'refreshRate', 'pressAction', 'pressCommand'];

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
  fields.pressAction.addEventListener('change', updatePressCommandVisibility);
  applySettings({});
  setStatus('Waiting for OpenDeck');
})();
