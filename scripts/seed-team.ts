import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { generateShortId } from '../src/utils/id.js';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);
  
  // Create Manager
  const manager = await prisma.user.upsert({
    where: { email: 'manager@example.com' },
    update: {},
    create: {
      email: 'manager@example.com',
      fullName: 'Project Manager',
      passwordHash,
      role: 'MANAGER',
      avatarUrl: 'https://ui-avatars.com/api/?name=Project+Manager&background=6366f1&color=fff'
    }
  });

  // Create Developers
  const dev1 = await prisma.user.upsert({
    where: { email: 'dev1@example.com' },
    update: {},
    create: {
      email: 'dev1@example.com',
      fullName: 'Alice Developer',
      passwordHash,
      role: 'TEAM_MEMBER',
      avatarUrl: 'https://ui-avatars.com/api/?name=Alice+Dev&background=10b981&color=fff'
    }
  });

  const dev2 = await prisma.user.upsert({
    where: { email: 'dev2@example.com' },
    update: {},
    create: {
      email: 'dev2@example.com',
      fullName: 'Bob Developer',
      passwordHash,
      role: 'TEAM_MEMBER',
      avatarUrl: 'https://ui-avatars.com/api/?name=Bob+Dev&background=3b82f6&color=fff'
    }
  });

  // Create Project
  const project = await prisma.project.create({
    data: {
      id: generateShortId(),
      name: 'Multi-Assignee Test Project',
      slug: `multi-test-${Date.now().toString().slice(-4)}`,
      description: 'A project to test multi-assignee task features.',
      manager: { connect: { id: manager.id } },
      createdBy: { connect: { id: manager.id } },
      status: 'ACTIVE',
      members: {
        create: [
          { userId: manager.id },
          { userId: dev1.id },
          { userId: dev2.id }
        ]
      }
    }
  });

  // Create a Task with multiple assignees
  await prisma.task.create({
    data: {
      id: generateShortId(),
      title: 'Implement Multi-Assignee Backend',
      description: 'Refactor TaskService and schema for many-to-many relationship.',
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      project: { connect: { id: project.id } },
      createdBy: { connect: { id: manager.id } },
      assignees: {
        connect: [
          { id: dev1.id },
          { id: dev2.id }
        ]
      }
    }
  });

  console.log('Seeding completed successfully');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
