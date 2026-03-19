console.log("Current working directory:", process.cwd());
import path from "path";
console.log("Absolute path to prisma/dev.db:", path.resolve(process.cwd(), "prisma/dev.db"));
