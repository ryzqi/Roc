import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

const api = await loadResearchTestApi();
after(() => api.dispose());

for (const looping of [false, true]) {
  test(`independent evidence batches ${looping ? 'still stop a loop within one batch' : 'may reread frozen manuscript pages'}`, async () => {
    const f = createScientificReviewFixture(api, {
      claimContents: Array.from({length: 21}, (_, index) => `Frozen observation ${index + 1}.`)
    });
    const child = f.children.find(run => run.role === 'evidence-reviewer');
    const valid = f.output(child), batchIds = new Set();
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'review-batch-progress-regression'; }
      bindTools(tools) {
        const response = tools.find(entry => (entry.function?.name ?? entry.name) !== 'read_artifact');
        responseToolName = response.function?.name ?? response.name;
        return this;
      }
      async _generate(messages) {
        assert.ok(++requests <= 30, 'loop detection must stop repeated reads promptly');
        const initial = JSON.parse(String(messages.find(message => message.getType() === 'human').content));
        const ids = initial.frozenClaims.map(claim => claim.claimId);
        batchIds.add(ids.join(','));
        const reads = messages.filter(message => message.getType() === 'tool' && message.name === 'read_artifact');
        assert.ok(reads.every(message => message.status !== 'error'), 'valid manuscript pages must be readable');
        const call = reads.length < 2 || looping ? {
          name: 'read_artifact', args: {artifactId: f.artifactId, offset: (reads.length % 2) * 8000, limit: 8000}
        } : {
          name: responseToolName, args: {title: 'Frozen evidence review', markdown: 'Retain uncertainty.',
            claims: [], sections: [], verdict: 'uncertain',
            scientificReview: {...valid, suggestions: valid.suggestions.filter(item => ids.includes(item.claimId))}}
        };
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          ...call, id: `read-or-submit-${requests}`, type: 'tool_call'
        }]})}]};
      }
    }
    try {
      const signal = new AbortController().signal;
      const context = f.repository.runs.getContext(child.id);
      const tools = f.worker(child.id, () => api.createResearchRoleTools({
        run: f.repository.runs.get(child.id, f.project.id), context, repository: f.repository, signal,
        capabilities: {invoke: async () => assert.fail('no external capabilities are needed')}
      })).filter(entry => entry.name === 'read_artifact');
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const execute = () => f.worker(child.id, id => prepared.execute({
        run: f.repository.runs.get(id, f.project.id), context, tools, signal,
        loadTaskContext: () => ({
          task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({
            taskId: child.taskId, projectId: f.project.id
          })
        })
      }));
      if (looping) {
        await assert.rejects(execute(), /tool_call_loop_detected/);
        assert.equal(batchIds.size, 1);
        assert.equal(requests, 4);
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
      } else {
        const result = await execute();
        assert.equal(batchIds.size, 6);
        assert.equal(requests, 18);
        assert.deepEqual(result.output.scientificReview, valid);
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
        assert.equal(completed.outputArtifactIds.length, 1);
        assert.deepEqual(f.repository.scientificReviews.inspect(f.project.id, completed.outputArtifactIds[0]).output, valid);
        assert.equal(f.agentDb.prepare('SELECT count(*) FROM agent_tool_progress WHERE run_id=?').pluck().get(child.id), 12,
          'all batch read progress remains in the audit ledger');
      }
    } finally {f.close();}
  });
}
