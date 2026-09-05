import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Cleaning up database...");
  
  // Delete in order of dependence
  await prisma.notification.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.taskComment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  
  console.log("Database cleared.");

  const passwordHash = await bcrypt.hash("Test@123", 10);

  const users = [
    {
      fullName: "Manager One",
      email: "manager@entro-labs.com",
      passwordHash,
      role: "MANAGER" as any,
    },
    {
      fullName: "Team Member One",
      email: "member@entro-labs.com",
      passwordHash,
      role: "TEAM_MEMBER" as any,
    },
  ];

  for (const user of users) {
    await prisma.user.create({
      data: user,
    });
    console.log(`Created user: ${user.email} with role: ${user.role}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
