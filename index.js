'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const bodyParser = require('body-parser');
const cheerio = require('cheerio');
const app = express();
const dbm = require('./db/drizzle.js');

// Constants
const host = 'localhost';
const port = 1337;
const userAgent = "example";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_LOG_ENTRIES = 1000;
const RETRY_BACKOFFS_MS = [500, 1500, 3500];

// Ensure upload directory exists
fs.mkdirSync(path.join(__dirname, 'upload'), { recursive: true });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'upload/');
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

// Globals
let gTasks = [];
let gTasksLog = [];
let gIntervals = [];
let gClip = [];
let gNotes = [];
let { uFiles, uSize } = getFilesAndSize();

// Health and stability guards
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Periodic update of storage stats
setInterval(() => {
  const gfas = getFilesAndSize();
  uFiles = gfas.uFiles;
  uSize = gfas.uSize;
}, 300000);

// Initialize SQLite and hydrate in-memory caches and intervals
try { dbm.initDb(); } catch (e) { console.error('DB init failed', e); }
try {
  // hydrate caches
  gTasks = dbm.getAllTasks()
    .filter(t => String(t.name || '').trim().length > 0)
    .map(t => ({
      name: t.name, type: t.type, data: t.data, postType: t.postType, postData: t.postData
    }));
  gNotes = dbm.getAllNotes();
  gClip = dbm.getClipHistory();
  gTasksLog = dbm.getLastLogs(MAX_LOG_ENTRIES);
  // rehydrate intervals
  const defs = dbm.getAllIntervalDefs();
  defs.forEach((def) => {
    if (!gTasks.some(t => t.name === def.name)) {
      console.warn('[hydrate] skipping interval for missing task', { name: def.name });
      try { dbm.deleteIntervalDef(def.name); } catch (_) {}
      return;
    }
    const id = setInterval(() => { doTask({ body: { name: def.name } }); }, def.timeMs);
    gIntervals.push({ name: def.name, id, time: def.timeMs });
  });
} catch (e) {
  console.error('DB hydrate failed', e);
}
/**
 * @typedef {Object} RequestOptions
 * @property {'http'|'https'} protocol
 * @property {string} hostname
 * @property {number} [port]
 * @property {string} path
 * @property {'GET'|'POST'} method
 * @property {Object.<string,string>} [headers]
 * @property {string|Buffer} [body]
 * @property {number} [timeout]
 */

/**
 * Determine if an HTTP status code is transient and worth retrying.
 * @param {number} statusCode
 * @returns {boolean}
 */
function isTransientStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/**
 * Determine if a Node.js network error is transient and worth retrying.
 * @param {NodeJS.ErrnoException|any} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (!err || !err.code) return false;
  return ['ETIMEDOUT','ECONNRESET','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ENOTFOUND','EPIPE'].includes(err.code);
}

/**
 * Sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Perform a single HTTP/HTTPS request with timeout.
 * Returns status, headers and full body Buffer.
 * @param {RequestOptions} opts
 * @returns {Promise<{ statusCode:number, headers:Object, body:Buffer }>}
 */
function httpRequestWithTimeout(opts) {
  return new Promise((resolve, reject) => {
    try {
      const isHttps = opts.protocol === 'https';
      const reqOptions = {
        hostname: opts.hostname,
        port: opts.port || (isHttps ? 443 : 80),
        path: opts.path || '/',
        method: opts.method || 'GET',
        headers: opts.headers || {}
      };
      const req = (isHttps ? https : http).request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks)
        }));
      });
      const to = opts.timeout || REQUEST_TIMEOUT_MS;
      req.setTimeout(to, () => req.destroy(Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Execute request with retries/backoff on transient errors or retryable status codes.
 * @param {RequestOptions} opts
 * @param {number[]} [backoffsMs]
 * @returns {Promise<{ statusCode:number, headers:Object, body:Buffer }>}
 */
async function withRetries(opts, backoffsMs = RETRY_BACKOFFS_MS) {
  let attempt = 0;
  // Include final attempt without backoff after the loop
  while (attempt < backoffsMs.length) {
    try {
      const res = await httpRequestWithTimeout(opts);
      if (isTransientStatus(res.statusCode)) {
        await sleep(backoffsMs[attempt++]);
        continue;
      }
      return res;
    } catch (err) {
      if (isTransientError(err)) {
        await sleep(backoffsMs[attempt++]);
        continue;
      }
      throw err;
    }
  }
  // Last attempt without delay
  return httpRequestWithTimeout(opts);
}

/**
 * Push an entry to the tasks log with retention limit.
 * @param {any} entry
 */
function pushLog(entry) {
  try {
    // persist to sqlite (also keep limited in-memory cache for UI)
    try { require('./db/drizzle.js').addLog(entry); } catch (_) {}
    gTasksLog.push(entry);
    if (gTasksLog.length > MAX_LOG_ENTRIES) {
      gTasksLog.splice(0, gTasksLog.length - MAX_LOG_ENTRIES);
    }
  } catch (e) {
    console.error('pushLog error', e);
  }
}

/**
 * Ensure the given user-supplied path stays under upload/ sandbox.
 * @param {string} userPath relative path provided by client (may include subdirs)
 * @returns {string} absolute safe path
 * @throws if outside sandbox
 */
function safePathUnderUpload(userPath) {
  const base = path.resolve(path.join(__dirname, 'upload'));
  // Prevent undefined/null
  const upath = String(userPath || '');
  const full = path.resolve(path.join(base, upath));
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error('Path escapes upload sandbox');
  }
  return full;
}

/**
 * Clear and stop all interval timers.
 */
function clearAllIntervals() {
  try {
   gIntervals.forEach((i) => { try { clearInterval(i.id); } catch (_) {} });
  } finally {
   gIntervals = [];
  }
}

/**
 * Convert HTML to readable text with link and image hints.
 * @param {string} html
 * @returns {string}
 */
function html2txt(html) {
  const $ = cheerio.load(html);
  $('a').each((i, el) => {
    const linkText = $(el).text();
    const linkUrl = $(el).attr('href');
    const linkFormattedText = `~~~ ${linkText} => ${linkUrl} ~~~`;
    $(el).text(linkFormattedText);
  });
  const imgs = $('<p>').text(`\n*** ${$('img').attr('alt')} => ${$('img').attr('src')} ***\n`);
  $('img').replaceWith(imgs);
  $('script, style').remove();
  const title = $('title').text();
  const body = ($('body').text()).replace(/\n+/g, '\n');
  return `title: \t\t${title}
    ${body}`;
}

/**
 * Recursively list files in a directory.
 * @param {string} cdir
 * @param {string} [rPath]
 * @returns {string[]}
 */
function dirRecursively(cdir, rPath = '') {
  let ret = [];
  try {
    const files = fs.readdirSync(cdir);
    files.forEach(file => {
      const fPath = path.join(cdir, file);
      const stat = fs.statSync(fPath);
      if (stat.isDirectory()) {
        ret = ret.concat(dirRecursively(fPath, path.join(rPath, file)));
      } else {
        ret.push(path.join(rPath, file).replace(/\\/g, '/'));
      }
    });
  } catch (e) {
    console.error('dirRecursively error', e);
  }
  return ret;
}

/**
 * Return file name by index from a folder inside upload/.
 * @param {string} folder relative folder under upload/
 * @param {number|string} id index
 * @returns {string}
 */
function fileById(folder, id) {
  try {
    const files = fs.readdirSync(path.join(__dirname, 'upload', folder));
    const idx = parseInt(id, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= files.length) return "";
    const f = files[idx];
    const full = path.join(__dirname, 'upload', folder, f);
    return fs.statSync(full).isFile() ? path.join(folder, f).replace(/\\/g, '/') : "";
  } catch (e) {
    return "";
  }
}

function getHour() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  return `${hours}_${minutes}`;
}

