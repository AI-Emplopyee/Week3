import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Local, read-only presentation of the frozen source evaluation. No inference,
// new scoring, production imports, or network requests occur here.
// Usage: node scripts/render-source-vision-pilot.mjs gold.json evaluation.json report.html [run-summary.json ...] [--manual-review review.json] [--format-recovery recovery.json]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const money = value => `$${value.toFixed(6)}`;
const list = items => items.length ? `<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
const quote = value => `<blockquote>${escape(value || '(No quote supplied)')}</blockquote>`;
const fieldLabel = fact => `${fact.field}${fact.rowIndex === undefined ? '' : ` · goods row ${fact.rowIndex}`}`;
const withoutFormatMetadata = outcome => {
  const copy = { ...outcome };
  delete copy.formatCompatibility;
  return copy;
};
const comparableReviewedOutcome = (outcome, recoveredPair) => {
  const copy = structuredClone(withoutFormatMetadata(outcome));
  // lib/kimi.ts gives accepted candidates fresh UUIDs on every parse. Ignore
  // only those generated identities when independently verified recoveries of
  // one original response are compared; all actual proposal content remains.
  if (recoveredPair && Array.isArray(copy.result?.candidates)) for (const candidate of copy.result.candidates) {
    if (!/^candidate-ai-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(candidate.id ?? '')) throw new Error('Recovered candidate has an unexpected generated identity.');
    delete candidate.id;
  }
  return copy;
};

/** Validate stored recovery provenance independently, without production code
 * or network access. A matching hash alone never excuses changed proposals. */
export async function verifyOutcomeFile(file, expectedHash, cache = new Map(), ancestry = new Set()) {
  if (typeof file !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('Outcome provenance requires an exact file and SHA-256.');
  const absolute = path.resolve(file), key = `${absolute}:${expectedHash}`;
  if (ancestry.has(absolute)) throw new Error(`Cyclic outcome provenance: ${absolute}`);
  if (cache.has(key)) return cache.get(key);
  const bytes = await fs.readFile(absolute);
  if (sha256(bytes) !== expectedHash) throw new Error(`Outcome fingerprint changed: ${absolute}`);
  const data = JSON.parse(bytes), metadata = data.formatCompatibility;
  let originalHash = expectedHash;
  if (metadata) {
    if (metadata.mode !== 'offline_exact_fence_recovery' || metadata.networkCalls !== 0 || metadata.sourceFieldValuesChanged !== false || typeof metadata.recovered !== 'boolean') throw new Error(`Unverified format transformation: ${absolute}`);
    const original = await verifyOutcomeFile(metadata.originalOutcomePath, metadata.originalOutcomeSha256, cache, new Set([...ancestry, absolute]));
    originalHash = original.originalHash;
    if (metadata.firstPassError !== (original.data.error ?? null) || metadata.firstPassUsable !== !original.data.error) throw new Error(`Incorrect first-pass status in provenance: ${absolute}`);
    const copy = withoutFormatMetadata(data);
    if (!metadata.recovered) {
      if (!isDeepStrictEqual(copy, original.data)) throw new Error(`Unrecovered outcome differs from its original: ${absolute}`);
    } else {
      if (metadata.classification !== 'first_pass_format_compatibility_failure' || original.data.error !== 'transport_or_validation_failure' || original.data.httpStatus !== 200 || data.error !== undefined) throw new Error(`Unsupported recovery classification: ${absolute}`);
      const originalBase = { ...original.data }, recoveredBase = { ...copy };
      delete originalBase.error;
      delete originalBase.result;
      delete recoveredBase.result;
      if (!isDeepStrictEqual(originalBase, recoveredBase)) throw new Error(`Recovery changed outcome metadata: ${absolute}`);
      const responseBytes = await fs.readFile(metadata.originalResponsePath);
      if (sha256(responseBytes) !== metadata.originalResponseSha256 || metadata.originalResponseSha256 !== original.data.rawResponseSha256) throw new Error(`Recovery response fingerprint changed: ${absolute}`);
      const response = JSON.parse(responseBytes), content = response?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || sha256(content) !== metadata.originalContentSha256) throw new Error(`Recovery source content fingerprint changed: ${absolute}`);
      const match = content.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
      if (!match || sha256(match[1]) !== metadata.unfencedContentSha256) throw new Error(`Recovery is not an exact outer-fence removal: ${absolute}`);
      const source = JSON.parse(match[1]).candidates;
      if (!Array.isArray(source) || !Array.isArray(data.result?.proposals)) throw new Error(`Missing recovered source proposals: ${absolute}`);
      const facts = values => values.map(({ field, value, quote, page, rowIndex }) => [field, value, quote, page, rowIndex ?? null]);
      if (!isDeepStrictEqual(facts(source), facts(data.result.proposals))) throw new Error(`Recovery changed source values or evidence: ${absolute}`);
    }
  }
  const verified = { path: absolute, hash: expectedHash, data, originalHash };
  cache.set(key, verified);
  return verified;
}

export function summarizeCosts(summaries) {
  const models = new Map(), seenCalls = new Set();
  const get = model => {
    if (!models.has(model)) models.set(model, { model, costUsd: 0, requests: 0, unknownCostRequests: 0 });
    return models.get(model);
  };
  for (const { data, source } of summaries) {
    if (Array.isArray(data.modelCosts)) {
      if (summaries.length !== 1) throw new Error('An aggregate modelCosts file must be the only cost input.');
      for (const item of data.modelCosts) {
        if (typeof item.model !== 'string' || !Number.isFinite(item.costUsd) || item.costUsd < 0 || !Number.isInteger(item.requests) || !Number.isInteger(item.unknownCostRequests) || item.unknownCostRequests < 0 || item.requests < item.unknownCostRequests) throw new Error(`Invalid aggregate costs in ${source}`);
        if (models.has(item.model)) throw new Error(`Duplicate aggregate cost model: ${item.model}`);
        models.set(item.model, { model: item.model, costUsd: item.costUsd, requests: item.requests, unknownCostRequests: item.unknownCostRequests });
      }
      continue;
    }
    if (data.mode !== 'live' || !Array.isArray(data.outcomes)) throw new Error(`Cost input must be a live run summary or explicit modelCosts aggregate: ${source}`);
    for (const outcome of data.outcomes) {
      if (outcome.skipped) continue;
      const model = outcome.requestedModel ?? outcome.model;
      if (typeof model !== 'string' || typeof outcome.jobId !== 'string') throw new Error(`Missing cost call identity in ${source}`);
      // The pilot has a no-resend policy. Ambiguous duplicate summaries must be
      // resolved in a reviewed cost aggregate, never silently double-counted.
      const key = `${model}\0${outcome.jobId}`;
      if (seenCalls.has(key)) throw new Error(`Repeated cost call ${model}/${outcome.jobId}; supply a reviewed modelCosts aggregate instead.`);
      seenCalls.add(key);
      const total = get(model), cost = outcome.usage?.cost;
      total.requests += 1;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) total.costUsd += cost;
      else total.unknownCostRequests += 1;
    }
  }
  return [...models.values()];
}

function actualValues(actual) {
  if (!actual?.length) return '<p class="muted">No value returned for this fact.</p>';
  return actual.map(value => `<p><strong>${escape(value.value)}</strong> <span class="muted">(${escape(fieldLabel(value))})</span></p>${quote(value.quote)}`).join('');
}

function factEvidence(fact) {
  return `<article class="finding ${fact.status}"><h4>${escape(fieldLabel(fact))} <span class="tag">${escape(fact.status)}</span></h4>
    <p>Expected: <strong>${escape(fact.expected)}</strong></p><p class="label">Source quote</p>${quote(fact.expectedSourceQuote)}
    <p class="label">Model output</p>${actualValues(fact.actual)}</article>`;
}

function extraRowEvidence(row, goldPage) {
  const relevant = goldPage.reviewOnly.filter(check => row.proposals.some(proposal => proposal.field === check.field || String(check.literal).toLowerCase().includes(String(proposal.value).toLowerCase())));
  return `<article class="finding wrong"><h4>Extra goods row ${escape(row.rowIndex)}</h4>
    <p>Expected physical goods rows on this page: <strong>${escape(goldPage.expectedGoodsRowCount)}</strong>.</p>
    ${relevant.length ? relevant.map(check => `<p class="label">Source quote</p>${quote(check.literal)}<p>${escape(check.policy)}</p>`).join('') : `<p>Source goods: ${escape(goldPage.goodsRows.map(item => `${item.goodsCode} (${item.description})`).join('; ') || 'No itemized physical goods rows.')}</p>`}
    <p class="label">Model output assigned to the extra row</p>${actualValues(row.proposals)}</article>`;
}

function sourceImage(page) {
  return `<figure><button class="image-button" data-zoom="${escape(page.jobId)}" title="Open full-size source image"><img data-source="${escape(page.jobId)}" alt="${escape(`${page.case}, ${page.sourceName}, page ${page.page}`)}" loading="lazy"></button><figcaption>${escape(page.sourceName)} · page ${escape(page.page)}<br><span class="muted">Click to inspect the original image.</span></figcaption></figure>`;
}

function manualFinding(finding) {
  return `<article class="finding ${finding.finding === 'wrong_semantic_field' ? 'wrong' : ''}"><h4>${escape(fieldLabel(finding))} <span class="tag">${escape(finding.finding.replaceAll('_', ' '))}</span></h4><p>Model value: <strong>${escape(finding.value)}</strong></p><p class="label">Quoted source text</p>${quote(finding.quote)}<p>${escape(finding.explanation)}</p></article>`;
}

function manualSection(review, gold, report) {
  if (!review) return '<div class="note"><strong>No review of facts outside the frozen checks is included.</strong><p>The percentages below are limited to predeclared facts; they cannot establish overall extraction accuracy.</p></div>';
  const sourcePages = new Map(gold.pages.map(page => [page.jobId, page]));
  const rows = report.models.map(model => {
    const reviewed = review.models.find(item => item.model === model.model);
    if (!reviewed) return `<tr><th>${escape(model.model)}</th><td colspan="5">Not included in this manual review</td></tr>`;
    const counts = reviewed.manualFindingCounts;
    return `<tr><th>${escape(model.model)}</th><td><strong>${counts.wrong_semantic_field ?? 0}</strong></td><td>${(counts.unsupported_role ?? 0) + (counts.unsupported_narrower_role ?? 0)}</td><td>${counts.unproven_commercial_party_role ?? 0}</td><td>${counts.extra_goods_row ?? 0}</td><td>${counts.rejected_goods_scope ?? 0}</td></tr>`;
  }).join('');
  const errors = review.models.flatMap(model => model.pages.flatMap(page => {
    const findings = page.reviewedUnscoredProposals.filter(item => item.finding === 'wrong_semantic_field');
    return findings.length ? [`<article class="page"><h3>${escape(model.model)} · ${escape(page.case)}</h3><div class="evidence">${sourceImage(sourcePages.get(page.jobId))}<div>${findings.map(manualFinding).join('')}</div></div></article>`] : [];
  })).join('');
  const remaining = review.models.map(model => `<details><summary>${escape(model.model)} — other reviewed proposals</summary>${model.pages.map(page => {
    const findings = page.reviewedUnscoredProposals.filter(item => item.finding !== 'wrong_semantic_field' && item.finding !== 'literal_source_supported');
    return findings.length ? `<details class="page"><summary>${escape(page.case)} · ${escape(page.sourceName)}</summary><div class="evidence">${sourceImage(sourcePages.get(page.jobId))}<div>${findings.map(manualFinding).join('')}</div></div></details>` : '';
  }).join('')}</details>`).join('');
  return `<section class="summary-card"><h2 style="margin-top:0">Source-reviewed issues beyond the frozen fact score</h2><p><strong>A perfect frozen-fact score is not overall accuracy.</strong> This separate review found populated values assigned to the wrong semantic field. Unsupported role assertions are listed separately: missing role evidence does not prove the real-world role is different.</p><div class="table-scroll"><table><thead><tr><th>Model</th><th>Wrong semantic fields</th><th>Unsupported role / narrower role</th><th>Unproven commercial party role</th><th>Extra goods rows<br>already counted below</th><th>Rejected goods scope</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">Counts are reviewed proposals, not independent examples or an additional accuracy percentage. Missing address detail and wording/component differences are excluded from substantive correctness. Extra goods rows must not be counted twice.</p>${errors}${remaining}<details><summary>Manual review scope and limitations</summary><p>${escape(review.reviewKind)}</p><p>Reviewer: ${escape(review.reviewer)} · ${escape(review.sourceImagesVisuallyReviewed)} source images · ${escape(review.createdAt)}</p>${list(review.limitations.map(escape))}</details></section>`;
}

