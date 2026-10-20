/**
 * Minimal EBML (Matroska / WebM) reading: variable-length integers and element headers.
 * Works on a Uint8Array window; positions are absolute file offsets (`base` = window start).
 */

export const UNKNOWN_SIZE = -1;

export interface VintResult {
  value: number;
  length: number;
  allOnes: boolean;
}

export interface ElementHeaderResult {
  id: number;
  size: number;
  headerLength: number;
}

/** A variable-length integer at `pos`: { value, length } (value without the marker bit), or null. */
export function readVint(
  bytes: Uint8Array,
  pos: number,
  { keepMarker = false }: { keepMarker?: boolean } = {}
): VintResult | null {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null; // longer than 8 bytes: not valid here
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

/** An element header at `pos`: { id, size (or UNKNOWN_SIZE), headerLength }, or null if cut off. */
export function readElementHeader(bytes: Uint8Array, pos: number): ElementHeaderResult | null {
  const id = readVint(bytes, pos, { keepMarker: true });
  if (!id) return null;
  const size = readVint(bytes, pos + id.length);
  if (!size) return null;
  return {
    id: id.value,
    size: size.allOnes ? UNKNOWN_SIZE : size.value,
    headerLength: id.length + size.length
  };
}

export const readUint = (bytes: Uint8Array, pos: number, len: number): number => {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + bytes[pos + i];
  return v;
};

export const readFloat = (bytes: Uint8Array, pos: number, len: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos, len);
  return len === 4 ? view.getFloat32(0) : view.getFloat64(0);
};

const utf8 = new TextDecoder('utf-8');
export const readString = (bytes: Uint8Array, pos: number, len: number): string =>
  utf8.decode(bytes.subarray(pos, pos + len)).replace(/\0+$/, '');