function getDate() {
  const now = new Date();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const year = now.getFullYear().toString();
  return `${day}_${month}_${year}`;
}

function getFilesAndSize() {
  let fnum = 0;
  let fSize = 0;
  try {
    const files = fs.readdirSync(path.join(__dirname, 'upload'));
    files.forEach((f) => {
      const filePath = path.join(__dirname, 'upload', f);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        fnum++;
        fSize += stats.size;
      }
    });
  } catch (e) {
    // ignore
  }
  const fSizeMB = (fSize / (1024 * 1024)).toFixed(2);
  return { uFiles: fnum, uSize: fSizeMB };
}

function getLine(fileName, id) {
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'upload', fileName), 'utf-8').split("\n");
    return lines[id] !== undefined ? lines[id] : "";
  } catch (e) { return ""; }
}

function getWord(fileName, id) {
  try {
    const words = fs.readFileSync(path.join(__dirname, 'upload', fileName), 'utf-8').split(" ");
    return words[id] !== undefined ? words[id] : "";
  } catch (e) { return ""; }
}

function alwaysArr(value) {
  if (Array.isArray(value)) {
    return value;
  } else if (value === undefined || value === null) {
    return [];
  } else {
    return [value];
  }
}

/**
 * Run a saved task by name from req.body.name. Errors are logged, not thrown.
 * @param {{body: {name: string}}} req
 */
