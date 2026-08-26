import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const svgPaths = process.argv.slice(2);
if (svgPaths.length === 0) {
  console.error("usage: bun scripts/export-svg-png.js <file.svg> [...]");
  process.exit(1);
}

for (const svgPath of svgPaths) {
  const absolutePath = resolve(svgPath);
  const svg = await Bun.file(absolutePath).text();
  const width = readNumericAttr(svg, "width");
  const height = readNumericAttr(svg, "height");
  const pngPath = absolutePath.replace(/\.svg$/i, ".png");

  await using view = new Bun.WebView({
    width,
    height,
    dataStore: "ephemeral",
  });

  await view.navigate(pathToFileURL(absolutePath).href);
  await view.evaluate("document.fonts.ready");
  await Bun.write(pngPath, await view.screenshot());

  // Bun WebView screenshots may use the display scale factor. Normalize to the
  // SVG canvas size so the PNG dimensions stay predictable.
  const resize = spawnSync("sips", ["-z", String(height), String(width), pngPath], {
    stdio: "inherit",
  });
  if (resize.status !== 0) process.exit(resize.status ?? 1);

  console.log(`wrote ${pngPath}`);
}

function readNumericAttr(svg, name) {
  const match = svg.match(new RegExp(`${name}="([0-9]+(?:\\.[0-9]+)?)"`));
  if (!match) throw new Error(`missing SVG ${name} attribute`);
  return Number(match[1]);
}
