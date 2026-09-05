import "dotenv/config";
import { AuthService } from "../services/auth.service.js";
import fs from "fs";

async function debug() {
  const logs: string[] = [];
  logs.push("Log start: " + new Date().toISOString());
  try {
    logs.push("Attempting Manager login...");
    const manager = await AuthService.login({
      email: "manager@entro-labs.com",
      password: "Test@123"
    });
    logs.push("Manager login success: " + !!manager.token);

    logs.push("Attempting Member login...");
    const member = await AuthService.login({
      email: "member@entro-labs.com",
      password: "Test@123"
    });
    logs.push("Member login success: " + !!member.token);
  } catch (e: any) {
    logs.push("Login failed: " + e.message);
  }
  fs.writeFileSync("auth_debug.log", logs.join("\n"));
  process.exit(0);
}

debug();