function doTask(req) {
  try {
    const tName = String(req.body.name);
    const a = gTasks.find(ob => ob.name === tName);
    if (!a) {
      pushLog(`Task '${tName}' not found`);
      return;
    }
    let isPost = false;
    const data = a.data
      .replace('~hour~', getHour())
      .replace("~date~", getDate())
      .replace(/~inc\$(\d+)~/, (m, p) => parseInt(p))
      .replace(/~dec\$(\d+)~/, (m, p) => parseInt(p))
      .replace(/~{([^}]*)}~/g, (match, contents) => { return contents.split(' ')[0] })
      .replace(/~(\d+)\s*\+\s*(\d+)~/, (match, co1, co2) => { return co1 })
      .replace(/~(\d+)\s*\-\s*(\d+)~/, (match, co1, co2) => { return co1 })
      .replace(/~files\s+(\S+)\s+(\d+)~/, (match, co1, co2) => { return fileById(co1, co2) })
      .replace(/~lines\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return getLine(co1, co2) })
      .replace(/~words\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return getWord(co1, co2) });
    const postData = a.postData
      .replace('~hour~', getHour())
      .replace("~date~", getDate())
      .replace(/~inc\$(\d+)~/, (m, p) => parseInt(p))
      .replace(/~dec\$(\d+)~/, (m, p) => parseInt(p))
      .replace(/~{([^}]*)}~/g, (match, contents) => { return contents.split(' ')[0] })
      .replace(/~(\d+)\s*\+\s*(\d+)~/, (match, co1, co2) => { return co1 })
      .replace(/~(\d+)\s*\-\s*(\d+)~/, (match, co1, co2) => { return co1 })
      .replace(/~files\s+(\S+)\s+(\d+)~/, (match, co1, co2) => { return fileById(co1, co2) })
      .replace(/~lines\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return getLine(co1, co2) })
      .replace(/~words\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return getWord(co1, co2) });

    // advance dynamic patterns for next run
    a.data = a.data
      .replace(/~inc\$(\d+)~/, (m, p) => "~inc$" + (parseInt(p) + 1) + "~")
      .replace(/~dec\$(\d+)~/, (m, p) => "~dec$" + (parseInt(p) - 1) + "~")
      .replace(/~{([^}]*)}~/g, (match, contents) => { return '~{' + (contents.split(' ')).slice(1).join(' ') + ` ${(contents.split(' ')).slice(0, 1)}` + '}~' })
      .replace(/~(\d+)\s*\+\s*(\d+)~/, (match, co1, co2) => { return "~" + (parseInt(co1) + parseInt(co2)) + " + " + co2 + "~" })
      .replace(/~(\d+)\s*\-\s*(\d+)~/, (match, co1, co2) => { return "~" + (parseInt(co1) - parseInt(co2)) + " - " + co2 + "~" })
      .replace(/~files\s+(\S+)\s+(\d+)~/, (match, co1, co2) => { return `~files ${co1} ${parseInt(co2) + 1}~` })
      .replace(/~lines\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return `~lines ${co1} ${parseInt(co2) + 1}~` })
      .replace(/~words\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return `~words ${co1} ${parseInt(co2) + 1}~` });
    a.postData = a.postData
      .replace(/~inc\$(\d+)~/, (m, p) => "~inc$" + (parseInt(p) + 1) + "~")
      .replace(/~dec\$(\d+)~/, (m, p) => "~dec$" + (parseInt(p) - 1) + "~")
      .replace(/~{([^}]*)}~/g, (match, contents) => { return '~{' + (contents.split(' ')).slice(1).join(' ') + ` ${(contents.split(' ')).slice(0, 1)}` + '}~' })
      .replace(/~(\d+)\s*\+\s*(\d+)~/, (match, co1, co2) => { return "~" + (parseInt(co1) + parseInt(co2)) + " + " + co2 + "~" })
      .replace(/~(\d+)\s*\-\s*(\d+)~/, (match, co1, co2) => { return "~" + (parseInt(co1) - parseInt(co2)) + " - " + co2 + "~" })
      .replace(/~files\s+(\S+)\s+(\d+)~/, (match, co1, co2) => { return `~files ${co1} ${parseInt(co2) + 1}~` })
      .replace(/~lines\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return `~lines ${co1} ${parseInt(co2) + 1}~` })
      .replace(/~words\s+(.+?)\s+(\d+)~/, (match, co1, co2) => { return `~words ${co1} ${parseInt(co2) + 1}~` });

    let reqd = "";
    switch (a.type) {
      case "http": reqd = `http://${host}:${port}/api/httpp/${data}`; break;
      case "httppost": reqd = `http://${host}:${port}/api/httpp/${data}`; isPost = true; break;
      case "https": reqd = `http://${host}:${port}/api/httpps/${data}`; break;
      case "httpspost": reqd = `http://${host}:${port}/api/httpps/${data}`; isPost = true; break;
      case "httptxt": reqd = `http://${host}:${port}/api/txt/httpp/${data}`; break;
      case "httpstxt": reqd = `http://${host}:${port}/api/txt/httpps/${data}`; break;
      case "scrapurl": reqd = `http://${host}:${port}/api/scraper/links/?link=${data}`; break;
      case "scrapimg": reqd = `http://${host}:${port}/api/scraper/imgs/?link=${data}`; break;
      case "cheerioc": reqd = `http://${host}:${port}/api/scraper/cheeriohtml/?link=${data}`; break;
      case "scraprss": reqd = `http://${host}:${port}/api/scraper/rss?link=${data}`; break;
      case "cclip": reqd = `http://${host}:${port}/api/clip/erase`; break;
      case "delfile": reqd = `http://${host}:${port}/api/files/del?path=${data}`; break;
      case "mvfile": reqd = `http://${host}:${port}/api/files/mv${data}`; break;
      case "uploadlink": reqd = `http://${host}:${port}/api/uploadLink`; isPost = true; break;
      case "saveclip": reqd = `http://${host}:${port}/api/clip/save`; isPost = true; break;
      case "logfile": reqd = `http://${host}:${port}/api/task/log/toFile?name=${data}`; break;
      case "cfgimport": reqd = `http://${host}:${port}/api/cfg/import?path=${data}`; break;
      case "cfgexport": reqd = `http://${host}:${port}/api/cfg/export?name=${data}`; break;
      case "consoleget": reqd = `http://${host}:${port}/api/console?text=${data}`; break;
      case "consolepost": reqd = `http://${host}:${port}/api/console`; isPost = true; break;
      case "sendfile": reqd = `http://${host}:${port}/api/files/send${data}`; break;
      case "reload": reqd = `http://${host}:${port}/api/reload?cfg=${data}`; break;
      default: reqd = `http://example.com`;
    }
    if (isPost) {
      const rData = postData;
      const purl = url.parse(reqd);
      const options = {
        host: purl.hostname,
        port: port,
        path: purl.path,
        method: 'POST',
        headers: {
          'content-type': a.postType,
          'content-length': Buffer.byteLength(rData)
        }
      };
      const preq = http.request(options, (response) => {
        let d = '';
        response.on('data', (chunk) => { d += chunk; });
        response.on('end', () => { pushLog(d); });
      });
      preq.setTimeout(REQUEST_TIMEOUT_MS, () => preq.destroy(new Error('Request timeout')));
      preq.on('error', (err) => { pushLog(`Task '${tName}' POST error: ${err.message}`); });
      preq.write(rData);
      preq.end();
    } else {
      const creq = http.get(reqd, (response) => {
        let d = '';
        response.on('data', (chunk) => { d += chunk; });
        response.on('end', () => { pushLog(d); });
      });
      creq.setTimeout(REQUEST_TIMEOUT_MS, () => creq.destroy(new Error('Request timeout')));
      creq.on('error', (err) => { pushLog(`Task '${tName}' GET error: ${err.message}`); });
    }
  } catch (e) {
    pushLog(`doTask error: ${e.message}`);
  }
}

// Routes
app.get('/', (req, res) => {
  fs.readFile('web/index.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read index.html'); return; }
    data = data.replace("<!-- additional info -->", `
        <h3 class="lead">saved tasks: <b>${gTasks.length}</b></h3>
        <h3 class="lead">tasks running in routine <b>${gIntervals.length}</b></h3>
        <h3 class="lead">executed tasks: <b>${gTasksLog.length}</b></h3>
        <h3 class="lead">snippets in clipboard: <b>${gClip.length}</b></h3>
        <h3 class="lead">saved notes: <b>${gNotes.length}</b></h3>
        <h3 class="lead">'upload/' folder has <b>${uFiles}</b> files which together use <b>${uSize} MB</b> of memory</h3>
        <h3 class="lead">server is currently using <b>${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB</b> ram</h3>
        `);
    res.send(data);
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memoryMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
    tasks: gTasks.length,
    intervals: gIntervals.length,
    logs: gTasksLog.length
  });
});

app.get('/proxy', (req, res) => {
  fs.readFile('web/proxy.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read proxy.html'); return; }
    res.send(data);
  });
});

app.get('/get/pythonClient', (req, res) => {
  res.download(path.join(__dirname, 'client/hmmClient.py'));
});

app.get('/get/pdfDocs', (req, res) => {
  res.download(path.join(__dirname, 'docs/HomeMiddleman_api.pdf'));
});

app.get('/get/texDocs', (req, res) => {
  res.download(path.join(__dirname, 'docs/HomeMiddleman_api.tex'));
});

app.get('/notes', (req, res) => {
  fs.readFile('web/notes.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read notes.html'); return; }
    let notesHtml = '';
    let allNotes = [];
    try { allNotes = dbm.getAllNotes(); } catch (_) { allNotes = gNotes; }
    for (let i = allNotes.length - 1; i >= 0; i--) {
      const cgn = allNotes[i];
      notesHtml += `
            <div class="card">
                <h2 class="text-center">${cgn.name}</h2>
                <div class="card-body">
                <p class="text-center">${cgn.text}</p>
                </div>
                <div class="card-body">
                    <p class="text-center">${cgn.date}</p>
                    <p role="button" style="color:blue;" onclick="getRemove('/api/notes/del/${cgn.name}')">remove note</p>
                </div>
                `;
    }
    data = data.replace('<!-- notes -->', notesHtml);
    res.send(data);
  });
});

