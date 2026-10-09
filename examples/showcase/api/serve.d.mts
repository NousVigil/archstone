import type { Server } from "node:http";
export function createApiServer(options?: { port?: number; now?: number | (() => number); imageBase?: string }): Server;
