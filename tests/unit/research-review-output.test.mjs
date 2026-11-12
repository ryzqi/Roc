import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
import {ToolInputParsingException} from '@langchain/core/tools';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

const api = await loadResearchTestApi();
after(() => api.dispose());

function productionToolContext(f, child) {
  // These capability-boundary tests stub production reads. Supply the matching frozen
  // production kind while retaining real active-run fencing and scientific inputs.
  const context = f.repository.runs.getContext(child.id);
  const entry = context.inputs.find(input => input.artifact.id === f.artifactId);
  const artifactId = 'artifact_production_fixture';
  context.inputs.push({...entry, artifact: {...entry.artifact, id: artifactId, kind: 'experiment_run', stage: 'experiment'},
    output: null, manuscript: null});
  const frozen = structuredClone(context);
  const repository = Object.create(f.repository);
  repository.runs = Object.create(f.repository.runs);
  repository.runs.requireActive = (...args) => f.repository.runs.requireActive(...args);
  repository.runs.getContext = id => id === child.id ? structuredClone(frozen) : f.repository.runs.getContext(id);
  return {context, repository, artifactId};
}

test('actual panel corrects a child-only scientific report before durable synthesis save', async () => {
  const f = createScientificReviewFixture(api);
  const plain = {title: 'Panel synthesis', markdown: 'Retain the independent uncertainty findings.',
    claims: [], sections: [], verdict: 'revise'};
  const invalid = {...plain, scientificReview: f.output(f.children[0])};
  let responseToolName, requests = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'panel-role-boundary-fixture'; }
    bindTools(tools) { responseToolName = tools[0].function?.name ?? tools[0].name; return this; }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 2);
      if (requests === 2) assert.ok(messages.some(message => message.getType() === 'tool' &&
        String(message.content).includes('scientificReview')), 'the forbidden field must be returned for correction');
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
        id: `panel-${requests}`, name: responseToolName, type: 'tool_call', args: requests === 1 ? invalid : plain
      }]})}]};
    }
  }
  try {
    const children = f.children.map(child => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id,
      {...plain, claims: [], sections: [], scientificReview: f.output(child)})));
    f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, children));
    assert.throws(() => f.worker(f.parent.id, id => f.repository.runs.complete(id, f.project.id, invalid)),
      /research_scientific_review_role_invalid/);
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(f.parent.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
      context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
      loadTaskContext: () => ({task: f.tasks.get(f.parent.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.parent.taskId, projectId: f.project.id})})}));
    const completed = f.worker(f.parent.id, id => f.repository.runs.complete(id, f.project.id, result.output));
    assert.equal(completed.status, 'completed');
    assert.equal(requests, 2);
    assert.deepEqual(result.output, plain);
  } finally {f.close();}
});

test('actual reviewer recovers from a production path outside the manifest without inventing file content', async () => {
  const f = createScientificReviewFixture(api);
  const child = f.children.find(run => run.role === 'evidence-reviewer');
  const production = productionToolContext(f, child);
  const output = {title: 'Review', markdown: 'Only inspected frozen evidence.', claims: [], sections: [],
    verdict: 'uncertain', scientificReview: f.output(child)};
  let responseToolName, requests = 0, reads = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'production-manifest-error-correction-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => !['read_production_input_file', 'list_evidence'].includes(tool.function?.name ?? tool.name));
      responseToolName = response.function?.name ?? response.name; return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 3);
      if (requests === 2) {
        const error = messages.find(message => message.tool_call_id === 'missing-file');
        assert.equal(error?.status, 'error');
        assert.match(String(error.content), /research_production_file_not_found/);
        assert.match(String(error.content), /inspect_production_input/);
        assert.match(String(error.content), /area\/path/);
      }
      const call = requests === 1 ? {id: 'missing-file', name: 'read_production_input_file',
        args: {artifactId: production.artifactId, area: 'output', path: 'not-in-manifest.csv', offset: 0, limit: 100}}
        : requests === 2 ? {id: 'frozen-evidence', name: 'list_evidence', args: {offset: 0, limit: 20}}
        : {id: 'review-output', name: responseToolName, args: output};
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const {context, repository} = production, signal = new AbortController().signal;
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository, signal, capabilities: {invoke: async (name, request) => {
        assert.equal(name, 'research.artifacts.readProductionFile');
        assert.equal(request.path, 'not-in-manifest.csv'); reads++;
        throw new Error('research_production_file_not_found');
      }}})).filter(tool => ['read_production_input_file', 'list_evidence'].includes(tool.name));
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id), context,
      tools, signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 3);
    assert.equal(reads, 1);
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
  } finally {f.close();}
});

test('production read integrity, authorization, cancellation and binding errors remain fatal', async () => {
  const f = createScientificReviewFixture(api);
  const child = f.children[0], controller = new AbortController();
  let failure = new Error('research_production_snapshot_changed'), reads = 0;
  try {
    const {context, repository, artifactId} = productionToolContext(f, child);
    const tool = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository, signal: controller.signal, capabilities: {invoke: async () => {reads++; throw failure;}}}))
      .find(tool => tool.name === 'read_production_input_file');
    const request = {artifactId, area: 'output', path: 'metrics.json', offset: 0, limit: 100};
    for (const message of ['research_production_snapshot_changed', 'research_production_project_mismatch',
      'research_production_approval_required', 'research_experiment_snapshot_changed']) {
      failure = new Error(message);
      await assert.rejects(f.worker(child.id, () => tool.invoke(request)), error => error === failure);
    }
    failure = Object.assign(new Error('physical file absent'), {code: 'ENOENT'});
    await assert.rejects(f.worker(child.id, () => tool.invoke(request)), error => error === failure);
    const before = reads;
    context.inputs = [];
    await assert.rejects(f.worker(child.id, () => tool.invoke(request)), /research_role_tool_binding_invalid/);
    controller.abort(new Error('controlled_read_cancelled'));
    await assert.rejects(f.worker(child.id, () => tool.invoke(request)), /controlled_read_cancelled/);
    assert.equal(reads, before);
  } finally {f.close();}
});

