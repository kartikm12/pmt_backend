import { z } from "zod";
import { MEMBERSHIP_ROLE, USER_ROLE } from "../constants/enums.js";
export const inviteTeamMemberSchema = z.object({
    fullName: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    role: z.nativeEnum(USER_ROLE).optional(),
    title: z.string().max(120).optional(),
    projectId: z.string().cuid().optional(),
    membershipRole: z.nativeEnum(MEMBERSHIP_ROLE).optional()
});
