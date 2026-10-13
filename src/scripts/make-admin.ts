import { PrismaClient } from "@prisma/client";

// Makes an existing, approved account an Admin. Only an Admin can grant Admin inside the app,
// so the very first one is made with this:  npm run make-admin -- someone@example.com
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Usage: npm run make-admin -- someone@example.com");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt) throw new Error(`No account for ${email}. They need to sign up (or be added) first.`);
  if (user.pendingApproval) throw new Error(`${email} is still waiting for sign-up approval. Approve them on the Team page first.`);
  if (user.role === "ADMIN") {
    console.log(`${user.fullName} (${email}) is already an Admin. Nothing changed.`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN", roleLocked: true } });
  await prisma.activityLog.create({
    data: {
      action: "PROFILE_UPDATED",
      entityType: "User",
      entityId: user.id,
      description: `${user.fullName} was made an Admin with the make-admin script (was ${user.role})`,
      userId: user.id
    }
  });
  console.log(`${user.fullName} (${email}) is now an Admin (was ${user.role}). They should sign out and back in.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
