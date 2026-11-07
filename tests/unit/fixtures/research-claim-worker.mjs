import {parentPort, workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';

const api = await import(workerData.modulePath);
const db = new Database(workerData.databasePath, {timeout: 5000});
const tasks = new api.ResearchTaskRepository(db, () => workerData.now);
const barrier = new Int32Array(workerData.barrier);
parentPort.postMessage({ready: true});
Atomics.wait(barrier, 0, 0);
try {
  const lease = tasks.graph.claim({...workerData.claim, workerId: workerData.workerId});
  parentPort.postMessage({lease});
} finally {db.close();}
