const { clamp, getAdaptiveFontSize, escapeXml } = require('./utils');

function generateButtonImage(icon, title, line1, line2, percent = -1) {
  const safeTitle = String(title || '');
  const safeLine1 = String(line1 || '');
  const safeLine2 = String(line2 || '');

  const titleSize = getAdaptiveFontSize(safeTitle, 19, 15, 8, 1);
  const line1Size = getAdaptiveFontSize(safeLine1, 35, 21, 5, 2);
  const line2Size = getAdaptiveFontSize(safeLine2, 20, 13, 16, 1);

  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const r = p > 50 ? 255 : Math.floor((p * 2) * 255 / 100);
    const g = p < 50 ? 255 : Math.floor(((100 - p) * 2) * 255 / 100);
    const width = (112 * p) / 100;

    barHtml = `<rect x="16" y="122" width="112" height="8" fill="#333" rx="4"/><rect x="16" y="122" width="${width}" height="8" fill="rgb(${r},${g},0)" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="60" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="21" text-anchor="end">${escapeXml(icon)}</text>
    <text x="64" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" text-anchor="start">${escapeXml(safeTitle)}</text>
    <text x="72" y="76" fill="#ffffff" font-family="sans-serif" font-size="${line1Size}" font-weight="bold" text-anchor="middle">${escapeXml(safeLine1)}</text>
    <text x="72" y="104" fill="#a1a1aa" font-family="sans-serif" font-size="${line2Size}" text-anchor="middle">${escapeXml(safeLine2)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateCenteredHeaderButtonImage(icon, title, line1, line2, percent = -1) {
  const safeHeader = `${String(icon || '').trim()} ${String(title || '').trim()}`.trim();
  const safeLine1 = String(line1 || '');
  const safeLine2 = String(line2 || '');

  const headerSize = getAdaptiveFontSize(safeHeader, 18, 13, 10, 1);
  const line1Size = getAdaptiveFontSize(safeLine1, 35, 21, 5, 2);
  const line2Size = getAdaptiveFontSize(safeLine2, 20, 13, 16, 1);

  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const r = p > 50 ? 255 : Math.floor((p * 2) * 255 / 100);
    const g = p < 50 ? 255 : Math.floor(((100 - p) * 2) * 255 / 100);
    const width = (112 * p) / 100;
    barHtml = `<rect x="16" y="122" width="112" height="8" fill="#333" rx="4"/><rect x="16" y="122" width="${width}" height="8" fill="rgb(${r},${g},0)" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="72" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="${headerSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeHeader)}</text>
    <text x="72" y="76" fill="#ffffff" font-family="sans-serif" font-size="${line1Size}" font-weight="bold" text-anchor="middle">${escapeXml(safeLine1)}</text>
    <text x="72" y="104" fill="#a1a1aa" font-family="sans-serif" font-size="${line2Size}" text-anchor="middle">${escapeXml(safeLine2)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generatePageDialImage(icon, title, valueText, pageIndex, pageCount) {
  const safeTitle = String(title || '');
  const safeValue = String(valueText || '');
  const safeLabel = `${String(icon || '').trim()} ${safeTitle}`.trim();

  const labelSize = getAdaptiveFontSize(safeLabel, 18, 13, 9, 1);
  const valueSize = getAdaptiveFontSize(safeValue, 30, 18, 8, 2);

  const dots = Array.from({ length: Math.max(1, Math.min(4, pageCount || 1)) }, (_, index) => {
    const active = index === pageIndex;
    const cx = 72 + ((index - ((pageCount - 1) / 2)) * 16);
    const fill = active ? '#ffffff' : '#52525b';
    const r = active ? 4.5 : 3;
    return `<circle cx="${cx}" cy="120" r="${r}" fill="${fill}"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="72" y="32" fill="#a1a1aa" font-family="sans-serif" font-size="${labelSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeLabel)}</text>
    <text x="72" y="80" fill="#ffffff" font-family="sans-serif" font-size="${valueSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeValue)}</text>
    ${dots}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateBlankButtonImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateFooterButtonImage(icon, title, line1, line2, footer = '') {
  const safeTitle = String(title || '');
  const safeLine1 = String(line1 || '');
  const safeLine2 = String(line2 || '');
  const safeFooter = String(footer || '');

  const titleSize = getAdaptiveFontSize(safeTitle, 19, 15, 8, 1);
  const line1Size = getAdaptiveFontSize(safeLine1, 30, 20, 6, 2);
  const line2Size = getAdaptiveFontSize(safeLine2, 24, 16, 8, 1);
  const footerSize = getAdaptiveFontSize(safeFooter, 18, 13, 12, 1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="60" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="21" text-anchor="end">${escapeXml(icon)}</text>
    <text x="64" y="31" fill="#a1a1aa" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" text-anchor="start">${escapeXml(safeTitle)}</text>
    <text x="72" y="70" fill="#ffffff" font-family="sans-serif" font-size="${line1Size}" font-weight="bold" text-anchor="middle">${escapeXml(safeLine1)}</text>
    <text x="72" y="96" fill="#a1a1aa" font-family="sans-serif" font-size="${line2Size}" text-anchor="middle">${escapeXml(safeLine2)}</text>
    <text x="72" y="126" fill="#71717a" font-family="sans-serif" font-size="${footerSize}" text-anchor="middle">${escapeXml(safeFooter)}</text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateDialImage(icon, title, valueText, percent = -1, barColor = 'rgb(74, 222, 128)') {
  const safeTitle = String(title || '');
  const safeValue = String(valueText || '');
  const safeLabel = `${String(icon || '').trim()} ${safeTitle}`.trim();

  const labelSize = getAdaptiveFontSize(safeLabel, 18, 13, 9, 1);
  const valueSize = getAdaptiveFontSize(safeValue, 40, 24, 4, 2);

  let barHtml = '';

  if (percent >= 0) {
    const p = clamp(percent, 0, 100);
    const width = (100 * p) / 100;
    barHtml = `<rect x="22" y="115" width="100" height="8" fill="#333" rx="4"/><rect x="22" y="115" width="${width}" height="8" fill="${escapeXml(barColor)}" rx="4"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#18181b"/>
    <text x="72" y="32" fill="#a1a1aa" font-family="sans-serif" font-size="${labelSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeLabel)}</text>
    <text x="72" y="86" fill="#ffffff" font-family="sans-serif" font-size="${valueSize}" font-weight="bold" text-anchor="middle">${escapeXml(safeValue)}</text>
    ${barHtml}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function unavailableButton(icon, title, reason) {
  return generateButtonImage(icon, title, 'N/A', reason, -1);
}

function unavailableDial(icon, title, reason) {
  return generateDialImage(icon, title, reason, -1, 'rgb(239, 68, 68)');
}

module.exports = {
  generateButtonImage,
  generateCenteredHeaderButtonImage,
  generateFooterButtonImage,
  generateDialImage,
  generatePageDialImage,
  generateBlankButtonImage,
  unavailableButton,
  unavailableDial,
};
