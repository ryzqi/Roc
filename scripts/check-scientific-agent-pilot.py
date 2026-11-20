"""Independent read-only audit of frozen desktop Agent pilot observations.

This verifies provenance and reproduces exact-quote checks, not semantic quality.
All trials, including incomplete answers and rejected quotations, remain in output.
"""
import collections
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def pinned(value):
    assert sha(value['path']) == value['sha256'], value['path']
    return Path(value['path'])


def read(path):
    return json.loads(Path(path).read_text())


def database(path):
    db = sqlite3.connect('file:' + str(Path(path).resolve()) + '?mode=ro', uri=True)
    assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    return db


def slice16(text, start, end):
    return text.encode('utf-16-le')[2 * start:2 * end].decode('utf-16-le')


def quoted_sources(evidence):
    return [s for h in evidence['hits'] for s in h['sources']] + [
        {'text': p['text'], 'locator': p['sourceLocator']} for p in evidence['passages']]


def verify_replay(trial, stored, messages):
    run = trial['run']['runId']
    replay = [json.loads(line) for line in Path(trial['eventsPath']).read_text().splitlines()]
    assert len(replay) == len(stored) == trial['eventCount'], 'event_count_mismatch'
    for index, (record, event) in enumerate(zip(replay, stored), 1):
        assert record['runId'] == event['runId'] == run, 'event_run_mismatch'
        assert record['sequence'] == event['sequence'] == index, 'event_sequence_mismatch'
        assert record['event'] == event['payload'] and record['createdAt'] == event['createdAt'], 'event_payload_mismatch'
    events = [r['event'] for r in replay]
    assert trial['terminal'] == events[-1], 'terminal_mismatch'
    answer = events[-1].get('assistantMessage', '')
    assert messages == [(answer,)], 'persisted_answer_mismatch'
    text = ''.join(e['block']['text'] for e in events if e['type'] == 'assistant_block'
                   and e['block']['kind'] == 'text' and e['block']['phase'] == 'delta')
    assert text.strip() == answer.strip(), 'stream_answer_mismatch'
    return events, answer


def verify_tool_lifecycle(events):
    started, closed, failures = {}, set(), []
    for event in events:
        block = event.get('block', {})
        if block.get('kind') != 'tool_call':
            continue
        call = block['callId']
        if block['phase'] == 'start':
            assert call not in started, 'duplicate_tool_start'
            started[call] = block
        else:
            assert block['phase'] in ('end', 'error'), 'unknown_tool_phase'
            assert call in started, 'tool_terminal_without_start'
            assert call not in closed, 'duplicate_tool_terminal'
            assert all(block[key] == started[call][key] for key in ('name', 'input', 'blockId')), 'tool_identity_mismatch'
            closed.add(call)
            if block['phase'] == 'error':
                failures.append(block)
    return started, failures, [block for call, block in started.items() if call not in closed]


def verify_source(source, reference, before, receipt):
    locator = source['locator']
    assert locator['documentId'] == reference['documentId'], 'source_document_mismatch'
    assert locator['sourceHash'] == reference['sourceHash'], 'source_hash_mismatch'
    doc = before.execute('SELECT source_path,source_hash,current_parse_id FROM research_documents WHERE id=?',
                         (locator['documentId'],)).fetchone()
    assert doc[1:] == (locator['sourceHash'], locator['parseId']), 'source_parse_mismatch'
    assert sha(Path(receipt['libraryRoot']) / doc[0]) == locator['sourceHash']
    parse = json.loads(before.execute('SELECT data_json FROM research_document_parses WHERE id=?',
                                      (locator['parseId'],)).fetchone()[0])
    ir_path = Path(receipt['libraryRoot']) / parse['paperIR']['path']
    assert sha(ir_path) == parse['paperIR']['sha256']
    ir = read(ir_path)
    for key, expected in ir['identity'].items():
        if key in locator:
            assert locator[key] == expected, 'source_identity_mismatch'
    original = next(b for b in ir['blocks'] if b['blockId'] == locator['blockId'])
    assert locator['locations'] == original['sourceLocator']['locations'], 'source_geometry_mismatch'
    span = locator.get('textSpan')
    expected = slice16(original['text'], span['start'], span['end']) if span else original['text']
    assert source['text'] == expected, 'source_text_mismatch'


