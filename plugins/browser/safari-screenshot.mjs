/**
 * Element-aware Safari screenshots.
 *
 * Apple's `screenshot` tool captures the whole viewport (its `node` parameter
 * is a documented no-op). This module adds `querySelector`: an in-page script
 * locates the element, scrolls it into view (optional), waits for scrolling to
 * settle (polling with setTimeout: rAF does not fire in occluded windows), and
 * reports its client rect and devicePixelRatio; the caller (tools.mjs) takes a
 * viewport screenshot, measures again (retaking once if the element moved),
 * and crops the sub-rectangle with sharp (not `sips`: its `--cropOffset 0 0`
 * is treated as unset and crops the centre).
 */

import { readFile } from 'node:fs/promises'
import sharp from 'sharp'

/**
 * In-page function body (Apple's evaluate_javascript contract; `await` allowed).
 * Returns `{ rect, dpr, viewport, scroll }` or `{ error }`.
 * @param {string} selector - CSS selector, JSON-embedded.
 * @param {boolean} scrollTo - scroll the element into view first.
 */
export function measureScript(selector, scrollTo) {
  return `
const el = document.querySelector(${JSON.stringify(selector)});
if (!el) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
// setTimeout, not requestAnimationFrame: rAF is suspended in occluded/hidden
// windows (e.g. a second stacked STP window), which would hang this loop.
const frame = () => new Promise(r => setTimeout(r, 40));
const snap = () => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, sx: window.scrollX, sy: window.scrollY }; };
if (${scrollTo ? 'true' : 'false'}) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
let prev = snap(); let stable = 0;
for (let i = 0; i < 60 && stable < 3; i++) {
  await frame();
  const cur = snap();
  const same = Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.sx - prev.sx) < 0.5 && Math.abs(cur.sy - prev.sy) < 0.5;
  stable = same ? stable + 1 : 0;
  prev = cur;
}
const r = el.getBoundingClientRect();
return {
  rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  dpr: window.devicePixelRatio,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  scroll: { x: window.scrollX, y: window.scrollY },
  settled: stable >= 3
};`
}

/** Parse the JSON text the evaluate tool returns (possibly double-encoded). */
export function parseMeasurement(text) {
  let value = text
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value) } catch { break }
  }
  if (value === null || typeof value !== 'object') throw new Error(`unexpected measurement result: ${String(text).slice(0, 200)}`)
  if (typeof value.error === 'string') throw new Error(value.error)
  return value
}

/** True when two rects differ by more than `tolerance` CSS px in any edge. */
export function rectMoved(a, b, tolerance = 2) {
  return Math.abs(a.x - b.x) > tolerance || Math.abs(a.y - b.y) > tolerance
    || Math.abs(a.width - b.width) > tolerance || Math.abs(a.height - b.height) > tolerance
}

/**
 * Convert a CSS-pixel rect to an integer device-pixel crop box clamped to the image.
 * The scale is derived from the actual image size vs. the CSS viewport, so it is
 * exact even when devicePixelRatio is fractional or the viewport was resized.
 * @returns {{ x: number, y: number, width: number, height: number, scale: number, clipped: boolean }}
 */
export function cropBox(rect, viewport, image) {
  const scale = image.width / viewport.width
  const x0 = Math.max(0, Math.floor(rect.x * scale))
  const y0 = Math.max(0, Math.floor(rect.y * scale))
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width) * scale))
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height) * scale))
  if (x1 <= x0 || y1 <= y0) throw new Error('element is outside the viewport; pass scrollTo: true or enlarge the window (set_viewport_size)')
  const clipped = rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale, clipped }
}

/** Pixel dimensions of a PNG file. */
export async function imageSize(path) {
  const { width, height } = await sharp(path).metadata()
  if (width === undefined || height === undefined) throw new Error(`could not read image size of ${path}`)
  return { width, height }
}

/**
 * Crop a PNG file to `box` (device pixels).
 * @returns {Promise<Uint8Array>} PNG bytes of the crop.
 */
export async function cropImage(input, box) {
  const buffer = await sharp(input).extract({ left: box.x, top: box.y, width: box.width, height: box.height }).png().toBuffer()
  return new Uint8Array(buffer)
}

/** Read PNG bytes. */
export async function readPng(path) {
  return new Uint8Array(await readFile(path))
}
