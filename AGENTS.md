# AGENTS.md

## Purpose

This repository stores long-form WeChat public account articles and their SVG cover images. Use this guide when drafting or revising articles in the current project, especially for Go, Docker, runtime, SDK migration, tooling, and release-analysis topics.

## Repository Pattern

Existing references:

- `articles/2026/08/20/docker.md`: Docker Engine v29, Moby v2, SDK migration, compatibility risks, and upgrade actions.
- `articles/2026/08/21/go127.md`: Go 1.27 release analysis, standard library changes, runtime diagnostics, tooling updates, and upgrade checklist.
- `articles/2026/08/23/go-generic-method.md`: Go 1.27 generic methods, language comparison, and Go generics limitations.
- `articles/2026/08/*/image.svg`: 2350x1000 SVG covers for WeChat article sharing.

Article directories use a nested date path under `articles/`: `articles/YYYY/MM/DD/`. The main article is Markdown. The cover image is `image.svg` in the same day directory.

Article metadata uses HTML comments near the top of the Markdown file:

- `<!-- summary: ... -->` for the article summary.
- `<!-- tags: tag1, tag2, tag3 -->` for one or more tags. Tags must use English text only, and may be separated by English commas, Chinese commas, or Chinese enumeration commas.

## Writing Style

Write the article body in Chinese. Keep the technical tone calm, concrete, and engineering-oriented.

Prefer this structure:

1. A direct H1 title with one core claim.
2. A short intro that explains why the topic matters now.
3. An early summary table for the main changes or decisions.
4. Numbered sections with concrete examples, code snippets, and migration notes.
5. A practical checklist before the conclusion.
6. A conclusion that restates the engineering meaning, not just the feature list.

Do not write a translation of release notes. Reorder information by developer impact:

- What changed.
- Why it changed.
- Who is affected.
- What breaks.
- What to do next.

Use tables when comparing versions, boundaries, compatibility risks, or migration paths. Use short Go code examples when explaining API shape. Avoid unexplained jargon, hype, and marketing language.

All fenced code snippets in Markdown articles must use two-space indentation. Do not use tabs or four-space indentation inside article code blocks.

## New Article Target

Draft target file:

- `articles/2026/08/23/go-generic-method.md`

Working topic:

- Go 1.27 generic methods.
- Explain why Go methods historically could not declare their own type parameters.
- Explain the new syntax, what it enables, and what it still does not enable.
- Connect the feature to API design, fluent pipelines, collections, parsers, builders, and library ergonomics.

Suggested main title:

```markdown
# Go 1.27 的 generic methods：为什么等了这么久，它真正改变了什么
```

## Suggested Outline

### Intro: A long-missing piece in Go generics.

Open with the practical pain point: since Go 1.18, types could be generic, functions could be generic, but methods could not introduce their own type parameters. This forced some APIs into package-level helper functions even when the operation naturally belonged to a type.

Make the framing clear:

- This is an API ergonomics improvement.
- It does not make Go a higher-kinded type or trait language.
- The most important effect is moving some generic operations back into method namespaces.

### Section 1: The old limitation.

Show the previous shape:

```go
type Stream[T any] struct {
	items []T
}

func Map[T, U any](s Stream[T], fn func(T) U) Stream[U] {
	out := make([]U, 0, len(s.items))
	for _, item := range s.items {
		out = append(out, fn(item))
	}
	return Stream[U]{items: out}
}
```

Explain why this worked but felt awkward:

- The receiver type had a namespace, but transformation functions had to live outside it.
- Chained APIs needed free functions or extra wrapper types.
- Library authors had to choose between fluent APIs and type-changing operations.

### Section 2: The new syntax.

Show the Go 1.27 style:

```go
type Stream[T any] struct {
	items []T
}

func (s Stream[T]) Map[U any](fn func(T) U) Stream[U] {
	out := make([]U, 0, len(s.items))
	for _, item := range s.items {
		out = append(out, fn(item))
	}
	return Stream[U]{items: out}
}
```

Explain the two layers of type parameters:

- `T` belongs to the receiver type.
- `U` belongs to the method declaration.

Then show a compact call site:

```go
names := Stream[User]{items: users}.Map(func(user User) string {
	return user.Name
})
```

### Section 3: What this unlocks.

Use examples that feel practical:

- Collection and stream transformations: `Map`, `FlatMap`, `Collect`.
- Parser combinators: `Parser[T].Then[U]`.
- Typed builders: `Query[T].Select[U]`.
- Result-like helpers: `Result[T].Then[U]`.
- Test fixtures and decode helpers that transform typed state.

Emphasize that the improvement is not only fewer characters. It lets APIs group related operations under the receiver type and makes autocomplete, documentation, and discoverability better.

### Section 4: What it still does not do.

Be explicit about limitations:

- Generic methods do not turn Go interfaces into Rust traits or Haskell type classes.
- If interface methods cannot declare their own type parameters, generic methods remain primarily a concrete-type API feature.
- Avoid designing frameworks that depend on deep chains of type-changing methods if a simple generic function is clearer.
- Type inference is helpful but should not be treated as a substitute for clear API names.

Use one cautionary example where a free function remains better than a method.

### Section 5: API design guidance.

Give practical rules:

- Use a generic method when the operation conceptually belongs to the receiver and changes or introduces a type.
- Use a generic function when there is no clear receiver ownership.
- Keep receiver type parameters and method type parameters visually distinct in names and examples.
- Avoid overloading method chains with too many inferred type transitions.
- Add tests around type inference call sites and public examples.

