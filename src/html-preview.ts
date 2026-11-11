export type PreviewFile = { file: string; content: string };

// Parse in an inert document; never attach imported nodes to the Studio DOM.
export function buildHtmlPreview(
  content: string,
  file: string,
  files: PreviewFile[],
) {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const sources = new Map(files.map((item) => [item.file, item.content]));
  const warnings = new Set<string>();
  const resolve = (reference: string, from: string): string | null => {
    if (!reference || /^(?:[a-z][\w+.-]*:|\/\/|\/|#)/i.test(reference))
      return null;
    try {
      const base = new URL(
        from.split("/").map(encodeURIComponent).join("/"),
        "https://preview.invalid/",
      );
      const path = decodeURIComponent(new URL(reference, base).pathname).slice(
        1,
      );
      return sources.has(path) ? path : null;
    } catch {
      return null;
    }
  };
  const missing = (reference: string) =>
    warnings.add(`読み込めない参照: ${reference.slice(0, 160)}`);
  const dataImage = (reference: string, from: string) => {
    if (/^data:image\//i.test(reference)) return reference;
    const path = resolve(reference, from);
    if (path && /\.svg$/i.test(path))
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sources.get(path)!).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`;
    missing(reference);
    return "";
  };
  const css = (
    text: string,
    from: string,
    seen = new Set<string>(),
  ): string => {
    return text
      .replace(
        /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi,
        (_, reference: string) => {
          const path = resolve(reference, from);
          if (!path || seen.has(path)) {
            missing(reference);
            return "";
          }
          return css(sources.get(path)!, path, new Set([...seen, path]));
        },
      )
      .replace(
        /url\(\s*(["']?)(.*?)\1\s*\)/gi,
        (_, _quote: string, reference: string) =>
          reference.startsWith("#")
            ? `url("${reference}")`
            : `url("${dataImage(reference, from)}")`,
      );
  };
  doc
    .querySelectorAll("base, iframe, object, embed, meta[http-equiv]")
    .forEach((node) => node.remove());
  for (const link of doc.querySelectorAll("link")) {
    if (link.rel.toLowerCase() === "stylesheet") {
      const path = resolve(link.getAttribute("href") ?? "", file);
      if (path) {
        const style = doc.createElement("style");
        style.textContent = css(sources.get(path)!, path).replace(
          /<\/style/gi,
          "<\\/style",
        );
        if (link.media) style.media = link.media;
        link.replaceWith(style);
        continue;
      }
      missing(link.getAttribute("href") ?? "stylesheet");
    }
    link.remove();
  }
  for (const style of doc.querySelectorAll("style"))
    style.textContent = css(style.textContent ?? "", file);
  for (const node of doc.querySelectorAll<HTMLElement>("[style]"))
    node.setAttribute("style", css(node.getAttribute("style") ?? "", file));
  for (const script of doc.querySelectorAll("script[src]")) {
    const reference = script.getAttribute("src") ?? "";
    const path = resolve(reference, file);
    if (!path) {
      missing(reference);
      script.remove();
      continue;
    }
    const source = sources.get(path)!;
    if (
      script.getAttribute("type") === "module" &&
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](?!data:)/.test(source)
    ) {
      warnings.add(
        "モジュールの相対参照には対応していません。ビルド済みの単体HTMLを開いてください。",
      );
      script.remove();
      continue;
    }
    // Keep external-script ordering (including defer/async). Data URLs avoid
    // opaque-origin requests through the authenticated extension proxy.
    script.setAttribute(
      "src",
      `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`,
    );
    script.removeAttribute("integrity");
    script.removeAttribute("crossorigin");
  }
  for (const script of doc.querySelectorAll(
    'script[type="module"]:not([src])',
  )) {
    if (
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](?!data:)/.test(
        script.textContent ?? "",
      )
    ) {
      warnings.add(
        "モジュール参照には対応していません。ビルド済みの単体HTMLを開いてください。",
      );
      script.remove();
    }
  }
  for (const image of doc.querySelectorAll(
    "img, source, video, audio, input[type=image]",
  )) {
    image.removeAttribute("srcset");
    for (const attribute of ["src", "poster"]) {
      const value = image.getAttribute(attribute);
      if (value) image.setAttribute(attribute, dataImage(value, file));
    }
  }
  for (const anchor of doc.querySelectorAll("a[href], area[href]")) {
    if (!anchor.getAttribute("href")?.startsWith("#"))
      anchor.removeAttribute("href");
    anchor.removeAttribute("target");
  }
  return {
    html: "<!doctype html>\n" + doc.documentElement.outerHTML,
    warnings: [...warnings],
  };
}
