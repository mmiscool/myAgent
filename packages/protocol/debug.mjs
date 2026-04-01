function shouldLog(debug, category) {
  if (!debug) {
    return false;
  }

  if (debug === true) {
    return true;
  }

  if (typeof debug === "function") {
    return true;
  }

  if (Array.isArray(debug)) {
    return debug.includes(category);
  }

  if (debug instanceof Set) {
    return debug.has(category);
  }

  if (typeof debug === "object") {
    return Boolean(debug[category]);
  }

  return false;
}

export function createDebugLogger(category, debug) {
  return (...args) => {
    if (!shouldLog(debug, category)) {
      return;
    }

    if (typeof debug === "function") {
      debug(category, ...args);
      return;
    }

    console.debug(`[${category}]`, ...args);
  };
}
