#!/usr/bin/env node
/**
 * Generates placeholder extension icons at 16/48/128 px in TWO variants:
 *   - prod: purple `#a855f7`     (matches the prod popup gradient)
 *   - dev:  orange `#f97316`     (instantly recognizable in the toolbar)
 *
 * These are solid squares with a white "G" — intentionally temporary so
 * we have something to ship with the scaffold. Replace with real icons
 * before Chrome Web Store submission.
 *
 * Uses pngjs (declared in devDependencies).
 *
 * Run: `npm run icons`  (or `node scripts/make-placeholder-icons.mjs`)
 */

import { PNG } from "pngjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "public", "icons");
mkdirSync(iconsDir, { recursive: true });

const VARIANTS = {
  prod: { r: 0xa8, g: 0x55, b: 0xf7, suffix: "" },         // purple
  dev:  { r: 0xf9, g: 0x73, b: 0x16, suffix: "-dev" },     // orange
};

// Letter "G" bitmap drawn at 5×7 resolution, then scaled up per icon size.
// 1 = white pixel, 0 = background. Classic pixel font.
const LETTER_G = [
  "01110",
  "10001",
  "10000",
  "10011",
  "10001",
  "10001",
  "01110",
];
const LETTER_W = 5;
const LETTER_H = 7;

function makeIcon(size, variant) {
  const { r, g, b, suffix } = VARIANTS[variant];
  const png = new PNG({ width: size, height: size });
  // Letter bounding box: centered, ~60% of icon size.
  const letterBoxH = Math.floor(size * 0.6);
  const letterBoxW = Math.floor((letterBoxH * LETTER_W) / LETTER_H);
  const pxPerX = letterBoxW / LETTER_W;
  const pxPerY = letterBoxH / LETTER_H;
  const offsetX = Math.floor((size - letterBoxW) / 2);
  const offsetY = Math.floor((size - letterBoxH) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;

      // Start with the variant background color.
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 0xff;

      // Draw the letter if we're inside the bbox.
      const lx = x - offsetX;
      const ly = y - offsetY;
      if (lx >= 0 && lx < letterBoxW && ly >= 0 && ly < letterBoxH) {
        const charX = Math.floor(lx / pxPerX);
        const charY = Math.floor(ly / pxPerY);
        if (
          charX >= 0 &&
          charX < LETTER_W &&
          charY >= 0 &&
          charY < LETTER_H &&
          LETTER_G[charY][charX] === "1"
        ) {
          png.data[idx] = 0xff;
          png.data[idx + 1] = 0xff;
          png.data[idx + 2] = 0xff;
          png.data[idx + 3] = 0xff;
        }
      }
    }
  }

  const filename = join(iconsDir, `icon-${size}${suffix}.png`);
  writeFileSync(filename, PNG.sync.write(png));
  console.log(`wrote ${filename} (${size}×${size}, ${variant})`);
}

for (const variant of Object.keys(VARIANTS)) {
  for (const size of [16, 48, 128]) makeIcon(size, variant);
}
console.log("done");
