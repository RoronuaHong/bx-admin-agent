import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
loadEnv({ path: envPath, override: true });
