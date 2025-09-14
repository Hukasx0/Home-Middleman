const mainSite = "http://"+ window.location.hostname + ":" + window.location.port

// UI helpers
function notify(msg) {
  try { console.log('[ui]', msg); } catch (_) {}
  alert(msg);
}
/**
 * Standardized fetch handler: reloads on success, alerts on failure.
 * @param {Promise<Response>} p
 */
function handleFetch(p) {
  p.then(async (response) => {
    const text = await response.text();
    if (!response.ok) {
      notify(text || response.statusText || 'Request failed');
      return;
    }
    document.location.reload(true);
  }).catch((error) => {
    notify(String(error));
  });
}

function guiProxy(){
    const protocol = document.getElementById('protocol');
    const targetEl = document.getElementById('target');
    const iFrame = document.getElementById('fr');
    const raw = (targetEl.value || '').trim();
    if (!raw) {
        notify('Target cannot be empty');
        return;
    }
    // strip scheme if provided; backend expects host/path without http(s)://
    const hostPath = raw.replace(/^https?:\/\//i, '');
    const prefix = protocol.value == "1" ? "/api/httpps/" : "/api/httpp/";
    const req = mainSite + prefix + hostPath;
    console.log('[proxy] requesting', req);
    iFrame.src = req;
}

function guiUpload(){
    const fileInput = document.getElementById('fUpload').files[0];
    if(!fileInput){
        notify("No file specified");
        return;
    }
    const formData = new FormData();
    formData.append('file', fileInput);
    handleFetch(fetch('/api/upload', {
        method: 'POST',
        body: formData
    }));
}

function guiLinkUpload(){
    const fileLink = (document.getElementById('fLink').value || '').trim();
    if(!fileLink){
        notify("No file link specified");
        return;
    }
    if (!(fileLink.startsWith('http://') || fileLink.startsWith('https://'))) {
        notify("Link must start with http:// or https://");
        return;
    }
    handleFetch(fetch('/api/uploadLink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `link=${encodeURIComponent(fileLink)}`
    }));
}

function newTask(){
    const rawName = document.getElementById('tName').value;
    const tName = (rawName || '').trim().replace("?","%3F").replace("&", "%26");
    if (!tName) {
        notify("Task name is required");
        return;
    }
    const tType = document.getElementById('tType').value;
    let tData = document.getElementById('tData').value.replace("?","%3F").replace("&", "%26");
    let pType = document.getElementById('pType').value;
    let pData = document.getElementById('pData').value;
    const tData2 = document.getElementById('tData2').value;
    const sPath = document.getElementById('path').value;
    switch (tType) {
        case "cheerioc":
            tData += `${manyParsers(tData2)}&path=${sPath}`;
            break;
        case "scraprss":
            tData += `${manyParsers(tData2)}&path=${sPath}`;
            break;
        case "scrapurl":
            tData += `&path=${sPath}`;
            break;
        case "scrapimg":
            tData += `&path=${sPath}`;
            break;
        case "mvfile":
            tData = `?old=${tData}&new=${tData2}`;
            break;
        case "uploadlink":
            pType = "application/x-www-form-urlencoded";
            pData = `link=${tData}`;
            break;
        case "saveclip":
            pType = "application/x-www-form-urlencoded";
            pData = `data=${tData}`;
            break;
        case "consolepost":
            pType = "application/x-www-form-urlencoded";
            pData = `text=${tData}`;
            break;
        case "sendfile":
            tData = `?target=${tData}&path=${tData2}`;
            break;
        default:
            break;
    }
    handleFetch(fetch('/api/task/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `name=${encodeURIComponent(tName)}&type=${encodeURIComponent(tType)}&data=${encodeURIComponent(tData)}&pType=${encodeURIComponent(pType)}&pData=${encodeURIComponent(pData)}`
    }));
}

function startTask(){
    const tName = (document.getElementById('stName').value || '').trim();
    if (!tName) {
        notify("Select task name to run");
        return;
    }
    handleFetch(fetch('/api/task/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `name=${encodeURIComponent(tName)}`
    }));
}

function startRoutine(){
    const tName = (document.getElementById('intName').value || '').trim();
    const tTime = parseInt(document.getElementById('intTime').value, 10);
    if (!tName) {
        notify("Select task to add to routine");
        return;
    }
    if (!Number.isFinite(tTime) || tTime <= 0) {
        notify("Provide interval in minutes (> 0)");
        return;
    }
    const tMins = tTime * 60000;
    handleFetch(fetch('/api/task/interval/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `name=${encodeURIComponent(tName)}&time=${encodeURIComponent(tMins)}&`
    }));
}

function addToClipboard(){
    const inpc = (document.getElementById('addToClip').value || '').trim();
    if (!inpc) {
        notify("Clipboard text cannot be empty");
        return;
    }
    handleFetch(fetch('/api/clip/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(inpc)}`
    }));
}

function addNote(){
    const nName = (document.getElementById('nName').value || '').trim();
    const nText = (document.getElementById('nText').value || '').trim();
    const nDate = (document.getElementById('nDate').value || '').trim();
    if (!nName || !nText || !nDate) {
        notify("Note requires non-empty name, text, and date");
        return;
    }
    handleFetch(fetch('/api/notes/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `name=${encodeURIComponent(nName)}&text=${encodeURIComponent(nText)}&date=${encodeURIComponent(nDate)}`
    }));
}

function getRemove(linkC){
    handleFetch(fetch(linkC, { method: 'GET' }));
}

function manyParsers(str){
    return str.split(" ").map(elem => "&parse="+elem).join("");
}