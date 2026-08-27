function clean(value) {
  return String(value || "").replace(/\*\*/g, "").trim();
}

function parseMarkdownNameBank(markdown, metadata = {}) {
  const raw = String(markdown || "");
  const header = Object.fromEntries(
    [...raw.matchAll(/^\*\*(Clothing|Gender|Version):\*\*\s*(.+)$/gim)]
      .map((match) => [match[1].toLowerCase(), clean(match[2])])
  );
  const entries = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  let tier = "Unranked";
  for (const line of lines) {
    const heading = line.match(/^#{2,6}\s+(.+)$/);
    if (heading) {
      const tierMatch = heading[1].match(/\b([SABC])-?tier\b/i);
      tier = tierMatch ? `${tierMatch[1].toUpperCase()}-tier` : clean(heading[1]);
      continue;
    }
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(clean);
    if (!cells.length || cells.every((cell) => /^-+$/.test(cell))) continue;
    if (/^(rank|name|full name)$/i.test(cells[0])) continue;
    const possibleName = /^\d+$/.test(cells[0]) ? cells[1] : cells[0];
    const name = clean(possibleName).split(/\s+/)[0];
    if (!/^[A-Za-z][A-Za-z'-]{1,23}$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      name,
      tier,
      reference: clean(cells[2] || cells[1] || ""),
      status: "available",
    });
  }
  return {
    clothing: metadata.clothing || header.clothing || "",
    gender: metadata.gender || header.gender || "",
    version: metadata.version || header.version || "",
    entries,
  };
}

module.exports = { parseMarkdownNameBank };
