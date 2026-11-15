// Starts the API server. The app itself is built in app.js (so tests can use it without a port).
import app from './app.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`ResolveIT API listening on http://localhost:${PORT}`);
});
