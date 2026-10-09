// Preloaded (`node --import`) into the CLI processes that a scenario says must be offline.
//
// It does not trust the command to behave: it makes any attempt to open an outbound connection
// (a socket connect, a DNS lookup, a fetch) both fail and leave a line in the file named by
// ARCHSTONE_RECORD_NET_LOG. A scenario then asserts that file is empty. That is a stronger proof
// than "the backend's request counter stayed at zero", because it also covers a host the command
// was never pointed at.
//
// Pipes (stdin, stdout) are not connections and are untouched.
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.ARCHSTONE_RECORD_NET_LOG;

function refuse(what) {
  return function refused() {
    if (log) appendFileSync(log, `${what}\n`);
    throw new Error(`outbound network access refused by the recorder (${what})`);
  };
}

net.Socket.prototype.connect = refuse("socket connect");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
dns.lookup = refuse("dns.lookup");
if (dns.promises) dns.promises.lookup = refuse("dns.promises.lookup");
globalThis.fetch = refuse("fetch");
