
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import Redlock from 'redlock';
import RedisMock from 'ioredis-mock';

const prisma = new PrismaClient();

// Use ioredis-mock if no REDIS_URL
let redis: any;
let redisSubscriber: any;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redisSubscriber = new Redis(process.env.REDIS_URL);
} else {
  console.log("Using ioredis-mock for testing");
  redis = new RedisMock();
  redisSubscriber = new RedisMock();
  redis.config = async () => 'OK';
}

const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  automaticExtensionThreshold: 500,
});

// Replicate the expiration handler from server.ts for testing
redisSubscriber.on('message', async (channel: string, message: string) => {
  if (channel === '__keyevent@0__:expired' && message.startsWith('reservation:')) {
    const parts = message.split(':');
    if (parts.length >= 4) {
      const productId = parts[2];
      const quantity = parseInt(parts[3], 10);
      
      try {
        const lock = await redlock.acquire([`lock:product:${productId}`], 5000);
        try {
          await prisma.product.update({
            where: { id: productId },
            data: { stockQuantity: { increment: quantity } }
          });
          console.log(`✅ Restored ${quantity} stock for product ${productId} due to TTL expiration.`);
        } finally {
          await lock.release();
        }
      } catch (error) {
        console.error(`Failed to restore stock:`, error);
      }
    }
  }
});

async function testTTL() {
  const product = await prisma.product.findFirst({
    where: { stockQuantity: { gt: 10 } }
  });

  if (!product) {
    console.error("No product found with stock > 10");
    return;
  }

  const userId = 'test_user_ttl';
  const quantity = 5;
  const initialStock = product.stockQuantity;

  console.log(`Initial stock: ${initialStock}`);

  // 1. Simulate adding to cart (decrement stock)
  await prisma.product.update({
    where: { id: product.id },
    data: { stockQuantity: { decrement: quantity } }
  });
  console.log(`Reserved ${quantity} items. Current stock: ${initialStock - quantity}`);

  // 2. Set TTL (in mock, this won't trigger automatically)
  const key = `reservation:${userId}:${product.id}:${quantity}`;
  await redis.setex(key, 2, "reserved");
  console.log(`Set TTL for key: ${key}`);

  // 3. Manually trigger the expiration event (since it's a mock)
  console.log("Simulating TTL expiration...");
  redisSubscriber.emit('message', '__keyevent@0__:expired', key);

  // 4. Wait a bit for the handler to run
  await new Promise(resolve => setTimeout(resolve, 1000));

  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  console.log(`Final stock after TTL: ${finalProduct.stockQuantity} (Expected: ${initialStock})`);
  
  if (finalProduct.stockQuantity === initialStock) {
    console.log("✅ TTL Test Passed!");
  } else {
    console.log("❌ TTL Test Failed!");
  }
}

testTTL().finally(() => {
  prisma.$disconnect();
  redis.disconnect();
  redisSubscriber.disconnect();
});
