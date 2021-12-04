import { TLS_CRT, TLS_KEY } from "./helpers/node/config.js";
import * as tls from "tls";
// import { IncomingMessage, ServerResponse } from "http";
import * as https from "https";
import { handleRequest } from "./index.js";
import { encodeUint8ArrayBE } from "./helpers/util.js";

const TLS_PORT = 10000;
const HTTPS_PORT = 8080;
const tlsOptions = {
  key: TLS_KEY,
  cert: TLS_CRT,
};
const minDNSPacketSize = 12 + 5;
const maxDNSPacketSize = 4096;
const dnsHeaderSize = 2;

const tServer = tls.createServer(tlsOptions, serveTLS).listen(
  TLS_PORT,
  () => up(tServer.address()),
);

const hServer = https.createServer(tlsOptions, serveHTTPS).listen(
  HTTPS_PORT,
  () => up(hServer.address()),
);

function up(addr) {
  console.log(`listening on: [${addr.address}]:${addr.port}`);
}

/**
 * Services a DNS over TLS connection
 * @param {tls.TLSSocket} socket
 */
function serveTLS(socket) {
  // TODO: Find a way to match DNS name with SNI
  if (!socket.servername || socket.servername.split(".").length < 3) {
    socket.destroy();
    return;
  }

  let qlBuf = Buffer.allocUnsafe(dnsHeaderSize).fill(0);
  let qlBufOffset = 0;

  socket.on("data", /** @param {Buffer} chunk */ (chunk) => {

    const cl = chunk.byteLength;
    if (cl <= 0) return;

    const rem = dnsHeaderSize - qlBufOffset; // not more than 2 bytes
    const seek = Math.min(rem, cl);
    if (seek > 0) {
      const read = chunk.slice(0, seek)
      qlBuf.fill(read, qlBufOffset);
      qlBufOffset += seek;
    }
    // done reading entire chunk
    if (cl === seek) return;

    // read the actual dns query starting from seek-th byte
    chunk = chunk.slice(seek);

    const ql = qlBuf.readUInt16BE();
    qlBuf.fill(0);

    if (ql < minDNSPacketSize || ql > maxDNSPacketSize) {
      console.warn(`TCP query length out of [min, max] bounds: ${ql}`);
      socket.destroy();
      return;
    }

    // chunk must exactly be ql bytes in size
    if (chunk.byteLength !== ql) {
      console.warn(`size mismatch: ${chunk.byteLength} <> ${ql}`);
      socket.destroy();
      return;
    }

    const ok = await handleTCPQuery(chunk, socket);
    // Only close socket on error, else it would break pipelining of queries.
    if (!ok && !socket.destroyed) {
      socket.destroy();
    }
  });

  socket.on("end", () => {
    // console.debug("TLS socket clean half shutdown");
    socket.end();
  });
}

/**
 * @param {Buffer} q
 * @param {tls.TLSSocket} socket
 */
async function handleTCPQuery(q, socket) {
  if (socket.destroyed) return false;
  try {
    // const t1 = Date.now(); // debug
    const r = await resolveQuery(q, socket.servername);
    const rlBuf = encodeUint8ArrayBE(r.byteLength, 2);
    const y = socket.write(new Uint8Array([...rlBuf, ...r]));
    if (!y) console.error(`res write incomplete: < ${r.byteLength + 2}`);
    // console.debug("processing time t-q =", Date.now() - t1);
    return y;
  } catch (e) {
    console.warn(e);
  }
  return false;
}

/**
 * @param {Buffer} q
 * @param {String} sni
 * @returns
 */
async function resolveQuery(q, sni) {
  // NOTE: b32 flag uses delimiter `+` internally, instead of `-`.
  // TODO: Find a way to match DNS name with SNI to find flag.
  const [flag, host] = sni.split(".").length < 4
    ? ["", sni]
    : [sni.split(".")[0].replace(/-/g, "+"), sni.slice(sni.indexOf(".") + 1)];

  // FIXME: GET requests are capped at 2KB, where-as DNS-over-TCP
  // has a much higher ceiling (even if rarely used)
  const qURL = new URL(
    `/${flag}?dns=${q.toString("base64url").replace(/=/g, "")}`,
    `https://${host}`,
  );

  const r = await handleRequest({
    request: new Request(qURL, {
      method: "GET",
      headers: {
        "Accept": "application/dns-message",
      },
    }),
  });

  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Services a DNS over HTTPS connection
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
async function serveHTTPS(req, res) {
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const b = Buffer.concat(buffers);
  const bl = b.byteLength;

  if (req.method == "POST" && (bl < minDNSPacketSize || bl > maxDNSPacketSize)) {
    console.warn(`HTTP req body length out of [min, max] bounds: ${bl}`);
    res.end();
    return;
  }

  // console.debug("-> HTTPS req", req.method, bl);
  handleHTTPRequest(b, req, res);
}

/**
 * @param {Buffer} b - Request body
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
async function handleHTTPRequest(b, req, res) {
  try {
    // const t1 = Date.now(); // debug
    const fReq = new Request(
      new URL(req.url, `https://${req.headers.host}`),
      {
        // Note: In VM container, Object spread may not be working for all
        // properties, especially of "hidden" Symbol values!? like "headers"?
        ...req,
        headers: req.headers,
        body: req.method.toUpperCase() == "POST" ? b : null,
      },
    );
    const fRes = await handleRequest({ request: fReq });

    const resHeaders = Object.assign({}, fRes.headers);
    res.writeHead(fRes.status, resHeaders);
    res.end(Buffer.from(await fRes.arrayBuffer()));
    // console.debug("processing time h-q =", Date.now() - t1);
  } catch (e) {
    console.warn(e);
  } finally {
    res.end();
  }
}
