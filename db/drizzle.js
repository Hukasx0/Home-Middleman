/**
 * Drizzle ORM + better-sqlite3 bootstrap for Home Middleman
 * - No migrations required. Tables are created with IF NOT EXISTS on startup.
 * - Provides simple sync helpers used by the server.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'home_middleman.sqlite');

// Ensure data dir
fs.mkdirSync(DATA_DIR, { recursive: true });

// Open DB
const raw = new Database(DB_PATH);
const db = drizzle(raw);

// Schema
const tasks = sqliteTable('tasks', {
  name: text('name').primaryKey().notNull(),
  type: text('type'),
  data: text('data'),
  postType: text('postType'),
  postData: text('postData'),
});

const intervals = sqliteTable('intervals', {
  name: text('name').primaryKey().notNull(),
  timeMs: integer('time_ms').notNull(), // milliseconds
});

const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  message: text('message').notNull(),
  createdAt: integer('created_at').notNull(), // unix epoch ms
});

const clips = sqliteTable('clips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
});

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  text: text('text').notNull(),
  date: text('date').notNull(),
});

// DDL bootstrap (no migration system needed)
function initDb() {
  raw.prepare(`
    CREATE TABLE IF NOT EXISTS tasks (
      name TEXT PRIMARY KEY,
      type TEXT,
      data TEXT,
      postType TEXT,
      postData TEXT
    )
  `).run();

  raw.prepare(`
    CREATE TABLE IF NOT EXISTS intervals (
      name TEXT PRIMARY KEY,
      time_ms INTEGER NOT NULL
    )
  `).run();

  raw.prepare(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();

  raw.prepare(`
    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();

  raw.prepare(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      date TEXT NOT NULL
    )
  `).run();
}

// Helpers: Tasks
function getAllTasks() {
  const stmt = raw.prepare(`SELECT name, type, data, postType, postData FROM tasks ORDER BY name`);
  return stmt.all();
}
function upsertTask(task) {
  const stmt = raw.prepare(`
    INSERT INTO tasks(name, type, data, postType, postData) VALUES(@name, @type, @data, @postType, @postData)
    ON CONFLICT(name) DO UPDATE SET type=excluded.type, data=excluded.data, postType=excluded.postType, postData=excluded.postData
  `);
  stmt.run({
    name: String(task.name),
    type: task.type ?? null,
    data: task.data ?? null,
    postType: task.postType ?? null,
    postData: task.postData ?? null
  });
}
function deleteTask(name) {
  raw.prepare(`DELETE FROM tasks WHERE name = ?`).run(String(name));
}
function clearTasks() {
  raw.prepare(`DELETE FROM tasks`).run();
}

// Helpers: Intervals (persistent definitions)
function getAllIntervalDefs() {
  const stmt = raw.prepare(`SELECT name, time_ms as timeMs FROM intervals ORDER BY name`);
  return stmt.all();
}
function addIntervalDef(name, timeMs) {
  const stmt = raw.prepare(`
    INSERT INTO intervals(name, time_ms) VALUES(?, ?)
    ON CONFLICT(name) DO UPDATE SET time_ms=excluded.time_ms
  `);
  stmt.run(String(name), Number(timeMs));
}
function deleteIntervalDef(name) {
  raw.prepare(`DELETE FROM intervals WHERE name = ?`).run(String(name));
}
function clearIntervals() {
  raw.prepare(`DELETE FROM intervals`).run();
}

// Helpers: Logs
function addLog(message) {
  raw.prepare(`INSERT INTO logs(message, created_at) VALUES(?, ?)`).run(String(message), Date.now());
}
function getLastLogs(limit) {
  const stmt = raw.prepare(`SELECT id, message, created_at as createdAt FROM logs ORDER BY id DESC LIMIT ?`);
  const rows = stmt.all(Number(limit));
  // Return newest to oldest or oldest to newest? Original memory showed append; we return array in order they were created
  return rows.reverse().map(r => r.message);
}
function clearLogsTable() {
  raw.prepare(`DELETE FROM logs`).run();
}

// Helpers: Clips
function addClipEntry(textV) {
  raw.prepare(`INSERT INTO clips(text, created_at) VALUES(?, ?)`).run(String(textV), Date.now());
}
function getClipHistory() {
  const stmt = raw.prepare(`SELECT id, text FROM clips ORDER BY id ASC`);
  return stmt.all().map(r => r.text);
}
function getLastClipText() {
  const row = raw.prepare(`SELECT text FROM clips ORDER BY id DESC LIMIT 1`).get();
  return row ? row.text : '';
}
function clearClipsTable() {
  raw.prepare(`DELETE FROM clips`).run();
}

// Helpers: Notes
function getAllNotes() {
  const stmt = raw.prepare(`SELECT id, name, text, date FROM notes ORDER BY id ASC`);
  return stmt.all().map(r => ({ name: r.name, text: r.text, date: r.date }));
}
function addNoteEntry(name, textV, date) {
  raw.prepare(`INSERT INTO notes(name, text, date) VALUES(?, ?, ?)`).run(String(name), String(textV), String(date));
}
function deleteNoteEntry(name) {
  raw.prepare(`DELETE FROM notes WHERE name = ?`).run(String(name));
}
function clearNotesTable() {
  raw.prepare(`DELETE FROM notes`).run();
}

// Helpers: Clear all (used by restart/reload)
function clearAllData() {
  raw.prepare('BEGIN').run();
  try {
    clearTasks();
    clearIntervals();
    clearLogsTable();
    clearClipsTable();
    clearNotesTable();
    raw.prepare('COMMIT').run();
  } catch (e) {
    raw.prepare('ROLLBACK').run();
    throw e;
  }
}

module.exports = {
  // core
  initDb,
  db,
  raw,
  schema: { tasks, intervals, logs, clips, notes },
  // tasks
  getAllTasks,
  upsertTask,
  deleteTask,
  clearTasks,
  // intervals
  getAllIntervalDefs,
  addIntervalDef,
  deleteIntervalDef,
  clearIntervals,
  // logs
  addLog,
  getLastLogs,
  clearLogsTable,
  // clips
  addClipEntry,
  getClipHistory,
  getLastClipText,
  clearClipsTable,
  // notes
  getAllNotes,
  addNoteEntry,
  deleteNoteEntry,
  clearNotesTable,
  // all
  clearAllData,
  // paths
  DB_PATH,
};