#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MAX_PEERS = 32;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 24;
const MAX_COORDINATE = 100000;
const PEER_TIMEOUT_MS = 20000;
const MAX_MESSAGES_PER_SECOND = 120;
const DEFAULT_COLOR = '#a8321f';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

const peers = new Map();

function sanitizeName(value) {
  if (typeof value !== 'string') return 'Wanderer';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || 'Wanderer';
}

function sanitizeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
}

function sanitizeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, -MAX_COORDINATE), MAX_COORDINATE);
}

function sanitizeLevel(value) {
  return typeof value === 'string' && value.length <= 32 ? value : null;
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function sendJson(peer, message) {
  if (peer.socket.destroyed) return;
  try {
    peer.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));
  } catch (error) {
    console.error('[ws] write failed', error.message);
  }
}

function broadcast(message, exceptId = null) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = encodeFrame(0x1, payload);
  for (const peer of peers.values()) {
    if (peer.id === exceptId || peer.socket.destroyed) continue;
    peer.socket.write(frame);
  }
}

function publicPeer(peer) {
  return { id: peer.id, name: peer.name, color: peer.color, level: peer.level };
}

function createPeer(socket, id) {
  return {
    id,
    socket,
    name: 'Wanderer',
    color: DEFAULT_COLOR,
    level: null,
    joined: false,
    lastSeen: Date.now(),
    windowStart: Date.now(),
    windowCount: 0,
  };
}

function dropPeer(peer) {
  if (!peers.has(peer.id)) return;
  peers.delete(peer.id);
  broadcast({ t: 'leave', id: peer.id });
}

function readFrameLength(buffer, second) {
  const shortLength = second & 0x7f;
  if (shortLength < 126) return { length: shortLength, offset: 2 };
  if (shortLength === 126) {
    if (buffer.length < 4) return null;
    return { length: buffer.readUInt16BE(2), offset: 4 };
  }
  if (buffer.length < 10) return null;
  const big = buffer.readBigUInt64BE(2);
  if (big > BigInt(MAX_FRAME_BYTES)) return { overflow: true };
  return { length: Number(big), offset: 10 };
}

function unmask(payload, mask) {
  const output = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index & 3];
  }
  return output;
}

function attachSocket(socket) {
  const peer = createPeer(socket, null);
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let closeRequested = false;

  const close = (code) => {
    if (closeRequested) return;
    closeRequested = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      socket.write(encodeFrame(0x8, payload));
    } catch {}
    dropPeer(peer);
    socket.end();
  };

  const handleMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    peer.lastSeen = Date.now();
    peer.windowCount += 1;
    if (peer.windowCount > MAX_MESSAGES_PER_SECOND) return;

    if (!peer.joined) {
      if (message.t !== 'join') return;
      peer.name = sanitizeName(message.name);
      peer.color = sanitizeColor(message.color);
      peer.joined = true;
      if (peers.size >= MAX_PEERS) {
        close(1013);
        return;
      }
      peers.set(peer.id, peer);
      sendJson(peer, {
        t: 'welcome',
        id: peer.id,
        peers: [...peers.values()].filter((other) => other.id !== peer.id).map(publicPeer),
      });
      broadcast({ t: 'join', peer: publicPeer(peer) }, peer.id);
      return;
    }

    if (message.t === 's') {
      peer.level = sanitizeLevel(message.level);
      const state = {
        t: 's',
        id: peer.id,
        x: sanitizeNumber(message.x),
        y: sanitizeNumber(message.y),
        z: sanitizeNumber(message.z),
        rootY: sanitizeNumber(message.rootY),
        heading: sanitizeNumber(message.heading),
        speed: Math.abs(sanitizeNumber(message.speed)),
        state: typeof message.state === 'string' ? message.state.slice(0, 16) : 'IDLE',
        level: peer.level,
      };
      broadcast(state, peer.id);
      return;
    }

    if (message.t === 'profile') {
      peer.name = sanitizeName(message.name);
      peer.color = sanitizeColor(message.color);
      broadcast({ t: 'profile', id: peer.id, name: peer.name, color: peer.color });
    }
  };

  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;

      if (!masked) {
        close(1002);
        return;
      }

      const size = readFrameLength(buffer, second);
      if (!size) return;
      if (size.overflow) {
        close(1009);
        return;
      }

      const isControl = opcode >= 0x8;
      if (isControl && (size.length > 125 || !fin)) {
        close(1002);
        return;
      }

      const maskOffset = size.offset;
      const payloadOffset = maskOffset + 4;
      if (buffer.length < payloadOffset + size.length) return;

      const payload = unmask(buffer.subarray(payloadOffset, payloadOffset + size.length), buffer.subarray(maskOffset, maskOffset + 4));
      buffer = buffer.subarray(payloadOffset + size.length);

      if (opcode === 0x8) {
        close(1000);
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x0) {
        if (fragmentOpcode === 0) {
          close(1002);
          return;
        }
        fragments.push(payload);
        if (!fin) continue;
        const complete = Buffer.concat(fragments);
        fragments = [];
        const finishedOpcode = fragmentOpcode;
        fragmentOpcode = 0;
        if (finishedOpcode === 0x1) handleMessage(complete.toString('utf8'));
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragmentOpcode = opcode;
          fragments = [payload];
          continue;
        }
        if (opcode === 0x1) handleMessage(payload.toString('utf8'));
      }
    }
  });

  socket.on('error', () => dropPeer(peer));
  socket.on('close', () => dropPeer(peer));

  const sweep = setInterval(() => {
    if (Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
      clearInterval(sweep);
      close(1001);
    }
  }, 5000);
  socket.on('close', () => clearInterval(sweep));

  return peer;
}

let nextPeerId = 1;

function acceptUpgrade(request, socket) {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.setNoDelay(true);
  const peer = attachSocket(socket);
  peer.id = `p${nextPeerId++}`;

  const resetWindow = setInterval(() => {
    peer.windowCount = 0;
    peer.windowStart = Date.now();
  }, 1000);
  socket.on('close', () => clearInterval(resetWindow));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(ROOT, `.${relative}`);

  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  if (info.isDirectory()) {
    response.writeHead(302, { Location: `${pathname.replace(/\/?$/, '/')}index.html` }).end();
    return;
  }

  const extension = extname(target).toLowerCase();
  const type = MIME_TYPES[extension] ?? 'application/octet-stream';
  const cacheable = /^\/(assets|bundle)\//.test(relative);
  const headers = {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache',
    'Accept-Ranges': 'bytes',
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, headers).end();
    return;
  }

  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
}

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      peers: [...peers.values()].map(publicPeer),
      count: peers.size,
    });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    return;
  }
  serveStatic(request, response).catch((error) => {
    console.error('[http] failed', error.message);
    response.writeHead(500).end('Internal error');
  });
});

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  acceptUpgrade(request, socket);
});

server.listen(PORT, HOST, () => {
  console.log(`Sumiro is walking at http://localhost:${PORT}`);
  console.log(`Multiplayer socket ws://localhost:${PORT}/ws  (max ${MAX_PEERS} walkers)`);
});
