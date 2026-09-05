import { ProjectService } from './src/services/project.service.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const u = await prisma.user.findFirst({where: {email: 'shanthi@gmail.com'}});
  if (!u) {
    console.error("user not found");
    return;
  }
  console.log("Logged in as:", u.email, "Role:", u.role);
  const projects = await ProjectService.list(u.id, u.role as any);
  console.log('Shanthi sees:', projects.data.map((p: any) => p.name));
}

main().finally(()=>process.exit(0));
