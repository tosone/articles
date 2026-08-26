const state = {
  articles: [],
  current: null,
};

const list = document.querySelector("#article-list");
const content = document.querySelector("#content");
const coverWrap = document.querySelector("#cover-wrap");
const reader = document.querySelector(".reader");
const contentRoot = location.pathname.includes("/web/") ? "../" : "./";
let shikiModule;

init().catch((error) => {
  content.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
});

async function init() {
  const response = await fetch("./articles.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to load articles.json.");
  }

  state.articles = (await response.json()).sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  renderList(state.articles);

  const initialPath = decodeURIComponent(location.hash.replace(/^#/, ""));
  const initial =
    state.articles.find((article) => article.path === initialPath) ||
    state.articles[0];
  if (initial) {
    await openArticle(initial);
  }
}

function renderList(articles) {
  list.innerHTML = articles
    .map((article) => {
      const active = state.current?.path === article.path ? " active" : "";
      const tags = (article.tags || [])
        .map(
          (tag) =>
            `<a class="article-tag" href="./tags.html?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`,
        )
        .join("");
      return `
      <div class="article-link${active}">
        <button class="article-open" type="button" data-path="${escapeAttr(article.path)}">
          <span class="article-date">${escapeHtml(article.date)}</span>
          <span class="article-title">${escapeHtml(article.title)}</span>
        </button>
        ${tags ? `<span class="article-tags">${tags}</span>` : ""}
        <span class="article-summary">${escapeHtml(article.summary)}</span>
      </div>
    `;
    })
    .join("");

  list.querySelectorAll(".article-open").forEach((button) => {
    button.addEventListener("click", () => {
      const article = state.articles.find(
        (item) => item.path === button.dataset.path,
      );
      if (article) {
        openArticle(article);
      }
    });
  });
}

async function openArticle(article) {
  const hadArticle = Boolean(state.current);
  const loadId = Symbol(article.path);
  state.current = article;
  state.loadId = loadId;
  location.hash = encodeURIComponent(article.path);
  renderList(state.articles);

  const response = await fetch(`${contentRoot}${article.path}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load article: ${article.path}`);
  }

  if (state.loadId !== loadId) {
    return;
  }

  const markdown = await response.text();
  const coverHtml = await renderCover(article);
  if (state.loadId !== loadId) {
    return;
  }

  const updateArticle = () => {
    coverWrap.innerHTML = coverHtml;
    content.innerHTML = renderMarkdown(markdown, article.path);
    document.title = `${article.title} - Articles`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (
    hadArticle &&
    document.startViewTransition &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    const transition = document.startViewTransition(updateArticle);
    await transition.finished;
  } else {
    updateArticle();
    restartReaderAnimation();
  }

  await highlightCodeBlocks(article.path);
}

async function renderCover(article) {
  if (!article.cover) {
    return "";
  }
  const src = `${contentRoot}${article.cover}`;

  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(article.title)}">`;
  }
  return await response.text();
}

function restartReaderAnimation() {
  reader.classList.remove("reader-enter");
  void reader.offsetWidth;
  reader.classList.add("reader-enter");
}