test('evidence review fits bounded responses and saves only the complete frozen report', async () => {
  const f = createScientificReviewFixture(api, {claimContents: Array.from({length: 9}, (_, i) => `Observation ${i + 1}.`)});
  const child = f.children.find(run => run.role === 'evidence-reviewer');
  const valid = f.output(child);
  let responseToolName;
  const batches = [];
  class Model extends BaseChatModel {
    _llmType() { return 'bounded-review-output-budget-fixture'; }
    bindTools(tools) {
      const response = tools[0].function ?? tools[0];
      responseToolName = response.name;
      assert.ok(response.parameters.properties.scientificReview.properties.suggestions.maxItems <= 4,
        'a full long-reference report exceeds the response budget');
      return this;
    }
    async _generate(messages) {
      const initial = JSON.parse(String(messages.find(message => message.getType() === 'human').content));
      assert.equal(initial.scientificInputHash, valid.inputHash, 'batches retain the full frozen input identity');
      assert.ok(initial.frozenClaims.length <= 4);
      const ids = initial.frozenClaims.map(claim => claim.claimId);
      batches.push(ids);
      assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
        id: `batch-${batches.length}`, name: responseToolName, type: 'tool_call', args: {
          title: 'Evidence review', markdown: `Batch ${batches.length}`, claims: [], sections: [],
          verdict: batches.length === 2 ? 'revise' : 'ready',
          scientificReview: {...valid, suggestions: valid.suggestions.filter(item => ids.includes(item.claimId))}
        }
      }]})}]};
    }
  }
  try {
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
      context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
      loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.deepEqual(batches.map(batch => batch.length), [4, 4, 1]);
    assert.deepEqual(batches.flat(), f.input.claims.map(claim => claim.id));
    assert.deepEqual(result.output.scientificReview, valid);
    assert.equal(result.output.verdict, 'revise', 'aggregation must preserve any revision requirement');
    assert.match(result.output.markdown, /Batch 1[\s\S]*Batch 2[\s\S]*Batch 3/);
    const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
    assert.equal(completed.outputArtifactIds.length, 1);
    assert.deepEqual(f.repository.scientificReviews.inspect(f.project.id, completed.outputArtifactIds[0]).output, valid);
  } finally {f.close();}
});

for (const fault of ['locator_correction', 'cancelled', 'later_failure', 'correction_limit']) {
  test(`bounded evidence review handles ${fault} without saving an intermediate report`, async () => {
    const f = createScientificReviewFixture(api, {claimContents: Array.from({length: 5}, (_, i) => `Observation ${i + 1}.`)});
    const child = f.children.find(run => run.role === 'evidence-reviewer');
    const controller = new AbortController();
    const valid = f.output(child);
    let responseToolName, requests = 0, laterRequests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'bounded-review-failure-fixture'; }
      bindTools(tools) { responseToolName = tools[0].function?.name ?? tools[0].name; return this; }
      async _generate(messages) {
        requests++;
        const initial = JSON.parse(String(messages.find(message => message.getType() === 'human').content));
        const ids = initial.frozenClaims.map(claim => claim.claimId);
        const review = structuredClone({...valid, suggestions: valid.suggestions.filter(item => ids.includes(item.claimId))});
        if (ids.length === 1) {
          laterRequests++;
          assert.ok(laterRequests <= 7, 'corrections must be bounded');
          assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
          if (fault === 'cancelled') controller.abort(new Error('controlled_batch_cancelled'));
          if (fault === 'later_failure') throw new Error('controlled_later_batch_failure');
          if (fault === 'correction_limit' || fault === 'locator_correction' && laterRequests === 1) {
            review.suggestions[0].supporting[0] = {...f.reference, quote: 'Wrong frozen text.'};
          }
          if (fault === 'locator_correction' && laterRequests === 2) {
            assert.match(String(messages.findLast(message => message.getType() === 'tool').content),
              /research_scientific_locator_invalid/);
          }
        }
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          id: `bounded-${requests}`, name: responseToolName, type: 'tool_call', args: {
            title: 'Evidence review', markdown: 'Bounded review.', claims: [], sections: [], verdict: 'uncertain',
            scientificReview: review
          }
        }]})}]};
      }
    }
    try {
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const execute = () => f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context: f.repository.runs.getContext(id), tools: [], signal: controller.signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      if (fault === 'locator_correction') {
        const result = await execute();
        assert.deepEqual(result.output.scientificReview, valid);
        assert.equal(laterRequests, 2);
        const partial = {...result.output, scientificReview: {...valid, suggestions: valid.suggestions.slice(0, 4)}};
        assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, partial)), /coverage_required/);
      } else {
        const error = fault === 'cancelled' ? /controlled_batch_cancelled|abort/i
          : fault === 'later_failure' ? /controlled_later_batch_failure/ : /research_role_output_correction_limit/;
        await assert.rejects(execute, error);
        assert.equal(laterRequests, fault === 'correction_limit' ? 7 : 1);
      }
      assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
    } finally {f.close();}
  });
}

