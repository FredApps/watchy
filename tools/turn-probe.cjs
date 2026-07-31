const dgram = require("dgram");
const crypto = require("crypto");

const server = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || "3478");
const username = process.argv[4] || "watchy";
const password = process.argv[5] || "pPJkSpUz60SrUoRnt1I3TInG";
const MAGIC = 0x2112a442;
const ATTR = {
  USERNAME: 0x0006,
  ERROR_CODE: 0x0009,
  MESSAGE_INTEGRITY: 0x0008,
  LIFETIME: 0x000d,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
};

function pad4(length) {
  return (4 - (length % 4)) % 4;
}

function attr(type, value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const buffer = Buffer.alloc(4 + content.length + pad4(content.length));
  buffer.writeUInt16BE(type, 0);
  buffer.writeUInt16BE(content.length, 2);
  content.copy(buffer, 4);
  return buffer;
}

function lifetime(seconds) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(seconds, 0);
  return attr(ATTR.LIFETIME, buffer);
}

function requestedTransport() {
  const buffer = Buffer.alloc(4);
  buffer[0] = 17;
  return attr(ATTR.REQUESTED_TRANSPORT, buffer);
}

function longTermKey(realm) {
  return crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
}

function buildMessage(type, transactionId, attributes, realm) {
  let body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(MAGIC, 4);
  transactionId.copy(header, 8);

  if (realm) {
    // RFC 5389: the HMAC covers the header (with the length already including
    // the 24-byte MESSAGE-INTEGRITY attribute) plus the preceding attributes,
    // and stops before the MESSAGE-INTEGRITY attribute itself.
    header.writeUInt16BE(body.length + 24, 2);
    const input = Buffer.concat([header, body]);
    const mac = crypto.createHmac("sha1", longTermKey(realm)).update(input).digest();
    body = Buffer.concat([body, attr(ATTR.MESSAGE_INTEGRITY, mac)]);
  }

  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function parseMessage(buffer) {
  const attributes = {};
  let offset = 20;
  while (offset + 4 <= buffer.length) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    attributes[type] = buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length + pad4(length);
  }
  return { type: buffer.readUInt16BE(0), attributes };
}

function stringAttr(attributes, type) {
  return attributes[type] ? attributes[type].toString() : "";
}

function xorAddress(value) {
  if (!value) return "";
  const portValue = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const octets = [];
  for (let index = 0; index < 4; index += 1) {
    octets.push(value[4 + index] ^ ((MAGIC >>> (24 - index * 8)) & 255));
  }
  return `${octets.join(".")}:${portValue}`;
}

const socket = dgram.createSocket("udp4");

function send(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 4000);
    socket.once("message", (response) => {
      clearTimeout(timer);
      resolve(parseMessage(response));
    });
    socket.send(message, port, server);
  });
}

(async () => {
  const challenge = await send(buildMessage(0x0003, crypto.randomBytes(12), [requestedTransport()], null));
  const realm = stringAttr(challenge.attributes, ATTR.REALM);
  const nonce = stringAttr(challenge.attributes, ATTR.NONCE);
  const common = [attr(ATTR.USERNAME, username), attr(ATTR.REALM, realm), attr(ATTR.NONCE, nonce)];
  const allocated = await send(buildMessage(0x0003, crypto.randomBytes(12), [...common, requestedTransport()], realm));
  const freed = await send(buildMessage(0x0004, crypto.randomBytes(12), [...common, lifetime(0)], realm));

  const errorOf = (message) => {
    const value = message.attributes[ATTR.ERROR_CODE];
    return value ? `${value[2] * 100 + value[3]} ${value.subarray(4).toString()}` : null;
  };

  console.log(
    JSON.stringify({
      allocateError: errorOf(allocated),
      refreshError: errorOf(freed),
      challengeType: `0x${challenge.type.toString(16)}`,
      allocateType: `0x${allocated.type.toString(16)}`,
      relayed: xorAddress(allocated.attributes[ATTR.XOR_RELAYED_ADDRESS]),
      lifetime: allocated.attributes[ATTR.LIFETIME]?.readUInt32BE(0),
      refreshType: `0x${freed.type.toString(16)}`,
      refreshLifetime: freed.attributes[ATTR.LIFETIME]?.readUInt32BE(0),
    }),
  );
  socket.close();
})().catch((error) => {
  console.error(error.message);
  socket.close();
  process.exit(1);
});
