import { describe, expect, it } from 'vitest';

import { readRunInterruptedEvents } from '../../../../src/main/plugins/agent/deep-agent-final-output';

describe('readRunInterruptedEvents', () => {
  it('projects every framework interrupt in order', () => {
    expect(
      readRunInterruptedEvents(
        {
          interrupts: [
            {
              interruptId: 'interrupt-a',
              payload: {
                kind: 'question',
                question: 'First?'
              }
            },
            {
              interruptId: 'interrupt-b',
              payload: {
                actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
                reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve'] }]
              }
            }
          ]
        },
        'run-multiple',
        'thread-multiple'
      )
    ).toEqual([
      {
        type: 'run_interrupted',
        runId: 'run-multiple',
        threadId: 'thread-multiple',
        interruptId: 'interrupt-a',
        payload: {
          kind: 'question',
          question: 'First?'
        }
      },
      {
        type: 'run_interrupted',
        runId: 'run-multiple',
        threadId: 'thread-multiple',
        interruptId: 'interrupt-b',
        payload: {
          kind: 'approval',
          request: {
            actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
            reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve'] }]
          }
        }
      }
    ]);
  });
});
