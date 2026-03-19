import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkUser() {
  const email = 'pavels@pzka.lv';
  const user = await prisma.user.findUnique({ where: { email } });
  
  if (!user) {
    console.log(`User ${email} not found.`);
  } else {
    console.log(`User found:`, {
      id: user.id,
      email: user.email,
      hasPasswordHash: !!user.passwordHash,
      passwordHash: user.passwordHash,
      role: user.role
    });
  }
}

checkUser().catch(console.error);
