// @archstone/compiler — Compiler front-end + IR (#3, #4)
// Semantic Validator (#3) runs on the loaded model; compile (#4) lowers it to the
// IR — the target-agnostic contract every emitter consumes.
export * from "./ir";
export * from "./resolve";
export * from "./path";
export * from "./fingerprint";
export * from "./shape-diff";
export * from "./exposure";
export * from "./ir-diff";
export * from "./validate";
export * from "./lint";
export * from "./compile";
