// Loaded ahead of every test file (bunfig.toml). ORI_URL points at the discard port on
// loopback, where nothing listens: a test that forgets to inject a fake backend or mock fetch
// gets a refused connection (ModelUnavailableError) at once, never a call to a running Ori
// runtime. The blanked keys mean a missed guard still has no credentials to spend.
process.env.ORI_URL = "http://127.0.0.1:9";
process.env.OPEN_ROUTER_API_KEY = "";
process.env.OPENROUTER_API_KEY = "";
