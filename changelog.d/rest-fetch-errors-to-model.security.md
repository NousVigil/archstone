- **`@archstone/provider-rest` passed fetch error messages to the model.** When a request failed
  before any response arrived, or its body could not be read, the error returned to the caller
  included the transport's own message, which can name the backend's host, port and IP
  (`getaddrinfo ENOTFOUND api.internal`, `connect ECONNREFUSED 10.0.3.7:443`) — and a custom
  `fetchImpl` may throw anything. That result reaches the model. Now the caller gets a fixed
  message and the error code only: `request failed (ECONNREFUSED)`,
  `request failed (UND_ERR_CONNECT_TIMEOUT)`, `request failed (TimeoutError)`, or
  `(error code unknown)` when there is none. The message and its cause chain go to one stderr
  line for the operator, named by capability id, with the request URL, header values, URL
  credentials, query values and the caller's access token removed.