app.get('/clipboard', (req, res) => {
  fs.readFile('web/clip.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read clip.html'); return; }
    let history = [];
    let last = '';
    try { history = dbm.getClipHistory(); last = dbm.getLastClipText(); }
    catch (_) { history = gClip; last = gClip[gClip.length - 1] || ''; }
    let scb = '';
    for (let i = history.length - 1; i >= 0; i--) {
      scb += `<li>${history[i]}</li>`;
    }
    data = data.replace("<!-- insert history -->", scb);
    res.send(data.replace("<!-- copyme -->", `<h1 id="copyMe" style="color: darkblue;" role="button" onclick="toClipboard()">${last}</h1>`));
  });
});

app.get('/files', (req, res) => {
  fs.readFile('web/files.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read files.html'); return; }
    let filesL = '';
    let filesOp = '';
    dirRecursively("upload/").forEach((fileName) => {
      filesL += `<li><a href="api/download/${fileName}">${fileName}</a> <i class="bi bi-trash3" role="button" style="color:blueviolet;" onclick="getRemove('/api/files/del?path=${fileName}')"></i></li>`;
      filesOp += `<option value="${fileName}">${fileName}</option>`;
    });
    data = data.replace("<!-- files options -->", filesOp);
    res.send(data.replace('<!-- insert files -->', filesL));
  });
});

app.get('/tasks', (req, res) => {
  fs.readFile('web/tasks.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read tasks.html'); return; }
    let tasksHtml = '';
    let stasks = '';
    let allTasks = [];
    try { allTasks = dbm.getAllTasks().map(t => ({ name: t.name, type: t.type, data: t.data })); }
    catch (_) { allTasks = gTasks; }
    allTasks = allTasks.filter(t => String(t.name || '').trim().length > 0);
    allTasks.forEach((t) => {
      tasksHtml += `<li>${t.name} | ${t.type} | ${t.data} <i class="bi bi-trash3" role="button" style="color:blueviolet;" onclick="getRemove('/api/task/del/${t.name}')"></i></li>`;
      stasks += `<option value="${t.name}">${t.name}</option>`;
    });
    data = data.replace("<!-- import tasks -->", stasks);
    res.send(data.replace("<!-- tasks -->", tasksHtml));
  });
});

app.get('/routine', (req, res) => {
  fs.readFile('web/routine.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read routine.html'); return; }
    let intervals = '';
    let stasks = '';
    gIntervals.forEach((i) => {
      intervals += `<li>${i.name} every ${i.time / 60000} minutes <i class="bi bi-calendar-x" role="button" style="color:blueviolet;" onclick="getRemove('/api/task/interval/kill/${i.id}')"></i></li>`;
    });
    gTasks.forEach((t) => { stasks += `<option value="${t.name}">${t.name}</option>`; });
    data = data.replace("<!-- import tasks -->", stasks);
    res.send(data.replace("<!-- routine -->", intervals));
  });
});

app.get('/css/main.css', (req, res) => {
  fs.readFile('web/css/main.css', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read CSS'); return; }
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(data);
  });
});

app.get('/js/main.js', (req, res) => {
  fs.readFile('web/js/main.js', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read JS'); return; }
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(data);
  });
});

app.get('/api/cfg/import', (req, res) => {
  fs.readFile(path.join(__dirname, 'upload', req.query.path || ''), (err, jsoncfg) => {
    if (err) { res.status(400).send(`Failed to read config: ${err.message}`); return; }
    let parsed;
    try { parsed = JSON.parse(jsoncfg); } catch (e) { res.status(400).send('Invalid JSON'); return; }

    const tasksToUpsert = [];
    const routinesToAdd = [];

    parsed.forEach((i) => {
      switch (i.type) {
        case "task": {
          tasksToUpsert.push({
            'name': i.data.name,
            'type': i.data.type,
            'data': i.data.data,
            'postType': i.data.postType,
            'postData': i.data.postData
          });
          break;
        }
        case "routine": {
          routinesToAdd.push({ name: i.data.name, time: i.data.time });
          break;
        }
        default:
          break;
      }
    });

    // Upsert tasks first
    const skippedEmptyTasks = [];
    tasksToUpsert.forEach((t) => {
      const nm = String(t.name || '').trim();
      if (!nm) {
        skippedEmptyTasks.push(t);
        console.warn('[cfg:import] skipping task with empty name');
        return;
      }
      t.name = nm;
      try { dbm.upsertTask(t); } catch (_) {}
      const idx = gTasks.findIndex(ob => ob.name === t.name);
      if (idx >= 0) gTasks[idx] = t; else gTasks.push(t);
    });

    // Then add routines that reference existing tasks
    const skipped = [];
    routinesToAdd.forEach((r) => {
      if (!gTasks.some(t => t.name === r.name)) {
        skipped.push(r.name);
        console.warn('[cfg:import] skipping routine referencing missing task', { name: r.name });
        return;
      }
      try { dbm.addIntervalDef(r.name, r.time); } catch (_) {}
      gIntervals.push({
        'name': r.name,
        'id': setInterval(() => { doTask({ body: { name: r.name } }); }, r.time),
        'time': r.time
      });
    });

    console.log('[cfg:import] loaded', { path: req.query.path, tasks: tasksToUpsert.length, routines: routinesToAdd.length, skipped, tasksSkippedEmpty: skippedEmptyTasks.length });
    const msg = skipped.length
      ? `Config ${req.query.path} loaded. Skipped routines for missing tasks: ${skipped.join(', ')}`
      : `Config ${req.query.path} loaded`;
    res.send(msg);
  });
});

app.get('/api/cfg/export', (req, res) => {
  let toJson = [];
  gTasks.forEach((e) => { toJson.push({ 'type': 'task', 'data': e }); });
  gIntervals.forEach((e) => { toJson.push({ 'type': 'routine', 'data': { 'name': e.name, 'time': e.time } }); });
  const fName = `${req.query.name}.json`;
  fs.writeFile(path.join(__dirname, 'upload', fName), JSON.stringify(toJson, null, 2), (erro) => {
    if (erro) { res.status(500).send(`Failed to export: ${erro.message}`); return; }
    console.log('[cfg:export] wrote', { file: fName });
    res.send(`Config exported successfully to ${fName}`);
  });
});

