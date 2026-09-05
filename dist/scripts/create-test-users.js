import bcrypt from "bcryptjs";
import { prisma } from "../prisma/client.js";
import { USER_ROLE } from "../constants/enums.js";
async function createTestUsers() {
    const passwordHash = await bcrypt.hash("Test@123", 10);
    const users = [
        {
            fullName: "Manager One",
            email: "manager@entro-labs.com",
            passwordHash,
            role: USER_ROLE.MANAGER,
        },
        {
            fullName: "Team Member One",
            email: "member@entro-labs.com",
            passwordHash,
            role: USER_ROLE.TEAM_MEMBER,
        },
    ];
    for (const user of users) {
        await prisma.user.upsert({
            where: { email: user.email },
            update: {
                fullName: user.fullName,
                passwordHash: user.passwordHash,
                role: user.role,
                deletedAt: null,
            },
            create: user,
        });
        console.log(`Upserted user: ${user.email} with role: ${user.role}`);
    }
    process.exit(0);
}
createTestUsers()
    .catch((e) => {
    console.error(e);
    process.exit(1);
});
