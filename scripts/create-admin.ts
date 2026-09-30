/**
 * Create or reset a staff account from the terminal (password is read from a prompt, never argv).
 *   npm run admin:create -- owner@isolationpvt.shop ADMIN
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import readline from "node:readline";

const prisma = new PrismaClient();

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) out.output.write(s);
      else out.output.write("*");
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  const role = (process.argv[3] ?? "ADMIN").toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["ADMIN", "AGENT"].includes(role)) {
    console.error("Usage: npm run admin:create -- <email> [ADMIN|AGENT]");
    process.exit(1);
  }
  const pw = await askHidden("Password (12+ chars, upper, lower, number): ");
  if (pw.length < 12 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
    console.error("Password does not meet the policy.");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(pw, 12);
  await prisma.adminUser.upsert({
    where: { email },
    create: { email, role: role as "ADMIN" | "AGENT", passwordHash },
    update: { role: role as "ADMIN" | "AGENT", passwordHash, active: true },
  });
  console.log(`✅ ${role} account ready: ${email}`);
}

main().finally(() => prisma.$disconnect());