app.get('/api/restart', (req, res) => {
  clearAllIntervals();
  try { require('./db/drizzle.js').clearAllData(); } catch (_) {}
  gTasks = [];
  gTasksLog = [];
  gClip = [];
  gNotes = [];
  console.log('[system] restart');
  res.send("Home middleman has been restarted");
});

app.get('/api/reload', (req, res) => {
  clearAllIntervals();
  gTasks = [];
  gTasksLog = [];
  gClip = [];
  gNotes = [];
  const dbm = require('./db/drizzle.js');
  try { dbm.clearAllData(); } catch (_) {}
  fs.readFile(path.join(__dirname, 'upload', req.query.cfg || ''), (err, jsoncfg) => {
    if (err) { res.status(400).send(`Failed to read config: ${err.message}`); return; }
    let parsed;
    try { parsed = JSON.parse(jsoncfg); } catch (e) { res.status(400).send('Invalid JSON'); return; }

    const tasksToUpsert = [];
    const routinesToAdd = [];

    parsed.forEach((i) => {
      switch (i.type) {
        case "task": {
          tasksToUpsert.push({
            'name': i.data.name,
            'type': i.data.type,
            'data': i.data.data,
            'postType': i.data.postType,
            'postData': i.data.postData
          });
          break;
        }
        case "routine": {
          routinesToAdd.push({ name: i.data.name, time: i.data.time });
          break;
        }
        default:
          break;
      }
    });

    // Upsert tasks first
    const skippedEmptyTasks = [];
    tasksToUpsert.forEach((t) => {
      const nm = String(t.name || '').trim();
      if (!nm) {
        skippedEmptyTasks.push(t);
        console.warn('[system:reload] skipping task with empty name');
        return;
      }
      t.name = nm;
      try { dbm.upsertTask(t); } catch (_) {}
      gTasks.push(t);
    });

    // Then add routines if task exists
    const skipped = [];
    routinesToAdd.forEach((r) => {
      if (!gTasks.some(t => t.name === r.name)) {
        skipped.push(r.name);
        console.warn('[system:reload] skipping routine referencing missing task', { name: r.name });
        return;
      }
      try { dbm.addIntervalDef(r.name, r.time); } catch (_) {}
      gIntervals.push({
        'name': r.name,
        'id': setInterval(() => { doTask({ body: { name: r.name } }); }, r.time),
        'time': r.time
      });
    });

    console.log('[system] reload', { cfg: req.query.cfg, tasks: tasksToUpsert.length, routines: routinesToAdd.length, skipped, tasksSkippedEmpty: skippedEmptyTasks.length });
    const msg = skipped.length
      ? `Restarted Home Middleman and loaded ${req.query.cfg} config. Skipped routines for missing tasks: ${skipped.join(', ')}`
      : `Restarted Home Middleman and loaded ${req.query.cfg} config`;
    res.send(msg);
  });
});