for (const role of ['methods-reviewer', 'evidence-reviewer', 'writing-reviewer']) {
  test(`actual ${role} exposes the complete frozen claim contract and corrects partial coverage`, async () => {
    const claimCount = role === 'evidence-reviewer' ? 4 : 16;
    const f = createScientificReviewFixture(api, {claimContents: Array.from({length: claimCount}, (_, i) => `Fixture observation ${i + 1}.`)});
    const child = f.children.find(run => run.role === role);
    const valid = {title: 'Complete review', markdown: 'Controlled review.', claims: [], sections: [],
      verdict: 'uncertain', scientificReview: f.output(child)};
    const field = role === 'evidence-reviewer' ? 'suggestions' : 'coveredClaimIds';
    const partial = structuredClone(valid);
    partial.scientificReview[field] = partial.scientificReview[field].slice(0, claimCount - 1);
    const wrongIds = structuredClone(valid);
    wrongIds.scientificReview[field][1] = structuredClone(wrongIds.scientificReview[field][0]);
    if (field === 'suggestions') wrongIds.scientificReview[field][2].claimId = 'claim-not-frozen';
    else wrongIds.scientificReview[field][2] = 'claim-not-frozen';
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'complete-frozen-review-contract-fixture'; }
      bindTools(tools) {
        const response = tools[0].function ?? tools[0];
        responseToolName = response.name;
        const array = response.parameters.properties.scientificReview.properties[field];
        assert.equal(array.minItems, claimCount, 'generation must require every frozen claim');
        assert.equal(array.maxItems, claimCount, 'generation must prohibit extra suggestions');
        return this;
      }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= 3);
        const initial = JSON.parse(String(messages.find(message => message.getType() === 'human').content));
        assert.deepEqual(initial.frozenClaims, f.input.claims.map(claim => ({
          claimId: claim.id, claimVersion: claim.version, claimHash: api.relationClaimHash(claim),
          content: claim.content, evidenceIds: claim.evidenceIds
        })));
        if (requests === 2) assert.ok(messages.some(message => message.getType() === 'tool' &&
          String(message.content).includes(String(claimCount))), 'partial length must be returned to the model');
        if (requests === 3) {
          const feedback = String(messages.findLast(message => message.getType() === 'tool').content);
          const coverage = role === 'evidence-reviewer' ? 'claim' : 'finding';
          assert.match(feedback, new RegExp(`research_scientific_${coverage}_coverage_required`));
          assert.ok(feedback.includes(`missingClaimIds=${JSON.stringify(f.input.claims.slice(1, 3).map(claim => claim.id))}`));
          assert.ok(feedback.includes(`duplicateClaimIds=${JSON.stringify([f.input.claims[0].id])}`));
          assert.ok(feedback.includes('unknownClaimIds=["claim-not-frozen"]'));
        }
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          id: `coverage-${requests}`, name: responseToolName, type: 'tool_call',
          args: requests === 1 ? partial : requests === 2 ? wrongIds : valid
        }]})}]};
      }
    }
    try {
      assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, partial)), /coverage_required/);
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      assert.equal(requests, 3);
      const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
      assert.equal(completed.status, 'completed');
      const saved = f.repository.scientificReviews.inspect(f.project.id, completed.outputArtifactIds[0]);
      assert.deepEqual(saved.output, valid.scientificReview);
    } finally {f.close();}
  });
}

for (const fault of ['met_without_reference', 'missing_required_criterion']) {
  test(`actual evidence reviewer corrects ${fault} refinement before durable save`, async () => {
    const f = createScientificReviewFixture(api);
    const child = f.children.find(run => run.role === 'evidence-reviewer');
    const valid = {title: 'Evidence review', markdown: 'Controlled review.', claims: [], sections: [],
      verdict: 'uncertain', scientificReview: f.output(child)};
    const invalid = structuredClone(valid);
    const suggestion = invalid.scientificReview.suggestions[0];
    if (fault === 'met_without_reference') suggestion.conditions[0].references = [];
    else suggestion.conditions = [];
    const errorCode = fault === 'met_without_reference'
      ? 'research_scientific_evidence_conditions_missing' : 'research_scientific_conditions_required';
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'scientific-condition-correction-fixture'; }
      bindTools(tools) { responseToolName = tools[0].function?.name ?? tools[0].name; return this; }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= 2);
        if (requests === 2) assert.ok(messages.some(message => message.getType() === 'tool' &&
          String(message.content).includes(errorCode) &&
          JSON.parse(String(message.content)).some(issue =>
            issue.path.join('.') === (fault === 'met_without_reference'
              ? 'scientificReview.suggestions.0.conditions.0.references'
              : 'scientificReview.suggestions.0.conditions') &&
            issue.message.includes(suggestion.conditions[0]?.criterion ?? valid.scientificReview.suggestions[0].conditions[0].criterion) &&
            (fault !== 'met_without_reference' || issue.message.includes('missing') && issue.message.includes('uncertain')))),
        'the exact refinement and affected suggestion must be returned to the model');
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          id: `condition-${requests}`, name: responseToolName, type: 'tool_call', args: requests === 1 ? invalid : valid
        }]})}]};
      }
    }
    try {
      assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, invalid)),
        new RegExp(errorCode));
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      assert.equal(requests, 2);
      assert.deepEqual(result.output, valid);
      const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
      assert.equal(completed.status, 'completed');
      assert.equal(completed.outputArtifactIds.length, 1);
    } finally {f.close();}
  });
}

