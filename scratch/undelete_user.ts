import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function undeleteUser() {
  const user = await prisma.user.updateMany({
    where: { 
      fullName: { contains: 'Shivam Dube' },
      deletedAt: { not: null }
    },
    data: { 
      deletedAt: null,
      status: 'ACTIVE'
    }
  });
  console.log('User(s) restored:', user.count);
  await prisma.$disconnect();
}

undeleteUser().catch(console.error);
