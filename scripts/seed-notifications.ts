import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ where: { deletedAt: null } });
  
  for (const user of users) {
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'PROJECT_UPDATED',
        title: 'Welcome to Entro Labs!',
        message: 'Your account is ready. Explore your dashboard and manage your team efficiently.',
        isRead: false,
      }
    });
    console.log(`Created welcome notification for ${user.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
