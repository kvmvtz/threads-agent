function buildCaption({ day, siteName, hook }) {
  const hookLine = hook && hook.trim() ? hook.trim() : '';
  const lines = [
    'Every day I show you a website design worth stealing 🔥',
    `Today: ${siteName}`,
    '',
    ...(hookLine ? [hookLine, ''] : []),
    'We can build something like this for your brand.',
    'Portfolio + contact in bio.',
    '',
    `Day ${day} of 100`,
  ];
  const caption = lines.join('\n');
  if (caption.length > 480) {
    // Hard safety net — Threads limit is 500 chars.
    return caption.slice(0, 477) + '...';
  }
  return caption;
}

module.exports = { buildCaption };