def verify_quotes(statements, results, context):
    checked = []
    for statement, result in zip(statements, results, strict=True):
        assert statement['id'] == result['statementId'] and statement['text'] == result['text']
        assert statement['kind'] == 'quote', 'pilot verifier supports only observed quote statements'
        evidence = next(e for e in context['evidence'] if e['id'] == statement['evidenceId'])
        source = next((s for s in quoted_sources(evidence) if s['locator'] == statement['sourceLocator']), None)
        exact = source is not None and 0 <= statement['start'] < statement['end'] <= len(source['text'].encode('utf-16-le')) // 2
        exact = exact and slice16(source['text'], statement['start'], statement['end']) == statement['text']
        assert result['supportStatus'] == ('supported' if exact else 'insufficient_evidence'), 'quote_support_mismatch'
        assert result['reasons'] == ([] if exact else ['quote_source_span_mismatch']), 'quote_reason_mismatch'
        checked.append({'id': statement['id'], 'exact': exact, 'locatorMatched': source is not None,
                        'reasons': result['reasons']})
    return checked


def corruption_controls(root, reference_path):
    """Change copies of actual observations; originals and databases stay read-only."""
    report = read(Path(root) / 'report.json')
    manifest = read(Path(root) / 'manifest.json')
    receipt = read(pinned(manifest['receipt']))
    reference = read(reference_path)['references'][0]
    trial = report['trials'][0]
    before, agent = database(pinned(manifest['before'])), database(pinned(report['agent']))
    checks = []

    def rejected(name, reason, operation):
        try:
            operation()
        except AssertionError as error:
            assert str(error) == reason, (name, str(error), reason)
            checks.append({'name': name, 'rejected': True, 'reason': reason})
        else:
            raise AssertionError('corruption accepted: ' + name)

    try:
        run = trial['run']['runId']
        stored = [json.loads(row[0]) for row in agent.execute(
            'SELECT event_json FROM agent_run_events WHERE run_id=? ORDER BY sequence', (run,))]
        messages = agent.execute("SELECT content FROM session_messages WHERE thread_id=? AND role='assistant'",
                                 (trial['run']['threadId'],)).fetchall()
        events, answer = verify_replay(trial, stored, messages)
        verify_tool_lifecycle(events)
        start_index = next(i for i, e in enumerate(events)
                           if e.get('block', {}).get('kind') == 'tool_call' and e['block']['phase'] == 'start')
        end_index = next(i for i, e in enumerate(events)
                         if e.get('block', {}).get('callId') == events[start_index]['block']['callId']
                         and e['block']['phase'] == 'end')
        altered = copy.deepcopy(events)
        altered.pop(start_index)
        rejected('tool-terminal-owner', 'tool_terminal_without_start',
                 lambda: verify_tool_lifecycle(altered))
        altered = copy.deepcopy(events)
        altered[end_index]['block']['name'] = 'changed-tool'
        rejected('tool-terminal-identity', 'tool_identity_mismatch',
                 lambda: verify_tool_lifecycle(altered))
        altered = copy.deepcopy(events)
        altered.insert(end_index + 1, copy.deepcopy(altered[end_index]))
        rejected('tool-terminal-duplicate', 'duplicate_tool_terminal',
                 lambda: verify_tool_lifecycle(altered))
        for name, key, changed, reason in [
            ('event-owner', 'runId', 'other-run', 'event_run_mismatch'),
            ('event-order', 'sequence', 999, 'event_sequence_mismatch'),
            ('event-time', 'createdAt', 'changed', 'event_payload_mismatch'),
            ('event-content', 'payload', {'type': 'changed'}, 'event_payload_mismatch')
        ]:
            altered = copy.deepcopy(stored)
            altered[0][key] = changed
            rejected(name, reason, lambda: verify_replay(trial, altered, messages))
        rejected('persisted-answer', 'persisted_answer_mismatch',
                 lambda: verify_replay(trial, stored, [(answer + ' changed',)]))
        with tempfile.TemporaryDirectory(prefix='roc-pilot-control-') as temporary:
            path = Path(temporary) / 'events.jsonl'
            replay = [json.loads(line) for line in Path(trial['eventsPath']).read_text().splitlines()]
            delta = next(r for r in replay if r['event'].get('block', {}).get('kind') == 'text')
            delta['event']['block']['text'] += 'changed'
            altered = copy.deepcopy(stored)
            altered[delta['sequence'] - 1]['payload'] = delta['event']
            path.write_text(''.join(json.dumps(r) + '\n' for r in replay))
            changed_trial = {**trial, 'eventsPath': str(path)}
            rejected('stream-answer', 'stream_answer_mismatch',
                     lambda: verify_replay(changed_trial, altered, messages))
            pin = {'path': str(path), 'sha256': sha(path)}
            path.write_text('changed')
            rejected('artifact-bytes', str(path), lambda: pinned(pin))
        contexts, supported, unsupported = {}, None, None
        for event in events:
            block = event.get('block', {})
            if block.get('kind') != 'tool_call' or block.get('phase') != 'end':
                continue
            value = block['output']
            if isinstance(value, dict) and value.get('kind') == 'tool_result_artifact':
                value = json.loads(agent.execute('SELECT content FROM context_artifacts WHERE id=?',
                                                (value['artifactId'],)).fetchone()[0])
            elif isinstance(value, str):
                value = json.loads(value)
            if block['name'] == 'research_read_scientific_context':
                contexts[value['contextId']] = value
            if block['name'] == 'research_validate_scientific_evidence':
                context = contexts[block['input']['contextId']]
                for statement, result in zip(block['input']['statements'], value['statements'], strict=True):
                    verify_quotes([statement], [result], context)
                    pair = (statement, result, context)
                    if result['supportStatus'] == 'supported':
                        supported = pair
                    else:
                        unsupported = pair
        assert contexts and supported and unsupported, 'controls require observed accepted and rejected quotes'
        source = quoted_sources(next(iter(contexts.values()))['evidence'][0])[0]
        verify_source(source, reference, before, receipt)
        for name, key, changed, reason in [
            ('source-owner', 'documentId', 'other-paper', 'source_document_mismatch'),
            ('source-bytes', 'sourceHash', '0' * 64, 'source_hash_mismatch'),
            ('source-parse', 'parseId', 'other-parse', 'source_parse_mismatch'),
            ('source-geometry', 'locations', [], 'source_geometry_mismatch')
        ]:
            altered = copy.deepcopy(source)
            altered['locator'][key] = changed
            rejected(name, reason, lambda: verify_source(altered, reference, before, receipt))
        altered = {**source, 'text': source['text'] + 'changed'}
        rejected('source-window', 'source_text_mismatch',
                 lambda: verify_source(altered, reference, before, receipt))
        statement, result, context = supported
        changed_statement = {**statement, 'text': statement['text'] + 'changed'}
        changed_result = {**result, 'text': changed_statement['text']}
        rejected('quote-text', 'quote_support_mismatch',
                 lambda: verify_quotes([changed_statement], [changed_result], context))
        statement, result, context = unsupported
        rejected('invented-quote-support', 'quote_support_mismatch',
                 lambda: verify_quotes([statement], [{**result, 'supportStatus': 'supported'}], context))
        return checks
    finally:
        before.close()
        agent.close()


