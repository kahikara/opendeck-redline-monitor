const { exec } = require('child_process');
const state = require('./state');

function log(...parts) {
  console.log('[Redline]', ...parts);
}

function warn(...parts) {
  console.warn('[Redline]', ...parts);
}

function warnOnce(key, ...parts) {
  if (state.warnedKeys.has(key)) return;
  state.warnedKeys.add(key);
  warn(...parts);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getAdaptiveFontSize(text, baseSize, minSize, softLimit = 6, step = 2) {
  const length = String(text || '').length;
  if (length <= softLimit) return baseSize;
  return Math.max(minSize, baseSize - ((length - softLimit) * step));
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runCommand(command, timeout = 2000) {
  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

async function commandExists(command) {
  if (state.toolCache.has(command)) return state.toolCache.get(command);

  const result = await runCommand(`command -v ${command}`, 1500);
  const exists = !result.error && result.stdout.trim().length > 0;
  state.toolCache.set(command, exists);

  if (!exists) warnOnce(`missing-tool:${command}`, `${command} not found`);

  return exists;
}

function fileExists(filePath) {
  try {
    return require('fs').existsSync(filePath);
  } catch {
    return false;
  }
}

function readText(filePath) {
  return require('fs').readFileSync(filePath, 'utf8').trim();
}

module.exports = {
  log,
  warn,
  warnOnce,
  clamp,
  getAdaptiveFontSize,
  shellEscape,
  escapeXml,
  runCommand,
  commandExists,
  fileExists,
  readText,
};