for (const role of ['methods-reviewer', 'evidence-reviewer', 'writing-reviewer']) {
  test(`actual ${role} corrects missing scientific output before durable save`, async () => {
    const f = createScientificReviewFixture(api);
    const child = f.children.find(run => run.role === role);
    assert.ok(child);
    const plain = {title: 'Independent review', markdown: 'Controlled review.', claims: [], sections: [], verdict: 'uncertain'};
    const output = {...plain, scientificReview: f.output(child)};
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'scientific-review-correction-fixture'; }
      bindTools(tools) { responseToolName = tools[0].function?.name ?? tools[0].name; return this; }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= 2);
        if (requests === 2) assert.ok(messages.some(message => message.getType() === 'tool' &&
          String(message.content).includes('scientificReview')), 'missing review must be returned to the model');
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          id: `review-${requests}`, name: responseToolName, type: 'tool_call', args: requests === 1 ? plain : output
        }]})}]};
      }
    }
    try {
      assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, plain)),
        /research_scientific_review_required/);
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
      assert.equal(requests, 2);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.outputArtifactIds.length, 1);
      assert.deepEqual(result.output, output);
    } finally {f.close();}
  });
}

test('actual reviewer corrects a shortened quote through exact frozen excerpt lookup before saving', async () => {
  const quote = '"overall": "partial",\n  "note": "fixture 😀 only"';
  const sourceText = `前缀😀\n{\n  ${quote}\n}\nOther source context remains available.`;
  const f = createScientificReviewFixture(api, {sourceText});
  const child = f.children.find(run => run.role === 'methods-reviewer');
  const review = f.output(child), invalid = structuredClone(review);
  invalid.findings[0].references[0].quote = quote; // Actual failure: short quote, full-page offsets.
  let responseToolName, requests = 0, reference;
  class Model extends BaseChatModel {
    _llmType() { return 'exact-frozen-quote-lookup-fixture'; }
    bindTools(tools) {
      const response = tools.find(value => (value.function?.name ?? value.name) !== 'inspect_evidence_source');
      responseToolName = response.function?.name ?? response.name;
      return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 3, 'the tool should resolve the exact quote without repeated guessing');
      if (requests === 2) {
        const feedback = String(messages.findLast(message => message.getType() === 'tool').content);
        assert.match(feedback, /research_scientific_locator_invalid/);
        assert.match(feedback, /quote.*inspect_evidence_source|inspect_evidence_source.*quote/);
      }
      if (requests === 3) {
        const toolResult = String(messages.findLast(message => message.getType() === 'tool').content);
        assert.doesNotMatch(toolResult, /Error invoking tool/, 'exact quote lookup must be accepted by the real tool');
        const response = JSON.parse(toolResult);
        reference = response.excerptPage.reference;
        assert.deepEqual(reference, {...f.reference, start: sourceText.indexOf(quote),
          end: sourceText.indexOf(quote) + quote.length, quote});
        assert.equal(response.excerptPage.totalChars, sourceText.length);
        review.findings[0].references = [reference];
      }
      const call = requests === 2 ? {id: 'lookup-exact-quote', name: 'inspect_evidence_source',
        args: {evidenceId: f.evidence.id, offset: 0, limit: 8000, quote}}
        : {id: `review-${requests}`, name: responseToolName, args: {title: 'Review', markdown: 'Fixture only.',
          claims: [], sections: [], verdict: 'uncertain', scientificReview: requests === 1 ? invalid : review}};
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const context = f.repository.runs.getContext(child.id), signal = new AbortController().signal;
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository: f.repository, capabilities: {invoke: async () => assert.fail('No unfrozen retrieval')}, signal}))
      .filter(tool => tool.name === 'inspect_evidence_source');
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id), context,
      tools, signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.equal(requests, 3);
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
    const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
    assert.deepEqual(f.repository.scientificReviews.inspect(f.project.id, completed.outputArtifactIds[0]).output, review);
  } finally {f.close();}
});

