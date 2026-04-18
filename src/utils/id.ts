// Simple UUID v4 fallback (no crypto dependency required at runtime)
let counter = 0;

export function v4Fallback(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  counter++;
  return `${ts}-${rand}-${counter.toString(36)}`;
}
