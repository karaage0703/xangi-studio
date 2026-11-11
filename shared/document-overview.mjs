// Keep content descriptions separate from review findings.
/** @returns {{label: string, text: string}[]} */
export function documentOverviews(reviews) {
  const first = reviews
    .filter((r) => r.document)
    .sort((a, b) => a.document.page - b.document.page)[0];
  if (!first) return [];
  return (first.explanations ?? [])
    .filter(
      (e) =>
        /^(?:\[[^\]]+\]\s*)?資料全体の概要$/.test(e.heading ?? "") &&
        e.summary?.trim(),
    )
    .map((e) => ({ label: e.heading, text: e.summary.trim() }));
}
