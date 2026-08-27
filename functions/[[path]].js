/**
 * Cloudflare Pages Functions 版 VLESS Worker
 * 与 worker.js 逻辑一致，仅导出方式不同（onRequest）。
 * 部署方式见 README.md。
 */

const VERSION = '1.0.0';

export function onRequest(context) {
  const { request, env } = context;
  return handleRequest(request, env);
}

async function handleRequest(request, env) {
  const userID = String(env.UUID || '').toLowerCase().trim();
  const wsPath = (env.PATH || '/vless').trim();
  const url = new URL(request.url);

  if (!isValidUUID(userID)) {
    return new Response(
      'UUID 未配置。请在 Pages 项目设置 → 环境变量 / 密钥中设置 UUID。',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  if (url.pathname === '/sub' || url.pathname === '/' + userID) {
    return buildSubscription(request, env, userID, url);
  }

  if (url.pathname === wsPath && isWebSocketRequest(request)) {
    return handleVLESS(request, env, userID, url);
  }

  return landingPage(url.hostname);
}

async function handleVLESS(request, env, userID, url) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.binaryType = 'arraybuffer';

  const reader = server.readable.getReader();
  const writer = server.writable.getWriter();

  (async () => {
    try {
      const { value: firstValue, done } = await reader.read();
      if (done || !firstValue) return;
      const firstData = toBytes(firstValue);

      const parsed = parseVLESSRequest(firstData, userID);
      if (parsed.error) return;

      if (parsed.cmd === 2) {
        await handleUDPLoop(server, reader, writer, parsed.payload, parsed.version);
        return;
      }

      const target = connect({ hostname: parsed.host, port: parsed.port });
      await target.opened;
      const targetWriter = target.writable.getWriter();
      const targetReader = target.readable.getReader();

      await writer.write(new Uint8Array([parsed.version, 0]));
      if (parsed.payload.length) await targetWriter.write(parsed.payload);

      pump(reader, targetWriter, [server, target]);
      pump(targetReader, writer, [target, server]);
    } catch (e) {}
    finally {
      try { server.close(); } catch (e) {}
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
}

async function pump(reader, writer, closeList) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writer.write(toBytes(value));
    }
  } catch (e) {}
  try { await writer.close(); } catch (e) {}
  for (const s of closeList) {
    try { s.close(); } catch (e) {}
  }
}

async function handleUDPLoop(server, reader, writer, firstPayload, version) {
  let payload = firstPayload;
  while (payload && payload.length) {
    await handleOneUDP(writer, payload, version);
    const { done, value } = await reader.read();
    if (done) break;
    payload = toBytes(value);
  }
}

async function handleOneUDP(writer, payload, version) {
  let offset = 0;
  const atype = payload[offset++];
  let host = '';
  if (atype === 1) {
    host = `${payload[offset]}.${payload[offset + 1]}.${payload[offset + 2]}.${payload[offset + 3]}`;
    offset += 4;
  } else if (atype === 2) {
    const len = payload[offset++];
    host = new TextDecoder().decode(payload.subarray(offset, offset + len));
    offset += len;
  } else if (atype === 3) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(((payload[offset + i * 2] << 8) | payload[offset + i * 2 + 1]).toString(16));
    host = parts.join(':');
    offset += 16;
  } else {
    return;
  }
  const port = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
  const length = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
  const dnsQuery = payload.subarray(offset, offset + length);

  try {
    const sock = connect({ hostname: host, port });
    await sock.opened;
    const w = sock.writable.getWriter();
    const r = sock.readable.getReader();

    const lenPrefix = new Uint8Array([(length >> 8) & 0xff, length & 0xff]);
    await w.write(concatBytes(lenPrefix, dnsQuery));

    const header = await readExactly(r, 2);
    const respLen = (header[0] << 8) | header[1];
    const respData = await readExactly(r, respLen);

    const respPacket = concatBytes(
      new Uint8Array([atype]),
      encodeAddr(atype, host),
      new Uint8Array([(port >> 8) & 0xff, port & 0xff]),
      new Uint8Array([(respLen >> 8) & 0xff, respLen & 0xff]),
      respData
    );
    await writer.write(concatBytes(new Uint8Array([version, 0]), respPacket));

    try { w.close(); } catch (e) {}
    try { r.cancel(); } catch (e) {}
    try { sock.close(); } catch (e) {}
  } catch (e) {}
}

