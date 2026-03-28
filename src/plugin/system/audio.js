const { commandExists, runCommand, clamp } = require('../utils');

async function getAudio() {
  if (!(await commandExists('wpctl'))) {
    return { available: false, vol: 0, muted: false };
  }

  const result = await runCommand('wpctl get-volume @DEFAULT_AUDIO_SINK@', 2000);
  if (result.error || !result.stdout) {
    return { available: false, vol: 0, muted: false };
  }

  const match = result.stdout.match(/([0-9]*\.?[0-9]+)/);
  const volume = match ? Math.round(Number.parseFloat(match[1]) * 100) : 0;
  const muted = result.stdout.includes('MUTED');

  return {
    available: true,
    vol: clamp(Number.isFinite(volume) ? volume : 0, 0, 100),
    muted,
  };
}

async function adjustVolume(ticks, stepPercent = 2) {
  if (!(await commandExists('wpctl'))) return false;
  const step = clamp(Number.parseInt(stepPercent, 10) || 2, 1, 20);
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ 0', 1500);
  await runCommand(`wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ ${ticks > 0 ? `${step}%+` : `${step}%-`}`, 1500);
  return true;
}

async function toggleMute() {
  if (!(await commandExists('wpctl'))) return false;
  await runCommand('wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle', 1500);
  return true;
}

module.exports = {
  getAudio,
  adjustVolume,
  toggleMute,
};
