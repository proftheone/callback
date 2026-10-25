'use strict';
// Buduje wtyczkę WordPress w locie, z adresem tego serwera wpisanym w CBW_SERVER,
// żeby pobrana wtyczka zawsze łączyła się z właściwą instalacją.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PLUGIN_DIR = path.join(__dirname, '..', 'wordpress-plugin', 'callback-widget');

function listFiles(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(base, e.name);
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel];
  });
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function buildPluginZip(serverUrl) {
  const entries = listFiles(PLUGIN_DIR).map((rel) => {
    let data = fs.readFileSync(path.join(PLUGIN_DIR, rel));
    if (rel.endsWith('.php')) {
      data = Buffer.from(data.toString('utf8').replace(/^(\s+)define\('CBW_SERVER', '[^']*'\)/m, `$1define('CBW_SERVER', '${serverUrl.replace(/'/g, '')}')`));
    }
    return { name: `callback-widget/${rel}`, data };
  });
  return zip(entries);
}

module.exports = { buildPluginZip };