// Proxies (GET)
app.get('/api/httpp/*', async (req, res) => {
  try {
    const npurl = "http://" + req.params[0];
    const p = url.parse(npurl);
    const resp = await withRetries({
      protocol: 'http',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (resp.statusCode >= 300 && resp.statusCode < 400) {
      const location = (resp.headers.location || '').toString();
      const repRedirectUrl = location.replace(/^http:\/\//, '');
      res.redirect(`http://${host}:${port}/api/httpp/` + repRedirectUrl);
      return;
    }
    res.send(resp.body.toString());
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

app.get('/api/txt/httpp/*', async (req, res) => {
  try {
    const npurl = "http://" + req.params[0];
    const p = url.parse(npurl);
    const resp = await withRetries({
      protocol: 'http',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (resp.statusCode >= 300 && resp.statusCode < 400) {
      const location = (resp.headers.location || '').toString();
      const repRedirectUrl = location.replace(/^http:\/\//, '');
      res.redirect(`http://${host}:${port}/api/txt/httpp/` + repRedirectUrl);
      return;
    }
    res.send(html2txt(resp.body.toString()));
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

app.get('/api/httpps/*', async (req, res) => {
  try {
    const npurl = "https://" + req.params[0];
    const p = url.parse(npurl);
    const resp = await withRetries({
      protocol: 'https',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (resp.statusCode >= 300 && resp.statusCode < 400) {
      const location = (resp.headers.location || '').toString();
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/httpps/` + repRedirectUrl);
      return;
    }
    res.send(resp.body.toString());
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

app.get('/api/txt/httpps/*', async (req, res) => {
  try {
    const npurl = "https://" + req.params[0];
    const p = url.parse(npurl);
    const resp = await withRetries({
      protocol: 'https',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (resp.statusCode >= 300 && resp.statusCode < 400) {
      const location = (resp.headers.location || '').toString();
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/txt/httpps/` + repRedirectUrl);
      return;
    }
    res.send(html2txt(resp.body.toString()));
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

// POST proxies
app.post('/api/httpp/*', async (req, res) => {
  try {
    const rData = JSON.stringify(req.body || {});
    const p = url.parse("http://" + req.params[0]);
    const headers = { ...req.headers };
    delete headers['user-agent']; delete headers['host']; delete headers['content-length'];
    const resp = await withRetries({
      protocol: 'http',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'POST',
      headers: { ...headers, 'user-agent': userAgent, 'content-length': Buffer.byteLength(rData), 'content-type': headers['content-type'] || 'application/json' },
      body: rData,
      timeout: REQUEST_TIMEOUT_MS
    });
    res.status(resp.statusCode || 200).send(resp.body.toString());
  } catch (e) {
    res.status(502).send(`Proxy POST error: ${e.message}`);
  }
});

app.post('/api/httpps/*', async (req, res) => {
  try {
    const rData = JSON.stringify(req.body || {});
    const p = url.parse("https://" + req.params[0]);
    const headers = { ...req.headers };
    delete headers['user-agent']; delete headers['host']; delete headers['content-length'];
    const resp = await withRetries({
      protocol: 'https',
      hostname: p.hostname,
      port: p.port ? Number(p.port) : undefined,
      path: p.path,
      method: 'POST',
      headers: { ...headers, 'user-agent': userAgent, 'content-length': Buffer.byteLength(rData), 'content-type': headers['content-type'] || 'application/json' },
      body: rData,
      timeout: REQUEST_TIMEOUT_MS
    });
    res.status(resp.statusCode || 200).send(resp.body.toString());
  } catch (e) {
    res.status(502).send(`Proxy POST error: ${e.message}`);
  }
});

// Uploads
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) { res.status(400).send("No file specified"); return; }
  console.log('[upload:file] uploaded', { name: req.file.originalname, size: req.file.size });
  res.status(200).send("File uploaded successfully");
});

app.post('/api/uploadLink', (req, res) => {
  const fileLink = req.body.link;
  if (!fileLink) { res.status(400).send("No file url specified"); return; }
  try {
    const fName = fileLink.substring(fileLink.lastIndexOf('/') + 1) || `download_${Date.now()}`;
    const targetPath = path.join(__dirname, 'upload', fName);
    const fileStream = fs.createWriteStream(targetPath);
    const getter = fileLink.startsWith('https://') ? https : (fileLink.startsWith('http://') ? http : null);
    if (!getter) { res.status(400).send("Unsupported URL protocol"); return; }
    const pr = getter.get(fileLink, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        res.status(502).send(`Upstream responded with ${response.statusCode}`);
        fileStream.close(() => fs.unlink(targetPath, () => {}));
        return;
      }
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        console.log('[upload:link] downloaded', { name: fName });
        fileStream.close(() => res.status(200).send("File downloaded successfully from provided link"));
      });
    });
    pr.setTimeout(REQUEST_TIMEOUT_MS, () => pr.destroy(new Error('Request timeout')));
    pr.on('error', (e) => {
      fileStream.close(() => fs.unlink(targetPath, () => {}));
      res.status(502).send(`Download error: ${e.message}`);
    });
  } catch (e) {
    res.status(500).send(`Download failed: ${e.message}`);
  }
});

// Files APIs
app.get('/api/download/*', (req, res) => {
  try {
    const fileName = req.params[0];
    const full = safePathUnderUpload(fileName);
    res.sendFile(full);
  } catch (e) {
    res.status(400).send(`Invalid path: ${e.message}`);
  }
});

app.get('/api/files/list', (req, res) => {
  let filesL = '';
  dirRecursively("upload/").forEach((filename) => { filesL += `${filename} `; });
  res.send(filesL.trim());
});

app.get('/api/files/del', (req, res) => {
  try {
    const full = safePathUnderUpload(req.query.path || '');
    fs.unlink(full, (err) => {
      if (err) { res.status(400).send(`Failed to remove: ${err.message}`); return; }
      console.log('[files:del] removed', { path: req.query.path });
      res.send(`${req.query.path} removed successfully`);
    });
  } catch (e) {
    res.status(400).send(`Invalid path: ${e.message}`);
  }
});

app.get('/api/files/mv', (req, res) => {
  try {
    const oldFull = safePathUnderUpload(req.query.old || '');
    const newFull = safePathUnderUpload(req.query.new || '');
    const dirName = path.dirname(newFull);
    fs.mkdir(dirName, { recursive: true }, (err) => {
      if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
      fs.rename(oldFull, newFull, (err2) => {
        if (err2) { res.status(400).send(`Failed to rename: ${err2.message}`); return; }
        console.log('[files:mv] moved', { old: req.query.old, new: req.query.new });
        res.send(`${req.query.old} has been renamed to ${req.query.new}`);
      });
    });
  } catch (e) {
    res.status(400).send(`Invalid path: ${e.message}`);
  }
});

app.get('/api/files/send', (req, res) => {
  try {
    const file = fs.readFileSync(safePathUnderUpload(req.query.path || ''));
    const target = req.query.target;
    if (!target) { res.status(400).send('Missing target'); return; }
    const isHttps = target.startsWith('https://');
    const pr = url.parse(target);
    const options = {
      method: 'POST',
      hostname: pr.hostname,
      port: pr.port || (isHttps ? 443 : 80),
      path: pr.path,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': file.length }
    };
    const reqx = (isHttps ? https : http).request(options, (pres) => {
      let data = '';
      pres.on('data', (chunk) => { data += chunk; });
      pres.on('end', () => {
        console.log('[files:send] sent', { source: req.query.path, target });
        res.send(data);
      });
    });
    reqx.setTimeout(REQUEST_TIMEOUT_MS, () => reqx.destroy(new Error('Request timeout')));
    reqx.on('error', (e) => res.status(502).send(`Send error: ${e.message}`));
    reqx.write(file);
    reqx.end();
  } catch (e) {
    res.status(400).send(`Failed to send: ${e.message}`);
  }
});

app.post('/api/write/', (req, res) => {
  const savePath = String(req.body.path || '');
  const fileName = String(req.body.name || '');
  if (!fileName) { res.status(400).send("No name specified"); return; }
  const fileData = String(req.body.data || '');
  if (fileData === undefined) { res.status(400).send("No data specified"); return; }
  try {
    const fullDir = safePathUnderUpload(savePath);
    fs.mkdir(fullDir, { recursive: true }, (err) => {
      if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
      const fullFile = safePathUnderUpload(path.join(savePath, fileName));
      fs.writeFile(fullFile, fileData, (erro) => {
        if (erro) { res.status(500).send(`Failed to write file: ${erro.message}`); return; }
        console.log('[files:write] wrote', { path: path.join(savePath, fileName) });
        res.send("File created successfully!");
      });
    });
  } catch (e) {
    res.status(400).send(`Invalid path: ${e.message}`);
  }
});

// Tasks
app.post('/api/task/add', (req, res) => {
  const tName = String(req.body.name || '').trim();
  if (!tName) {
    console.error('[validation] Task name is required', { body: req.body });
    return res.status(400).send('Task name is required');
  }
  const tType = String(req.body.type || '');
  const tData = String(req.body.data || '');
  const postType = String(req.body.pType || '');
  const postData = String(req.body.pData || '');
  const task = { 'name': tName, 'type': tType, 'data': tData, 'postType': postType, 'postData': postData };
  try {
    const dbm = require('./db/drizzle.js');
    dbm.upsertTask(task);
    const idx = gTasks.findIndex(ob => ob.name === tName);
    if (idx >= 0) gTasks[idx] = task; else gTasks.push(task);
    console.log('[task:add] Saved', { name: tName, type: tType });
    res.send(gTasks);
  } catch (e) {
    console.error('[task:add] Failed to save task', e);
    res.status(500).send(`Failed to save task: ${e.message}`);
  }
});

app.post('/api/task/run', (req, res) => {
  doTask(req);
  res.send('Task execution triggered');
});

app.get('/api/task/del/:name', (req, res) => {
  const tName = String(req.params.name);
  try { require('./db/drizzle.js').deleteTask(tName); } catch (_) {}
  gTasks = gTasks.filter(ob => ob.name !== tName);

  // Remove any routines using this task
  const affected = gIntervals.filter(inte => inte.name === tName);
  affected.forEach((inte) => {
    try { require('./db/drizzle.js').deleteIntervalDef(inte.name); } catch (_) {}
    try { clearInterval(inte.id); } catch (_) {}
  });
  gIntervals = gIntervals.filter(inte => inte.name !== tName);

  console.log('[task:del] Removed', { name: tName, removedIntervals: affected.length });
  res.send(`Task '${tName}' removed. Also removed ${affected.length} routine(s) using this task.`);
});

app.post('/api/task/time/run', (req, res) => {
  const tTime = parseInt(req.body.time, 10);
  setTimeout(() => { doTask(req); }, tTime);
  res.send("Time task started");
});

app.get('/api/task', (req, res) => { res.send(gTasks); });

app.get('/api/task/log/', (req, res) => {
  try {
    const dbm = require('./db/drizzle.js');
    return res.send({ 'return': dbm.getLastLogs(MAX_LOG_ENTRIES) });
  } catch (_) {
    return res.send({ 'return': gTasksLog });
  }
});

app.get('/api/task/log/toFile', (req, res) => {
  const fileName = `${req.query.name}.json`;
  fs.writeFile(path.join(__dirname, 'upload', fileName), JSON.stringify(gTasksLog, null, 2), (erro) => {
    if (erro) { res.status(500).send(`Failed to save log: ${erro.message}`); return; }
    console.log('[logs:save] wrote', { file: fileName });
    res.send("Log saved to file successfully!");
  });
});

app.get('/api/task/log/clear', (req, res) => {
  try { require('./db/drizzle.js').clearLogsTable(); } catch (_) {}
  gTasksLog = [];
  console.log('[logs:clear] cleared');
  res.send("Tasks log cleared!");
});

app.get('/api/task/count', (req, res) => {
  try {
    const row = require('./db/drizzle.js').raw.prepare('SELECT COUNT(*) AS c FROM logs').get();
    res.send("logs: " + (row ? row.c : 0));
  } catch (_) {
    res.send("logs: " + (gTasksLog.length));
  }
});

app.get('/api/task/log/:logid', (req, res) => {
  const idp = String(req.params.logid);
  try {
    const logs = require('./db/drizzle.js').getLastLogs(MAX_LOG_ENTRIES);
    if (idp === "n") return res.send(logs[logs.length - 1] || '');
    const idx = parseInt(idp, 10);
    return res.send(logs[idx] || '');
  } catch (_) {
    if (idp === "n") { res.send(gTasksLog[gTasksLog.length - 1] || ''); return; }
    const logid = parseInt(idp, 10);
    res.send(gTasksLog[logid] || '');
  }
});

app.get('/api/task/interval', (req, res) => {
  let inter = '';
  gIntervals.forEach((t) => { inter += `${t.name} every ${t.time / 60000} minutes\n`; });
  res.send(inter);
});

app.post('/api/task/interval/add', (req, res) => {
  const intTime = parseInt(req.body.time, 10);
  const name = String(req.body.name || '').trim();

  if (!name) {
    console.error('[validation] Interval requires task name');
    return res.status(400).send('Task name is required for routine');
  }
  if (!Number.isFinite(intTime) || intTime <= 0) {
    console.error('[validation] Invalid interval time', { time: req.body.time });
    return res.status(400).send('Invalid interval time');
  }
  const exists = gTasks.some(t => t.name === name);
  if (!exists) {
    console.warn('[interval:add] Rejected - task does not exist', { name });
    return res.status(400).send(`Task '${name}' does not exist`);
  }

  try { require('./db/drizzle.js').addIntervalDef(name, intTime); } catch (_) {}
  const id = setInterval(() => { doTask({ body: { name } }); }, intTime);
  gIntervals.push({ 'name': name, 'id': id, 'time': intTime });
  console.log('[interval:add] added', { name, timeMs: intTime, id });
  res.send("Added new interval");
});

app.get('/api/task/interval/count', (req, res) => { res.send("intervals: " + gIntervals.length); });

app.get('/api/task/interval/kill/:iid', (req, res) => {
  const iid = parseInt(req.params.iid, 10);
  const found = gIntervals.find(inte => inte.id == iid);
  if (found) {
    try { require('./db/drizzle.js').deleteIntervalDef(found.name); } catch (_) {}
  }
  clearInterval(iid);
  gIntervals = gIntervals.filter(inte => inte.id != iid);
  console.log('[interval:kill] stopped', { id: iid, name: found ? found.name : undefined });
  res.send(`interval with ${iid} id has been stopped`);
});

// Scrapers
app.get('/api/scraper/links/', (req, res) => {
  const target = "https://" + req.query.link;
  const purl = url.parse(target);
  const options = { host: purl.hostname, path: purl.path, headers: { 'User-Agent': userAgent } };
  const r = https.get(options, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location || '';
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/scraper/links/` + repRedirectUrl);
    } else {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let links = [];
        const $ = cheerio.load(data);
        $('a').each((i, el) => { const linkUrl = $(el).attr('href'); if (linkUrl) links.push({ 'link': linkUrl }); });
        const dirName = safePathUnderUpload(req.query.path || '');
        fs.mkdir(dirName, { recursive: true }, (err) => {
          if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
          fs.writeFile(path.join(dirName, `${(req.query.link || '').replace(/[./]/g, '_')}.json`), JSON.stringify(links, null, 2), (erro) => {
            if (erro) { res.status(500).send(`Failed to write links: ${erro.message}`); return; }
            res.send("Links scrapped successfully!");
          });
        });
      });
    }
  });
  r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('Request timeout')));
  r.on('error', (e) => res.status(502).send(`Scraper error: ${e.message}`));
});

app.get('/api/scraper/imgs/', (req, res) => {
  const baseUrl = "https://" + req.query.link;
  const purl = url.parse(baseUrl);
  const options = { host: purl.hostname, path: purl.path, headers: { 'User-Agent': userAgent } };
  const r = https.get(options, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location || '';
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/scraper/imgs/` + repRedirectUrl);
    } else {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        const dirName = safePathUnderUpload(req.query.path || '');
        fs.mkdir(dirName, { recursive: true }, (err) => {
          if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
          const $ = cheerio.load(data);
          $('img').each((i, el) => {
            let imgUrl = $(el).attr('src');
            if (!imgUrl) return;
            try {
              const resolved = new URL(imgUrl, baseUrl).toString();
              const isHttpsImg = resolved.startsWith('https://');
              const getter = isHttpsImg ? https : http;
              const filename = path.basename(url.parse(resolved).pathname || `img_${i}.bin`);
              const filepath = path.join(dirName, filename);
              getter.get(resolved, (res2) => {
                const fileStream = fs.createWriteStream(filepath);
                res2.pipe(fileStream);
              }).on('error', () => {/* ignore per-image errors */});
            } catch (_) { /* ignore */ }
          });
          res.send("Images downloaded from url");
        });
      });
    }
  });
  r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('Request timeout')));
  r.on('error', (e) => res.status(502).send(`Scraper error: ${e.message}`));
});

app.get('/api/scraper/cheeriohtml', (req, res) => {
  const target = "https://" + req.query.link;
  const elem = alwaysArr(req.query.parse);
  const purl = url.parse(target);
  const options = { host: purl.hostname, path: purl.path, headers: { 'User-Agent': userAgent } };
  const r = https.get(options, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location || '';
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/scraper/links/` + repRedirectUrl);
    } else {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let rets = '';
        elem.forEach((m) => {
          const $ = cheerio.load(data);
          $(m).each((i, el) => { rets += $(el).html(); });
        });
        const dirName = safePathUnderUpload(req.query.path || '');
        fs.mkdir(dirName, { recursive: true }, (err) => {
          if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
          fs.writeFile(path.join(dirName, `${(purl.hostname || '').replace(/[./]/g, '_')}.html`), rets, (erro) => {
            if (erro) { res.status(500).send(`Failed to write file: ${erro.message}`); return; }
            res.send(`html tags scrapped successfully!`);
          });
        });
      });
    }
  });
  r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('Request timeout')));
  r.on('error', (e) => res.status(502).send(`Scraper error: ${e.message}`));
});

app.get('/api/scraper/rss', (req, res) => {
  const target = "https://" + req.query.link;
  const elem = alwaysArr(req.query.parse);
  const purl = url.parse(target);
  const options = { host: purl.hostname, path: purl.path, headers: { 'User-Agent': userAgent } };
  const r = https.get(options, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location || '';
      const repRedirectUrl = location.replace(/^https:\/\//, '');
      res.redirect(`http://${host}:${port}/api/scraper/links/` + repRedirectUrl);
    } else {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let tags = '';
        elem.forEach((m) => {
          const re = new RegExp(`<${m}>([\\s\\S]*?)<\\/${m}>`, "g");
          let tagm; while ((tagm = re.exec(data))) { tags += `${tagm[1]}\n`; }
        });
        const dirName = safePathUnderUpload(req.query.path || '');
        fs.mkdir(dirName, { recursive: true }, (err) => {
          if (err) { res.status(500).send(`Failed to create directory: ${err.message}`); return; }
          fs.writeFile(path.join(dirName, `${(purl.hostname || '').replace(/[./]/g, '_')}.txt`), tags, (erro) => {
            if (erro) { res.status(500).send(`Failed to write file: ${erro.message}`); return; }
            res.send(`rss scrapped successfully!`);
          });
        });
      });
    }
  });
  r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('Request timeout')));
  r.on('error', (e) => res.status(502).send(`Scraper error: ${e.message}`));
});

