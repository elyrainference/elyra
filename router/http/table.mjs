// Tiny route table: [method | "*", exact path | RegExp, handler]. First match wins, in table order. No I/O.
export function routeTable(entries) {
  return (method, path) => {
    for (const [m, pattern, handler] of entries) {
      if (m !== "*" && m !== method) continue;
      if (typeof pattern === "string") { if (pattern === path) return { handler, params: [] }; continue; }
      const hit = path.match(pattern);
      if (hit) return { handler, params: hit.slice(1) };
    }
    return null;
  };
}
