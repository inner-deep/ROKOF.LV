import bcrypt from "bcryptjs";

async function test() {
  const password = "password123";
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  const isMatch = await bcrypt.compare(password, hash);
  console.log("Match:", isMatch);
}

test();
