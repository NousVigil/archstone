import type { Server } from "node:http";
import type { ApprovalStore } from "./wanderlust-api.mjs";
export function createApiServer(options?: { port?: number; now?: number | (() => number); imageBase?: string; approvals?: ApprovalStore }): Server;
