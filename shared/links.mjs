/** @param {string} baseUrl @param {string} id @param {string} key @param {string} mode */
export function reviewUrl(baseUrl, id, key, mode = "preview") {
  const url = new URL(`/review/${encodeURIComponent(id)}`, baseUrl);
  url.searchParams.set("mode", mode);
  url.hash = new URLSearchParams({ key }).toString();
  return url.toString();
}

/** @param {string} url @param {string} label @param {string} platform */
export function formatLink(url, label, platform) {
  if (platform === "slack")
    return `<${url}|${label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "｜")}>`;
  if (platform === "discord")
    return `[${label.replace(/[\\[\]()]/g, "\\$&")}](${url})`;
  return url;
}
