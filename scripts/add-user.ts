// Create (or reset the password of) a login account from the Terminal. The password is typed hidden and not saved in shell history.
//   npm run user:add -- email@company.com "Full Name" --admin
import { createInterface } from "node:readline";
import { db } from "../src/lib/db";
import { hashPassword, MIN_PASSWORD } from "../src/lib/auth";
import { rootWorkspace } from "../src/lib/setup";

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes("\n")) out.output.write(muted ? "\n" : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const [email, nameArg] = args.filter((a) => !a.startsWith("--"));
  if (!email) {
    console.log('Usage: npm run user:add -- email@company.com ["Full Name"] [--admin]  (omit the name and the script will ask)');
    process.exitCode = 1;
    return;
  }
  const e = email.trim().toLowerCase();
  const name = nameArg || (await ask("Display name: "));
  if (!name) throw new Error("No name entered.");
  const pw = await askHidden(`Password for ${e} (at least ${MIN_PASSWORD} characters, input is hidden): `);
  const again = await askHidden("Repeat password: ");
  if (pw !== again) throw new Error("The two entries do not match.");
  const passwordHash = await hashPassword(pw);
  const role = flags.includes("--admin") ? "admin" : "member";
  const existing = await db.user.findUnique({ where: { email: e } });
  if (existing) {
    await db.user.update({ where: { email: e }, data: { passwordHash, name, role, active: true } });
    await db.session.deleteMany({ where: { userId: existing.id } });
    console.log(`✓ Updated account ${e} (${role}) and signed out all old devices.`);
  } else {
    await db.user.create({ data: { email: e, name, passwordHash, role } });
    await rootWorkspace(); // a fresh install set up from the Terminal (no /setup in the browser) still needs it to create clients
    console.log(`✓ Created account ${e} (${role}).`);
  }
}

main()
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
