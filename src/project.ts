/**
 * Project files: a JSON description plus binary arrays (the paint grid, the color guide image),
 * packed into one gzip-compressed file so a full canvas stays small and quick to save.
 *
 * Layout before compression: "PSIM" magic, a uint32 version, a uint32 JSON byte length, the
 * JSON, then each array's bytes in the order the JSON's `arrays` list gives.
 */

export const PROJECT_EXTENSION = ".paintsim";
const MAGIC = "PSIM";
const FORMAT_VERSION = 1;

export type BinaryArray = Float32Array | Uint8Array;

interface ArrayEntry {
  name: string;
  type: "f32" | "u8";
  length: number;
}

/** Pack a description and named arrays into a compressed project file. */
export async function packProject(meta: unknown, arrays: Record<string, BinaryArray>): Promise<Blob> {
  const entries: ArrayEntry[] = Object.entries(arrays).map(([name, a]) => ({
    name,
    type: a instanceof Float32Array ? "f32" : "u8",
    length: a.length,
  }));
  const json = new TextEncoder().encode(JSON.stringify({ meta, arrays: entries }));
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, json.length, true);
  const parts: BlobPart[] = [header, json];
  for (const e of entries) {
    const a = arrays[e.name];
    parts.push(new Uint8Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  }
  const raw = new Blob(parts);
  return new Response(raw.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/** Read a project file written by packProject. */
export async function unpackProject(file: Blob): Promise<{ meta: unknown; arrays: Record<string, BinaryArray> }> {
  let bytes = new Uint8Array(await file.arrayBuffer());
  // Gzip files start with 1f 8b.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error("That isn't a Paint Plotter Sim project file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version > FORMAT_VERSION) throw new Error("That project was saved by a newer version of the app.");
  const jsonLength = view.getUint32(8, true);
  const { meta, arrays: entries } = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLength))) as {
    meta: unknown;
    arrays: ArrayEntry[];
  };
  const arrays: Record<string, BinaryArray> = {};
  let offset = 12 + jsonLength;
  for (const e of entries) {
    const byteLength = e.length * (e.type === "f32" ? 4 : 1);
    // Copy out so each array is aligned and independent of the file buffer.
    const chunk = bytes.slice(offset, offset + byteLength);
    arrays[e.name] = e.type === "f32" ? new Float32Array(chunk.buffer) : chunk;
    offset += byteLength;
  }
  return { meta, arrays };
}
