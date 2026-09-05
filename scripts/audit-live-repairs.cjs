const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.loadEnvFile('.env.local');
const { readState, readJson } = require('../api/_lib/store');
const review = require('../review_data.json');
const repair = require('../api/_lib/surname-repair');
async function main() {
  const state = await readState();
  if (!state?.curation?.records) throw Error('No live curation');
  const dir = path.resolve('audits', `studio-health-${new Date().toISOString().replace(/[:.]/g, '-')}-r${state.revision}`);
  fs.mkdirSync(dir, { recursive: true });
  const raw = JSON.stringify(state, null, 2);
  fs.writeFileSync(path.join(dir, 'live-before.json'), raw, { flag: 'wx' });
  const banks = { markdown: await readJson('panic:name-review:v12:uploaded-name-banks'), iconic: await readJson('panic:name-review:v12:iconic-bank') };
  fs.writeFileSync(path.join(dir, 'shared-banks-backup.json'), JSON.stringify(banks,null,2), { flag:'wx' });
  const rows = [];
  for (const c of review.characters) {
    const record = state.curation.records[String(c.id)];
    if (!record || !repair.shouldOfferRepair(c, record, state)) continue;
    const proposals = repair.repairCandidates(c, record, state);
    const safety = repair.safeAutomaticRepair(proposals);
    rows.push({ id:c.id, clothing:c.clothing, first:record.parts?.first?.replacement_value || c.first, surname:repair.liveSurname(c,record), stored_route:record.parts?.surname_part_1?.replacement_trait_source || '', traits:c.traits, decisions:Object.fromEntries(Object.entries(record.parts||{}).map(([k,v])=>[k,v.decision||null])), safe:safety.safe, reason:safety.reason, proposals });
  }
  fs.writeFileSync(path.join(dir,'repair-audit.json'), JSON.stringify(rows,null,2));
  const clothing=Object.fromEntries([...new Set(review.characters.map(c=>c.clothing).filter(Boolean))].sort().map(name=>[name,{characters:review.characters.filter(c=>c.clothing===name).length,flagged:0,safe:0}])); for(const row of rows) { clothing[row.clothing].flagged++; if(row.safe) clothing[row.clothing].safe++; }
  const summary={directory:dir,revision:state.revision,backup_sha256:crypto.createHash('sha256').update(raw).digest('hex'),flagged:rows.length,safe:rows.filter(r=>r.safe).length,clothing};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
  const q=x=>'"'+String(x??'').replaceAll('"','""')+'"';
  const headers=['id','clothing','first','surname','stored_route','reason','decisions'];
  fs.writeFileSync(path.join(dir,'surname-source-review.csv'),[headers.join(','),...rows.sort((a,b)=>a.clothing.localeCompare(b.clothing)||Number(a.id)-Number(b.id)).map(r=>headers.map(k=>q(k==='decisions'?JSON.stringify(r[k]):r[k])).join(','))].join('\n'));
  const md=['# Name Studio source audit',`Live revision: ${state.revision}. Characters inspected: ${review.characters.length}.`, '',`${rows.length} Western surnames need source review; ${summary.safe} have a supported automatic two-trait repair. No live names, decisions, or banks were changed by this audit.`, '', 'A missing second source cannot be recovered by attaching a convenient trait. Names originally selected from one trait or containing invented suffixes need an artist decision before they can satisfy the two-distinct-trait rule.', '', '| Clothing | Characters | Needs review | Automatic |','|---|---:|---:|---:|',...Object.entries(clothing).map(([name,v])=>`| ${name} | ${v.characters} | ${v.flagged} | ${v.safe} |`),'','## Each unresolved character','',...rows.map(r=>`- #${r.id} **${r.first} ${r.surname}** (${r.clothing}) — stored route: ${r.stored_route}. ${r.reason}. Decisions: ${JSON.stringify(r.decisions)}.`),'','## Backups','', '- live-before.json: complete shared state, including decisions and provenance.','- shared-banks-backup.json: shared uploaded Markdown and Iconic banks.','- surname-source-review.csv: artist review list.','- repair-audit.json: detailed audit including traits and candidate evidence.','- summary.json: counts and backup hash.'];
  fs.writeFileSync(path.join(dir,'ARTIST-REVIEW.md'),md.join('\n'));
  console.log(JSON.stringify(summary,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
