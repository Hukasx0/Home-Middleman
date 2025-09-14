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
    let notes = '';
    for (let i = gNotes.length - 1; i >= 0; i--) {
      const cgn = gNotes[i];
      notes += `
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
    data = data.replace('<!-- notes -->', notes);
    res.send(data);
  });
});

app.get('/clipboard', (req, res) => {
  fs.readFile('web/clip.html', 'utf-8', (err, data) => {
    if (err) { res.status(500).send('Failed to read clip.html'); return; }
    let scb = '';
    for (let i = gClip.length - 1; i >= 0; i--) {
      scb += `<li>${gClip[i]}</li>`;
    }
    data = data.replace("<!-- insert history -->", scb);
    res.send(data.replace("<!-- copyme -->", `<h1 id="copyMe" style="color: darkblue;" role="button" onclick="toClipboard()">${gClip[gClip.length - 1] || ''}</h1>`));
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
    let tasks = '';
    let stasks = '';
    gTasks.forEach((t) => {
      tasks += `<li>${t.name} | ${t.type} | ${t.data} <i class="bi bi-trash3" role="button" style="color:blueviolet;" onclick="getRemove('/api/task/del/${t.name}')"></i></li>`;
      stasks += `<option value="${t.name}">${t.name}</option>`;
    });
    data = data.replace("<!-- import tasks -->", stasks);
    res.send(data.replace("<!-- tasks -->", tasks));
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
    parsed.forEach((i) => {
      switch (i.type) {
        case "task":
          gTasks.push({
            'name': i.data.name,
            'type': i.data.type,
            'data': i.data.data,
            'postType': i.data.postType,
            'postData': i.data.postData
          });
          break;
        case "routine":
          gIntervals.push({
            'name': i.data.name,
            'id': setInterval(() => {
              doTask({ body: { name: i.data.name } });
            }, i.data.time),
            'time': i.data.time
          });
        default:
          break;
      }
    });
    res.send(`Config ${req.query.path} loaded`);
  });
});

app.get('/api/cfg/export', (req, res) => {
  let toJson = [];
  gTasks.forEach((e) => { toJson.push({ 'type': 'task', 'data': e }); });
  gIntervals.forEach((e) => { toJson.push({ 'type': 'routine', 'data': { 'name': e.name, 'time': e.time } }); });
  const fName = `${req.query.name}.json`;
  fs.writeFile(path.join(__dirname, 'upload', fName), JSON.stringify(toJson, null, 2), (erro) => {
    if (erro) { res.status(500).send(`Failed to export: ${erro.message}`); return; }
    res.send(`Config exported successfully to ${fName}`);
  });
});

app.get('/api/restart', (req, res) => {
  clearAllIntervals();
  gTasks = [];
  gTasksLog = [];
  gClip = [];
  gNotes = [];
  res.send("Home middleman has been restarted");
});

app.get('/api/reload', (req, res) => {
  clearAllIntervals();
  gTasks = [];
  gTasksLog = [];
  gClip = [];
  gNotes = [];
  fs.readFile(path.join(__dirname, 'upload', req.query.cfg || ''), (err, jsoncfg) => {
    if (err) { res.status(400).send(`Failed to read config: ${err.message}`); return; }
    let parsed;
    try { parsed = JSON.parse(jsoncfg); } catch (e) { res.status(400).send('Invalid JSON'); return; }
    parsed.forEach((i) => {
      switch (i.type) {
        case "task":
          gTasks.push({
            'name': i.data.name,
            'type': i.data.type,
            'data': i.data.data,
            'postType': i.data.postType,
            'postData': i.data.postData
          });
          break;
        case "routine":
          gIntervals.push({
            'name': i.data.name,
            'id': setInterval(() => {
              doTask({ body: { name: i.data.name } });
            }, i.data.time),
            'time': i.data.time
          });
        default:
          break;
      }
    });
    res.send(`Restarted Home Middleman and loaded ${req.query.cfg} config`);
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
      fileStream.on('finish', () => { fileStream.close(() => res.status(200).send("File downloaded successfully from provided link")); });
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
      pres.on('end', () => { res.send(data); });
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
        res.send("File created successfully!");
      });
    });
  } catch (e) {
    res.status(400).send(`Invalid path: ${e.message}`);
  }
});

// Tasks
app.post('/api/task/add', (req, res) => {
  const tName = String(req.body.name || '');
  const tType = String(req.body.type || '');
  const tData = String(req.body.data || '');
  const postType = String(req.body.pType || '');
  const postData = String(req.body.pData || '');
  gTasks.push({ 'name': tName, 'type': tType, 'data': tData, 'postType': postType, 'postData': postData });
  res.send(gTasks);
});

app.post('/api/task/run', (req, res) => {
  doTask(req);
  res.send('Task execution triggered');
});

app.get('/api/task/del/:name', (req, res) => {
  const tName = String(req.params.name);
  gTasks = gTasks.filter(ob => ob.name !== tName);
  res.send(`Task with name ${tName} has been removed`);
});

app.post('/api/task/time/run', (req, res) => {
  const tTime = parseInt(req.body.time, 10);
  setTimeout(() => { doTask(req); }, tTime);
  res.send("Time task started");
});

app.get('/api/task', (req, res) => { res.send(gTasks); });

app.get('/api/task/log/', (req, res) => { res.send({ 'return': gTasksLog }); });

app.get('/api/task/log/toFile', (req, res) => {
  const fileName = `${req.query.name}.json`;
  fs.writeFile(path.join(__dirname, 'upload', fileName), JSON.stringify(gTasksLog, null, 2), (erro) => {
    if (erro) { res.status(500).send(`Failed to save log: ${erro.message}`); return; }
    res.send("Log saved to file successfully!");
  });
});

app.get('/api/task/log/clear', (req, res) => { gTasksLog = []; res.send("Tasks log cleared!"); });

app.get('/api/task/count', (req, res) => { res.send("logs: " + (gTasksLog.length)); });

app.get('/api/task/log/:logid', (req, res) => {
  if (String(req.params.logid) === "n") { res.send(gTasksLog[gTasksLog.length - 1] || ''); return; }
  const logid = parseInt(req.params.logid);
  res.send(gTasksLog[logid] || '');
});

app.get('/api/task/interval', (req, res) => {
  let inter = '';
  gIntervals.forEach((t) => { inter += `${t.name} every ${t.time / 60000} minutes\n`; });
  res.send(inter);
});

app.post('/api/task/interval/add', (req, res) => {
  const intTime = parseInt(req.body.time, 10);
  const name = req.body.name;
  const id = setInterval(() => { doTask({ body: { name } }); }, intTime);
  gIntervals.push({ 'name': name, 'id': id, 'time': intTime });
  res.send("Added new interval");
});

app.get('/api/task/interval/count', (req, res) => { res.send("intervals: " + gIntervals.length); });

app.get('/api/task/interval/kill/:iid', (req, res) => {
  const iid = parseInt(req.params.iid, 10);
  clearInterval(iid);
  gIntervals = gIntervals.filter(inte => inte.id != iid);
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
app.get('/api/clip', (req, res) => { res.send(gClip[gClip.length - 1] || ''); });

app.post('/api/clip/save', (req, res) => { gClip.push(req.body.data); res.send('data saved to clip'); });

app.get('/api/clip/history', (req, res) => { res.send(gClip); });

app.get('/api/clip/erase', (req, res) => { gClip = []; res.send('Clipboard erased'); });

// Notes
app.get('/api/notes', (req, res) => { res.send(gNotes); });

app.post('/api/notes/add', (req, res) => {
  gNotes.push({ 'name': req.body.name, 'text': req.body.text, 'date': req.body.date });
  res.send(`'${req.body.name}' note added`);
});

app.get('/api/notes/del/:name', (req, res) => {
  const noteName = String(req.params.name);
  gNotes = gNotes.filter(ob => ob.name !== noteName);
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
