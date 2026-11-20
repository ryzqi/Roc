"""Freeze a small diagnostic selection from exact published QASPER bytes."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


root, output = map(Path, sys.argv[1:3])
lock = json.loads(Path('evaluation/lib/sources.lock.json').read_text())['qasper']
archive = Path('evaluation/local/sources/qasper/v0.3-dev/source.tgz')
assert sha(archive.read_bytes()) == lock['archiveSha256']
with tarfile.open(archive) as source:
    raw = source.extractfile(lock['member']).read()
assert sha(raw) == lock['memberSha256']
data = json.loads(raw)
receipt = json.loads((root / 'project-receipt.json').read_text())
seed_bytes = Path(receipt['sourceRun']['path']).read_bytes()
assert sha(seed_bytes) == receipt['sourceRun']['sha256']
papers = {r['paperId']: r for r in json.loads(seed_bytes)['observations']}
rows = [(paper, q) for paper in sorted(papers) for q in data[paper]['qas']]
answerable = [(p, q) for p, q in rows if q['answers'] and all(not a['answer']['unanswerable'] for a in q['answers'])]
unanswerable = [(p, q) for p, q in rows if q['answers'] and all(a['answer']['unanswerable'] for a in q['answers'])]
selected = answerable[:2] + unanswerable[:1]
assert len(papers) == 45 and len(selected) == 3
output.mkdir()
inputs, references = [], []
for paper, question in selected:
    document = papers[paper]
    instructions = (
        'Answer the question using only this project paper. Use the scientific research search, '
        'context and evidence-validation tools; read full context before answering. '
        'Use read-only research tools only: no filesystem, shell, web, memory, subagents or project edits. '
        'If evidence is insufficient, say so explicitly. Do not invent missing facts. '
        'Cite exact source quotes with paper/page and return a concise English answer. '
        'Use rerank none. Do not request user approval or clarification.\n'
        f'Paper: {data[paper]["title"]}\narXiv: {paper}\n'
        f'documentIds: {json.dumps([document["documentId"]])}\n'
        f'Question: {question["question"]}'
    )
    inputs.append({'id': question['question_id'], 'input': instructions})
    references.append({'paperId': paper, 'documentId': document['documentId'],
                       'sourceHash': document['sourceHash'], 'published': question})
manifest = {'version': 1, 'selection': 'paper-id-asc/original-QA-order: first2 unanimously answerable plus first unanimously unanswerable',
            'availablePapers': len(papers), 'availableQuestions': len(rows),
            'archive': {'path': str(archive), 'sha256': lock['archiveSha256']},
            'member': lock['member'], 'memberSha256': lock['memberSha256'],
            'projectReceipt': {'path': str(root / 'project-receipt.json'), 'sha256': sha((root / 'project-receipt.json').read_bytes())},
            'references': references,
            'limitations': ['Diagnostic pilot; no category coverage or representative quality estimate.',
                            'Published QASPER labels; manuscript version correspondence requires independent review.']}
for name, value in [('inputs.json', inputs), ('references.json', manifest)]:
    (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'papers': len(papers), 'questions': len(rows), 'selected': [i['id'] for i in inputs]}))