function formatSection(recovery, report, gold) {
  if (!recovery) return '';
  const entries = recovery.entries.filter(entry => entry.classification === 'first_pass_format_compatibility_failure');
  return `<section class="summary-card"><h2 style="margin-top:0">Response-format compatibility</h2><p><strong>${entries.length} first-pass format failure(s)</strong> are recorded separately from source-content correctness. Offline removal of one exact JSON code fence can make stored content evaluable; it does not make the original request a successful integration. No values were corrected and no model call was repeated.</p>${list(entries.map(entry => {
    const page = gold.pages.find(item => item.jobId === entry.jobId);
    const scored = report.models.find(model => model.model === entry.model)?.pages.find(item => item.jobId === entry.jobId)?.status === 'usable';
    return `<strong>${escape(entry.model)}</strong> · ${escape(page.case)} · ${escape(page.sourceName)} p${page.page}: first pass ${escape(entry.firstPassError)}. ${entry.recovered && scored ? 'Recovered content is included in the frozen-fact score below.' : 'Recovered content is not included in the frozen-fact score below.'}`;
  }))}<p class="muted">Content-usable page counts below may include an offline recovered response. They are not first-pass success counts. Provider routing/HTTP failures remain separate unusable responses.</p></section>`;
}

function pageSection(page, goldPage) {
  const title = `${goldPage.case} · ${goldPage.sourceName} · page ${goldPage.page}`;
  if (page.status !== 'usable') return `<details class="page"><summary>${escape(title)} <span class="tag">${escape(page.status === 'not_run' ? 'not run' : 'unusable')}</span></summary><p>${escape(page.problem || 'No response was evaluated for this model and page.')}</p><p>No fact accuracy, wrong-fact count, or omission count is inferred from this page.</p>${sourceImage(goldPage)}</details>`;
  const wrong = page.facts.filter(fact => fact.status === 'wrong');
  const omissions = page.facts.filter(fact => fact.status === 'omitted');
  const hasIssues = wrong.length || omissions.length || page.extraGoodsRows.length || page.rowAssignmentFindings.length || page.missingGoodsRows.length;
  const assignments = page.rowAssignmentFindings.map(item => `<article class="finding"><h4>Row assignment: ${escape(item.kind)}</h4><p>${escape(item.note || 'Check the supplied row identity against the source goods rows.')}</p><pre>${escape(JSON.stringify(item, null, 2))}</pre></article>`).join('');
  return `<details class="page"${hasIssues ? ' open' : ''}><summary>${escape(title)} <span class="tag">${page.correct}/${page.correct + page.wrong} correct · ${page.omitted} omitted · ${page.extraGoodsRows.length} extra rows</span></summary>
    <div class="evidence">${sourceImage(goldPage)}<div>
    ${wrong.map(factEvidence).join('')}${page.extraGoodsRows.map(row => extraRowEvidence(row, goldPage)).join('')}${assignments}
    ${page.missingGoodsRows.length ? `<article class="finding"><h4>Missing goods rows</h4>${list(page.missingGoodsRows.map(row => `${escape(row.goodsCode)} · ${escape(row.description)} (source row ${escape(row.rowIndex)})`))}</article>` : ''}
    ${omissions.length ? `<details class="omissions"><summary>${omissions.length} omitted source facts — excluded from correctness denominator</summary>${omissions.map(factEvidence).join('')}</details>` : ''}
    ${!hasIssues ? '<p>No wrong facts, omissions or row findings among this page’s predeclared facts.</p>' : ''}
    <details><summary>All ${page.facts.length} scored facts</summary><div class="table-scroll"><table><thead><tr><th>Field</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead><tbody>${page.facts.map(fact => `<tr><td>${escape(fieldLabel(fact))}</td><td>${escape(fact.expected)}</td><td>${escape(fact.actual.map(value => value.value).join(' | ') || '—')}</td><td>${escape(fact.status)}</td></tr>`).join('')}</tbody></table></div></details>
    <details><summary>${page.unscoredProposals.length} unscored proposals · manual source checks</summary><p>These were not automatically marked correct or wrong. Wording and translation differences are excluded from numerical correctness.</p>${list(goldPage.reviewOnly.map(check => `${escape(fieldLabel(check))}: ${escape(check.literal)} — ${escape(check.policy)}`))}${actualValues(page.unscoredProposals)}</details>
    <p class="muted">Grounding rejections: ${escape(page.groundingRejected ?? 'unavailable')}. Evaluation measures model proposals before application mapping.</p>
    </div></div></details>`;
}

