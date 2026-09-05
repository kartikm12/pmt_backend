import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkUsers() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true
    }
  });
  console.log(JSON.stringify(users, null, 2));
}

checkUsers().catch(console.error).finally(() => prisma.$disconnect());
