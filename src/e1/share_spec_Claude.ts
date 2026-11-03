/**
 * Labels shared to the app from Android's Share menu (Web Share Target, see niimblue.webmanifest).
 *
 * Shared text may be a plain string (printed as is) or contain an E1LABEL block, e.g. one written by Claude:
 *
 *   E1LABEL
 *   text: Paprika\nSmoked
 *   length: 40
 *   size: auto
 *   align: center
 *   qr: https://example.com
 *
 * The block runs from the E1LABEL line to the first blank line or ``` fence. Unknown keys are ignored.
 */

export interface ShareSpec {
  text: string;
  tapeMm: number;
  /** undefined = auto length */
  lengthMm?: number;
  /** text height in dots; undefined = as large as fits */
  sizeDots?: number;
  /** text height in mm, converted by the caller; overrides sizeDots */
  sizeMm?: number;
  align: "left" | "center" | "right";
  qr?: string;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export const parseShareSpec = (shared: string): ShareSpec | null => {
  const raw = shared.replace(/\r\n?/g, "\n").trim();
  if (!raw) return null;

  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.trim().toUpperCase() === "E1LABEL");
  if (start === -1) {
    // plain text: one label, as large as fits
    return { text: raw, tapeMm: 16, align: "center" };
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "" || t.startsWith("```")) break;
    const colon = t.indexOf(":");
    if (colon === -1) continue;
    fields[t.slice(0, colon).trim().toLowerCase()] = t.slice(colon + 1).trim();
  }

  const text = (fields["text"] ?? "").replace(/\\n/g, "\n");
  const qr = fields["qr"] || undefined;
  if (!text && !qr) return null;

  const size = fields["size"];
  const align = fields["align"]?.toLowerCase();
  return {
    text,
    tapeMm: num(fields["tape"]) ?? 16,
    lengthMm: fields["length"]?.toLowerCase() === "auto" ? undefined : num(fields["length"]),
    sizeMm: size?.toLowerCase().endsWith("mm") ? num(size) : undefined,
    sizeDots: size && !size.toLowerCase().endsWith("mm") ? num(size) : undefined,
    align: align === "left" || align === "right" ? align : "center",
    qr,
  };
};

/** Shared text from the URL query (?title=&text=&url=), or null when the app wasn't opened by a share. */
export const readSharedText = (): string | null => {
  const params = new URLSearchParams(location.search);
  if (!params.has("text") && !params.has("title") && !params.has("url")) return null;
  // Android puts the shared text in `text`; some apps put a link in `url` or a subject in `title`.
  return params.get("text") || params.get("url") || params.get("title") || "";
};

/** Drop the share query so a reload doesn't load the same label again. */
export const clearSharedText = () => {
  history.replaceState(null, "", location.pathname + location.hash);
};
