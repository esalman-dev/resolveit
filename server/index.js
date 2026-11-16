// Server entry point: starts the API on a port.
//
// The app itself is built in app.js, so the tests can use it without opening a port.

import app from './app.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`ResolveIT API listening on http://localhost:${PORT}`);
});
