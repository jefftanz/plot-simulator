/** A named set of paint colors for an artwork. */
export interface Palette {
  name: string;
  /** #rrggbb, lowercase. */
  colors: string[];
}

export const MAX_COLORS = 10;
export const SUGGESTED_MIN = 4;

export const DEFAULT_PALETTE: Palette = {
  name: "Starter",
  colors: ["#f4f1ea", "#f2c300", "#c8261e", "#1f3fa8", "#0f6b4f", "#8a3b16", "#1c1c1c"],
};

const STORAGE_KEY = "paint-plotter-sim.palette";

/** The palette saved in this browser, or the starter palette. */
export function loadPalette(): Palette {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved.name === "string" && Array.isArray(saved.colors)) {
      const colors = saved.colors.map(normalizeHex).filter((c: string | null): c is string => !!c).slice(0, MAX_COLORS);
      if (colors.length) return { name: saved.name, colors };
    }
  } catch {
    // Storage unavailable or unreadable: fall back to the starter palette.
  }
  return { name: DEFAULT_PALETTE.name, colors: [...DEFAULT_PALETTE.colors] };
}

export function savePalette(p: Palette): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable (e.g. private window): the palette just won't be remembered.
  }
}

/** "#ABC", "abc123", "#aabbcc" → "#aabbcc"; anything else → null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let h = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

/** GIMP/Inkscape palette (.gpl) text. */
export function toGpl(p: Palette): string {
  const lines = ["GIMP Palette", `Name: ${p.name}`, `Columns: ${Math.min(p.colors.length, 5)}`, "#"];
  p.colors.forEach((hex, i) => {
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${hex} (${i + 1})`);
  });
  return lines.join("\n") + "\n";
}

/**
 * Read a palette from a .gpl file, this app's JSON, or any text listing hex codes
 * (one or more per line). Keeps the first MAX_COLORS distinct colors.
 */
export function parsePalette(text: string, fallbackName: string): Palette {
  let name = fallbackName;
  const found: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    if (typeof data.name === "string") name = data.name;
    for (const c of Array.isArray(data.colors) ? data.colors : []) {
      const hex = normalizeHex(typeof c === "string" ? c : c?.hex);
      if (hex) found.push(hex);
    }
  } else if (/^GIMP Palette/i.test(trimmed)) {
    for (const line of trimmed.split(/\r?\n/).slice(1)) {
      const nameMatch = line.match(/^Name:\s*(.+)$/i);
      if (nameMatch) {
        name = nameMatch[1].trim();
        continue;
      }
      const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (!m) continue;
      const hex = "#" + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, "0")).join("");
      found.push(hex);
    }
  } else {
    for (const m of trimmed.matchAll(/#?\b([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      const hex = normalizeHex(m[1]);
      if (hex) found.push(hex);
    }
  }
  const colors = [...new Set(found)].slice(0, MAX_COLORS);
  if (colors.length === 0) throw new Error("No colors were found in that file.");
  return { name, colors };
}
