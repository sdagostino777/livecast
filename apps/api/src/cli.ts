/**
 * Operator CLI, run on the server inside the app directory.
 *
 *   node --env-file=.env dist/cli.js create-admin --username admin
 *   node --env-file=.env dist/cli.js reset-password --username admin
 *
 * Passwords are never required on the command line: `--password` exists for
 * automation that already keeps the secret out of argv, everything else gets a
 * generated one printed exactly once (stdout, captured by the deploy script).
 */
import { randomBytes } from "node:crypto";
import { dbFile } from "./config.js";
import { destroyAllSessions, createUser, getUserByUsername, hashPassword, setPassword } from "./auth.js";
import { openDb } from "./db.js";
import { MIN_PASSWORD_LENGTH } from "./auth.js";

const USAGE = `Usage:
  cli.js create-admin     --username <name> [--password <pass>]
  cli.js reset-password   --username <name> [--password <pass>]
`;

function parseFlags(argv: string[]): { command: string; flags: Record<string, string | true> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command: command ?? "", flags };
}

function generatedPassword(): string {
  return randomBytes(16).toString("base64url"); // 22 chars, ~128 bits
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { command, flags } = parseFlags(process.argv.slice(2));
if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const username = typeof flags["username"] === "string" ? flags["username"] : null;
if (!username) fail("--username is required");

const db = openDb(dbFile());
const password = typeof flags["password"] === "string" ? flags["password"] : undefined;

switch (command) {
  case "create-admin": {
    if (getUserByUsername(db, username)) {
      // Exit code 2 is the deploy script's "already exists, nothing to do" signal,
      // distinct from a real failure (1).
      console.error(`user "${username}" already exists`);
      process.exit(2);
    }
    const pw = password ?? generatedPassword();
    if (pw.length < MIN_PASSWORD_LENGTH) fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const user = createUser(db, username, await hashPassword(pw));
    console.log(`ADMIN_PASSWORD=${pw}`);
    console.log(`created admin user "${user.username}" (id ${user.id})`);
    break;
  }
  case "reset-password": {
    const user = getUserByUsername(db, username);
    if (!user) fail(`no such user: ${username}`);
    const pw = password ?? generatedPassword();
    if (pw.length < MIN_PASSWORD_LENGTH) fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    setPassword(db, user.id, await hashPassword(pw));
    destroyAllSessions(db, user.id);
    console.log(`ADMIN_PASSWORD=${pw}`);
    console.log(`password reset for "${user.username}" — all sessions invalidated`);
    break;
  }
  default:
    console.error(USAGE);
    fail(`unknown command: ${command}`);
}

process.exit(0);