export function renderReport({ gold, report, images, costs, inputs, generatedAt, manualReview, formatRecovery, costNotes = [] }) {
  const pages = new Map(gold.pages.map(page => [page.jobId, page]));
  const costMap = new Map(costs.map(item => [item.model, item]));
  const totalCost = costs.reduce((total, item) => total + item.costUsd, 0);
  const unknownCosts = costs.reduce((total, item) => total + item.unknownCostRequests, 0);
  const costCell = model => {
    const item = costMap.get(model);
    if (!item) return 'Not supplied';
    return `${money(item.costUsd)} known<br><span class="muted">${item.requests} requests${item.unknownCostRequests ? ` · ${item.unknownCostRequests} cost unknown` : ''}</span>`;
  };
  const summaryRows = report.models.map((model, index) => {
    const populated = model.correct + model.wrong;
    const expected = populated + model.omitted;
    const usable = model.usablePages > 0;
    const formatFailures = formatRecovery?.entries.filter(entry => entry.model === model.model && entry.classification === 'first_pass_format_compatibility_failure').length;
    return `<tr><th><a href="#model-${index}">${escape(model.model)}</a></th><td>${populated ? `<strong>${model.correct}/${populated}</strong><br>${percent(model.filledSourceFactAccuracy)} of frozen facts` : '—'}</td><td>${usable ? `${populated}/${expected}<br>${percent(model.sourceFactCoverage)}` : '—'}</td><td>${usable ? model.wrong : '—'}</td><td>${usable ? model.omitted : '—'}</td><td>${model.usablePages}/${gold.pages.length}</td><td>${model.unusableResponses}</td><td>${formatFailures ?? 'Not supplied'}</td><td>${model.pagesNotRun}</td><td>${usable ? `${model.extraGoodsRows} / ${model.missingGoodsRows}` : '—'}</td><td>${usable ? model.rowAssignmentFindings : '—'}</td><td>${costCell(model.model)}</td></tr>`;
  }).join('');
  const models = report.models.map((model, index) => `<section id="model-${index}"><h2>${escape(model.model)}</h2>${model.pages.map(page => pageSection(page, pages.get(page.jobId))).join('')}</section>`).join('');
  const extraCostModels = costs.filter(item => !report.models.some(model => model.model === item.model));
  const imageJson = JSON.stringify(images).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Source vision pilot — evidence report</title><style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172a3a;background:#f2f5f7;line-height:1.5}*{box-sizing:border-box}body{margin:0}main{max-width:1480px;margin:auto;padding:32px 24px 60px}h1{font-size:32px;line-height:1.2;margin:0 0 12px}h2{font-size:23px;margin-top:36px;overflow-wrap:anywhere}h3,h4{margin:0 0 10px}p{margin:10px 0}a{color:#17678b}header,.note,.page,.summary-card{background:white;border:1px solid #d5e0e7;border-radius:12px;padding:20px;margin-bottom:16px}.note{border-left:5px solid #c89b32;background:#fffaf0}.muted,figcaption{color:#586b79;font-size:13px}.eyebrow,.label{text-transform:uppercase;letter-spacing:.06em;font-weight:650;font-size:11px;color:#586b79}.tag{font-size:12px;font-weight:500;display:inline-block;border-radius:5px;background:#edf2f6;padding:3px 7px;margin:3px 0 3px 7px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #dfe7ec;padding:12px 9px;vertical-align:top}thead th{color:#526978;font-size:11px;text-transform:uppercase}tbody th{min-width:175px;font-weight:600}summary{cursor:pointer;font-weight:650}details>p:first-of-type{margin-top:16px}details details{margin:15px 0}.evidence{display:grid;grid-template-columns:minmax(270px,.9fr) minmax(0,1.1fr);gap:24px;margin-top:20px;align-items:start}figure{margin:0;min-width:0}figcaption{padding:8px 0;overflow-wrap:anywhere}.image-button{display:block;width:100%;border:1px solid #d6dfe5;background:#fff;padding:0;cursor:zoom-in}.image-button img{display:block;width:100%;height:auto}.finding{padding:16px;margin-bottom:16px;background:#f7f9fb;border:1px solid #e0e6eb;border-radius:8px;overflow-wrap:anywhere}.finding.wrong{border-left:4px solid #ae4b3e}.finding.omitted{border-left:4px solid #a5883c}blockquote{margin:8px 0 14px;padding:8px 12px;background:#fff;border-left:2px solid #aebec9;font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap}pre{overflow:auto;font-size:12px}.provenance{overflow-wrap:anywhere}dialog{width:95vw;max-width:none;height:94vh;padding:12px;border:0;border-radius:8px;overflow:auto}dialog::backdrop{background:#10212de0}dialog img{display:block;max-width:none;margin:auto}dialog button{position:sticky;top:0;float:right;padding:10px 16px;cursor:pointer;border:1px solid #d5e0e7;border-radius:5px;background:white;font-size:14px}footer{font-size:12px;color:#586b79;margin-top:28px}@media(max-width:850px){main{padding:18px 12px}.evidence{grid-template-columns:1fr}h1{font-size:27px}}@media print{body{background:white}main{max-width:none;padding:0}dialog{display:none}details{break-inside:avoid}.evidence{grid-template-columns:40% 60%}header,.page{border-radius:0}a{color:inherit}}
    </style></head><body><main><header><div class="eyebrow">Measured source extraction · local evidence report</div><h1>Four-page vision pilot</h1><p>${escape(gold.scoringPolicy.scope)}</p><p class="muted">${gold.pages.reduce((n, page) => n + page.facts.length, 0)} predeclared facts · ${gold.pages.length} original pages · evaluation ${escape(report.generatedAt)} · report ${escape(generatedAt)}</p></header>
    <div class="note"><strong>This is a small diagnostic, not whole-form accuracy.</strong><p>Correctness = correct ÷ (correct + wrong) among populated, predeclared source facts on usable pages. Omissions are excluded and reported separately. Failed responses and pages not run have no fact score. A model can therefore show 100% while omitting facts or inventing goods rows.</p><p>Coverage = populated ÷ expected facts on usable pages; it excludes failed and unrun pages. Compare the page counts as well. Accepted equivalent representations are frozen in the source reference; wording and translation differences in descriptions are not automatically scored.</p><p>${escape(gold.authorship)}</p></div>
    ${manualSection(manualReview, gold, report)}${formatSection(formatRecovery, report, gold)}
    <section class="summary-card"><h2 style="margin-top:0">Frozen fact correctness only · recorded cost</h2><p>These scores cover the predeclared facts. They exclude the separate semantic and role findings above, and must not be read as overall extraction accuracy.</p><div class="table-scroll"><table><thead><tr><th>Model</th><th>Correct / populated<br>frozen facts only</th><th>Fact coverage<br>usable content</th><th>Wrong frozen facts</th><th>Omitted</th><th>Content-usable pages</th><th>Unusable content</th><th>First-pass format failures</th><th>Not run</th><th>Extra / missing<br>goods rows</th><th>Row findings</th><th>Reported cost USD</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
    <p>${costs.length ? `Known provider-reported cost: <strong>${money(totalCost)}</strong>${unknownCosts ? `; ${unknownCosts} attempted request(s) have no returned cost, so this is not a confirmed complete bill.` : '.'}` : 'No run summaries supplied; costs are unavailable.'} Budget reservations are not charges.</p>${costNotes.map(note => `<p class="muted">${escape(note)}</p>`).join('')}${extraCostModels.length ? `<p>Additional attempted models outside this evaluator report: ${escape(extraCostModels.map(item => `${item.model}: ${money(item.costUsd)} known, ${item.unknownCostRequests} cost unknown`).join('; '))}.</p>` : ''}</section>
    ${report.unknownOutcomes?.length ? `<div class="note">${report.unknownOutcomes.length} outcome(s) were not matched to a frozen source page and have no fact score.</div>` : ''}
    ${models}<details class="summary-card provenance"><summary>Source set and reproducibility</summary>${list(gold.pages.map(page => `${escape(page.case)} · ${escape(page.sourceName)} p${escape(page.page)} · ${page.facts.length} facts · ${page.expectedGoodsRowCount} physical goods rows<br>Image SHA-256: <code>${escape(page.inputImageSha256)}</code>`))}<p>Gold, source images and evaluated outcome files were hash-checked while rendering. Manual reviews match the evaluated outcomes directly or through a verified recovery chain. Exact-fence recovery is checked against the original response and source proposals. The renderer does not alter evaluator outcomes or recompute scores.</p>${list(inputs.map(input => `${escape(input.kind)}: ${escape(input.path)}<br>SHA-256: <code>${escape(input.sha256)}</code>`))}<p>${escape(gold.scoringPolicy.rows)}</p><p>${escape(gold.scoringPolicy.unscored)}</p></details>
    <footer>This self-contained local file contains original source-page images and extracted values. Images appear exactly as supplied to the pilot. No external assets or network requests are used.</footer></main><dialog id="image-dialog"><button id="close-image">Close image</button><img id="large-image" alt="Original source page"></dialog>
    <script type="application/json" id="source-images">${imageJson}</script><script>const images=JSON.parse(document.getElementById('source-images').textContent);document.querySelectorAll('img[data-source]').forEach(img=>{img.src=images[img.dataset.source]});const dialog=document.getElementById('image-dialog');document.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>{document.getElementById('large-image').src=images[button.dataset.zoom];dialog.showModal()}));document.getElementById('close-image').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});</script></body></html>`;
}

async function main() {
  const [goldPath, reportPath, outputPath, ...optionalArgs] = process.argv.slice(2);
  if (!goldPath || !reportPath || !outputPath) throw new Error('Usage: node scripts/render-source-vision-pilot.mjs gold.json evaluation.json report.html [run-summary.json ...] [--manual-review review.json] [--format-recovery recovery.json]');
  const summaryPaths = [], options = {};
  for (let index = 0; index < optionalArgs.length; index++) {
    const argument = optionalArgs[index];
    if (argument === '--manual-review' || argument === '--format-recovery') {
      if (options[argument] || !optionalArgs[index + 1] || optionalArgs[index + 1].startsWith('--')) throw new Error(`Missing or duplicate value: ${argument}`);
      options[argument] = optionalArgs[++index];
    } else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else summaryPaths.push(argument);
  }
  const inputs = [];
  const read = async (inputPath, kind) => {
    const bytes = await fs.readFile(inputPath);
    inputs.push({ kind, path: path.resolve(inputPath), sha256: sha256(bytes) });
    return JSON.parse(bytes.toString('utf8'));
  };
  const gold = await read(goldPath, 'Frozen source reference'), report = await read(reportPath, 'Evaluator report');
  if (gold.schemaVersion !== 1 || !Array.isArray(gold.pages) || !gold.pages.length || report.schemaVersion !== 1 || !Array.isArray(report.models)) throw new Error('Unsupported source or evaluation schema.');
  if (report.goldSha256 !== inputs[0].sha256) throw new Error('Evaluation does not reference this exact frozen gold file.');
  const images = {};
  for (const page of gold.pages) {
    const imagePath = path.isAbsolute(page.imagePath) ? page.imagePath : path.resolve(path.dirname(goldPath), page.imagePath);
    const bytes = await fs.readFile(imagePath);
    if (sha256(bytes) !== page.inputImageSha256) throw new Error(`Source image hash changed: ${page.jobId}`);
    const extension = path.extname(imagePath).toLowerCase(), mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[extension];
    if (!mime) throw new Error(`Unsupported source image type: ${extension}`);
    images[page.jobId] = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  for (const model of report.models) for (const page of model.pages) {
    if (!gold.pages.some(source => source.jobId === page.jobId)) throw new Error(`Evaluator page is absent from gold: ${page.jobId}`);
  }
  if (!Array.isArray(report.inputOutcomes)) throw new Error('Evaluator report lacks outcome provenance.');
  const outcomeCache = new Map(), evaluatedOutcomes = [];
  for (const input of report.inputOutcomes) evaluatedOutcomes.push(await verifyOutcomeFile(input.path, input.sha256, outcomeCache));
  const summaries = [];
  for (const summaryPath of summaryPaths) summaries.push({ data: await read(summaryPath, 'Run costs'), source: summaryPath });
  const manualReview = options['--manual-review'] ? await read(options['--manual-review'], 'Post-output source review') : undefined;
  if (manualReview) {
    if (manualReview.schemaVersion !== 1 || manualReview.goldSha256 !== inputs[0].sha256 || !Array.isArray(manualReview.models)) throw new Error('Manual review does not reference this exact frozen gold.');
    for (const model of manualReview.models) {
      if (!report.models.some(item => item.model === model.model)) throw new Error(`Manual review model is absent from evaluator report: ${model.model}`);
      for (const page of model.pages) {
        const source = gold.pages.find(item => item.jobId === page.jobId);
        if (!source || page.inputImageSha256 !== source.inputImageSha256 || !Array.isArray(page.reviewedUnscoredProposals)) throw new Error(`Manual review page does not match frozen source: ${page.jobId}`);
        const reviewed = await verifyOutcomeFile(page.outcomePath, page.outcomeSha256, outcomeCache);
        const evaluated = evaluatedOutcomes.find(item => (item.data.requestedModel ?? item.data.model) === model.model && item.data.jobId === page.jobId);
        const recoveredPair = reviewed.data.formatCompatibility?.recovered === true && evaluated?.data.formatCompatibility?.recovered === true;
        if (!evaluated || (reviewed.data.requestedModel ?? reviewed.data.model) !== model.model || reviewed.data.jobId !== page.jobId || reviewed.originalHash !== evaluated.originalHash || !isDeepStrictEqual(comparableReviewedOutcome(reviewed.data, recoveredPair), comparableReviewedOutcome(evaluated.data, recoveredPair))) throw new Error(`Manual review outcome has no unchanged provenance chain to evaluator report: ${model.model}/${page.jobId}`);
      }
    }
  }
  const formatRecovery = options['--format-recovery'] ? await read(options['--format-recovery'], 'Offline format recovery') : undefined;
  if (formatRecovery) {
    if (formatRecovery.mode !== 'offline_exact_fence_recovery' || formatRecovery.networkCalls !== 0 || formatRecovery.originalOutcomesModified !== false || !Array.isArray(formatRecovery.entries)) throw new Error('Unsupported or unaudited format recovery sidecar.');
    for (const entry of formatRecovery.entries) {
      if (!gold.pages.some(page => page.jobId === entry.jobId) || entry.sourceFieldValuesChanged !== false || entry.networkCalls !== 0) throw new Error(`Format recovery changes source values or has unknown source: ${entry.jobId}`);
      const evaluated = evaluatedOutcomes.find(item => item.path === path.resolve(entry.outcomePath));
      const metadata = { ...entry };
      delete metadata.jobId;
      delete metadata.model;
      delete metadata.outcomePath;
      if (!evaluated || evaluated.data.jobId !== entry.jobId || (evaluated.data.requestedModel ?? evaluated.data.model) !== entry.model || !isDeepStrictEqual(metadata, evaluated.data.formatCompatibility)) throw new Error(`Format recovery entry does not match a verified evaluated outcome: ${entry.jobId}`);
    }
    if (formatRecovery.recoveredResponses !== formatRecovery.entries.filter(entry => entry.recovered).length) throw new Error('Recovery summary count does not match its entries.');
  }
  if (evaluatedOutcomes.some(item => item.data.formatCompatibility) && !formatRecovery) throw new Error('Evaluated outcomes include format recovery metadata; supply the audited --format-recovery summary.');
  const html = renderReport({ gold, report, images, costs: summarizeCosts(summaries), inputs, generatedAt: new Date().toISOString(), manualReview, formatRecovery, costNotes: summaries.map(item => item.data.costCaveat).filter(note => typeof note === 'string') });
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, html, { flag: 'wx' });
  process.stdout.write(`${path.resolve(outputPath)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
