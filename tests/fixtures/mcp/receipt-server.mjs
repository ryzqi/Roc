import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const receiptsPath = process.argv[2];
const send = (id, result) => process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, result})}\n`);
const record = value => appendFileSync(receiptsPath, `${JSON.stringify(value)}\n`);
record({event: 'started', pid: process.pid});

createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send(request.id, {protocolVersion: '2025-06-18', capabilities: {tools: {}},
      serverInfo: {name: 'roc-local-receipt-fixture', version: '1'}});
  } else if (request.method === 'tools/list') {
    send(request.id, {tools: ['write', 'query'].map(name => ({
      name, description: `Local ${name} receipt fixture`,
      inputSchema: {type: 'object', properties: {requestId: {type: 'string'}},
        required: ['requestId'], additionalProperties: false}
    }))});
  } else if (request.method === 'tools/call') {
    if (request.params.name === 'write') {
      // The side effect commits, but the caller never receives its response.
      record({event: 'write', receiptId: `local:${request.params.arguments.requestId}`,
        args: request.params.arguments, pid: process.pid});
    } else if (request.params.name === 'query') {
      record({event: 'query', requestId: request.params.arguments.requestId});
      const matches = readFileSync(receiptsPath, 'utf8').trim().split('\n').map(JSON.parse)
        .filter(receipt => receipt.event === 'write' &&
          receipt.args.requestId === request.params.arguments.requestId);
      send(request.id, {content: [{type: 'text', text: JSON.stringify(matches)}]});
    } else {
      throw new Error(`unsupported_local_tool:${request.params.name}`);
    }
  } else if (request.method === 'ping') {
    send(request.id, {});
  } else {
    process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id: request.id,
      error: {code: -32601, message: 'Unsupported fixture method'}})}\n`);
  }
});
