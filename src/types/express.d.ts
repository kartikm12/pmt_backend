import type { UserRole } from "../constants/enums.js";

declare global {
  namespace Express {
    interface UserPayload {
      userId: string;
      sessionId: string;
      email: string;
      role: UserRole;
      fullName: string;
    }

    interface Request {
      user?: UserPayload;
    }
  }
}

export {};
