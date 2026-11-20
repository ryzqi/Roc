import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

test('bounded timers wait for the deadline, replace registrations, and clear on suspension', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const timers = new api.BackgroundDeadlines(10), fired = [];
  timers.schedule('long', new Date(Date.now() + 80).toISOString(), () => fired.push('long'));
  timers.schedule('replace', new Date(Date.now() + 20).toISOString(), () => fired.push('obsolete'));
  timers.schedule('replace', new Date(Date.now() + 90).toISOString(), () => fired.push('replace'));
  t.mock.timers.tick(35);
  assert.deepEqual(fired, []);
  timers.remove('replace');
  t.mock.timers.tick(70);
  assert.deepEqual(fired, ['long']);
  timers.schedule('suspended', new Date(Date.now() + 10).toISOString(), () => fired.push('suspended'));
  timers.clear();
  t.mock.timers.tick(25);
  assert.deepEqual(fired, ['long']);
});

test('task scheduler reconciles durable occurrences on start and power resume, and stays suspended', () => {
  let reconciled = 0;
  const repository = {
    reconcileScheduledOccurrences() {reconciled++;},
    listSchedulableBackgroundTasks() {return [];},
    nextScheduledOccurrenceClaimExpiry() {return null;},
    countRecentSkippedScheduledRuns() {return 0;}
  };
  const scheduler = new api.TaskScheduler(repository);
  scheduler.start();
  assert.equal(reconciled, 1);
  scheduler.handlePowerResume();
  assert.equal(reconciled, 2);
  scheduler.suspendAll();
  scheduler.handlePowerResume();
  assert.equal(reconciled, 2);
  scheduler.resumeAll();
  assert.equal(reconciled, 3);
  scheduler.stop();
  scheduler.handlePowerResume();
  assert.equal(reconciled, 3);
  assert.equal(scheduler.getStatus().running, false);
});