test('exact quote lookup rejects missing, ambiguous and unfrozen text without silently choosing a reference', async () => {
  const f = createScientificReviewFixture(api, {sourceText: 'Repeated 😀 text.\nRepeated 😀 text.\nFrozen final sentence.'});
  const child = f.children.find(run => run.role === 'methods-reviewer');
  try {
    const tool = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context: f.repository.runs.getContext(child.id), repository: f.repository,
      capabilities: {invoke: async () => assert.fail('No unfrozen retrieval')}, signal: new AbortController().signal}))
      .find(tool => tool.name === 'inspect_evidence_source');
    for (const [quote, error] of [['Missing text', /research_evidence_quote_not_found/],
      ['Repeated 😀 text.', /research_evidence_quote_ambiguous/], ['Repeated', /research_evidence_quote_ambiguous/]]) {
      await assert.rejects(f.worker(child.id, () => tool.invoke({evidenceId: f.evidence.id, offset: 0, limit: 20, quote})), error);
    }
    await assert.rejects(f.worker(child.id, () => tool.invoke({evidenceId: 'not-in-frozen-input', offset: 0,
      limit: 20, quote: 'Frozen final sentence.'})), /research_evidence_not_in_run_inputs/);
    // Evidence IDs appear in metadata, but metadata must not become a citation target.
    await assert.rejects(f.worker(child.id, () => tool.invoke({evidenceId: f.evidence.id, offset: 0,
      limit: 20, quote: f.evidence.id})), /research_evidence_quote_not_found/);
    const result = await f.worker(child.id, () => tool.invoke({evidenceId: f.evidence.id, offset: 1000,
      limit: 1, quote: 'Frozen final sentence.'}));
    assert.equal(result.excerptPage.mode, 'quote');
    assert.equal(result.excerptPage.nextOffset, null);
    assert.equal(result.excerptPage.reference.quote, 'Frozen final sentence.');
    assert.equal(result.excerptPage.reference.sourceDigest, f.reference.sourceDigest);
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
    // Corrupt live data must still trip the currentness guard before any quote lookup.
    f.db.prepare('UPDATE research_evidence SET excerpt = ? WHERE id = ?')
      .run('New live text outside the frozen input.', f.evidence.id);
    await assert.rejects(f.worker(child.id, () => tool.invoke({evidenceId: f.evidence.id, offset: 0,
      limit: 20, quote: 'New live text outside the frozen input.'})), /research_evidence_integrity_invalid/);
  } finally {f.close();}
});

test('actual frozen reviewer can copy bounded UTF-16 excerpt references from inspection into a saved report', async () => {
  const sourceText = '前缀😀 "quoted"\nOnly fixture execution; safety remains untested.\n尾部。';
  const f = createScientificReviewFixture(api, {sourceText});
  const child = f.children.find(run => run.role === 'methods-reviewer');
  let responseToolName, requests = 0;
  const references = [];
  const pages = [{offset: 0, limit: 11}, {offset: 11, limit: 8000}];
  class Model extends BaseChatModel {
    _llmType() { return 'copy-exact-frozen-reference-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => (tool.function?.name ?? tool.name) !== 'inspect_evidence_source');
      responseToolName = response.function?.name ?? response.name; return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 3);
      if (requests > 1) {
        const message = messages.find(message => message.tool_call_id === `excerpt-${requests - 1}`);
        const response = JSON.parse(String(message.content));
        assert.ok(response.excerptPage?.reference, 'inspection must expose a copyable exact raw-excerpt reference');
        const reference = response.excerptPage.reference, requested = pages[requests - 2];
        assert.equal(response.excerptPage.totalChars, sourceText.length);
        assert.equal(reference.start, requested.offset);
        assert.equal(reference.end, Math.min(sourceText.length, requested.offset + requested.limit));
        assert.equal(reference.quote, sourceText.slice(reference.start, reference.end));
        assert.ok(reference.quote.length <= requested.limit);
        assert.equal(reference.sourceDigest, f.reference.sourceDigest);
        assert.equal(reference.evidenceId, f.evidence.id);
        assert.equal(response.excerptPage.nextOffset, requests === 2 ? 11 : null);
        references.push(reference);
      }
      const review = f.output(child);
      review.findings[0].references = references;
      const call = requests <= 2 ? {id: `excerpt-${requests}`, name: 'inspect_evidence_source',
        args: {evidenceId: f.evidence.id, ...pages[requests - 1]}}
        : {id: 'exact-review', name: responseToolName, args: {title: 'Review', markdown: 'Fixture limitations only.',
          claims: [], sections: [], verdict: 'uncertain', scientificReview: review}};
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const context = f.repository.runs.getContext(child.id), signal = new AbortController().signal;
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository: f.repository, capabilities: {invoke: async () => assert.fail('No live/global retrieval')}, signal}))
      .filter(tool => tool.name === 'inspect_evidence_source');
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id), context,
      tools, signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.equal(requests, 3);
    const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputArtifactIds.length, 1);
    const invalid = structuredClone(result.output);
    invalid.scientificReview.findings[0].references[0].end++;
    assert.throws(() => f.worker(f.children[2].id, id => f.repository.runs.complete(id, f.project.id, invalid)),
      /research_scientific_locator_invalid/);
    const emptyPage = await f.worker(f.children[2].id, id => api.createResearchRoleTools({run: f.repository.runs.get(id, f.project.id),
      context: f.repository.runs.getContext(id), repository: f.repository,
      capabilities: {invoke: async () => assert.fail('No global reads')}, signal})
      .find(tool => tool.name === 'inspect_evidence_source').invoke({evidenceId: f.evidence.id, offset: sourceText.length, limit: 10}));
    assert.equal(emptyPage.excerptPage.reference, null);
    assert.equal(emptyPage.excerptPage.nextOffset, null);
  } finally {f.close();}
});

