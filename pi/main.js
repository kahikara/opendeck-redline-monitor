(() => {
  const $ = (id) => document.getElementById(id);

  const fields = {
    pingHost: $('pingHost'),
    networkInterface: $('networkInterface'),
    volumeStep: $('volumeStep'),
    brightnessStep: $('brightnessStep'),
    timerStep: $('timerStep'),
    topMode: $('topMode'),
  };

  const saveButton = $('saveButton');
  const statusText = $('statusText');

  function setStatus(text) {
    statusText.textContent = text;
  }

  function getCurrentSettings() {
    return {
      pingHost: fields.pingHost.value.trim() || '1.1.1.1',
      networkInterface: fields.networkInterface.value.trim(),
      volumeStep: Number.parseInt(fields.volumeStep.value, 10) || 2,
      brightnessStep: Number.parseInt(fields.brightnessStep.value, 10) || 5,
      timerStep: Number.parseInt(fields.timerStep.value, 10) || 1,
      topMode: fields.topMode.value || 'grouped',
    };
  }

  function loadDefaults() {
    const defaults = getCurrentSettings();
    fields.pingHost.value = defaults.pingHost;
    fields.networkInterface.value = defaults.networkInterface;
    fields.volumeStep.value = String(defaults.volumeStep);
    fields.brightnessStep.value = String(defaults.brightnessStep);
    fields.timerStep.value = String(defaults.timerStep);
    fields.topMode.value = defaults.topMode;
  }

  saveButton.addEventListener('click', () => {
    const settings = getCurrentSettings();
    console.log('[Redline PI] Save clicked', settings);
    setStatus('Save clicked. Settings wiring comes next.');
  });

  loadDefaults();
  setStatus('Inspector ready');
})();
