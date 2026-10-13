import { z } from "zod";
import { MEMBERSHIP_ROLE, USER_ROLE } from "../constants/enums.js";

export const inviteTeamMemberSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  role: z.nativeEnum(USER_ROLE).optional(),
  title: z.string().max(120).optional(),
  projectId: z.string().min(1).optional(),
  membershipRole: z.nativeEnum(MEMBERSHIP_ROLE).optional()
});

export const approveSignupSchema = z.object({
  role: z.nativeEnum(USER_ROLE).default(USER_ROLE.TEAM_MEMBER)
});

export const updateTeamMemberSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: z.nativeEnum(USER_ROLE).optional(),
  title: z.string().max(120).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  projectId: z.string().min(1).optional(),
  membershipRole: z.nativeEnum(MEMBERSHIP_ROLE).optional()
});
