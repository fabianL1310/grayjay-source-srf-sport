const esbuild = require("esbuild");

esbuild.buildSync({
  entryPoints: ["src/source.ts"],
  bundle: true,
  outfile: "dist/script.js",
  format: "iife",
  target: "es2019",
  platform: "browser",
  minify: false,
});
