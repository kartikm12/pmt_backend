import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkUser() {
  const user = await prisma.user.findFirst({
    where: { fullName: { contains: 'Shivam Dube' } }
  });
  console.log('User found:', JSON.stringify(user, null, 2));
  await prisma.$disconnect();
}

checkUser().catch(console.error);
