import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import {
  createServer as createHttpsServer,
  type Server,
  type ServerOptions,
} from "node:https";

/** HTTPS server that answers a plain HTTP request on the same port with a redirect. */
export function httpsWithHttpRedirect(
  tls: ServerOptions,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Server {
  const inner = createHttpsServer(tls, handler);
  const front = createNetServer((socket) => {
    accept(socket, inner);
  });
  front.on("error", (error) => {
    inner.emit("error", error);
  });
  const close = inner.close.bind(inner);
  inner.close = (callback) => {
    front.close();
    return close(callback);
  };
  inner.address = () => front.address();
  inner.listen = ((...args: Parameters<Server["listen"]>) => {
    front.listen(...args);
    front.once("listening", () => {
      inner.emit("listening");
    });
    return inner;
  }) as Server["listen"];
  return inner;
}

function accept(socket: Socket, inner: Server) {
  const chunks: Buffer[] = [];
  let size = 0;
  socket.setTimeout(5_000, () => {
    socket.destroy();
  });
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    const buffered = chunks.length === 1 ? chunk : Buffer.concat(chunks, size);
    const hasLine = buffered.includes(0x0a);
    if (buffered[0] !== 0x16 && !hasLine && size < 8_192) return;
    socket.off("data", onData);
    socket.pause();
    socket.unshift(buffered);
    if (buffered[0] === 0x16) {
      inner.emit("connection", socket);
      queueMicrotask(() => {
        socket.resume();
      });
      return;
    }
    const location = redirectLocation(buffered);
    socket.write(
      location
        ? `HTTP/1.1 308 Permanent Redirect\r\nLocation: ${location}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        : "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      () => {
        socket.end();
      },
    );
  };
  socket.on("data", onData);
  socket.on("error", () => {
    socket.destroy();
  });
}

/** Only path-absolute request targets are redirected, so the Host header cannot be used as an open redirect. */
export function redirectLocation(payload: Buffer): string | null {
  const text = payload.toString("latin1", 0, Math.min(payload.length, 8_192));
  const end = text.indexOf("\r\n");
  if (end < 0) return null;
  const target = text.slice(0, end).split(" ")[1];
  if (!target || !target.startsWith("/") || target.startsWith("//"))
    return null;
  const host = /\r\nHost: ([^\r\n]+)/i.exec(text)?.[1]?.trim();
  if (!host || /[\s]/.test(host)) return null;
  return `https://${host}${target}`;
}
