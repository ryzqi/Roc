export const TOOL_ERROR_FIXTURES = [
  {
    name: 'trigger.schedule',
    schemaPath: 'trigger.type',
    badKeys: ['trigger.schedule'],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'trigger': {'schedule': '50 21 * * *'}} with error:\n" +
      "Received tool input did not match expected schema: Invalid input: expected 'manual' | 'once' | 'cron' at trigger.type\n" +
      'Please fix your mistakes.'
  },
  {
    name: 'missing trigger.type',
    schemaPath: 'trigger.type',
    badKeys: [],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'trigger': {'description': '每天 21:50 触发'}} with error:\n" +
      "Received tool input did not match expected schema: Invalid input: expected 'manual' | 'once' | 'cron' at trigger.type\n" +
      'Please fix your mistakes.'
  },
  {
    name: 'notificationPolicy on_error',
    schemaPath: 'notificationPolicy',
    badKeys: ['notificationPolicy'],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'notificationPolicy': 'on_error'} with error:\n" +
      "Received tool input did not match expected schema: Invalid input: expected 'failures_and_confirmations' at notificationPolicy\n" +
      'Please fix your mistakes.'
  },
  {
    name: 'notificationPolicy default',
    schemaPath: 'notificationPolicy',
    badKeys: ['notificationPolicy'],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'notificationPolicy': 'default'} with error:\n" +
      'Received tool input did not match expected schema: Unrecognized key: "notificationPolicy" at notificationPolicy\n' +
      'Please fix your mistakes.'
  },
  {
    name: 'non-ISO nextRunAt',
    schemaPath: 'trigger.nextRunAt',
    badKeys: [],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'trigger': {'type': 'cron', 'nextRunAt': '2026/05/25 21:50'}} with error:\n" +
      'Received tool input did not match expected schema: Invalid ISO datetime at trigger.nextRunAt\n' +
      'Please fix your mistakes.'
  },
  {
    name: 'trigger.expression',
    schemaPath: 'trigger',
    badKeys: ['trigger.expression'],
    message:
      "Error invoking tool 'propose_background_task' with kwargs {'trigger': {'type': 'cron', 'expression': '50 21 * * *'}} with error:\n" +
      'Received tool input did not match expected schema: Unrecognized key: "expression" at trigger\n' +
      'Please fix your mistakes.'
  }
] as const;
