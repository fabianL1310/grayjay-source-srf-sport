#!/usr/bin/env node
/**
 * fetch-sport-icons.js
 *
 * Finds every ".st-sport.<name>" CSS rule that embeds an inline SVG via a
 * data:image/svg+xml,... URI (used for mask / -webkit-mask / mask-image /
 * background-image), decodes it, and saves each icon as a rasterized .png
 * (transparent background, colors left untouched) so it renders on platforms
 * whose image pipeline can't decode SVG (e.g. Grayjay on mobile).
 *
 * Requires Node.js 18+ (uses built-in fetch) and the `sharp` package.
 *
 * USAGE
 * -----
 *   node fetch-sport-icons.js <css-url-or-local-file> [output-dir]
 *
 * The output-dir defaults to `dist/icons` when omitted.
 *
 * EXAMPLE
 * -------
 *   node fetch-sport-icons.js https://lrc.swisstxt.ch/srf/assets/main-XXXX.css
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// Default output directory, used when none is passed on the command line.
const DEFAULT_OUT_DIR = "dist/icons";

// Rendered PNG canvas size (square, in pixels).
const PNG_SIZE = 512;
const PNG_PADDING_RATIO = 0.12; // fraction of the canvas reserved as padding

// Overrides for icons whose SRF sprite entry is unusable. `wintersport` ships
// only as a tiny embedded bitmap (blurry when scaled), so reuse the crisp
// vector `ski-nordic` glyph rotated 60° instead.
const ICON_OVERRIDES = {
  wintersport: { from: "ski-nordic", rotate: 30 },
};

// Wrap an SVG's contents in a rotation transform (degrees, clockwise) about
// the center of its viewBox, so both the .svg and rasterized .png are rotated.
function rotateSvg(svg, degrees) {
  if (!degrees) return svg;

  let cx = 0;
  let cy = 0;
  const viewBox = svg.match(/viewBox\s*=\s*["']\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)/i);
  if (viewBox) {
    const [, minX, minY, w, h] = viewBox.map(Number);
    cx = minX + w / 2;
    cy = minY + h / 2;
  }

  return svg
    .replace(/(<svg\b[^>]*>)/i, `$1<g transform="rotate(${degrees} ${cx} ${cy})">`)
    .replace(/<\/svg>\s*$/i, "</g></svg>");
}

// Rasterize a single SVG string into a padded, transparent PNG buffer. The
// icon's original colors are left untouched.
async function svgToPng(svg) {
  const glyph = Math.round(PNG_SIZE * (1 - 2 * PNG_PADDING_RATIO));
  const glyphPng = await sharp(Buffer.from(svg), { density: 384 })
    .resize(glyph, glyph, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const pad = Math.round((PNG_SIZE - glyph) / 2);
  return sharp(glyphPng)
    .extend({
      top: pad,
      bottom: PNG_SIZE - glyph - pad,
      left: pad,
      right: PNG_SIZE - glyph - pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function loadCss(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Failed to fetch CSS: ${res.status} ${res.statusText}`);
    return await res.text();
  }
  return fs.readFileSync(source, "utf-8");
}

// Finds the start of each ".st-sport.<name>{" rule.
const CLASS_RE = /\.st-sport\.([a-zA-Z0-9_-]+)\s*\{/g;

// From that point forward, finds the next url("data:image/svg+xml,....")
// (or with single quotes). Uses a backreference to the opening quote so
// literal braces/quotes *inside* the SVG data itself don't break matching.
const DATA_URI_RE = /url\(\s*(["'])data:image\/svg\+xml,([\s\S]*?)\1\s*\)/i;

function extractIcons(css) {
  const icons = {};
  let match;
  CLASS_RE.lastIndex = 0;
  while ((match = CLASS_RE.exec(css)) !== null) {
    const name = match[1];
    const rest = css.slice(CLASS_RE.lastIndex);
    const uriMatch = DATA_URI_RE.exec(rest);
    if (!uriMatch) continue;
    const encoded = uriMatch[2];
    try {
      icons[name] = decodeURIComponent(encoded);
    } catch (e) {
      console.warn(`  warning: couldn't decode icon "${name}": ${e.message}`);
    }
  }
  return icons;
}

async function main() {
  const [, , source, outDirArg] = process.argv;

  if (!source) {
    console.log("Usage: node fetch-sport-icons.js <css-url-or-file> [output-dir]");
    process.exit(1);
  }

  const outDir = outDirArg || DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Loading CSS from: ${source}`);
  const css = await loadCss(source);

  const icons = extractIcons(css);

  // Apply overrides (e.g. wintersport -> rotated ski-nordic).
  for (const [name, { from, rotate }] of Object.entries(ICON_OVERRIDES)) {
    const source = icons[from];
    if (source) {
      icons[name] = rotateSvg(source, rotate);
    } else {
      console.warn(`  warning: override source "${from}" for "${name}" not found`);
    }
  }

  const names = Object.keys(icons);

  if (names.length === 0) {
    console.log("\nNo '.st-sport.<name>' icons with inline SVG data-URIs found.");
    console.log("Open the CSS file in a text editor and search for 'st-sport' to");
    console.log("confirm it's the right bundle and the pattern still matches.");
    process.exit(1);
  }

  for (const name of names) {
    const pngPath = path.join(outDir, `${name}.png`);
    try {
      const png = await svgToPng(icons[name]);
      fs.writeFileSync(pngPath, png);
      console.log(`  saved ${pngPath}`);
    } catch (e) {
      console.warn(`  warning: couldn't rasterize icon "${name}": ${e.message}`);
    }
  }

  console.log(`\nDone. Extracted ${names.length} icon(s) into '${outDir}/'.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
