import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
let scale = 1;
const svgPaths = [];

for (const arg of args) {
  const scaleMatch = arg.match(/^--scale=(\d+(?:\.\d+)?)$/);
  if (scaleMatch) {
    scale = Number(scaleMatch[1]);
  } else {
    svgPaths.push(arg);
  }
}

if (svgPaths.length === 0) {
  console.error(
    "usage: bun scripts/export-svg-png.js [--scale=2] <file.svg> [...]",
  );
  process.exit(1);
}

for (const svgPath of svgPaths) {
  const absolutePath = resolve(svgPath);
  const svg = await Bun.file(absolutePath).text();
  const width = readNumericAttr(svg, "width");
  const height = readNumericAttr(svg, "height");
  const outputWidth = Math.round(width * scale);
  const outputHeight = Math.round(height * scale);
  const suffix = scale === 1 ? "" : `@${formatScale(scale)}x`;
  const pngPath = absolutePath.replace(/\.svg$/i, `${suffix}.png`);

  await using view = new Bun.WebView({
    width: outputWidth,
    height: outputHeight,
    dataStore: "ephemeral",
  });

  const fileUrl = pathToFileURL(absolutePath).href;
  if (scale === 1) {
    await view.navigate(fileUrl);
    await view.evaluate("document.fonts.ready");
  } else {
    await view.navigate(
      `data:text/html;charset=utf-8,${encodeURIComponent(renderHtml(fileUrl))}`,
    );
    await view.evaluate(`new Promise((resolve, reject) => {
      const img = document.querySelector("img");
      if (img.complete) {
        resolve();
        return;
      }
      img.onload = resolve;
      img.onerror = () => reject(new Error("SVG image failed to load"));
    })`);
  }
  await Bun.write(pngPath, await view.screenshot());

  // Bun WebView screenshots may use the display scale factor. Normalize to the
  // SVG canvas size so the PNG dimensions stay predictable.
  const resize = spawnSync(
    "sips",
    ["-z", String(outputHeight), String(outputWidth), pngPath],
    { stdio: "inherit" },
  );
  if (resize.status !== 0) process.exit(resize.status ?? 1);

  console.log(`wrote ${pngPath}`);
}

function readNumericAttr(svg, name) {
  const match = svg.match(new RegExp(`${name}="([0-9]+(?:\\.[0-9]+)?)"`));
  if (!match) throw new Error(`missing SVG ${name} attribute`);
  return Number(match[1]);
}

function renderHtml(fileUrl) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
img { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body><img src="${escapeHtml(fileUrl)}" alt=""></body>
</html>`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function formatScale(value) {
  return Number.isInteger(value)
    ? String(value)
    : String(value).replace(".", "_");
}
