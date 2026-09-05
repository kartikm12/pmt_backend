import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
    console.log("Starting task cleanup...");
    // Find all projects that are soft-deleted
    const deletedProjects = await prisma.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true }
    });
    const projectIds = deletedProjects.map(p => p.id);
    console.log(`Found ${projectIds.length} deleted projects.`);
    if (projectIds.length > 0) {
        // Update all tasks in these projects that aren't yet soft-deleted
        const result = await prisma.task.updateMany({
            where: {
                projectId: { in: projectIds },
                deletedAt: null
            },
            data: {
                deletedAt: new Date()
            }
        });
        console.log(`Successfully soft-deleted ${result.count} orphaned tasks.`);
    }
    // Also handle ProjectMembers just in case
    const memberResult = await prisma.projectMember.updateMany({
        where: {
            projectId: { in: projectIds },
            removedAt: null
        },
        data: {
            removedAt: new Date()
        }
    });
    console.log(`Successfully removed ${memberResult.count} orphaned project members.`);
}
main()
    .catch(e => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
