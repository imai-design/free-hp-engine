/**
 * 写真のdata URIからピクセル寸法を読む。
 *
 * 目的＝生成HPの写真枠を写真の形（横長・正方形・縦長）に合わせるため。
 * フロントに新しい入力項目を足さずに済ませたいので、送られてきた画像そのものから測る。
 * 読めなければnullを返し、呼び出し側は従来どおり（横長扱い）で動く。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** これを超える値が出たらパース位置がずれていると判断する。 */
const MAX_REASONABLE_DIMENSION = 100_000;
/** JPEGはEXIFが先に入るとSOFマーカーが後ろへずれるので、先頭64KBまで走査する。 */
const JPEG_SCAN_BYTES = 64 * 1024;
/** PNG・WebPは先頭30バイト前後で寸法が確定する。 */
const HEADER_SCAN_BYTES = 64;

/**
 * base64の先頭だけを復号する。写真は最大2MB近くあり、全部展開すると無駄が大きい。
 * atobは長さが4の倍数でないと失敗するので、切り出したあと4の倍数に揃える。
 */
function decodeBase64Prefix(base64: string, byteLength: number): Uint8Array | null {
  const raw = base64.slice(0, Math.ceil(byteLength / 3) * 4);
  const aligned = raw.slice(0, raw.length - (raw.length % 4));
  if (aligned.length === 0) return null;
  let binary: string;
  try {
    binary = atob(aligned);
  } catch {
    return null;
  }
  const length = Math.min(binary.length, byteLength);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const readUint16BE = (bytes: Uint8Array, offset: number): number => (bytes[offset] << 8) | bytes[offset + 1];
const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
const readUint24LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  Array.from(bytes.slice(from, to), (code) => String.fromCharCode(code)).join("");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNGはシグネチャ8バイトの直後がIHDRチャンクで、幅と高さがオフセット16と20に並ぶ。 */
function readPngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  if (ascii(bytes, 12, 16) !== "IHDR") return null;
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

/** 寸法を持つSOFマーカー。SOF4(0xC4=ハフマン表)・SOF8(0xC8)・SOF12(0xCC)は別物なので除く。 */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** 単独で現れ、長さフィールドを持たないマーカー（RSTn・SOI・EOI・TEM）。 */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/**
 * JPEGはセグメントの連なり。FF+マーカー+長さ(2byte) を辿り、SOFに当たったらそこから寸法を読む。
 * SOFのペイロードは precision(1) height(2) width(2) の順に並ぶ。
 */
function readJpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    // 0xFFが連続する場合は詰め物なので読み飛ばす。
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
    if (markerOffset >= bytes.length) return null;
    const marker = bytes[markerOffset];
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      offset = markerOffset + 1;
      continue;
    }
    if (markerOffset + 2 >= bytes.length) return null;
    const segmentLength = readUint16BE(bytes, markerOffset + 1);
    if (segmentLength < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (markerOffset + 7 >= bytes.length) return null;
      return { height: readUint16BE(bytes, markerOffset + 4), width: readUint16BE(bytes, markerOffset + 6) };
    }
    offset = markerOffset + 1 + segmentLength;
  }
  return null;
}

/**
 * WebPは RIFF....WEBP のあとにチャンクが続く。先頭チャンクの種別で寸法の置き場所が変わる。
 * canvas.toDataURL("image/webp") が出すのは通常 VP8（非可逆）。
 */
function readWebpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8 ") {
    // チャンクデータ先頭3バイトがフレームタグ、続く3バイトが同期コード 9D 01 2A。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    // 幅・高さは14bit。上位2bitはスケール指定なのでマスクする。
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const packed = bytes[21] + (bytes[22] << 8) + (bytes[23] << 16) + bytes[24] * 0x1000000;
    return {
      width: (packed & 0x3fff) + 1,
      height: (Math.floor(packed / 0x4000) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    // 拡張フォーマットはチャンクデータの4バイト目から「幅-1」「高さ-1」が24bitずつ並ぶ。
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
  }
  return null;
}

const DATA_URI_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/u;

export function readImageSize(dataUri: string): ImageSize | null {
  if (typeof dataUri !== "string" || dataUri.length === 0) return null;
  const match = DATA_URI_PATTERN.exec(dataUri);
  if (!match) return null;
  const [, subtype, base64] = match;
  const scanBytes = subtype === "jpeg" ? JPEG_SCAN_BYTES : HEADER_SCAN_BYTES;
  const bytes = decodeBase64Prefix(base64, scanBytes);
  if (!bytes) return null;

  let size: ImageSize | null = null;
  if (subtype === "png") size = readPngSize(bytes);
  else if (subtype === "jpeg") size = readJpegSize(bytes);
  else if (subtype === "webp") size = readWebpSize(bytes);

  if (!size) return null;
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_REASONABLE_DIMENSION || height > MAX_REASONABLE_DIMENSION) return null;
  return size;
}

export type PhotoShape = "landscape" | "square" | "portrait";

/**
 * 写真の形を3種類に分ける。読めなかった場合は従来どおり横長として扱う（見た目を変えない）。
 * 縦写真を16:10の枠にcoverで入れると高さの6割以上が切り捨てられ、看板や顔が消えるため。
 */
export function photoShapeOf(size: ImageSize | null): PhotoShape {
  if (!size) return "landscape";
  const ratio = size.width / size.height;
  if (ratio >= 1.15) return "landscape";
  if (ratio > 0.85) return "square";
  return "portrait";
}
