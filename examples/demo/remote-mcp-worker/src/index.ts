// The Worker entry. Kept to a default export on purpose: the Workers runtime refuses to start when
// the entry module exports anything that is not a handler. Everything else lives in ./worker.
import { createWorker } from "./worker";

export default createWorker();