test('actual frozen reviewer corrects an unavailable evidence reference without reading that source', async () => {
  const f = createScientificReviewFixture(api);
  const child = f.children[0];
  const output = {title: 'Independent review', markdown: 'Controlled review.', claims: [], sections: [],
    verdict: 'uncertain', scientificReview: f.output(child)};
  let responseToolName, requests = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'frozen-evidence-correction-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => !['inspect_evidence_source', 'list_evidence'].includes(tool.function?.name ?? tool.name));
      responseToolName = response.function?.name ?? response.name; return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 4);
      if (requests === 2) {
        const error = messages.find(message => message.tool_call_id === 'unavailable-source');
        assert.equal(error?.status, 'error');
        assert.match(String(error.content), /research_evidence_not_in_run_inputs/);
        assert.match(String(error.content), /list_evidence/);
      }
      if (requests === 3) assert.ok(messages.some(message => message.tool_call_id === 'frozen-list' &&
        String(message.content).includes(f.evidence.id)));
      if (requests === 4) assert.ok(messages.some(message => message.tool_call_id === 'frozen-source' &&
        String(message.content).includes('sourceDigest')));
      const call = requests === 1 ? {id: 'unavailable-source', name: 'inspect_evidence_source',
        args: {evidenceId: 'evidence-outside-frozen-inputs', offset: 0, limit: 8000}}
        : requests === 2 ? {id: 'frozen-list', name: 'list_evidence', args: {offset: 0, limit: 20}}
        : requests === 3 ? {id: 'frozen-source', name: 'inspect_evidence_source',
          args: {evidenceId: f.evidence.id, offset: 0, limit: 8000}}
        : {id: 'review-output', name: responseToolName, args: output};
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const context = f.repository.runs.getContext(child.id);
    const inspectEvidence = f.repository.evidence.inspectEvidence.bind(f.repository.evidence);
    f.repository.evidence.inspectEvidence = (evidenceId, projectId) => {
      assert.equal(evidenceId, f.evidence.id, 'Unavailable sources must never be read from the live repository');
      return inspectEvidence(evidenceId, projectId);
    };
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository: f.repository, capabilities: {invoke: async () => assert.fail('No global reads')},
      signal: new AbortController().signal})).filter(tool => ['inspect_evidence_source', 'list_evidence'].includes(tool.name));
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id), context,
      tools, signal: new AbortController().signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 4);
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
  } finally {f.close();}
});

for (const role of ['methods-reviewer', 'evidence-reviewer', 'writing-reviewer']) {
  test(`actual ${role} corrects an invalid frozen locator before durable save`, async () => {
    const f = createScientificReviewFixture(api);
    const child = f.children.find(run => run.role === role);
    const valid = {title: 'Independent review', markdown: 'Controlled review.', claims: [], sections: [],
      verdict: 'uncertain', scientificReview: f.output(child)};
    const invalid = structuredClone(valid);
    const references = invalid.scientificReview.kind === 'verifier'
      ? invalid.scientificReview.suggestions[0].supporting : invalid.scientificReview.findings[0].references;
    references[0].end -= 1;
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'scientific-locator-correction-fixture'; }
      bindTools(tools) { responseToolName = tools[0].function?.name ?? tools[0].name; return this; }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= 2);
        if (requests === 2) assert.ok(messages.some(message => message.getType() === 'tool' &&
          String(message.content).includes('research_scientific_locator_invalid')),
        'the frozen locator rejection must be returned to the model');
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{
          id: `locator-${requests}`, name: responseToolName, type: 'tool_call', args: requests === 1 ? invalid : valid
        }]})}]};
      }
    }
    try {
      assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, invalid)),
        /research_scientific_locator_invalid/);
      assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context: f.repository.runs.getContext(id), tools: [], signal: new AbortController().signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
      assert.equal(requests, 2);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.outputArtifactIds.length, 1);
      assert.deepEqual(result.output, valid);
    } finally {f.close();}
  });
}

for (const fault of ['empty', 'text', 'missing_limit', 'mixed_limit', 'cancelled', 'provider_failure']) {
  test(`actual reviewer handles a terminal response without structured output: ${fault}`, async () => {
    const f = createScientificReviewFixture(api);
    const child = f.children.find(run => run.role === 'methods-reviewer');
    const controller = new AbortController();
    const valid = {title: 'Review', markdown: 'Only frozen sources inspected.', claims: [], sections: [],
      verdict: 'uncertain', scientificReview: f.output(child)};
    let responseToolName, requests = 0;
    class Model extends BaseChatModel {
      _llmType() { return 'missing-structured-review-fixture'; }
      bindTools(tools) {
        const response = tools.find(tool => (tool.function?.name ?? tool.name) !== 'list_evidence');
        responseToolName = response.function?.name ?? response.name;
        return this;
      }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= 8, 'missing and invalid output must share the correction budget');
        let content = '', call;
        if (requests === 1) {
          call = {id: 'read-frozen-once', name: 'list_evidence', args: {offset: 0, limit: 20}};
        } else {
          assert.equal(messages.filter(message => message.tool_call_id === 'read-frozen-once').length, 1,
            'continue with the original read result without replaying the tool');
          if (requests >= 3) {
            if (fault === 'provider_failure') throw new Error('controlled_provider_failure');
            assert.match(String(messages.findLast(message => message.getType() === 'human').content),
              /research_role_output_missing/);
          }
          if (fault === 'cancelled') controller.abort(new Error('controlled_output_cancelled'));
          if (requests >= 3 && ['empty', 'text'].includes(fault)) {
            call = {id: 'review-output', name: responseToolName, args: valid};
          } else if (fault === 'mixed_limit' && requests % 2 === 1) {
            call = {id: `invalid-output-${requests}`, name: responseToolName,
              args: {...valid, scientificReview: {...valid.scientificReview, coveredClaimIds: []}}};
          } else content = fault === 'text' ? JSON.stringify(valid) : '';
        }
        return {generations: [{text: content, message: new AIMessage({content,
          tool_calls: call === undefined ? [] : [{...call, type: 'tool_call'}]})}]};
      }
    }
    try {
      const context = f.repository.runs.getContext(child.id);
      const tools = f.worker(child.id, () => api.createResearchRoleTools({run: child, context,
        repository: f.repository, signal: controller.signal})).filter(tool => tool.name === 'list_evidence');
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const execute = () => f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context, tools, signal: controller.signal,
        loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      if (['empty', 'text'].includes(fault)) {
        assert.deepEqual((await execute()).output, valid);
        assert.equal(requests, 3, 'plain JSON prose is not accepted as structured success');
      } else {
        const expected = fault.endsWith('limit') ? /research_role_output_correction_limit/
          : fault === 'cancelled' ? /controlled_output_cancelled|abort/i : /controlled_provider_failure/;
        await assert.rejects(execute, expected);
        assert.equal(requests, fault.endsWith('limit') ? 8 : fault === 'cancelled' ? 2 : 3);
      }
      assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
    } finally {f.close();}
  });
}


