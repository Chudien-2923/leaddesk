import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

const directory = resolve(process.cwd(), ".local/google");
const tokenFile = resolve(directory, "tokens.json");
const scopes = ["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.owned"];

async function authorizeCalendar(): Promise<void> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId?.trim() || calendarId.trim().toLowerCase() === "primary" || calendarId !== calendarId.trim()) throw new Error("Dedicated GOOGLE_CALENDAR_ID required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (typeof process.getuid === "function" && dirStat.uid !== process.getuid())) throw new Error("Unsafe OAuth directory");
  await chmod(directory, 0o700);
  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const credentialsFile = resolve(directory, "credentials.json");
    const stat = await lstat(credentialsFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Unsafe OAuth credentials file");
    const file = JSON.parse(await readFile(credentialsFile, "utf8"));
    const credentials = file.installed ?? file.web;
    clientId = credentials?.client_id;
    clientSecret = credentials?.client_secret;
  }
  if (!clientId || !clientSecret) throw new Error("OAuth client credentials required");
  const state = randomBytes(32).toString("hex");
  const { promise: callback, resolve: resolveCallback, reject: rejectCallback } = Promise.withResolvers<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth2/callback") { response.writeHead(404).end(); return; }
    const receivedState = url.searchParams.get("state") ?? "";
    if (!/^[a-f0-9]{64}$/.test(receivedState) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) { response.writeHead(400).end("Invalid authorization state."); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    if (url.searchParams.has("error")) { response.writeHead(400).end("Authorization was not granted."); rejectCallback(new Error("Authorization denied")); return; }
    const code = url.searchParams.get("code");
    if (!code) { response.writeHead(400).end("Authorization code missing."); return; }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization received. Return to the terminal; you may close this tab.");
    resolveCallback(code);
  });
  const timeout = setTimeout(() => rejectCallback(new Error("Authorization timed out")), 5 * 60_000);
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback callback unavailable");
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
    const client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const verifier = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: scopes, state, code_challenge: verifier.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
    console.log("Open this URL yourself and authorize the Google user who owns the dedicated calendar:");
    console.log(url);
    console.log(`Loopback callback: ${redirectUri}`);
    const code = await callback;
    const { tokens } = await client.getToken({ code, codeVerifier: verifier.codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token || !tokens.access_token) throw new Error("Offline authorization was not granted");
    const granted = new Set((tokens.scope ?? "").split(" "));
    if (!scopes.every(scope => granted.has(scope))) throw new Error("Required scopes were not granted");
    // Refuse symlink targets; credentials never leave the app-owned local directory.
    try {
      const existing = await lstat(tokenFile);
      if (!existing.isFile() || existing.isSymbolicLink() || (typeof process.getuid === "function" && existing.uid !== process.getuid())) throw new Error("Unsafe token file");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await chmod(tokenFile, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await writeFile(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    console.log("Calendar authorization saved under .local/google with mode 0600. No event was created.");
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}

authorizeCalendar().catch(() => {
  // OAuth exceptions may contain request bodies, codes, client secrets or tokens.
  console.error("Calendar authorization failed. Check local credentials, dedicated calendar ownership, granted scopes and loopback callback, then retry.");
  process.exitCode = 1;
});
