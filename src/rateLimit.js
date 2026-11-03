const rateLimit = (options = {}) => {
  const windowMs = Number(options.windowMs || 60_000);
  const max = Number(options.max || 100);
  const skip = options.skip || (() => false);
  const clients = new Map();

  function getKey(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, record] of clients) {
      if (now - record.last > windowMs * 2) clients.delete(key);
    }
  }
  setInterval(cleanup, windowMs).unref();

  return (req, res, next) => {
    if (skip(req)) return next();
    const key = getKey(req);
    const now = Date.now();
    let record = clients.get(key);
    if (!record || now - record.last > windowMs) {
      record = { count: 0, last: now };
      clients.set(key, record);
    }
    record.count += 1;
    const remaining = Math.max(0, max - record.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((record.last + windowMs - now) / 1000)));
    if (record.count > max) {
      return res.status(429).json({ error: { message: 'Too many requests. Please try again later.' } });
    }
    return next();
  };
};

module.exports = { rateLimit };