test('actual reviewer corrects non-production manuscript IDs before reading production files', async () => {
  const f = createScientificReviewFixture(api);
  const child = f.children.find(run => run.role === 'methods-reviewer');
  const output = {title: 'Review', markdown: 'Reviewed the structured manuscript.', claims: [], sections: [],
    verdict: 'uncertain', scientificReview: f.output(child)};
  let responseToolName, requests = 0, productionCalls = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'production-artifact-kind-correction-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => !['inspect_production_input', 'read_production_input_file', 'read_artifact'].includes(tool.function?.name ?? tool.name));
      responseToolName = response.function?.name ?? response.name; return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 3);
      if (requests === 2) {
        for (const id of ['wrong-inspect', 'wrong-read']) {
          const error = messages.find(message => message.tool_call_id === id);
          assert.equal(error?.status, 'error');
          assert.match(String(error.content), /research_production_artifact_required/);
          assert.match(String(error.content), /read_artifact/);
          assert.match(String(error.content), /manuscript/);
        }
      }
      if (requests === 3) {
        const read = messages.find(message => message.tool_call_id === 'manuscript');
        assert.notEqual(read?.status, 'error');
        assert.match(String(read?.content), /Results/);
      }
      const calls = requests === 1 ? [
        {id: 'wrong-inspect', name: 'inspect_production_input', args: {artifactId: f.artifactId, section: 'files', offset: 0, limit: 8000}},
        {id: 'wrong-read', name: 'read_production_input_file', args: {artifactId: f.artifactId, area: 'output', path: 'paper.tex', offset: 0, limit: 8000}}
      ] : requests === 2 ? [{id: 'manuscript', name: 'read_artifact', args: {artifactId: f.artifactId, offset: 0, limit: 8000}}]
        : [{id: 'review-output', name: responseToolName, args: output}];
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: calls.map(call => ({...call, type: 'tool_call'}))})}]};
    }
  }
  const production = new api.ResearchProductionInputService(f.repository, {}, {}, {});
  try {
    await assert.rejects(production.inspect(f.project.id, f.artifactId), /research_production_artifact_required/);
    const context = f.repository.runs.getContext(child.id), signal = new AbortController().signal;
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
      context, repository: f.repository, signal, capabilities: {invoke: async (name, request) => {
        productionCalls++;
        return name === 'research.artifacts.inspectProduction' ? production.inspect(request.projectId, request.artifactId)
          : production.read(request);
      }}})).filter(tool => ['inspect_production_input', 'read_production_input_file', 'read_artifact'].includes(tool.name));
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id), context,
      tools, signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 3);
    assert.equal(productionCalls, 0, 'wrong kinds must be rejected before invoking production capabilities');
    const completed = f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, result.output));
    assert.equal(completed.status, 'completed');
  } finally {await production.shutdown(); f.close();}
});

function frozenClaimRelationTool(f, child) {
  const context = f.repository.runs.getContext(child.id), signal = new AbortController().signal;
  // Keep real currentness/lease checks on the original repository. Only the tool's
  // direct live-relation read is forbidden; it must use the frozen scientific input.
  const repository = Object.create(f.repository);
  repository.evidence = Object.create(f.repository.evidence);
  repository.evidence.relations = Object.create(f.repository.evidence.relations);
  repository.evidence.relations.list = () => assert.fail('Frozen review must not query live relations');
  const tool = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id),
    context, repository, signal, capabilities: {invoke: async () => assert.fail('No external retrieval')}}))
    .find(tool => tool.name === 'list_evidence_relations');
  assert.ok(tool);
  return {context, signal, tool};
}

test('frozen claim scope: unavailable claim IDs are recoverable tool input errors', async () => {
  const f = createScientificReviewFixture(api);
  const child = f.children.find(run => run.role === 'evidence-reviewer');
  try {
    const {tool} = frozenClaimRelationTool(f, child);
    for (const claimId of [f.evidence.id, f.artifactId, 'claim-outside-frozen-input']) {
      await assert.rejects(f.worker(child.id, () => tool.invoke({claimId, offset: 0, limit: 20})), error => {
        assert.ok(error instanceof ToolInputParsingException,
          `Unavailable claimId ${claimId} must be returned for model correction, not fail the review`);
        assert.match(error.message, /research_claim_not_in_run_inputs/);
        assert.match(error.message, /null/, 'feedback must explain how to discover valid frozen claim IDs');
        return true;
      });
    }
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
  } finally {f.close();}
});

