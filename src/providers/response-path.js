export function readResponsePath(value, path) {
  if (path === undefined || path === null || path === "") return value;
  if (typeof path !== "string") return undefined;
  const tokens = [];
  let offset = 0;
  const property = () => {
    const match = path.slice(offset).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/u);
    if (!match) return false;
    tokens.push(match[0]);
    offset += match[0].length;
    return true;
  };
  if (!property()) return undefined;
  while (offset < path.length) {
    if (path[offset] === ".") {
      offset += 1;
      if (!property()) return undefined;
      continue;
    }
    if (path[offset] === "[") {
      const match = path.slice(offset).match(/^\[(\d+)\]/u);
      if (!match) return undefined;
      tokens.push(match[1]);
      offset += match[0].length;
      continue;
    }
    return undefined;
  }
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined || !Object.hasOwn(Object(current), token)) return undefined;
    current = current[token];
  }
  return current;
}