function renderMarkdown(markdown, articlePath = "") {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let table = [];
  let pendingTableSvg = null;
  let quote = [];
  let inCode = false;
  let inComment = false;
  let codeLang = "text";
  let code = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = "";
  };

  const flushTable = () => {
    if (!table.length) {
      return;
    }
    const rows = table.filter(
      (row) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row),
    );
    if (pendingTableSvg) {
      const src = resolveArticleAsset(articlePath, pendingTableSvg.path);
      const maxHeight =
        pendingTableSvg.maxHeight || tableSvgMaxHeight(rows.length);
      html.push(
        `<figure class="table-svg" style="--table-svg-max-height: ${maxHeight}px"><img src="${escapeAttr(src)}" alt=""></figure>`,
      );
      table = [];
      pendingTableSvg = null;
      return;
    }
    const cells = rows.map((row) => splitTableRow(row));
    const [head, ...body] = cells;
    html.push("<table>");
    if (head) {
      html.push(
        `<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`,
      );
    }
    if (body.length) {
      html.push(
        `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
      );
    }
    html.push("</table>");
    table = [];
  };

  const flushQuote = () => {
    if (!quote.length) {
      return;
    }
    const blocks = [];
    let items = [];
    let text = [];
    const flushText = () => {
      if (text.length) {
        blocks.push(`<p>${inline(text.join(" "))}</p>`);
        text = [];
      }
    };
    const flushItems = () => {
      if (items.length) {
        blocks.push(
          `<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`,
        );
        items = [];
      }
    };

    for (const line of quote) {
      const item = line.match(/^\s*[-*]\s+(.+)$/);
      if (!line.trim()) {
        flushText();
        flushItems();
      } else if (item) {
        flushText();
        items.push(item[1]);
      } else {
        flushItems();
        text.push(line.trim());
      }
    }

    flushText();
    flushItems();
    html.push(`<blockquote>${blocks.join("")}</blockquote>`);
    quote = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
      if (inCode) {
        html.push(
          `<pre data-lang="${escapeAttr(codeLang)}"><code class="language-${escapeAttr(codeLang)}">${escapeHtml(code.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLang = "text";
        code = [];
      } else {
        inCode = true;
        codeLang = normalizeLanguage(fence[1]);
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    if (inComment) {
      if (line.includes("-->")) {
        inComment = false;
      }
      continue;
    }

    const comment = line.trim();
    const tableSvg = parseTableSvgComment(comment);
    if (tableSvg) {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
      pendingTableSvg = tableSvg;
      continue;
    }

    if (comment.startsWith("<!--")) {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
      inComment = !line.includes("-->");
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      flushQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*\|.+\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      table.push(line);
      continue;
    }

    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      flushTable();
      quote.push(quoted[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushTable();
      flushQuote();
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        flushList();
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${inline((unordered || ordered)[1])}</li>`);
      continue;
    }

    flushTable();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushTable();
  flushQuote();

  return html.join("\n");
}

async function highlightCodeBlocks(articlePath) {
  const blocks = Array.from(content.querySelectorAll("pre[data-lang]"));
  if (!blocks.length) {
    return;
  }

  try {
    shikiModule ||= import("https://esm.sh/shiki@3.0.0?bundle");
    const { codeToHtml } = await shikiModule;
    await Promise.all(
      blocks.map(async (block) => {
        const code = block.querySelector("code");
        if (!code) {
          return;
        }
        try {
          const html = await codeToHtml(code.textContent, {
            lang: block.dataset.lang || "text",
            theme: "github-dark",
          });
          if (state.current?.path === articlePath) {
            block.outerHTML = html;
          }
        } catch {
          block.dataset.highlight = "failed";
        }
      }),
    );
  } catch {
    blocks.forEach((block) => {
      block.dataset.highlight = "failed";
    });
  }
}

function normalizeLanguage(info) {
  const lang = info.trim().split(/\s+/)[0].toLowerCase();
  const aliases = {
    conf: "text",
    console: "bash",
    js: "javascript",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    txt: "text",
  };
  return aliases[lang] || lang || "text";
}

function splitTableRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function resolveArticleAsset(articlePath, assetPath) {
  if (/^(?:https?:)?\/\//.test(assetPath) || assetPath.startsWith("/")) {
    return assetPath;
  }
  const basePath = articlePath.split("/").slice(0, -1).join("/");
  return `${contentRoot}${basePath}/${assetPath}`;
}

function parseTableSvgComment(comment) {
  const match = comment.match(/^<!--\s*table-svg:\s*(.+?)\s*-->$/);
  if (!match) {
    return null;
  }

  const [path, ...options] = match[1].trim().split(/\s+/);
  const heightOption = options.find((option) =>
    /^(?:max-height|height)=\d+$/.test(option),
  );
  return {
    path,
    maxHeight: heightOption ? Number(heightOption.split("=")[1]) : 0,
  };
}

function tableSvgMaxHeight(rowCount) {
  return Math.max(180, Math.min(620, rowCount * 64));
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
