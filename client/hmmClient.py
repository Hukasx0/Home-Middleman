#!/usr/bin/env python3
"""
Home Middleman Python CLI client

Examples:
  python3 hmmClient.py --addr http://localhost:1337 tasks list
  python3 hmmClient.py --addr http://localhost:1337 tasks add get --name ping --type http --data example.com
  python3 hmmClient.py --addr http://localhost:1337 tasks add post --name up --type uploadlink --data https://example.com/a.jpg --post-type application/x-www-form-urlencoded --post-data "link=https://example.com/a.jpg"
  python3 hmmClient.py --addr http://localhost:1337 tasks run --name ping
  python3 hmmClient.py --addr http://localhost:1337 routine add --name ping --minutes 5
  python3 hmmClient.py --addr http://localhost:1337 clip get
  python3 hmmClient.py --addr http://localhost:1337 clip save --text "hello world"
  python3 hmmClient.py --addr http://localhost:1337 upload file --path ./notes.txt
  python3 hmmClient.py --addr http://localhost:1337 upload link --url https://example.com/img.png
  python3 hmmClient.py --addr http://localhost:1337 download --server-path path/in/upload/file.txt -o ./out.txt
  python3 hmmClient.py --addr http://localhost:1337 scrapper links --link example.com --path scraped/
  python3 hmmClient.py --addr http://localhost:1337 proxy http --target example.com
  python3 hmmClient.py --addr http://localhost:1337 files list
  python3 hmmClient.py --addr http://localhost:1337 files write --path notes --name a.txt --data "hello"
  python3 hmmClient.py --addr http://localhost:1337 config import --path mycfg.json
  python3 hmmClient.py --addr http://localhost:1337 restart --force
  python3 hmmClient.py --addr http://localhost:1337 health
"""

import argparse
import os
import sys
import typing as t

import requests
import pyperclip

DEFAULT_ADDR = os.getenv("HMM_ADDR", "http://localhost:1337")
TIMEOUT = 10  # seconds


def _url(addr: str, path: str) -> str:
    return addr.rstrip("/") + path


def _print(text: t.Union[str, bytes]) -> None:
    if isinstance(text, bytes):
        try:
            sys.stdout.write(text.decode("utf-8", errors="replace"))
        except Exception:
            sys.stdout.buffer.write(text)
    else:
        sys.stdout.write(str(text))
    if not str(text).endswith("\n"):
        sys.stdout.write("\n")


def _handle_req(fn: t.Callable[[], requests.Response]) -> int:
    try:
        resp = fn()
        _print(resp.text)
        return 0 if resp.ok else (resp.status_code if resp.status_code else 1)
    except requests.RequestException as e:
        _print(f"[error] {e}")
        return 2


# ----- tasks -----

def cmd_tasks_list(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/task"), timeout=TIMEOUT))


def cmd_tasks_add_get(addr: str, name: str, ttype: str, data: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/task/add"),
                                             data={"name": name, "type": ttype, "data": data},
                                             timeout=TIMEOUT))


def cmd_tasks_add_post(addr: str, name: str, ttype: str, data: str, post_type: str, post_data: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/task/add"),
                                             data={"name": name, "type": ttype, "data": data,
                                                   "pType": post_type, "pData": post_data},
                                             timeout=TIMEOUT))


def cmd_tasks_run(addr: str, name: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/task/run"),
                                             data={"name": name},
                                             timeout=TIMEOUT))


