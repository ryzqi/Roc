"""Extend the read-only pilot integrity audit with independent source-handle quotes.

No production quote resolver or validator is imported. The unchanged pilot auditor
owns replay, source/IR, PDF, SQLite and history checks; this adapter checks quotes.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('pilot_integrity', Path(__file__).with_name('check-scientific-agent-pilot.py'))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
legacy_quotes = pilot.verify_quotes


def sources(context):
    found = {}
    for evidence in context['evidence']:
        for source in [s for h in evidence['hits'] for s in h['sources']] + [
            {'sourceId': p.get('sourceId'), 'text': p['text'], 'locator': p['sourceLocator']}
            for p in evidence['passages']]:
            if not source.get('sourceId'):
                continue
            identity = json.dumps([context['contextId'], evidence['id'], source['text'], source['locator']],
                                  ensure_ascii=False, separators=(',', ':'))
            expected = 'scientific-source:' + hashlib.sha256(identity.encode()).hexdigest()
            assert source['sourceId'] == expected, 'quote_source_identity_mismatch'
            value = {'evidenceId': evidence['id'], 'text': source['text'], 'sourceLocator': source['locator']}
            assert source['sourceId'] not in found or found[source['sourceId']] == value, 'quote_source_id_conflict'
            found[source['sourceId']] = value
    return found


def resolve(statement, context):
    assert statement['kind'] == 'quote'
    source = sources(context).get(statement['sourceId'])
    assert source is not None, 'quote_source_missing'
    if 'selection' in statement:
        assert statement['selection'] == 'source' and 'text' not in statement, 'quote_source_selection_invalid'
        text = source['text']
    else:
        text = statement['text']
    start = source['text'].find(text)
    assert start >= 0, 'quote_text_missing'
    assert source['text'].find(text, start + 1) < 0, 'quote_text_ambiguous'
    # Python indices are code points; independently derive JS UTF-16 offsets.
    offset = len(source['text'][:start].encode('utf-16-le')) // 2
    length = len(text.encode('utf-16-le')) // 2
    return {'statementId': statement['id'], 'sourceId': statement['sourceId'],
            'evidenceId': source['evidenceId'], 'text': text,
            'sourceLocator': source['sourceLocator'], 'start': offset, 'end': offset + length}


def verify_quotes(statements, results, context):
    checked = []
    for statement, result in zip(statements, results, strict=True):
        if 'sourceId' not in statement:
            checked += legacy_quotes([statement], [result], context)
            continue
        resolved = resolve(statement, context)
        assert result['statementId'] == statement['id'] and result['text'] == resolved['text'], 'quote_result_identity_mismatch'
        assert result['evidenceIds'] == [resolved['evidenceId']], 'quote_result_owner_mismatch'
        assert result['sourceStatus'] == 'valid' and result['supportStatus'] == 'supported', 'quote_support_mismatch'
        assert result['reasons'] == [], 'quote_reason_mismatch'
        checked.append({'id': statement['id'], 'exact': True, 'locatorMatched': True,
                        'reasons': [], 'sourceId': statement['sourceId'], 'resolved': resolved})
    return checked


def assert_resolution(actual, expected):
    assert actual == expected, 'quote_resolution_mismatch'


def tool_output(block, agent):
    value = block['output']
    if isinstance(value, dict) and value.get('kind') == 'tool_result_artifact':
        value = agent.execute('SELECT content FROM context_artifacts WHERE id=?',
                              (value['artifactId'],)).fetchone()[0]
    return json.loads(value) if isinstance(value, str) else value


def audit(root, reference_path):
    # Inject only the quote observation check into the existing independent auditor.
    pilot.verify_quotes = verify_quotes
    try:
        result = pilot.audit(root, reference_path)
    finally:
        pilot.verify_quotes = legacy_quotes
    report = pilot.read(Path(root) / 'report.json')
    agent = pilot.database(pilot.pinned(report['agent']))
    samples, errors = [], []
    try:
        for trial in report['trials']:
            contexts = {}
            for record in map(json.loads, Path(trial['eventsPath']).read_text().splitlines()):
                block = record['event'].get('block', {})
                if block.get('kind') != 'tool_call':
                    continue
                if block['phase'] == 'error' and block['name'] == 'research_validate_scientific_evidence':
                    request = block['input']
                    context = contexts[request['contextId']]
                    rejected_reason = None
                    for statement in request['statements']:
                        if 'sourceId' not in statement:
                            continue
                        try:
                            resolve(statement, context)
                        except AssertionError as error:
                            rejected_reason = str(error)
                            break
                    assert rejected_reason is not None, 'quote_error_without_invalid_selection'
                    domain = {'quote_source_missing': 'research_scientific_quote_source_handle_missing',
                              'quote_text_missing': 'research_scientific_quote_text_missing',
                              'quote_text_ambiguous': 'research_scientific_quote_text_ambiguous'}
                    assert block['error'].startswith(domain[rejected_reason] + ':'), 'quote_error_reason_mismatch'
                    errors.append({'trialId': trial['id'], 'callId': block['callId'],
                                   'input': request, 'error': block['error'],
                                   'independentReason': rejected_reason})
                if block['phase'] != 'end':
                    continue
                value = tool_output(block, agent)
                if block['name'] == 'research_read_scientific_context':
                    sources(value)
                    contexts[value['contextId']] = value
                if block['name'] == 'research_validate_scientific_evidence':
                    context = contexts[block['input']['contextId']]
                    selected = [s for s in block['input']['statements'] if 'sourceId' in s]
                    expected = [resolve(s, context) for s in selected]
                    assert_resolution(value.get('resolvedQuotes', []), expected)
                    for statement in selected:
                        validation = next(r for r in value['statements'] if r['statementId'] == statement['id'])
                        samples.append((statement, context, validation, resolve(statement, context)))
        controls = []

        def rejected(name, reason, operation):
            try:
                operation()
            except AssertionError as error:
                assert str(error) == reason, (name, str(error))
                controls.append({'name': name, 'rejected': True, 'reason': reason})
            else:
                raise AssertionError('corruption accepted: ' + name)

        if samples:
            statement, context, validation, resolved = samples[0]
            # Excerpt controls remain applicable when the observed selection chose a full source.
            statement = {k: v for k, v in statement.items() if k != 'selection'}
            statement['text'] = resolved['text']
            rejected('foreign-source-handle', 'quote_source_missing',
                     lambda: resolve({**statement, 'sourceId': 'foreign'}, context))
            rejected('modified-source-text', 'quote_text_missing',
                     lambda: resolve({**statement, 'text': statement['text'] + '\nchanged-unobserved-text'}, context))
            source = sources(context)[statement['sourceId']]
            ambiguous = next((c for c in source['text'] if source['text'].count(c) > 1), None)
            if ambiguous:
                rejected('ambiguous-source-text', 'quote_text_ambiguous',
                         lambda: resolve({**statement, 'text': ambiguous}, context))
            rejected('invented-evidence-owner', 'quote_result_owner_mismatch',
                     lambda: verify_quotes([statement], [{**validation, 'evidenceIds': ['foreign']}], context))
            altered_context = copy.deepcopy(context)
            selected_source = next(s for e in altered_context['evidence']
                                   for s in [s for h in e['hits'] for s in h['sources']] + e['passages']
                                   if s.get('sourceId') == statement['sourceId'])
            selected_source['sourceId'] = 'scientific-source:' + '0' * 64
            rejected('context-source-handle', 'quote_source_identity_mismatch',
                     lambda: sources(altered_context))
            for key, changed in [('start', resolved['start'] + 1), ('sourceLocator', {}), ('sourceId', 'foreign')]:
                altered = {**resolved, key: changed}
                rejected('resolved-' + key, 'quote_resolution_mismatch',
                         lambda: assert_resolution([altered], [resolved]))
            whole = {k: v for k, v in statement.items() if k != 'text'}
            whole['selection'] = 'source'
            rejected('whole-source-replacement-text', 'quote_source_selection_invalid',
                     lambda: resolve({**whole, 'text': 'replacement'}, context))
        result['sourceSelectionsVerified'] = len(samples)
        result['wholeSourceSelectionsVerified'] = sum(s.get('selection') == 'source' for s, _, _, _ in samples)
        result['quoteSelectionErrors'] = errors
        result['negativeControls'] = controls
        result['verifierSha256'] = pilot.sha(__file__)
        result['integrityVerifier'] = {'path': str(Path(pilot.__file__)), 'sha256': pilot.sha(pilot.__file__)}
        result['limitations'] += [
            'Source-handle checks establish unique exact excerpts and offsets, not final-answer semantic support.',
            'Corruption controls use copies of accepted selections; an empty set means no accepted selection was observed.']
        return result
    finally:
        agent.close()


if __name__ == '__main__':
    assert len(sys.argv) == 4, 'usage: python3 scripts/check-scientific-quote-selection.py RUN REFERENCES OUTPUT'
    result = audit(sys.argv[1], sys.argv[2])
    with Path(sys.argv[3]).open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({'status': result['status'], 'trials': len(result['trials']),
                      'sourceSelectionsVerified': result['sourceSelectionsVerified'],
                      'wholeSourceSelectionsVerified': result['wholeSourceSelectionsVerified'],
                      'negativeControls': len(result['negativeControls'])}))