test('frozen claim scope: null and exact IDs expose only frozen relations and inactive fencing stays fatal', async () => {
  const f = createScientificReviewFixture(api, {contradiction: true,
    claimContents: ['First frozen observation.', 'Second frozen observation.']});
  const child = f.children.find(run => run.role === 'evidence-reviewer');
  try {
    const {tool, context} = frozenClaimRelationTool(f, child);
    const frozen = context.scientificInput.relations;
    assert.equal(frozen.length, 4);
    for (const claimId of [null, ...f.input.claims.map(claim => claim.id)]) {
      const expected = frozen.filter(relation => claimId === null || relation.claimId === claimId);
      const result = await f.worker(child.id, () => tool.invoke({claimId, offset: 0, limit: 20}));
      assert.equal(result.total, expected.length);
      assert.deepEqual(result.items.map(item => item.id), expected.map(relation => relation.id));
      for (const [index, item] of result.items.entries()) {
        const relation = expected[index];
        for (const field of ['claimId', 'claimVersion', 'evidenceId', 'status', 'version', 'sourceDigest']) {
          assert.equal(item[field], relation[field]);
        }
        assert.equal(item.excerpt, relation.source.evidence.excerpt);
      }
    }
    const page = await f.worker(child.id, () => tool.invoke({claimId: null, offset: 1, limit: 1}));
    assert.equal(page.total, frozen.length);
    assert.deepEqual(page.items.map(item => item.id), [frozen[1].id]);
    f.repository.runs.terminate(child.id, f.project.id, 'cancelled', 'Controlled inactive claim lookup');
    for (const claimId of [null, f.claim.id, 'claim-outside-frozen-input']) {
      await assert.rejects(f.worker(child.id, () => tool.invoke({claimId, offset: 0, limit: 20})), error => {
        assert.ok(!(error instanceof ToolInputParsingException), 'inactive fencing is not model-correctable input');
        assert.equal(error.message, 'research_run_not_current');
        return true;
      });
    }
    assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
  } finally {f.close();}
});

for (const inactive of [false, true]) {
  test(`frozen claim scope: actual reviewer ${inactive ? 'stops on inactive fencing' : 'recovers through null then an exact frozen ID'}`, async () => {
    const f = createScientificReviewFixture(api);
    const child = f.children.find(run => run.role === 'evidence-reviewer');
    const output = {title: 'Frozen relation review', markdown: 'Only inspected frozen relations.', claims: [], sections: [],
      verdict: 'uncertain', scientificReview: f.output(child)};
    let responseToolName, requests = 0, recoveredClaimId;
    class Model extends BaseChatModel {
      _llmType() { return 'frozen-claim-scope-correction-fixture'; }
      bindTools(tools) {
        const response = tools.find(tool => (tool.function?.name ?? tool.name) !== 'list_evidence_relations');
        responseToolName = response.function?.name ?? response.name;
        return this;
      }
      async _generate(messages) {
        requests++;
        assert.ok(requests <= (inactive ? 1 : 4), 'inactive fencing must stop; valid input may correct and continue');
        if (inactive) f.repository.runs.terminate(child.id, f.project.id, 'cancelled', 'Controlled inactive model call');
        if (requests === 2) {
          const error = messages.find(message => message.tool_call_id === 'unavailable-claim');
          assert.equal(error?.status, 'error');
          assert.match(String(error.content), /research_claim_not_in_run_inputs/);
          assert.match(String(error.content), /null/);
        }
        if (requests === 3 || requests === 4) {
          const id = requests === 3 ? 'discover-frozen-claims' : 'exact-frozen-claim';
          const message = messages.find(message => message.tool_call_id === id);
          assert.ok(message);
          assert.notEqual(message.status, 'error');
          const result = JSON.parse(String(message.content));
          assert.equal(result.total, f.input.relations.length);
          assert.deepEqual(result.items.map(item => item.id), f.input.relations.map(relation => relation.id));
          recoveredClaimId = result.items[0].claimId;
          assert.equal(recoveredClaimId, f.claim.id);
        }
        assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
        const call = requests === 1 ? {id: 'unavailable-claim', name: 'list_evidence_relations',
          args: {claimId: f.evidence.id, offset: 0, limit: 20}}
          : requests === 2 ? {id: 'discover-frozen-claims', name: 'list_evidence_relations',
            args: {claimId: null, offset: 0, limit: 20}}
          : requests === 3 ? {id: 'exact-frozen-claim', name: 'list_evidence_relations',
            args: {claimId: recoveredClaimId, offset: 0, limit: 20}}
          : {id: 'review-output', name: responseToolName, args: output};
        return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
      }
    }
    try {
      const {tool, context, signal} = frozenClaimRelationTool(f, child);
      const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
        return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
      }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
        api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
      const execute = () => f.worker(child.id, id => prepared.execute({run: f.repository.runs.get(id, f.project.id),
        context, tools: [tool], signal, loadTaskContext: () => ({task: f.tasks.get(child.taskId, f.project.id),
          facts: new api.ResearchTaskFactsService(f.repository).get({taskId: child.taskId, projectId: f.project.id})})}));
      if (inactive) {
        await assert.rejects(execute, error => {
          assert.ok(!(error instanceof ToolInputParsingException));
          assert.equal(error.message, 'research_run_not_current');
          return true;
        });
        assert.equal(requests, 1, 'the executor must not ask the model to repair an inactive run');
      } else {
        const result = await execute();
        assert.deepEqual(result.output, output);
        assert.equal(requests, 4);
      }
      assert.equal(f.repository.runs.get(child.id, f.project.id).outputArtifactIds.length, 0);
    } finally {f.close();}
  });
}