// Clipboard
app.get('/api/clip', (req, res) => {
  try { return res.send(require('./db/drizzle.js').getLastClipText()); }
  catch (_) { return res.send(gClip[gClip.length - 1] || ''); }
});

app.post('/api/clip/save', (req, res) => {
  const text = String(req.body.data || '').trim();
  if (!text) {
    console.error('[validation] Clipboard text cannot be empty');
    return res.status(400).send('Clipboard text cannot be empty');
  }
  try { require('./db/drizzle.js').addClipEntry(text); } catch (e) { console.error('[clip:save] DB error', e); }
  gClip.push(text);
  console.log('[clip:save] Saved', { length: text.length });
  res.send('data saved to clip');
});

app.get('/api/clip/history', (req, res) => {
  try { return res.send(require('./db/drizzle.js').getClipHistory()); }
  catch (_) { return res.send(gClip); }
});

app.get('/api/clip/erase', (req, res) => {
  try { require('./db/drizzle.js').clearClipsTable(); } catch (_) {}
  gClip = [];
  console.log('[clip:erase] Cleared');
  res.send('Clipboard erased');
});

// Notes
app.get('/api/notes', (req, res) => {
  try { return res.send(require('./db/drizzle.js').getAllNotes()); }
  catch (_) { return res.send(gNotes); }
});

