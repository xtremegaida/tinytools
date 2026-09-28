#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { parseArgs } = require('util');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const HELP = `Usage: node slideshow.js [folder] [options]

Serves a fullscreen slideshow of the images in <folder> (default: current folder).

Options:
  -f, --fit <mode>       stretch | center          (default: stretch)
                           stretch: scale every image to fill the screen
                           center:  show at actual size, only shrinking
                                    images larger than the screen
  -i, --interval <secs>  auto-advance every N seconds, 0 = off  (default: 0)
  -t, --fade <secs>      cross-fade duration, 0 = instant  (default: 0.5)
  -o, --order <order>    alpha | shuffle            (default: alpha)
  -r, --recursive        include images in subfolders
  -p, --port <port>      port to listen on          (default: 3000)
      --host <host>      interface to bind to       (default: 127.0.0.1)
                           use 0.0.0.0 to allow other devices on the network
  -h, --help             show this help

Keys in the browser:
  Left / Right      previous / next image
  Space             pause / resume the timer
  F or double-click toggle fullscreen
`;

function fail(message) {
  console.error(`Error: ${message}\n`);
  console.error(HELP);
  process.exit(1);
}

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        fit: { type: 'string', short: 'f', default: 'stretch' },
        interval: { type: 'string', short: 'i', default: '0' },
        fade: { type: 'string', short: 't', default: '0.5' },
        order: { type: 'string', short: 'o', default: 'alpha' },
        recursive: { type: 'boolean', short: 'r', default: false },
        port: { type: 'string', short: 'p', default: '3000' },
        host: { type: 'string', default: '127.0.0.1' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (positionals.length > 1) fail('only one folder can be given');

  const folder = path.resolve(positionals[0] || '.');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    fail(`folder not found: ${folder}`);
  }
  if (!['stretch', 'center'].includes(values.fit)) {
    fail(`--fit must be "stretch" or "center", got "${values.fit}"`);
  }
  if (!['alpha', 'shuffle'].includes(values.order)) {
    fail(`--order must be "alpha" or "shuffle", got "${values.order}"`);
  }
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 0) {
    fail(`--interval must be a number of seconds >= 0, got "${values.interval}"`);
  }
  const fade = Number(values.fade);
  if (!Number.isFinite(fade) || fade < 0) {
    fail(`--fade must be a number of seconds >= 0, got "${values.fade}"`);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`--port must be between 0 and 65535, got "${values.port}"`);
  }

  return {
    folder,
    fit: values.fit,
    interval,
    fade,
    order: values.order,
    recursive: values.recursive,
    port,
    host: values.host,
  };
}

// Returns image paths relative to root, using "/" as the separator.
function scanImages(root, recursive) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile() && MIME_TYPES[path.extname(entry.name).toLowerCase()]) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function orderImages(images, order) {
  if (order === 'shuffle') {
    for (let i = images.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [images[i], images[j]] = [images[j], images[i]];
    }
  } else {
    images.sort(collator.compare);
  }
  return images;
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, html) => {
    if (err) return sendText(res, 500, 'Could not read index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
}

// The folder is rescanned on every page load, so refreshing picks up new
// images and reshuffles.
function serveSlideshow(res, options) {
  let images;
  try {
    images = orderImages(scanImages(options.folder, options.recursive), options.order);
  } catch (err) {
    return sendText(res, 500, `Could not scan folder: ${err.message}`);
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ images, fit: options.fit, interval: options.interval, fade: options.fade }));
}

function serveImage(res, root, encodedPath) {
  let file;
  try {
    file = path.resolve(root, decodeURIComponent(encodedPath));
  } catch {
    return sendText(res, 400, 'Bad path');
  }
  const rel = path.relative(root, file);
  const outsideRoot = rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  const mime = MIME_TYPES[path.extname(file).toLowerCase()];
  if (outsideRoot || !mime) return sendText(res, 404, 'Not found');

  fs.stat(file, (err, stats) => {
    if (err || !stats.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Cache-Control': 'max-age=3600',
    });
    pipeline(fs.createReadStream(file), res, () => {});
  });
}

function main() {
  const options = parseOptions(process.argv.slice(2));

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/') return serveIndex(res);
    if (pathname === '/api/slideshow') return serveSlideshow(res, options);
    if (pathname.startsWith('/image/')) return serveImage(res, options.folder, pathname.slice('/image/'.length));
    sendText(res, 404, 'Not found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${options.port} is already in use. Try another with --port.`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const count = scanImages(options.folder, options.recursive).length;
    const { port } = server.address();
    const shownHost = ['0.0.0.0', '::'].includes(options.host) ? 'localhost' : options.host;
    console.log(`Slideshow of ${count} image(s) in ${options.folder}`);
    console.log(`  fit: ${options.fit}, order: ${options.order}, interval: ${options.interval ? options.interval + 's' : 'off'}, fade: ${options.fade}s`);
    console.log(`\n  Open http://${shownHost}:${port}/ in your browser  (Ctrl+C to stop)`);
  });
}

main();
