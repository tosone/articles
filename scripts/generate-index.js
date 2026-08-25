#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const articlePattern = /^\d{4}\/\d{2}\/\d{2}\/[^/]+\.md$/;

const articles = walk(root)
  .map((file) => path.relative(root, file).split(path.sep).join("/"))
  .filter((file) => articlePattern.test(file))
  .map(readArticle)
  .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));

writeJson();
writeReadme();

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules") {
      return [];
    }
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function readArticle(articlePath) {
  const markdown = fs.readFileSync(path.join(root, articlePath), "utf8");
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const title = readTitle(lines, articlePath);
  const summary = readSummary(markdown, lines);
  const tags = readTags(markdown);
  const cover = articlePath.replace(/[^/]+\.md$/, "image.svg");

  return {
    date: articlePath.slice(0, 10).replaceAll("/", "-"),
    title,
    path: articlePath,
    cover: fs.existsSync(path.join(root, cover)) ? cover : "",
    summary,
    tags,
  };
}

function readTitle(lines, articlePath) {
  const title = lines.find((line) => line.startsWith("# "));
  if (!title) {
    throw new Error(`Missing H1 title: ${articlePath}`);
  }
  return title.slice(2).trim();
}

function readSummary(markdown, lines) {
  const marked = markdown.match(/<!--\s*summary:\s*([\s\S]*?)\s*-->/i);
  if (marked) {
    return summaryText(marked[1].replace(/\s+/g, " "));
  }

  for (const line of lines) {
    if (line.startsWith("# ")) {
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    if (line.trim().startsWith("<!--")) {
      continue;
    }
    if (
      line.startsWith("```") ||
      line.startsWith("|") ||
      line.startsWith("## ")
    ) {
      continue;
    }
    return summaryText(line);
  }

  return "";
}

function readTags(markdown) {
  const marked = markdown.match(/<!--\s*tags:\s*([\s\S]*?)\s*-->/i);
  if (!marked) {
    return [];
  }
  return marked[1]
    .split(/[,，、]/)
    .map((tag) => plainText(tag))
    .filter(Boolean);
}

function summaryText(value) {
  const text = plainText(value);
  if (text.length <= 120) {
    return text;
  }

  const end = Math.max(
    text.lastIndexOf("。", 119),
    text.lastIndexOf("！", 119),
    text.lastIndexOf("？", 119),
    text.lastIndexOf(".", 119),
  );
  return end >= 40 ? text.slice(0, end + 1) : `${text.slice(0, 117)}...`;
}

function plainText(value) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function writeJson() {
  fs.writeFileSync(
    path.join(root, "articles.json"),
    `${JSON.stringify(articles, null, 2)}\n`,
  );
}

function writeReadme() {
  const readmePath = path.join(root, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const beforeList = readme.split("## 文章列表")[0].trimEnd();
  const rows = articles
    .map((article) => {
      const title = escapeTable(
        `[${article.title}](./${encodeURI(article.path).replaceAll("%2F", "/")})`,
      );
      return `| ${article.date} | ${title} |`;
    })
    .join("\n");

  fs.writeFileSync(
    readmePath,
    `${beforeList}\n\n## 文章列表\n\n| 日期 | 标题 |\n| --- | --- |\n${rows}\n`,
  );
}

function escapeTable(value) {
  return value.replaceAll("|", "\\|");
}
