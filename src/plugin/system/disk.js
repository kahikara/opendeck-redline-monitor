function summarizeDisks(diskData) {
  const uniqueDisks = {};

  for (const disk of diskData) {
    if (!disk.fs || !disk.fs.startsWith('/dev/')) continue;
    if (disk.fs.includes('loop')) continue;
    if (disk.mount && (disk.mount.includes('/snap/') || disk.mount.includes('/docker/'))) continue;
    uniqueDisks[disk.fs] = disk;
  }

  let totalSize = 0;
  let totalUsed = 0;

  for (const disk of Object.values(uniqueDisks)) {
    totalSize += disk.size || 0;
    totalUsed += disk.used || 0;
  }

  if (!totalSize) {
    return { available: false, percent: 0, freeGB: 0 };
  }

  return {
    available: true,
    percent: (totalUsed / totalSize) * 100,
    freeGB: (totalSize - totalUsed) / (1024 ** 3),
  };
}

module.exports = {
  summarizeDisks,
};
