// @archstone/emitter-support — shared substrate for IR-based emitters (ADD-0008 / RFC-0008)
//
// IR indexing (Registry), semantic-type → JSON-Schema lowering, tool-name sanitization, the
// response-mapping executor, and (#43) the one policy evaluation point every invocation path
// calls before any connector work. IR-only: no MCP SDK, no fs, no HTTP — the neutral ground
// both the MCP emitter (@archstone/runtime) and the embedded agent (@archstone/agent,
// RFC-0008 #28) build on.
export * from "./registry";
export * from "./lowering";
export * from "./mapping";
export * from "./origins";
export * from "./exposure";
export * from "./policy";
export * from "./ratelimit";
export * from "./audit";
export * from "./extraction";
export * from "./caller";
