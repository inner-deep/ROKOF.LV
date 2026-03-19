
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '/.env' });

const prisma = new PrismaClient();

async function getLowestPriceInLast30Days(productId: string, currentPrice: number) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentHistory = await prisma.priceHistory.findMany({
    where: {
      productId,
      changedAt: { gte: thirtyDaysAgo }
    }
  });

  const olderHistory = await prisma.priceHistory.findFirst({
    where: {
      productId,
      changedAt: { lt: thirtyDaysAgo }
    },
    orderBy: { changedAt: 'desc' }
  });

  const prices = recentHistory.map(h => h.price);
  if (olderHistory) prices.push(olderHistory.price);
  prices.push(currentPrice);

  return Math.min(...prices);
}

async function getActivePromotions() {
  const now = new Date();
  return await prisma.promotion.findMany({
    where: {
      startDate: { lte: now },
      endDate: { gte: now }
    }
  });
}

function calculateDiscountedPrice(product: any, promotions: any[]) {
  let bestPrice = product.price;
  let onSale = false;

  for (const promo of promotions) {
    let applies = false;
    if (promo.targetType === 'PRODUCT' && promo.targetId === product.id) {
      applies = true;
    } else if (promo.targetType === 'CATEGORY' && promo.targetId === product.category) {
      applies = true;
    }

    if (applies) {
      let discountedPrice = product.price;
      if (promo.discountType === 'PERCENTAGE') {
        discountedPrice = product.price * (1 - promo.value / 100);
      } else if (promo.discountType === 'FIXED') {
        discountedPrice = Math.max(0, product.price - promo.value);
      }

      if (discountedPrice < bestPrice) {
        bestPrice = discountedPrice;
        onSale = true;
      }
    }
  }

  return { bestPrice, onSale };
}

async function main() {
  try {
    console.log("Fetching products...");
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' }
    });
    console.log(`Found ${products.length} products.`);

    const activePromotions = await getActivePromotions();
    console.log(`Found ${activePromotions.length} active promotions.`);

    const parsedProducts = await Promise.all(products.map(async p => {
      try {
        const { bestPrice, onSale } = calculateDiscountedPrice(p, activePromotions);
        let lowestPrice30d = p.price;
        if (onSale) {
          lowestPrice30d = await getLowestPriceInLast30Days(p.id, p.price);
        }

        return {
          id: p.id,
          sku: p.sku,
          price: bestPrice,
          onSale,
          lowestPrice30d,
          images: JSON.parse(p.images || '[]'),
          specifications: JSON.parse(p.specifications || '{}'),
        };
      } catch (err) {
        console.error(`Error parsing product ${p.id} (${p.sku}):`, err);
        throw err;
      }
    }));

    console.log("Successfully parsed all products.");
  } catch (error) {
    console.error("Main error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
