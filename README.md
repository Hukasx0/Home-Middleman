# Home Middleman

Home Middleman is a self-hosted Node.js utility server for your LAN. It provides:
- HTTP/HTTPS proxy and text-only proxy for simple reading/scraping
- Web scrapers (links, images, HTML via Cheerio selectors, RSS tags)
- File storage under upload/ with list/upload/move/delete/send APIs
- Notes and Clipboard services
- Tasks and Routines (interval-based execution)
- A web UI and a Python CLI client

State is persisted in a local SQLite database for crash-safe 24/7 operation. On startup, intervals are rehydrated automatically from the database.

Key server file: [index.js](index.js)
DB module: [db/drizzle.js](db/drizzle.js)
Python CLI: [client/hmmClient.py](client/hmmClient.py)

## Features

- Proxy:
  - HTTP/HTTPS GET proxies
  - Text-only versions for reading/scraping without rendering
- Scrapers:
  - Links to JSON, Images download, Cheerio HTML selectors, RSS tags
- Files:
  - Upload from device or via URL, list, move/rename, delete, send via POST
- Notes and Clipboard:
  - Save and retrieve notes, store clipboard snippets and history
- Tasks and Routines:
  - Save tasks and run them immediately or on intervals; intervals survive restart
- Health:
  - /health endpoint with basic stats

## Requirements

- Node.js 18+ recommended (LTS)
- npm (comes with Node.js)
- No external DB/Docker required — a local SQLite file is created on first run
- Optional: Python 3.8+ if you want to use the CLI client

## Quick Start (all platforms)

1) Install dependencies (one command):
```
npm install
```

2) Start the server:
```
node index.js
```

3) Open:
- Web UI: http://localhost:1337
- Health check: http://localhost:1337/health

On first run, a new SQLite DB file is created at:
- data/home_middleman.sqlite

Uploaded files are stored under:
- upload/

## Platform-specific notes

Most users can simply run “npm install” + “node index.js”. If “better-sqlite3” fails to install, follow the platform notes below. Prebuilt binaries are available for many Node versions; build tools are only needed if a prebuilt is not available on your system.

### macOS
- Recommended: macOS 12+ with Xcode Command Line Tools installed:
```
xcode-select --install
```
- Then:
```
npm install
node index.js
```

### Ubuntu/Debian Linux
If npm install fails while building better-sqlite3, install build tools:
```
sudo apt update
sudo apt install -y build-essential python3 make g++
```
Then:
```
npm install
node index.js
```

### Fedora/CentOS/RHEL
If needed:
```
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y python3 gcc-c++ make
```
Then:
```
npm install
node index.js
```

### Windows 10/11
- Install Node.js LTS from https://nodejs.org
- If npm install fails while building better-sqlite3:
  - Install “Visual Studio Build Tools” (Desktop development with C++), then restart your terminal
  - Ensure Python is available (Node-gyp supports Python 3)
- Then:
```
npm install
node index.js
```

## Data and persistence

- SQLite DB file: data/home_middleman.sqlite
  - Stores tasks, intervals, logs, notes, and clipboard history
  - Intervals are rehydrated at startup
- File storage: upload/
  - Stores user uploads and scraper outputs
- Logs: kept in DB and also cached in memory (last 1000 entries)

## Python CLI (optional)

Install requirements:
```
pip install -r client/requirements.txt
```

Examples:
- Health:
```
python3 client/hmmClient.py --addr http://localhost:1337 health
```
- List tasks:
```
python3 client/hmmClient.py --addr http://localhost:1337 tasks list
```
- Add GET task:
```
python3 client/hmmClient.py --addr http://localhost:1337 tasks add get --name ping --type http --data example.com
```
- Run task:
```
python3 client/hmmClient.py --addr http://localhost:1337 tasks run --name ping
```
- Add to routine every 5 minutes:
```
python3 client/hmmClient.py --addr http://localhost:1337 routine add --name ping --minutes 5
```
- Clipboard get to local clipboard:
```
python3 client/hmmClient.py --addr http://localhost:1337 clip get
```

## Troubleshooting

- “npm install” fails at better-sqlite3:
  - macOS: run xcode-select --install, retry
  - Linux: install build tools (build-essential, gcc/g++, make, python3), retry
  - Windows: install Visual Studio Build Tools (C++), ensure Python available, retry
- Port in use:
  - Default port is 1337; change host/port in [index.js](index.js) if needed
- Database reset:
  - Use API endpoints:
    - /api/restart to clear all in-memory state and database tables
    - /api/reload?cfg=your_config.json to reset and load a saved config from upload/

## Development

Main server: [index.js](index.js)
DB bootstrap and helpers: [db/drizzle.js](db/drizzle.js)
Important server routines:
- Startup DB hydration and interval restoration: [index.js](index.js:62)
- Centralized log pushing: [function pushLog()](index.js:189)
- Interval cleanup before restart/reload: [function clearAllIntervals()](index.js:222)
- Health endpoint: [app.get()](index.js:490)

## License

Home Middleman is open-source under the MIT License.