def audit(root, reference_path):
    root = Path(root)
    report = read(root / 'report.json')
    assert sha(root / 'manifest.json') == report['manifestSha256']
    manifest = read(root / 'manifest.json')
    assert sha('scripts/run-scientific-agent-pilot.mjs') == manifest['scriptHash']
    inputs = read(pinned(manifest['input']))
    assert inputs == manifest['trials']
    assert len(inputs) == len(report['trials']) == 3
    assert [t['id'] for t in report['trials']] == [i['id'] for i in inputs]
    assert report['quality'] == dict.fromkeys(['answerCorrectness', 'faithfulness', 'evidenceRecall', 'correctRefusal'])
    refs = read(reference_path)
    with tarfile.open(pinned(refs['archive'])) as source:
        raw = source.extractfile(refs['member']).read()
    assert hashlib.sha256(raw).hexdigest() == refs['memberSha256']
    published = json.loads(raw)
    reference_rows = {r['published']['question_id']: r for r in refs['references']}
    assert set(reference_rows) == {i['id'] for i in inputs}
    receipt = read(pinned(manifest['receipt']))
    assert manifest['projectId'] == receipt['projectId']
    before = database(pinned(manifest['before']))
    after = database(pinned(report['after']))
    agent = database(pinned(report['agent']))
    try:
        retention = {}
        for table in ['research_documents', 'research_document_parses', 'research_evidence',
                      'research_evidence_source_metadata', 'research_evidence_source_locators',
                      'research_wiki_revisions', 'research_scientific_chunks', 'research_scientific_embeddings']:
            old = before.execute(f'SELECT rowid,* FROM "{table}"').fetchall()
            for row in old:
                assert after.execute(f'SELECT rowid,* FROM "{table}" WHERE rowid=?', (row[0],)).fetchone() == row, table
            count = after.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            retention[table] = {'originalRowsPreserved': len(old), 'appendedRows': count - len(old)}
        assets = [p for p in receipt['copies'] if p['target'].startswith(receipt['libraryRoot'] + '/')]
        for asset in assets:
            assert sha(asset['target']) == sha(asset['source']) == asset['sha256']
            assert str(Path(asset['source']).stat().st_mtime_ns) == asset['mtimeNs']
        trials = []
        for trial, item in zip(report['trials'], inputs):
            reference = reference_rows[item['id']]
            official = next(q for q in published[reference['paperId']]['qas'] if q['question_id'] == item['id'])
            assert reference['published'] == official
            assert official['question'] in item['input'] and reference['documentId'] in item['input']
            run = trial['run']['runId']
            status, thread, user_input = agent.execute(
                'SELECT status,thread_id,user_input FROM agent_runs WHERE id=?', (run,)).fetchone()
            assert user_input == item['input'] and thread == trial['run']['threadId']
            stored = [json.loads(row[0]) for row in agent.execute(
                'SELECT event_json FROM agent_run_events WHERE run_id=? ORDER BY sequence', (run,))]
            messages = agent.execute("SELECT content FROM session_messages WHERE thread_id=? AND role='assistant'", (thread,)).fetchall()
            events, answer = verify_replay(trial, stored, messages)
            assert trial['status'] == 'run_' + status
            started, failures, unfinished = verify_tool_lifecycle(events)
            scientific_names = {'research_search_scientific_knowledge', 'research_read_scientific_context',
                                'research_validate_scientific_evidence', 'read_context_artifact'}
            other_tools = sorted({b['name'] for b in started.values()} - scientific_names)
            outputs, contexts, validations = [], {}, []
            source_count = 0
            for e in events:
                block = e.get('block', {})
                if block.get('kind') != 'tool_call' or block.get('phase') != 'end':
                    continue
                assert started[block['callId']]['name'] == block['name']
                assert started[block['callId']]['input'] == block['input']
                value = block['output']
                if isinstance(value, dict) and value.get('kind') == 'tool_result_artifact':
                    content, expected, owner = agent.execute('SELECT content,sha256,run_id FROM context_artifacts WHERE id=?',
                                                            (value['artifactId'],)).fetchone()
                    assert owner == run and hashlib.sha256(content.encode()).hexdigest() == expected
                    assert len(content.encode('utf-16-le')) // 2 == value['originalChars']
                    value = json.loads(content)
                elif isinstance(value, str):
                    value = json.loads(value)
                outputs.append({'name': block['name'], 'callId': block['callId'], 'output': value})
                if block['name'] == 'research_read_scientific_context':
                    assert value['projectId'] == receipt['projectId']
                    contexts[value['contextId']] = value
                    for evidence in value['evidence']:
                        assert evidence['documentId'] == reference['documentId']
                        for source in quoted_sources(evidence):
                            verify_source(source, reference, before, receipt)
                            source_count += 1
                if block['name'] == 'research_validate_scientific_evidence':
                    context = contexts[block['input']['contextId']]
                    assert value['contextId'] == context['contextId']
                    statements = verify_quotes(block['input']['statements'], value['statements'], context)
                    validations.append({'callId': block['callId'], 'statements': statements})
            assert len(outputs) + len(failures) + len(unfinished) == len(started)
            trials.append({'id': item['id'], 'paperId': reference['paperId'], 'runId': run,
                           'status': status, 'events': len(events), 'elapsedMs': trial['elapsedMs'],
                           'answer': answer, 'plannerJsonVisible': '"intents":' in answer,
                           'toolCounts': dict(collections.Counter(o['name'] for o in outputs)),
                           'toolStartCounts': dict(collections.Counter(b['name'] for b in started.values())),
                           'toolErrors': failures, 'unfinishedToolCalls': unfinished,
                           'onlyScientificAndArtifactToolsObserved': not other_tools,
                           'otherToolsObserved': other_tools,
                           'sourceWindowsVerified': source_count, 'validations': validations,
                           'publishedUnanswerable': all(a['answer']['unanswerable'] for a in official['answers']),
                           'semanticJudgment': None})
        return {'status': 'Verified observation integrity; scientific acceptance pending',
                'report': {'path': str(root / 'report.json'), 'sha256': sha(root / 'report.json')},
                'references': {'path': str(reference_path), 'sha256': sha(reference_path)},
                'buildHash': manifest['buildHash'], 'sourceFilesUnchanged': len(assets),
                'retention': retention, 'trials': trials,
                'limitations': manifest['limitations'] + ['Source windows verify immutable stored IR, not independently judged PDF extraction accuracy.',
                    'Returned context is recorded; model inspection of every artifact segment is not assumed.',
                    'Tool errors and unfinished calls are retained observations, not successful tool outputs.',
                    'Completion and source correspondence do not establish answer correctness or refusal.']}
    finally:
        before.close()
        after.close()
        agent.close()


if __name__ == '__main__':
    assert len(sys.argv) in (4, 5) and (len(sys.argv) == 4 or sys.argv[4] == '--controls'), \
        'usage: python3 scripts/check-scientific-agent-pilot.py RUN REFERENCES OUTPUT [--controls]'
    result = audit(sys.argv[1], sys.argv[2])
    result['verifierSha256'] = sha(__file__)
    if len(sys.argv) == 5:
        result['negativeControls'] = corruption_controls(sys.argv[1], sys.argv[2])
    with Path(sys.argv[3]).open('x') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write('\n')
    print(json.dumps({'status': result['status'], 'trials': len(result['trials']),
                      'sourceFilesUnchanged': result['sourceFilesUnchanged'], 'retention': result['retention']}))