def cmd_tasks_del(addr: str, name: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/task/del/{name}"), timeout=TIMEOUT))


def cmd_tasks_log(addr: str, out_path: str) -> int:
    try:
        resp = requests.get(_url(addr, "/api/task/log"), timeout=TIMEOUT)
        resp.raise_for_status()
        with open(out_path, "wb") as f:
            f.write(resp.content)
        _print(f"saved logs to {out_path}")
        return 0
    except requests.RequestException as e:
        _print(f"[error] {e}")
        return 2
    except OSError as e:
        _print(f"[error] cannot write {out_path}: {e}")
        return 3


# ----- routine -----

def cmd_routine_list(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/task/interval"), timeout=TIMEOUT))


def cmd_routine_add(addr: str, name: str, minutes: t.Optional[int], ms: t.Optional[int]) -> int:
    if minutes is not None:
        time_ms = minutes * 60000
    elif ms is not None:
        time_ms = ms
    else:
        _print("[error] provide --minutes or --ms")
        return 1

    # Pre-validate that the task exists on the server
    try:
        resp = requests.get(_url(addr, "/api/task"), timeout=TIMEOUT)
        resp.raise_for_status()
        tasks = resp.json()
        exists = any(isinstance(t, dict) and t.get("name") == name for t in tasks)
        if not exists:
            _print(f"[error] task '{name}' does not exist on server")
            return 1
    except requests.RequestException as e:
        _print(f"[error] cannot validate task existence: {e}")
        return 2
    except ValueError as e:
        _print(f"[error] server returned invalid tasks payload: {e}")
        return 2

    return _handle_req(lambda: requests.post(_url(addr, "/api/task/interval/add"),
                                             data={"name": name, "time": str(time_ms)},
                                             timeout=TIMEOUT))


def cmd_routine_kill(addr: str, iid: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/task/interval/kill/{iid}"), timeout=TIMEOUT))


# ----- clip -----

def cmd_clip_get(addr: str) -> int:
    try:
        resp = requests.get(_url(addr, "/api/clip"), timeout=TIMEOUT)
        resp.raise_for_status()
        text = resp.text
        pyperclip.copy(text)
        _print(text)
        return 0
    except requests.RequestException as e:
        _print(f"[error] {e}")
        return 2


def cmd_clip_save(addr: str, text: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/clip/save"),
                                             data={"data": text},
                                             timeout=TIMEOUT))


def cmd_clip_history(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/clip/history"), timeout=TIMEOUT))


def cmd_clip_erase(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/clip/erase"), timeout=TIMEOUT))


# ----- notes -----

def cmd_notes_list(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/notes"), timeout=TIMEOUT))


def cmd_notes_add(addr: str, name: str, text: str, date: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/notes/add"),
                                             data={"name": name, "text": text, "date": date},
                                             timeout=TIMEOUT))


def cmd_notes_del(addr: str, name: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/notes/del/{name}"), timeout=TIMEOUT))


# ----- upload / download -----

def cmd_upload_file(addr: str, file_path: str) -> int:
    try:
        with open(file_path, "rb") as f:
            files = {'file': (os.path.basename(file_path), f)}
            return _handle_req(lambda: requests.post(_url(addr, "/api/upload"), files=files, timeout=TIMEOUT))
    except OSError as e:
        _print(f"[error] cannot open file: {e}")
        return 3


def cmd_upload_link(addr: str, url_str: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/uploadLink"),
                                             data={"link": url_str},
                                             timeout=TIMEOUT))


def cmd_download(addr: str, server_path: str, output: t.Optional[str]) -> int:
    try:
        resp = requests.get(_url(addr, f"/api/download/{server_path}"), timeout=TIMEOUT)
        resp.raise_for_status()
        out = output or os.path.basename(server_path)
        with open(out, "wb") as f:
            f.write(resp.content)
        _print(f"downloaded to {out}")
        return 0
    except requests.RequestException as e:
        _print(f"[error] {e}")
        return 2
    except OSError as e:
        _print(f"[error] cannot write file: {e}")
        return 3


# ----- scrapper -----

def cmd_scrapper_links(addr: str, link: str, path_param: str) -> int:
    # server expects link without scheme for this endpoint (it will add https://)
    # user may pass example.com or example.com/path
    return _handle_req(lambda: requests.get(_url(addr, f"/api/scraper/links/?link={link}&path={path_param}"),
                                           timeout=TIMEOUT))


def cmd_scrapper_imgs(addr: str, link: str, path_param: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/scraper/imgs/?link={link}&path={path_param}"),
                                           timeout=TIMEOUT))


def cmd_scrapper_cheerio(addr: str, link: str, parse: str, path_param: str) -> int:
    # multiple selectors separated by spaces are supported by server
    return _handle_req(lambda: requests.get(_url(addr, f"/api/scraper/cheeriohtml?link={link}&parse={parse}&path={path_param}"),
                                           timeout=TIMEOUT))


# ----- proxy -----

PROXY_PATHS = {
    "http": "/api/httpp/",
    "https": "/api/httpps/",
    "httptxt": "/api/txt/httpp/",
    "httpstxt": "/api/txt/httpps/",
}


def cmd_proxy(addr: str, ptype: str, target: str) -> int:
    prefix = PROXY_PATHS[ptype]
    # target should be host/path without scheme; this mirrors the server routing
    return _handle_req(lambda: requests.get(_url(addr, prefix + target), timeout=TIMEOUT))


# ----- files -----

def cmd_files_list(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/api/files/list"), timeout=TIMEOUT))


def cmd_files_del(addr: str, path_param: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/files/del?path={path_param}"), timeout=TIMEOUT))


def cmd_files_mv(addr: str, old: str, new: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/files/mv?old={old}&new={new}"), timeout=TIMEOUT))


def cmd_files_write(addr: str, save_path: str, name: str, data: str) -> int:
    return _handle_req(lambda: requests.post(_url(addr, "/api/write/"),
                                             data={"path": save_path, "name": name, "data": data},
                                             timeout=TIMEOUT))


# ----- config -----

def cmd_config_import(addr: str, path_param: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/cfg/import?path={path_param}"), timeout=TIMEOUT))


def cmd_config_export(addr: str, name: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, f"/api/cfg/export?name={name}"), timeout=TIMEOUT))


# ----- restart / health / console -----

def cmd_restart(addr: str, force: bool) -> int:
    if not force:
        ans = input("Are you sure? YES/NO ").strip()
        if ans != "YES":
            _print("aborted")
            return 0
    return _handle_req(lambda: requests.get(_url(addr, "/api/restart"), timeout=TIMEOUT))


def cmd_health(addr: str) -> int:
    return _handle_req(lambda: requests.get(_url(addr, "/health"), timeout=TIMEOUT))


def cmd_console(addr: str, text: str) -> int:
    # GET variant, mirrors server
    return _handle_req(lambda: requests.get(_url(addr, f"/api/console?text={requests.utils.quote(text)}"), timeout=TIMEOUT))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Home Middleman CLI", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--addr", default=DEFAULT_ADDR, help="Server address, e.g. http://localhost:1337")
    sp = p.add_subparsers(dest="cmd", required=True)

    # tasks
    tasks = sp.add_parser("tasks", help="Manage tasks")
    tsp = tasks.add_subparsers(dest="op", required=True)

    tsp.add_parser("list", help="List tasks")

    tadd = tsp.add_parser("add", help="Add a task")
    tadd_sp = tadd.add_subparsers(dest="mode", required=True)

    tadd_get = tadd_sp.add_parser("get", help="Add GET-based task")
    tadd_get.add_argument("--name", required=True)
    tadd_get.add_argument("--type", required=True, help="http/https/httptxt/httpstxt/scrapurl/scrapimg/cheerioc/cclip/delfile/mvfile/logfile/cfgimport/cfgexport/consoleget/sendfile/reload")
    tadd_get.add_argument("--data", required=True, help="Task data")

    tadd_post = tadd_sp.add_parser("post", help="Add POST-based task")
    tadd_post.add_argument("--name", required=True)
    tadd_post.add_argument("--type", required=True, help="httppost/httpspost/uploadlink/saveclip/consolepost")
    tadd_post.add_argument("--data", required=True, help="Task data")
    tadd_post.add_argument("--post-type", required=True, help="Content-Type for POST (e.g. application/x-www-form-urlencoded)")
    tadd_post.add_argument("--post-data", required=True, help="POST body")

    trun = tsp.add_parser("run", help="Run task by name")
    trun.add_argument("--name", required=True)

    tdel = tsp.add_parser("del", help="Delete task by name")
    tdel.add_argument("--name", required=True)

    tlog = tsp.add_parser("log", help="Save task logs to file")
    tlog.add_argument("-o", "--out", default="tasks.json", help="Output file")

    # routine
    routine = sp.add_parser("routine", help="Routine (interval) operations")
    rsp = routine.add_subparsers(dest="op", required=True)
    rsp.add_parser("list", help="List routine tasks")
    radd = rsp.add_parser("add", help="Add task to routine")
    radd.add_argument("--name", required=True)
    tm = radd.add_mutually_exclusive_group(required=True)
    tm.add_argument("--minutes", type=int, help="Interval in minutes")
    tm.add_argument("--ms", type=int, help="Interval in milliseconds")
    rkill = rsp.add_parser("kill", help="Kill routine by interval id")
    rkill.add_argument("--id", required=True, dest="iid")

    # clip
    clip = sp.add_parser("clip", help="Clipboard operations")
    csp = clip.add_subparsers(dest="op", required=True)
    csp.add_parser("get", help="Copy latest server clip to local clipboard and print")
    csave = csp.add_parser("save", help="Save text to server clipboard")
    csave.add_argument("--text", required=True)
    csp.add_parser("history", help="Show clipboard history")
    csp.add_parser("erase", help="Erase clipboard history")

    # notes
    notes = sp.add_parser("notes", help="Notes operations")
    nsp = notes.add_subparsers(dest="op", required=True)
    nsp.add_parser("list", help="List notes")
    nadd = nsp.add_parser("add", help="Add a note")
    nadd.add_argument("--name", required=True)
    nadd.add_argument("--text", required=True)
    nadd.add_argument("--date", required=True, help="Date string")
    ndel = nsp.add_parser("del", help="Delete a note")
    ndel.add_argument("--name", required=True)

    # upload
    upload = sp.add_parser("upload", help="Upload files or by link")
    usp = upload.add_subparsers(dest="op", required=True)
    ufile = usp.add_parser("file", help="Upload a local file")
    ufile.add_argument("--path", required=True, help="Local file path")
    ulink = usp.add_parser("link", help="Upload by URL")
    ulink.add_argument("--url", required=True, help="Remote file URL (http/https)")

    # download
    dl = sp.add_parser("download", help="Download a file from server upload/")
    dl.add_argument("--server-path", required=True, help="Path under upload/")
    dl.add_argument("-o", "--out", help="Local output path")

    # scrapper
    scr = sp.add_parser("scrapper", help="Scrape web data")
    ssp = scr.add_subparsers(dest="op", required=True)
    slinks = ssp.add_parser("links", help="Scrape links into JSON (server saves file)")
    slinks.add_argument("--link", required=True, help="example.com[/path]")
    slinks.add_argument("--path", required=True, help="Server directory under upload/")
    simgs = ssp.add_parser("imgs", help="Download images (server saves files)")
    simgs.add_argument("--link", required=True)
    simgs.add_argument("--path", required=True)
    scheerio = ssp.add_parser("cheerio", help="Scrape HTML elements with Cheerio selectors")
    scheerio.add_argument("--link", required=True)
    scheerio.add_argument("--parse", required=True, help="Selectors separated by spaces, e.g. \"h3 p a title\"")
    scheerio.add_argument("--path", required=True)

    # proxy
    proxy = sp.add_parser("proxy", help="Proxy a request via server")
    proxy.add_argument("ptype", choices=list(PROXY_PATHS.keys()), help="Proxy type")
    proxy.add_argument("--target", required=True, help="host/path (no scheme) to fetch")

    # files
    files = sp.add_parser("files", help="File operations on upload/")
    fsp = files.add_subparsers(dest="op", required=True)
    fsp.add_parser("list", help="List files")
    fdel = fsp.add_parser("del", help="Delete a file")
    fdel.add_argument("--path", required=True)
    fmv = fsp.add_parser("mv", help="Move/rename a file")
    fmv.add_argument("--old", required=True)
    fmv.add_argument("--new", required=True)
    fwr = fsp.add_parser("write", help="Write text to a file on server")
    fwr.add_argument("--path", required=True, help="Server dir under upload/")
    fwr.add_argument("--name", required=True, help="File name")
    fwr.add_argument("--data", required=True, help="File content")

    # config
    cfg = sp.add_parser("config", help="Import/export configuration")
    cgsp = cfg.add_subparsers(dest="op", required=True)
    cimp = cgsp.add_parser("import", help="Import configuration from upload/")
    cimp.add_argument("--path", required=True, help="Path in upload/ to JSON")
    cexp = cgsp.add_parser("export", help="Export configuration to upload/")
    cexp.add_argument("--name", required=True, help="Base name for JSON (no extension)")

    # restart, health, console
    rst = sp.add_parser("restart", help="Restart Home Middleman state")
    rst.add_argument("--force", action="store_true", help="Skip confirmation prompt")

    sp.add_parser("health", help="Server health")

    con = sp.add_parser("console", help="Print text in server console")
    con.add_argument("--text", required=True)

    return p


def main(argv: t.List[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    addr = args.addr

    if args.cmd == "tasks":
        if args.op == "list":
            return cmd_tasks_list(addr)
        if args.op == "add":
            if args.mode == "get":
                return cmd_tasks_add_get(addr, args.name, args.type, args.data)
            if args.mode == "post":
                return cmd_tasks_add_post(addr, args.name, args.type, args.data, args.post_type, args.post_data)
        if args.op == "run":
            return cmd_tasks_run(addr, args.name)
        if args.op == "del":
            return cmd_tasks_del(addr, args.name)
        if args.op == "log":
            return cmd_tasks_log(addr, args.out)

    elif args.cmd == "routine":
        if args.op == "list":
            return cmd_routine_list(addr)
        if args.op == "add":
            return cmd_routine_add(addr, args.name, getattr(args, "minutes", None), getattr(args, "ms", None))
        if args.op == "kill":
            return cmd_routine_kill(addr, args.iid)

    elif args.cmd == "clip":
        if args.op == "get":
            return cmd_clip_get(addr)
        if args.op == "save":
            return cmd_clip_save(addr, args.text)
        if args.op == "history":
            return cmd_clip_history(addr)
        if args.op == "erase":
            return cmd_clip_erase(addr)

    elif args.cmd == "notes":
        if args.op == "list":
            return cmd_notes_list(addr)
        if args.op == "add":
            return cmd_notes_add(addr, args.name, args.text, args.date)
        if args.op == "del":
            return cmd_notes_del(addr, args.name)

    elif args.cmd == "upload":
        if args.op == "file":
            return cmd_upload_file(addr, args.path)
        if args.op == "link":
            return cmd_upload_link(addr, args.url)

    elif args.cmd == "download":
        return cmd_download(addr, args.server_path, args.out)

    elif args.cmd == "scrapper":
        if args.op == "links":
            return cmd_scrapper_links(addr, args.link, args.path)
        if args.op == "imgs":
            return cmd_scrapper_imgs(addr, args.link, args.path)
        if args.op == "cheerio":
            return cmd_scrapper_cheerio(addr, args.link, args.parse, args.path)

    elif args.cmd == "proxy":
        return cmd_proxy(addr, args.ptype, args.target)

    elif args.cmd == "files":
        if args.op == "list":
            return cmd_files_list(addr)
        if args.op == "del":
            return cmd_files_del(addr, args.path)
        if args.op == "mv":
            return cmd_files_mv(addr, args.old, args.new)
        if args.op == "write":
            return cmd_files_write(addr, args.path, args.name, args.data)

    elif args.cmd == "config":
        if args.op == "import":
            return cmd_config_import(addr, args.path)
        if args.op == "export":
            return cmd_config_export(addr, args.name)

    elif args.cmd == "restart":
        return cmd_restart(addr, args.force)

    elif args.cmd == "health":
        return cmd_health(addr)

    elif args.cmd == "console":
        return cmd_console(addr, args.text)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
