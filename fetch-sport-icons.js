#!/usr/bin/env node
/**
 * extract_srf_icons.js
 *
 * Finds every ".st-sport.<name>" CSS rule that embeds an inline SVG via a
 * data:image/svg+xml,... URI (used for mask / -webkit-mask / mask-image /
 * background-image), decodes it, and saves each icon as its own .svg file.
 *
 * Requires Node.js 18+ (uses built-in fetch). No npm packages needed.
 *
 * USAGE
 * -----
 *   node extract_srf_icons.js <css-url-or-local-file> [output-dir]
 *
 * EXAMPLE
 * -------
 *   node extract_srf_icons.js https://lrc.swisstxt.ch/srf/assets/main-XXXX.css icons
 */

const fs = require("fs");
const path = require("path");

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
    console.log("Usage: node extract_srf_icons.js <css-url-or-file> [output-dir]");
    process.exit(1);
  }

  const outDir = outDirArg || "icons";
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Loading CSS from: ${source}`);
  const css = await loadCss(source);

  const icons = extractIcons(css);
  const names = Object.keys(icons);

  if (names.length === 0) {
    console.log("\nNo '.st-sport.<name>' icons with inline SVG data-URIs found.");
    console.log("Open the CSS file in a text editor and search for 'st-sport' to");
    console.log("confirm it's the right bundle and the pattern still matches.");
    process.exit(1);
  }

  for (const name of names) {
    const filePath = path.join(outDir, `${name}.svg`);
    fs.writeFileSync(filePath, icons[name], "utf-8");
    console.log(`  saved ${filePath}`);
  }

  console.log(`\nDone. Extracted ${names.length} icon(s) into '${outDir}/'.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});