app.post('/api/notes/add', (req, res) => {
  const nName = String(req.body.name || '').trim();
  const nText = String(req.body.text || '').trim();
  const nDate = String(req.body.date || '').trim();
  if (!nName || !nText || !nDate) {
    console.error('[validation] Note requires non-empty name, text, and date', { bodyKeys: Object.keys(req.body || {}) });
    return res.status(400).send('Note requires non-empty name, text, and date');
  }
  try { require('./db/drizzle.js').addNoteEntry(nName, nText, nDate); } catch (e) { console.error('[notes:add] DB error', e); }
  gNotes.push({ 'name': nName, 'text': nText, 'date': nDate });
  console.log('[notes:add] Added', { name: nName });
  res.send(`'${nName}' note added`);
});

app.get('/api/notes/del/:name', (req, res) => {
  const noteName = String(req.params.name);
  try { require('./db/drizzle.js').deleteNoteEntry(noteName); } catch (_) {}
  gNotes = gNotes.filter(ob => ob.name !== noteName);
  console.log('[notes:del] Removed', { name: noteName });
  res.send(`${noteName} removed`);
});

// Console
app.get('/api/console', (req, res) => { console.log(req.query.text); res.send(`${req.query.text} was printed in the server console`); });

app.post('/api/console', (req, res) => { console.log(req.body.text); res.send(`${req.body.text} was printed in the server console`); });

// Error handler middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Express error:', err && err.stack || err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: { message: 'Internal Server Error' } });
});

app.listen(port, () => {
  console.log(`server is running on port http://${host}:${port}/`);
});
