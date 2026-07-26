#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

const agentTables = [
  'agent_threads',
  'agent_runs',
  'agent_run_telemetry',
  'agent_langsmith_trace_sessions',
  'agent_events',
  'session_messages',
  'session_messages_fts',
  'agent_pending_interrupts',
  'agent_run_events',
  'langgraph_checkpoints',
  'langgraph_checkpoint_writes',
  'agent_tool_effects',
  'context_artifacts'
];

const taskTables = [
  'background_tasks',
  'scheduled_task_runs'
];

try {
  const options = readOptions(process.argv.slice(2));
  await main(options);
} catch (error) {
  console.error(readErrorMessage(error));
  process.exitCode = 1;
}

async function main(input) {
  if (!input.allThreadKinds) {
    throw new Error('clear_agent_history_requires_all_thread_kinds');
  }

  const rootDir = resolve(input.rootDir);
  const pluginDataDir = join(rootDir, 'plugin-data');
  const agentDbPath = join(pluginDataDir, 'data', 'plugins', '@roc', 'plugin-agent.db');
  const taskDbPath = join(pluginDataDir, 'data', 'plugins', '@roc', 'plugin-task.db');
  if (!existsSync(agentDbPath)) {
    throw new Error(`agent_database_missing:${agentDbPath}`);
  }

  const agentDb = openDatabase(agentDbPath);
  const taskDb = existsSync(taskDbPath) ? openDatabase(taskDbPath) : null;
  try {
    const before = {
      agent: countTables(agentDb, agentTables),
      task: taskDb === null ? null : countTables(taskDb, taskTables)
    };
    console.log(JSON.stringify({ phase: 'before', rootDir, agentDbPath, taskDbPath, counts: before }, null, 2));

    const backupDir = join(pluginDataDir, 'backups', `manual-clear-history-${timestampForPath(new Date())}`);
    mkdirSync(backupDir, { recursive: true });
    await agentDb.backup(join(backupDir, 'plugin-agent.db'));
    if (taskDb !== null) {
      await taskDb.backup(join(backupDir, 'plugin-task.db'));
    }
    console.log(JSON.stringify({ phase: 'backup', backupDir }, null, 2));

    deleteAllAgentHistory(agentDb);
    if (taskDb !== null) {
      deleteAllTaskHistory(taskDb);
    }
    rebuildSessionMessagesFts(agentDb);
    checkpoint(agentDb);
    if (taskDb !== null) {
      checkpoint(taskDb);
    }

    const after = {
      agent: countTables(agentDb, agentTables),
      task: taskDb === null ? null : countTables(taskDb, taskTables),
      integrity: {
        agent: integrityCheck(agentDb),
        task: taskDb === null ? 'missing' : integrityCheck(taskDb)
      }
    };
    console.log(JSON.stringify({ phase: 'after', counts: after }, null, 2));
  } finally {
    agentDb.close();
    if (taskDb !== null) {
      taskDb.close();
    }
  }
}

function readOptions(argv) {
  let rootDir = join(homedir(), '.roc');
  let allThreadKinds = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error('clear_agent_history_root_missing');
      }
      rootDir = value;
      index += 1;
      continue;
    }
    if (arg === '--all-thread-kinds') {
      allThreadKinds = true;
      continue;
    }
    if (arg === '--backup') {
      continue;
    }
    throw new Error(`clear_agent_history_unknown_arg:${arg}`);
  }
  return { rootDir, allThreadKinds };
}

function openDatabase(databasePath) {
  const db = new Database(databasePath);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

function countTables(db, tables) {
  const counts = {};
  for (const table of tables) {
    counts[table] = tableExists(db, table) ? db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() : 'missing';
  }
  return counts;
}

function deleteAllAgentHistory(db) {
  db.transaction(() => {
    runDeleteIfTableExists(db, 'agent_pending_interrupts');
    runDeleteIfTableExists(db, 'agent_run_events');
    runDeleteIfTableExists(db, 'agent_tool_effects');
    runDeleteIfTableExists(db, 'context_artifacts');
    runDeleteIfTableExists(db, 'langgraph_checkpoint_writes');
    runDeleteIfTableExists(db, 'langgraph_checkpoints');
    runDeleteIfTableExists(db, 'session_messages');
    runDeleteIfTableExists(db, 'agent_events');
    runDeleteIfTableExists(db, 'agent_run_telemetry');
    runDeleteIfTableExists(db, 'agent_langsmith_trace_sessions');
    runDeleteIfTableExists(db, 'agent_runs');
    runDeleteIfTableExists(db, 'agent_threads');
  })();
}

function deleteAllTaskHistory(db) {
  db.transaction(() => {
    runDeleteIfTableExists(db, 'scheduled_task_runs');
    runDeleteIfTableExists(db, 'background_tasks');
  })();
}

function rebuildSessionMessagesFts(db) {
  if (!tableExists(db, 'session_messages_fts')) {
    return;
  }
  if (!tableExists(db, 'session_messages')) {
    return;
  }
  db.prepare("INSERT INTO session_messages_fts(session_messages_fts) VALUES('rebuild')").run();
}

function runDeleteIfTableExists(db, tableName) {
  if (!tableExists(db, tableName)) {
    return;
  }
  db.prepare(`DELETE FROM ${tableName}`).run();
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return row !== undefined;
}

function checkpoint(db) {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

function integrityCheck(db) {
  const result = db.prepare('PRAGMA integrity_check').pluck().get();
  if (result !== 'ok') {
    throw new Error(`database_integrity_check_failed:${result}`);
  }
  return result;
}

function timestampForPath(date) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function readErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
