export function parseLocalFileLinkHref(rawHref) {
  const href = String(rawHref || "").trim();

  if (!href || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.startsWith("#")) {
    return null;
  }

  const [pathWithPossibleLineSuffix, hash = ""] = href.split("#", 2);
  const decodedPath = safeDecode(pathWithPossibleLineSuffix);
  const hashMatch = hash.match(/^L(\d+)(?:C(\d+))?$/i);
  let path = decodedPath;
  let line = hashMatch ? Number(hashMatch[1]) : 0;
  let column = hashMatch?.[2] ? Number(hashMatch[2]) : 0;

  if (!line) {
    const colonMatch = decodedPath.match(/^(\/.*?):(\d+)(?::(\d+))?$/);

    if (colonMatch) {
      path = colonMatch[1];
      line = Number(colonMatch[2]) || 0;
      column = Number(colonMatch[3]) || 0;
    }
  }

  if (!path.startsWith("/") || path.startsWith("/api/") || path.startsWith("/ws/")) {
    return null;
  }

  return {
    path,
    line: line > 0 ? line : 0,
    column: column > 0 ? column : 0,
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
