"""Export frozen AI forms and separate employee comparisons for the local website.

Offline only: no provider calls, workspace mutations, or answer-derived form values.
Original files are copied byte-for-byte into the ignored local sample directory.
"""
import collections
import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'outputs/final-paired-20261020T005412Z'
REVIEW = ROOT / 'outputs/final-paired-20261020T005412Z-review-work-v2'
PILOT = ROOT / 'outputs/kimi-glm-comparison-terminal-20261020T014245Z'
IMPROVEMENTS = ROOT / 'outputs/glm-form-improvement-20261020'
OUT = ROOT / '.aicd-local/sample-review'
TABS = ['general_1', 'general_2', 'goods', 'structured_goods_only', 'unmapped']
SEALED_HASHES = {}
IMPROVED_VARIANTS = [
    dict(id='glm53-flash-improved-auto', label='GLM 5.3 Flash · improved automatic · 4 samples',
         resultDirectory='candidate-v2-results', evaluationDirectory='evaluation-v2-automatic',
         freezeSha256='10afddbd1b6295248a35c81a94e621f2357a30476d37e32ac30e03a32a82722e',
         reportSha256='d4bcb7406bc9c515adfb505b5d9007269997be831afc3ea27ed917713b362ad1',
         exactSha256='4100b2ea8173cba05cd2a6371ee4352198a6fc76cfd8f694e04c9fdc086d9a72',
         integritySha256='32ee6339b2fb3a84194918240ee8c9aefbe7e62e686087610fe1c4dc2fa4a8bc',
         reviewed=False, expectedCorrect=140, expectedExact=136, expectedMissing=97),
    dict(id='glm53-flash-improved-reviewed', label='GLM 5.3 Flash · improved with review · 4 samples',
         resultDirectory='final-reviewed-results', evaluationDirectory='final-evaluation',
         freezeSha256='2cf7f2119e706a753e948f51889bb2361ed20fb955f573a706ba5485a8517995',
         reportSha256='9789d7982f57923ca19323fa451d652d11281614cf1ab7928a99531fabc5601b',
         exactSha256='57c16f0c1f189573c37f47d27c26895aaf2cfe52f646307f70c7844d933ebd36',
         integritySha256='6662dd46258abc43191a609cdfe22d7c1fa11b0ed7210cc705d6b30adcda984c',
         reviewed=True, expectedCorrect=159, expectedExact=138, expectedMissing=90),
]