### Section 6: Migration advice.

Explain how to update existing libraries:

1. Do not mass-convert every generic function into a method.
2. Start with APIs that users already think of as receiver-owned operations.
3. Keep old free functions as wrappers for one release if compatibility matters.
4. Update documentation examples before touching internal helpers.
5. Run examples and public API checks after migration.

### Conclusion: A small syntax change with real library-design impact.

Close with this point: generic methods mainly fix a mismatch between Go's type namespace and generic function expressiveness. They make some APIs more natural, but good Go design still rewards small surfaces, explicit ownership, and simple call sites.

## Cover SVG Design

Create a 2350x1000 SVG named `image.svg` alongside the article. Match the repository's existing cover style:

- Canvas: `width="2350" height="1000" viewBox="0 0 2350 1000"`.
- Typography: use `Avenir Next`, `Inter`, `Helvetica Neue`, `PingFang SC`, and fallback sans-serif.
- Letter spacing must be `0`.
- Use normal text weight on cover SVGs. Do not add explicit `font-weight` attributes.
- Keep the visual geometry precise and evenly spaced.
- Use real text, not outlined text paths.
- Keep the cover readable at thumbnail size.

Recommended art direction:

- Theme: Go cyan on a light technical paper background, continuing the `go127` visual family.
- Background: pale blue-white paper gradient with subtle grid or curved flow lines.
- Main object: a concrete technical diagram or topic-specific mark on the right.
- Core metaphor: a concise generic method signature anchoring the lower-left area.
- Avoid decorative blobs. If soft background highlights are used, keep them subtle and aligned.
- Do not add mid-page code cards, node boxes, arrow chains, or a bottom chip strip unless explicitly requested.

Suggested layout:

- Left text block at `x=170`, vertically starting around `y=170`.
- Eyebrow: `GO 1.27`.
- Main headline split across two lines:
  - `Generic Methods`
  - `泛型方法终于来了`
- Lower-left code signature:
  - `func (s Stream[T]) Map[U any](...)`.
  - `receiver type params meet method type params`.
- Right visual:
  - Use a concrete technical structure diagram or a compact set of topic-specific icons that explains the article topic; do not force every cover into a flowchart.
  - For runtime or migration topics, show clear before/after or layer relationships, such as source implementation, runtime core, ownership/lifecycle, API surface, compatibility boundary, and flow arrows.
  - For security and incident-analysis topics, the right visual may use symbolic attack indicators such as shields, cracked package marks, terminal windows, alert marks, network nodes, or lock/key motifs, without explanatory text inside the visual.
  - Keep enough whitespace around the right-side visual.
- Use cyan, teal, and amber accents so the image is not one-note.

Suggested color palette:

```text
Background: #fbfdff, #edfaff, #f5f2e9
Primary cyan: #00add8
Teal: #12c7b8
Dark text: #0b2533
Muted text: #5b6f79
Amber accent: #f6b73c
Panel fill: #ffffff
Panel border: #b7e8f2
```

SVG implementation notes:

- Prefer explicit coordinates over complex responsive logic.
- Use `rx` consistently, around `22` to `28`, for visual continuity with existing covers.
- Do not use SVG filters or drop shadows in cover images. Avoid `filter`, `feDropShadow`, and shadow-like effects.
- Do not let text overlap with the right-side visual or pipeline diagram.

## Table SVG Assets

When turning Markdown tables into standalone SVG/PNG assets:

- Generate separate SVG and PNG files alongside the article. Do not replace or embed the image back into the Markdown article unless explicitly requested.
- Do not add a title above the table image. The image should contain only the table.
- Keep the table canvas as compact as the content allows. Column widths should wrap the longest cell text plus reasonable inner padding, instead of using a fixed wide canvas.
- Keep all cell text on one line whenever practical. Prefer adjusting column widths over wrapping text.
- Use consistent cell padding. The first column should not feel cramped, especially for mixed Chinese/English labels.
- Do not use alternating row background colors. Keep the table body on a single clean white background, using borders/grid lines for row separation.
- Keep header styling consistent with the article visual family: cyan/teal/amber accents, dark text, subtle grid paper background, and restrained shadow.
- Prefer `PingFang SC, Avenir Next, Helvetica Neue, sans-serif` for mixed Chinese/English table text to reduce baseline drift in PNG export. Use monospace only for code, commands, target triples, and environment variables.
- After editing table SVGs, export PNG files at the SVG's native width and height with `rsvg-convert`, verify dimensions with `sips`, and visually inspect the PNG for clipping, overlap, cramped padding, and excessive empty columns.

## Cover PNG Export

After creating or updating `image.svg`, export PNG assets from the article directory with `rsvg-convert` and verify dimensions with `sips`.

Use this command pattern:

```bash
rsvg-convert -w 2350 -h 1000 image.svg -o image.png && rsvg-convert -w 4700 -h 2000 image.svg -o image@2x.png && sips -g pixelWidth -g pixelHeight image.png image@2x.png
```

Expected dimensions:

- `image.png`: 2350x1000.
- `image@2x.png`: 4700x2000.

## Article Quality Checklist

Before considering the article ready:

- The intro explains the real developer pain, not just the syntax.
- The first table summarizes old vs new vs still unsupported.
- Every code example compiles conceptually and uses simple names.
- The article distinguishes generic receiver parameters from method parameters.
- Limitations are explained clearly before the migration advice.
- The final checklist gives concrete actions for library authors.
- The SVG cover has consistent spacing, readable hierarchy, and no overlapping text.
- The Markdown article and SVG both end with a final newline.