function parseVLESSRequest(data, userID) {
  if (data.length < 18) return { error: 'short' };
  if (data[0] !== 0) return { error: 'version' };

  const uuidBytes = uuidToBytes(userID);
  if (!uuidBytes) return { error: 'uuid' };
  for (let i = 0; i < 16; i++) {
    if (data[i + 1] !== uuidBytes[i]) return { error: 'uuid' };
  }

  const candidates = [tryParse(data, 18, 19), tryParse(data, 17, 18)];
  for (const c of candidates) {
    if (c && !c.error) return c;
  }
  return { error: 'parse' };
}

function tryParse(data, optLenIdx, cmdBase) {
  const optLen = data[optLenIdx];
  const cmdIdx = cmdBase + optLen;
  if (data.length < cmdIdx + 1) return { error: 'short' };
  const cmd = data[cmdIdx];
  if (cmd !== 1 && cmd !== 2) return { error: 'cmd' };

  let offset = cmdIdx + 1;
  if (data.length < offset + 2) return { error: 'port' };
  const port = (data[offset] << 8) | data[offset + 1]; offset += 2;
  if (data.length < offset + 1) return { error: 'atype' };
  const atype = data[offset++];

  let host = '';
  if (atype === 1) {
    if (data.length < offset + 4) return { error: 'addr' };
    host = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
    offset += 4;
  } else if (atype === 2) {
    if (data.length < offset + 1) return { error: 'addr' };
    const len = data[offset++];
    if (data.length < offset + len) return { error: 'addr' };
    host = new TextDecoder().decode(data.subarray(offset, offset + len));
    offset += len;
  } else if (atype === 3) {
    if (data.length < offset + 16) return { error: 'addr' };
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(((data[offset + i * 2] << 8) | data[offset + i * 2 + 1]).toString(16));
    host = parts.join(':');
    offset += 16;
  } else {
    return { error: 'atype' };
  }

  if (port < 1 || port > 65535) return { error: 'port' };
  return { version: 0, cmd, host, port, payload: data.subarray(offset) };
}

async function buildSubscription(request, env, userID, url) {
  const host = url.hostname;
  const wsPath = (env.PATH || '/vless').trim();
  const name = env.NAME || host;
  const link = buildVLESSLink(userID, host, wsPath, name);

  const ua = request.headers.get('user-agent') || '';
  const isClash = /clash|meta|mihomo/i.test(ua) || url.searchParams.has('clash');
  const isSb = /singbox|sing-box/i.test(ua) || url.searchParams.has('sb');

  if (isClash || isSb) {
    const converter = env.SUBCONVERTER || 'https://sub.xeton.dev';
    const target = `${converter}/sub?target=${isSb ? 'singbox' : 'clash'}&url=${encodeURIComponent(link)}&insert=false&emoji=true&list=false&tfo=false&scv=true&fdn=false`;
    return Response.redirect(target, 302);
  }

  const sub = b64encode(link);
  return new Response(sub, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Subscription-Userinfo': `upload=0; download=0; total=0; expire=0`,
    },
  });
}

function buildVLESSLink(uuid, host, path, name) {
  const params = new URLSearchParams({
    type: 'ws',
    security: 'tls',
    path: path,
    host: host,
    sni: host,
    fp: 'chrome',
    alpn: 'h2,http/1.1',
  });
  return `vless://${uuid}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`;
}

function isWebSocketRequest(request) {
  const upgrade = request.headers.get('upgrade');
  return !!upgrade && upgrade.toLowerCase() === 'websocket';
}

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

function uuidToBytes(uuid) {
  const clean = String(uuid).replace(/-/g, '');
  if (clean.length !== 32) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function concatBytes(...chunks) {
  const list = chunks.map(toBytes);
  const total = list.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of list) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeAddr(atype, host) {
  if (atype === 1) return new Uint8Array(host.split('.').map(Number));
  if (atype === 2) {
    const enc = new TextEncoder().encode(host);
    return concatBytes(new Uint8Array([enc.length]), enc);
  }
  if (atype === 3) {
    const parts = host.split(':');
    return new Uint8Array(parts.map((p) => parseInt(p, 16)));
  }
  return new Uint8Array(0);
}

async function readExactly(reader, n) {
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const b = toBytes(value);
    chunks.push(b);
    got += b.length;
  }
  const all = concatBytes(...chunks);
  return all.subarray(0, n);
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function landingPage(host) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Welcome to nginx!</title>
<style>
body{width:35em;margin:0 auto;font-family:Tahoma,Verdana,Arial,sans-serif;}
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the web server is successfully installed and working.</p>
<p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