def read(p):
    if p in SEALED_HASHES: assert digest(p) == SEALED_HASHES[p], f'Sealed input changed: {p.name}'
    return json.loads(p.read_text())
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def value_hash(v): return hashlib.sha256(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
def save(p, v):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n')
    tmp.chmod(0o600)
    tmp.replace(p)

def metric(rows):
    count = collections.Counter(r['contentStatus'] for r in rows)
    n = len(rows); exact = count['exact_match']; equivalent = count['reviewed_equivalent']
    missing = count['missing']; filled = n - missing; correct = exact + equivalent
    ratio = lambda a, b: a / b if b else None
    return dict(eligible=n, exactMatches=exact, reviewedEquivalent=equivalent,
                reviewedNotEquivalent=count['reviewed_not_equivalent'],
                unreviewedMismatches=count['unreviewed_mismatch'], missing=missing,
                filled=filled, contentCorrect=correct, exactAgreement=ratio(exact,n),
                contentAgreement=ratio(correct,n), filledContentAgreement=ratio(correct,filled),
                filledCoverage=ratio(filled,n), assessedCoverage=ratio(correct+count['reviewed_not_equivalent'],n), measured=bool(n))

def metrics(rows):
    return dict(visible=metric([r for r in rows if r['tab'] in TABS[:3]]), all=metric(rows),
                byForm={tab:metric([r for r in rows if r['tab']==tab]) for tab in TABS})

def seal_input(path, sha256):
    assert path.is_file() and digest(path) == sha256, f'Sealed improvement input changed: {path.name}'
    SEALED_HASHES[path] = sha256

def improvement_inputs(config):
    result_root = IMPROVEMENTS/config['resultDirectory']
    evaluation_root = IMPROVEMENTS/config['evaluationDirectory']
    freeze_path = result_root/'result-freeze.json'
    seal_input(freeze_path, config['freezeSha256'])
    for entry in read(freeze_path)['files']:
        path = (result_root/entry['path']).resolve()
        assert path.is_relative_to(IMPROVEMENTS.resolve()), 'Improvement freeze path escaped its evidence directory.'
        seal_input(path, entry['sha256'])
    for filename, pin in [('improvement-report.json','reportSha256'),
                          ('candidate-unchanged-exact-report.json','exactSha256'),
                          ('evidence-integrity-manifest.json','integritySha256')]:
        seal_input(evaluation_root/filename, config[pin])
    integrity = read(evaluation_root/'evidence-integrity-manifest.json')
    result_inputs = []
    for entry in integrity['candidateInputs']:
        path = Path(entry['path']).resolve()
        assert path.is_relative_to(IMPROVEMENTS.resolve()), 'Evaluation input escaped its evidence directory.'
        seal_input(path, entry['sha256'])
        if entry['kind'] == 'candidate_result':
            assert path.parent == (result_root/'results').resolve(), 'Scoring report belongs to another candidate.'
            result_inputs.append(path.stem)
    report = read(evaluation_root/'improvement-report.json')
    evaluated = report['posthocReview']['candidate'] if config['reviewed'] else report['candidate']
    assert set(result_inputs) == {p['packetId'] for p in evaluated['packets']} and len(result_inputs) == 4
    assert evaluated['visibleUiComparableSubset']['eligible'] == 300
    assert evaluated['populationOverall']['eligible'] == 340
    return result_root, report, evaluated, read(evaluation_root/'candidate-unchanged-exact-report.json')

def main():
    previous_data = read(OUT/'data.json') if (OUT/'data.json').exists() else None
    previous_assets = read(OUT/'asset-index.json')['assets'] if (OUT/'asset-index.json').exists() else None
    # Pin the sealed evaluation inputs; a changed report cannot silently replace a score.
    assert digest(BASE/'final-manifest.json') == '79d3b6c7a4d76b5198adb63dbe77aad29666c81e67686c76bcd6e8644d9b1a2c'
    assert digest(REVIEW/'review-manifest.json') == '068565b822f94abca4d79c2a8fe4653a7e723af8785f517c48a406b815e02766'
    assert digest(PILOT/'snapshot-manifest.json') == 'ac0fe0b5d92c73211767c4b97701b012f139bc081d5e77029365de7a06746276'
    for directory, filename in [(BASE,'final-manifest.json'),(REVIEW,'review-manifest.json'),(PILOT,'snapshot-manifest.json')]:
        for entry in read(directory/filename)['files']:
            SEALED_HASHES[directory/entry['path']] = entry['sha256']
    manifest = read(BASE/'inputs/manifest.json')
    exact = read(BASE/'candidate-exact/accuracy-report.json')
    content = read(REVIEW/'content-combined/content-agreement-report.json')['candidate']
    pilot = read(PILOT/'model-comparison-report.json')
    historical = read(PILOT/'historical-kimi-reference.json')
    catalog = read(PILOT/'evaluation-private/form-catalog.json')
    development = {p['packetId'] for p in read(REVIEW/'content-development/content-agreement-report.json')['candidate']['packets']}
    spec = importlib.util.spec_from_file_location('frozen_exact', PILOT/'evaluation-private/exact-scorer.py')
    scorer = importlib.util.module_from_spec(spec); spec.loader.exec_module(scorer)
    packets = {p['id']:p for p in manifest['packets']}
    scores = {p['packetId']:p for p in exact['packets']}
    sources = {s['sha256'] for p in packets.values() for s in p['sources']}
    answers = {s['sha256'] for p in packets.values() for s in p['heldOut']}
    assert not sources.intersection(answers), 'Answer file appears in source inputs.'
    assets = {}; public_assets = {}; unavailable = []
    for packet in packets.values():
        for role, files in [('source',packet['sources']),('employee_answer',packet['heldOut'])]:
            for s in files:
                ident = role + '-' + s['sha256']
                if ident in public_assets: continue
                original = Path(s['originalPath'])
                available = original.is_file() and digest(original) == s['sha256']
                item = dict(id=ident, name=s['name'], mime=s['mime'], size=s['size'], sha256=s['sha256'], role=role, available=available)
                public_assets[ident] = item
                if not available: unavailable.append(ident); continue
                dest = OUT/'originals'/(s['sha256'] + Path(s['name']).suffix.lower())
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists(): shutil.copyfile(original, dest)
                assert digest(dest) == s['sha256']
                dest.chmod(0o600)
                assets[ident] = dict(path=str(dest), name=s['name'], mime=s['mime'], size=dest.stat().st_size, sha256=s['sha256'], role=role)
    def asset_list(packet, role):
        return [public_assets[role+'-'+s['sha256']] for s in packet['sources' if role=='source' else 'heldOut']]

    counts = dict(formValueChecks=0, actualComparisonChecks=0)
    def sample(variant, packet_id, result_path, rows, snapshot_id):
        result = read(result_path); original_shipment = result['state']['cases'][0]
        packet = packets[packet_id]; scored = scores[packet_id]
        docs = {d['id']:'source-'+d['sha256'] for d in result['state']['documents']}
        entries = []
        for entry in original_shipment.get('declarationDraft',{}).get('fields',[]):
            clean = {k:copy.deepcopy(entry[k]) for k in ['fieldId','goodsLineId','value','applicability','stale','componentIssues'] if k in entry}
            clean['provenance'] = [dict(assetId=docs[p['documentId']],page=p['page'],documentVersion=p['documentVersion']) for p in entry.get('provenance',[]) if p.get('kind')=='document' and p['documentId'] in docs]
            assert clean['value'] == entry['value']
            entries.append(clean); counts['formValueChecks'] += 1
        goods = []
        for g in original_shipment.get('goods',[]):
            clean = {k:copy.deepcopy(g.get(k,'')) for k in ['id','description','quantity','unit','unitPrice','amount','hsCode','origin','dutyRate','vatRate']}
            clean.update(reviewed=bool(g.get('reviewed')),manual=bool(g.get('manual')))
            if g.get('sourceDocumentId') in docs: clean['sourceAssetId']=docs[g['sourceDocumentId']]
            if g.get('sourcePage'): clean['sourcePage']=g['sourcePage']
            goods.append(clean)
        form = dict(id=original_shipment['id'],title=original_shipment['title'],caseType=original_shipment['caseType'],
                    declarationDraft=dict(schemaVersion=1,fields=entries),fields={},goods=goods)
        predicted = scorer.predictions(original_shipment)
        assert scorer.predictions(form) == predicted, 'Export changed AI prediction values.'
        comparisons=[]
        for i,row in enumerate(rows):
            key=(row['scope'],row['fieldId'],row['component'])
            assert predicted.get(key) == row['actual'], f'Frozen comparison differs from AI draft: {packet_id} {key}'
            counts['actualComparisonChecks']+=1
            index=int(row['scope'].split(':')[1])-1 if row['scope'].startswith('goods:') else None
            line_id=goods[index]['id'] if index is not None and index<len(goods) else None
            matching=[f for f in catalog if f['fieldId']==row['fieldId'] and f['component']==row['component']]
            review=row.get('review')
            clean_review={k:review.get(k,'') for k in ['status','reason','reviewer','reviewedAt','ruleId']} if review else None
            if clean_review is not None: clean_review['evidence']=None
            comparisons.append(dict(id=f'{packet_id}:{i}',packetId=packet_id,scope=row['scope'],fieldId=row['fieldId'],component=row['component'],
                ecusKeys=[f['key'] for f in matching],tab=row.get('tab','unmapped'),goodsLineId=line_id,printRowIndex=index,
                expected=row['expected'],actual=row['actual'],status=row['status'],contentStatus=row['contentStatus'],pairHash=row.get('pairHash',''),
                staleReviewCount=row.get('staleReviewCount',0),review=clean_review,
                answerLocation=dict(assetId='employee_answer-'+row['sourceSha256'] if row.get('sourceSha256') else None,
                    sourceFile=row.get('sourceFile',''),sheet=row.get('sheet',''),cell=row.get('cell',''))))
        return dict(id=variant+':'+packet_id,packetId=packet_id,label=packet['folder'],caseType=packet['caseType'],population='development' if packet_id in development else 'holdout',
            shipment=form,comparisons=comparisons,metrics=metrics(comparisons),originalAssets=asset_list(packet,'source'),employeeAssets=asset_list(packet,'employee_answer'),
            readingStatus=result.get('readingStatus','incomplete'),formStatus=result.get('formStatus','draft'),scoreStatus=scored['status'],
            failures=[dict(stage=f.get('stage','provider'),page=f.get('page'),error=f.get('error',''),assetId='source-'+f['sourceSha256'] if f.get('sourceSha256') else None) for f in result.get('failures',[])],
            blockedPages=result.get('blockedPages'),blockedDocuments=result.get('blockedDocuments'),extraGoodsRows=scored.get('extraGoodsRows'),
            unscoredPopulatedComponents=scored.get('extraFilledComponents',0) if isinstance(scored.get('extraFilledComponents'),int) else len(scored.get('extraFilledComponents',[])),
            labelConflictCount=len(scored.get('labelConflicts',[])),warnings=scored.get('warnings',[]),
            provenance=dict(snapshotId=snapshot_id,resultSha256=digest(result_path),formValuesSha256=value_hash(form),comparisonCount=len(rows),formValuesVerified=True,actualComparisonsVerified=True))
    variants=[]
    baseline_rows=collections.defaultdict(list)
    for row in content['components']: baseline_rows[row['packetId']].append(row)
    baseline_samples=[sample('kimi-k26',pid,BASE/'candidate-assembly/results'/f'{pid}.json',rows,BASE.name) for pid,rows in baseline_rows.items()]
    variants.append(dict(id='kimi-k26',label='Kimi K2.6 · 29 samples',model='kimi-k2.6',scope='Full eligible benchmark · 18 development + 11 held-out collections',sampleCount=len(baseline_samples),metrics=metrics(content['components']),samples=baseline_samples))
    for variant in pilot['variants']:
        if variant['status']=='not_run': continue
        ident=variant['variantId']; samples=[]; all_rows=[]
        exact_pilot=read(PILOT/'evaluation'/ident/'unchanged-exact-report.json')
        for group in variant['componentsByPacket']:
            item=sample(ident,group['packetId'],PILOT/'evaluation'/ident/'results'/f"{group['packetId']}.json",group['components'],PILOT.name)
            # Pilot extra-row counts differ by model; do not carry the Kimi values forward.
            if exact_pilot:
                pp=next(p for p in exact_pilot['packets'] if p['packetId']==group['packetId'])
                item['extraGoodsRows']=pp.get('extraGoodsRows');item['unscoredPopulatedComponents']=len(pp.get('extraFilledComponents',[])) if isinstance(pp.get('extraFilledComponents'),list) else pp.get('extraFilledComponents',0)
            else: item['extraGoodsRows']=None;item['unscoredPopulatedComponents']=0
            samples.append(item);all_rows.extend(group['components'])
        mm=metrics(all_rows)
        for k,v in variant['visibleThreeTabs'].items():
            if k in mm['visible']: assert mm['visible'][k]==v, f'Pilot metric changed: {k}'
        variants.append(dict(id=ident,label='GLM 5.3 Flash · '+('low' if ident.endswith('low') else 'high')+' reasoning · 4 samples',model='glm-5.3-flash',scope='Four related development samples · limited pilot',sampleCount=len(samples),metrics=mm,samples=samples))
    assert len(baseline_samples)==29 and len(variants)==3
    for k,v in content['visibleUiComparableSubset'].items():
        assert variants[0]['metrics']['visible'][k]==v, f'Benchmark metric changed: {k}'
    # Improvements are additive saved variants; frozen original forms/scores stay intact.
    original_variants = copy.deepcopy(variants)
    for config in IMPROVED_VARIANTS:
        result_root, report, evaluated, exact_improved = improvement_inputs(config)
        ident = config['id']; grouped = collections.defaultdict(list)
        for row in evaluated['components']: grouped[row['packetId']].append(row)
        samples = []
        exact_packets = {p['packetId']:p for p in exact_improved['packets']}
        for packet_id, rows in grouped.items():
            result_path = result_root/'results'/f'{packet_id}.json'
            result = read(result_path)
            assert result['model'] == 'glm-5.3-flash' and result['packetId'] == packet_id
            assert result['improvementAudit']['sourceOnly'] is True and result['improvementAudit']['employeeAnswerKeysUsed'] is False
            assert not {d['sha256'] for d in result['state']['documents']}.intersection(answers)
            item = sample(ident, packet_id, result_path, rows, result_root.name)
            scored = exact_packets[packet_id]
            item.update(scoreStatus=scored['status'], extraGoodsRows=scored.get('extraGoodsRows'),
                        unscoredPopulatedComponents=scored.get('extraFilledComponents',0),
                        labelConflictCount=len(scored.get('labelConflicts',[])), warnings=list(scored.get('warnings',[])))
            if config['reviewed']:
                item['warnings'].append('Includes AI-assisted source review and posthoc pair-bound content review; not independent human validation or fully automatic acceptance.')
                outcome = result['improvementAudit'].get('enrichment',{}).get('originalOutcome',{})
                if outcome.get('success') is False:
                    item['failures'].append(dict(stage='enrichment',page=None,error=outcome.get('error','Enrichment response failed validation.'),assetId=None))
            samples.append(item)
        mm = metrics(evaluated['components'])
        for key, value in evaluated['visibleUiComparableSubset'].items():
            if key in mm['visible']: assert mm['visible'][key] == value, f'Improvement score changed: {key}'
        assert (mm['visible']['contentCorrect'],mm['visible']['exactMatches'],mm['visible']['missing']) == (config['expectedCorrect'],config['expectedExact'],config['expectedMissing'])
        enrichment = report.get('reviewAssistedEnrichment') or {}
        variants.append(dict(id=ident,label=config['label'],model='glm-5.3-flash',
            scope='Four reused development samples · '+('AI-assisted review' if config['reviewed'] else 'automatic mapping improvements'),
            sampleCount=len(samples),metrics=mm,samples=samples,
            stage='review_assisted' if config['reviewed'] else 'automatic_mapping',reviewAssisted=config['reviewed'],
            scoreMethod='posthoc_pair_bound_review' if config['reviewed'] else 'frozen_pair_bound_review',
            limitations=['Four reused development samples; no independent or held-out validation.',
                         'The 300 comparable visible components do not cover every form control. Missing values remain uncredited.',
                         'Goods codes and missing customs decisions still require approved evidence.'] +
                        (['Equivalent-content decisions are AI-assisted internal review, not independent human validation.',
                          'All four additional enrichment envelopes failed. Separately reviewed source facts were applied without relabelling those failures.'] if config['reviewed'] else []),
            processingSummary=dict(newProviderCalls=enrichment.get('packetOutcomes',0),
                fullEnvelopeFailures=enrichment.get('fullEnvelopeFailures',0),
                fullyAcceptedEnvelopes=enrichment.get('fullEnvelopesAcceptedForApplication',0),
                reviewedSourceEdits=enrichment.get('appliedReviewedChanges',0))))
    assert len(variants) == 5 and variants[:3] == original_variants
    old_variants_preserved = True
    if previous_data:
        previous_variants = {v['id']:v for v in previous_data['variants']}
        for variant in original_variants:
            assert previous_variants.get(variant['id']) == variant, f'Original website variant changed: {variant["id"]}'
    if previous_assets is not None:
        assert previous_assets == assets, 'Original website asset index changed.'
    inventory=[]
    for pid,packet in packets.items():
        scored=scores[pid]; available=[v['id'] for v in variants if any(s['packetId']==pid for s in v['samples'])]
        inventory.append(dict(packetId=pid,label=packet['folder'],caseType=packet['caseType'],eligible=bool(available),status=scored['status'],population=('development' if pid in development else 'holdout') if available else 'excluded',sourceDocuments=len(packet['sources']),originalAssets=asset_list(packet,'source'),employeeAssets=asset_list(packet,'employee_answer'),availableVariants=available,notes=scored.get('warnings',[])))
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    data=dict(schemaVersion=1,generatedAt=now,scopeNotes=[
        'AI-filled draft forms come only from frozen source-document results. Employee ToKhai answers are separate comparison evidence.',
        'Missing values remain blank and receive no agreement credit. Unmeasured controls are not counted as correct.',
        'Equivalent-content decisions are AI-assisted internal review, not independent human validation. Goods rows use frozen printed-row alignment.',
        'Kimi covers 29 eligible collections. GLM covers four related development collections; the fresh Kimi pilot remains unrun.',
        'All forms remain drafts. Required customs decisions need approved business information. No sample is submitted to ECUS.'
    ],historicalPilotReference=dict(sampleCount=4,visible={**historical['visibleThreeTabs'],'measured':True},isFreshRun=False),inventory=inventory,variants=variants,validation=dict(inventoryCollections=len(inventory),eligibleCollections=len(baseline_samples),exportedSamples=sum(v['sampleCount'] for v in variants),comparedComponents=sum(len(s['comparisons']) for v in variants for s in v['samples']),originalAssets=len(assets),unavailableAssets=len(unavailable),**counts,sourceAndAnswerHashesDisjoint=True,frozenReportsMatched=True,originalVariantsPreserved=old_variants_preserved,improvementFreezeHashesVerified=True))
    assert not unavailable, 'An original file is unavailable or changed.'
    save(OUT/'asset-index.json',dict(schemaVersion=1,generatedAt=now,assets=assets))
    save(OUT/'data.json',data)
    save(OUT/'validation.json',dict(**data['validation'],dataSha256=digest(OUT/'data.json'),assetIndexSha256=digest(OUT/'asset-index.json')))
    print(json.dumps(data['validation']))

if __name__=='__main__': main()
