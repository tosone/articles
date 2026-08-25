const tagState = {
  articles: [],
  tags: [],
  selected: "",
};

const cloud = document.querySelector("#tag-cloud");
const title = document.querySelector("#tag-title");
const count = document.querySelector("#tag-count");
const grid = document.querySelector("#tag-articles");
const contentRoot = location.pathname.includes("/web/") ? "../" : "./";

initTags().catch((error) => {
  count.textContent = error.message;
});

async function initTags() {
  const response = await fetch("./articles.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to load articles.json.");
  }

  tagState.articles = (await response.json()).sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  tagState.tags = collectTags(tagState.articles);
  tagState.selected = getSelectedTag() || tagState.tags[0]?.text || "";

  renderTagPage();
  addEventListener("popstate", () => {
    tagState.selected = getSelectedTag() || tagState.tags[0]?.text || "";
    renderTagPage();
  });
}

function renderTagPage() {
  title.textContent = tagState.selected || "Tags";
  document.title = `${tagState.selected || "Tags"} - Articles`;
  if (cloud.hasChildNodes()) {
    updateCloudSelection();
  } else {
    renderCloud();
  }
  renderArticles();
}

function renderCloud() {
  if (!window.d3 || !window.d3.layout?.cloud) {
    renderCloudFallback();
    return;
  }

  const width = Math.max(cloud.clientWidth, 900);
  const height = 310;
  cloud.innerHTML = "";

  d3.layout
    .cloud()
    .size([width, height])
    .words(
      tagState.tags.map((tag) => ({
        text: tag.text,
        count: tag.count,
        size: 24 + tag.count * 10,
      })),
    )
    .padding(10)
    .rotate(() => 0)
    .font("Geist Variable")
    .fontSize((tag) => tag.size)
    .random(() => 0.5)
    .on("end", (words) => drawCloud(words, width, height))
    .start();
}

function drawCloud(words, width, height) {
  const svg = d3
    .select(cloud)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", "Article tag cloud");

  const group = svg
    .append("g")
    .attr("transform", `translate(${width / 2},${height / 2})`);

  group
    .selectAll("text")
    .data(words)
    .enter()
    .append("text")
    .attr("class", (tag) =>
      tag.text === tagState.selected ? "cloud-word active" : "cloud-word",
    )
    .attr("role", "button")
    .attr("tabindex", 0)
    .style("font-size", (tag) => `${tag.size}px`)
    .style("font-family", "Geist Variable, PingFang SC, sans-serif")
    .attr("text-anchor", "middle")
    .attr("transform", (tag) => `translate(${tag.x},${tag.y})`)
    .text((tag) => tag.text)
    .on("click", (_, tag) => selectTag(tag.text))
    .on("keydown", (event, tag) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectTag(tag.text);
      }
    });
}

function renderCloudFallback() {
  cloud.innerHTML = tagState.tags
    .map(
      (tag) =>
        `<button class="cloud-chip${tag.text === tagState.selected ? " active" : ""}" type="button" data-tag="${escapeAttr(tag.text)}">${escapeHtml(tag.text)}</button>`,
    )
    .join("");

  cloud.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => selectTag(button.dataset.tag));
  });
}

function updateCloudSelection() {
  cloud.querySelectorAll(".cloud-word").forEach((word) => {
    word.classList.toggle("active", word.textContent === tagState.selected);
  });
  cloud.querySelectorAll(".cloud-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.tag === tagState.selected);
  });
}

function renderArticles() {
  const articles = tagState.articles.filter((article) =>
    (article.tags || []).includes(tagState.selected),
  );

  count.textContent = `${articles.length} articles tagged ${tagState.selected}`;
  grid.innerHTML = articles
    .map(
      (article) => `
        <a class="tag-card" href="./index.html#${encodeURIComponent(article.path)}">
          <span class="article-date">${escapeHtml(article.date)}</span>
          <span class="tag-card-title">${escapeHtml(article.title)}</span>
          <span class="article-tags">
            ${(article.tags || [])
              .map(
                (tag) => `<span class="article-tag">${escapeHtml(tag)}</span>`,
              )
              .join("")}
          </span>
          <span class="article-summary">${escapeHtml(article.summary)}</span>
        </a>
      `,
    )
    .join("");
}

function collectTags(articles) {
  const counts = new Map();
  for (const article of articles) {
    for (const tag of article.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts]
    .map(([text, tagCount]) => ({ text, count: tagCount }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "zh-CN"));
}

function selectTag(tag) {
  tagState.selected = tag;
  history.pushState(null, "", `?tag=${encodeURIComponent(tag)}`);
  renderTagPage();
}

function getSelectedTag() {
  return new URLSearchParams(location.search).get("tag");
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
